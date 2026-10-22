// What the backups did (1.12.0), from the events the backup commands write into system_log:
//   backup          ets-backup: one per successful run (detail: file, size, key_id, config, logs, offsite = the
//                   destinations configured at that time, frequency_hours, next_run)
//   backup_failed   ets-backup stopped at a step
//   backup_offsite  one per destination and run: { dest, ok, target, files, deleted, error }
//   backup_verify   ets-backup-verify (weekly test restore / «تحقق الآن»): { ok, error, counts, … }
//   restore         a restore finished (web UI or CLI)
// Used by Settings → «النسخ الاحتياطي» (routes/backups.js) and the notification scan (S6, S9, S10, S11).
import { query } from '../db/pool.js';

export const VERIFY_MAX_AGE_DAYS = 8;     // weekly test restore: alert when none succeeded for this long
const H = 3600e3;

async function last(event, where = '', params = []) {
  return (await query(`SELECT id, ts, level, detail FROM system_log WHERE event=$1 ${where} ORDER BY ts DESC, id DESC LIMIT 1`, [event, ...params])).rows[0] || null;
}

// → the summary; thresholds from the settings (s) and the backup interval (backup_config.frequency_hours)
export async function backupSummary(s = {}, now = new Date()) {
  const cfg = (await query('SELECT config FROM backup_config WHERE id=1').catch(() => ({ rows: [] }))).rows[0]?.config || {};
  const freq = Number.isInteger(cfg.frequency_hours) ? cfg.frequency_hours : 1;
  // never less than the interval + 1 h (+ 2 h for the offsite copies), whatever the setting says
  const maxLocal = Math.max(+s['notify.backup_max_age_hours'] || 2, freq + 1);
  const maxOff = Math.max(+s['notify.offsite_max_age_hours'] || 3, freq + 2);
  const b = await last('backup');
  const failed = await last('backup_failed');
  const ref = (await query(`SELECT (SELECT min(ts) FROM system_log) AS first,
      (SELECT min(ts) FROM system_log WHERE event='migration' AND message='021_backup_center.sql') AS v112`)).rows[0];
  const age = ts => (ts ? (now - new Date(ts)) / H : null);
  const oldEnough = hours => ref.first && age(ref.first) > hours;
  const local = {
    last: b?.ts || null, file: b?.detail?.file || null, size: b?.detail?.size ?? null, key_id: b?.detail?.key_id || null,
    config: b?.detail?.config || null, logs: b?.detail?.logs || null, next_run: b?.detail?.next_run || null,
    failed_at: failed && (!b || new Date(failed.ts) > new Date(b.ts)) ? failed.ts : null, failed_step: failed?.detail?.step || null,
    max_age_hours: maxLocal,
  };
  local.stale = (!b || age(b.ts) > maxLocal) && !!oldEnough(maxLocal);
  // destinations: those of the newest run (a destination switched off is not reported any more)
  const dests = Array.isArray(b?.detail?.offsite) ? b.detail.offsite.filter(d => ['ssh', 'nas', 'cloud'].includes(d)) : [];
  const offsite = [];
  for (const dest of dests) {
    const a = await last('backup_offsite', `AND detail->>'dest' = $2`, [dest]);
    const ok = await last('backup_offsite', `AND detail->>'dest' = $2 AND (detail->>'ok')::boolean`, [dest]);
    const first = (await query(`SELECT min(ts) AS t FROM system_log WHERE event='backup_offsite' AND detail->>'dest'=$1`, [dest])).rows[0].t;
    const stale = (!ok || age(ok.ts) > maxOff) && (!!ok || (first && age(first) > maxOff) || (a && a.detail?.ok === false && age(first) > maxOff));
    offsite.push({ dest, target: a?.detail?.target || null, last_attempt: a?.ts || null, ok: a ? a.detail?.ok === true : null,
      error: a?.detail?.ok === false ? a.detail.error || 'failed' : null, last_ok: ok?.ts || null, files: a?.detail?.files ?? null, stale: !!stale,
      max_age_hours: maxOff });
  }
  const v = await last('backup_verify');
  const vok = await last('backup_verify', `AND (detail->>'ok')::boolean`);
  const since = ref.v112 || ref.first;
  const verify = { last: v?.ts || null, ok: v ? v.detail?.ok === true : null, error: v?.detail?.ok === false ? v.detail.error || 'failed' : null,
    details: v?.detail?.details || null, counts: v?.detail?.counts || null, last_ok: vok?.ts || null, enabled: cfg.verify?.enabled !== false };
  verify.failed = verify.ok === false;
  verify.stale = verify.enabled && (!vok || age(vok.ts) > VERIFY_MAX_AGE_DAYS * 24) && !!since && age(since) > VERIFY_MAX_AGE_DAYS * 24;
  return { frequency_hours: freq, local, offsite, verify };
}

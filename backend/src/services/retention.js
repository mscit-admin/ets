import { query, tx } from '../db/pool.js';
import { allSettings } from './settings.js';
import { logAudit, logSystem, logger } from './logs.js';
import { verifyAll, chainHeads } from './logchain.js';

// Deletes log rows older than the configured retention (Settings → Logs) (ETS-SEC-048):
//   - audit_log (change history): logs.audit_retention_days, at least 365 days
//   - auth_log, error_log, system_log: logs.retention_days
//   - access_log: logs.access_retention_days
// audit_log and auth_log are append-only chains: their old rows are removed only through ets_purge_log()
// (migration 012), which refuses rows younger than 365 / 30 days whatever the setting says and leaves an anchor.
// Every purge is itself recorded in the change history (with who ran it and the rows deleted per table), and the
// chains are verified first; the chain heads go to the file log / journald as an outside reference.
// A broken chain stops the purge (V5-O1): nothing is deleted, a 'purge_skipped' row with alert:true goes to the
// change history and the system log, and the result is { skipped: true } (the CLI then exits non-zero) — deleting
// the old rows would otherwise remove the evidence and the chain would verify clean again. The daily run keeps
// skipping and alerting until an administrator repairs the cause or acknowledges the break with
// `npm run purge-logs -- --acknowledge-broken-chain`, which records who acknowledged it (and the broken tables)
// before purging.
// actor: 'system' (daily run of the server) or 'cli:<user>' (npm run purge-logs).
export async function purgeLogs({ actor = 'system', acknowledgeBrokenChain = false } = {}) {
  const s = await allSettings();
  const days = Math.max(30, +s['logs.retention_days'] || 365);
  const auditDays = Math.max(365, +s['logs.audit_retention_days'] || 365);
  const accessDays = Math.max(7, +s['logs.access_retention_days'] || 90);
  const integrity = await verifyAll();
  if (!integrity.ok) {
    logger.error({ alert: true, kind: 'integrity', tables: integrity.tables.filter(t => !t.ok) }, 'log hash chain broken');
    await logSystem('log_chain_broken', 'audit/auth log hash chain verification failed', integrity, 'error');
    const broken = integrity.tables.filter(t => !t.ok)
      .map(t => ({ table: t.table, breaks: t.breaks.length, first_breaks: t.breaks.slice(0, 20) }));
    const by = { id: null, username: actor };
    if (!acknowledgeBrokenChain) {
      await logAudit(null, { actor: by, action: 'purge_skipped', entity: 'log', summary: 'log retention purge skipped: hash chain broken',
        newValue: { alert: true, reason: 'chain_broken', tables: broken } });
      await logSystem('log_purge_skipped', 'log retention purge skipped: hash chain broken — nothing deleted; ' +
        'repair, or acknowledge with: npm run purge-logs -- --acknowledge-broken-chain', { alert: true, actor, tables: broken }, 'error');
      return { skipped: true, reason: 'chain_broken', tables: broken.map(t => t.table) };
    }
    await logAudit(null, { actor: by, action: 'purge_acknowledge', entity: 'log', summary: 'broken hash chain acknowledged before purge',
      newValue: { alert: true, tables: broken } });
    await logSystem('log_chain_break_acknowledged', 'broken hash chain acknowledged; purge proceeds', { alert: true, actor, tables: broken }, 'warn');
  }
  // the plain tables first (no lock on the chains meanwhile), then the two chains with the purge's own audit row
  const out = {};
  for (const t of ['error_log', 'system_log']) {
    out[t] = (await query(`DELETE FROM ${t} WHERE ts < now() - make_interval(days => $1)`, [days])).rowCount;
  }
  out.access_log = (await query('DELETE FROM access_log WHERE ts < now() - make_interval(days => $1)', [accessDays])).rowCount;
  out.sessions = (await query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`)).rowCount;
  await tx(async c => {
    out.audit_log = Number((await c.query('SELECT ets_purge_log($1,$2,$3) AS n', ['audit_log', auditDays, actor])).rows[0].n);
    out.auth_log = Number((await c.query('SELECT ets_purge_log($1,$2,$3) AS n', ['auth_log', days, actor])).rows[0].n);
    // the purge's own record, in the change history (kept at least 365 days) and in the same transaction
    await logAudit(null, { db: c, actor: { id: null, username: actor }, action: 'purge', entity: 'log', summary: 'log retention purge',
      newValue: { deleted: out, retention_days: days, audit_retention_days: auditDays, access_retention_days: accessDays,
        chains_intact_before: integrity.ok, ...(integrity.ok ? {} : { break_acknowledged: true }) } });
  });
  const heads = await chainHeads();
  await logSystem('log_purge', 'log retention purge', { actor, retention_days: days, audit_retention_days: auditDays,
    access_retention_days: accessDays, deleted: out, chain_heads: heads, integrity_ok: integrity.ok });
  return out;
}


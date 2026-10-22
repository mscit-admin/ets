// The root backup agent (1.12.0) — backend/scripts/backup-agent.js, run by ets-backup-agent.service every 30 s
// (ets-backup-agent.timer) and at once when the API touches /var/lib/ets/inbox/.wake (ets-backup-agent.path).
// The API (user ets, unprivileged) only stores the desired configuration and queues jobs; this agent:
//   1. imports an existing /etc/ets/backup.conf into the database once (update from 1.11.0);
//   2. validates the desired configuration again (backup/config.js) and renders /etc/ets/backup.conf, rclone.conf and
//      the timer drop-ins — only the files of writable() can be written;
//   3. runs queued jobs of the whitelisted kinds, one at a time, commands started with argument arrays (no shell);
//   4. writes the status shown in Settings → «النسخ الاحتياطي» (inventory, destinations, disk, next runs, SSH key).
import fs from 'node:fs';
import path from 'node:path';
import { pool, query } from '../db/pool.js';
import { decrypt as decryptSecret } from '../services/crypto.js';
import { validateConfig, renderBackupConf, renderRcloneConf, timerSchedule, renderTimerDropIn, fromBackupConf, parseKv,
  DEFAULT_CONFIG, SECRET_KEYS, keyId, passphraseProblem, parseArtifact, DESTS } from './config.js';
import { agentPaths, writeAllowed, run, takeSecret, sweep, readText, readJsonFile, ips, hostname, writeAtomic } from './agent-util.js';
import { Tracker } from './progress.js';
import { restoreInspect, restoreRun } from './restore.js';

export const LOCK_KEY = 'ets_backup_agent';
export const JOB_KINDS = ['backup_now', 'verify_now', 'test_destination', 'generate_ssh_key', 'set_passphrase', 'restore_inspect', 'restore_run'];
const say = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- configuration
export async function importOnce(p = agentPaths()) {
  if ((await query('SELECT 1 FROM backup_config WHERE id=1')).rowCount) return false;
  const kv = parseKv(readText(p.backupConf) || '');
  const env = parseKv(readText(p.envFile) || '');
  const c = fromBackupConf(kv, { keepDaysEnv: env.ETS_BACKUP_KEEP_DAYS });
  const kid = fs.existsSync(p.backupKey) ? keyId(fs.readFileSync(p.backupKey, 'utf8')) : null;
  const r = await query(`INSERT INTO backup_config(id, config, source, key_id, key_changed_at) VALUES (1, $1, $2, $3, now())
    ON CONFLICT (id) DO NOTHING`, [JSON.stringify(c), Object.keys(kv).length ? 'imported' : 'default', kid]);
  if (r.rowCount) say(`backup settings imported into the database from ${Object.keys(kv).length ? p.backupConf : 'the defaults'}`);
  return r.rowCount > 0;
}

export async function applyConfig(p = agentPaths(), { reload = true } = {}) {
  const row = (await query('SELECT config, secrets, version FROM backup_config WHERE id=1')).rows[0];
  if (!row) return { applied: false, error: 'no_config' };
  const v = validateConfig(row.config);
  const fail = async error => {
    await query(`INSERT INTO backup_status(id, apply_error) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET apply_error=$1, updated_at=now()`, [error]);
    say('configuration NOT applied:', error);
    return { applied: false, error };
  };
  if (!v.ok) return fail(`invalid ${v.field}: ${v.reason}`);
  const c = v.value;
  writeAllowed(p, p.backupConf, renderBackupConf(c, { confDir: p.conf, version: row.version }));
  if (c.cloud.enabled && c.cloud.mode === 's3') {
    const secrets = {};
    try {
      for (const k of SECRET_KEYS) secrets[k] = row.secrets?.[k] ? decryptSecret(row.secrets[k], 'backup:' + k) : '';
      writeAllowed(p, p.rcloneConf, renderRcloneConf(c, secrets));
    } catch (e) { return fail('cloud credentials: ' + e.message.replace(/:.*$/, '')); }
  } else if ((readText(p.rcloneConf) || '').startsWith('# written by ets-backup-agent')) {
    fs.rmSync(p.rcloneConf, { force: true });     // credentials are not left on disk when the cloud copy is switched off
  }
  const sch = timerSchedule(c);
  const a = writeAllowed(p, path.join(p.systemd, 'ets-backup.timer.d', 'schedule.conf'), renderTimerDropIn(sch.backup), 0o644);
  const b = writeAllowed(p, path.join(p.systemd, 'ets-backup-verify.timer.d', 'schedule.conf'), renderTimerDropIn(sch.verify), 0o644);
  if ((a || b) && reload) {
    await run(p.systemctl, ['daemon-reload']);
    await run(p.systemctl, ['try-restart', 'ets-backup.timer', 'ets-backup-verify.timer']);
  }
  await query(`INSERT INTO backup_status(id, applied_version, apply_error) VALUES (1, $1, NULL)
    ON CONFLICT (id) DO UPDATE SET applied_version=$1, apply_error=NULL, updated_at=now()`, [row.version]);
  return { applied: true, version: row.version, timers_changed: a || b };
}

// ---------------------------------------------------------------- status shown in the UI
const SIDE = /\.(sha256|meta)$/;
function inventory(dir) {
  const files = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return files; }
  for (const n of names) {
    const a = parseArtifact(n);
    if (!a || SIDE.test(n)) continue;
    let size = 0; try { size = fs.statSync(path.join(dir, n)).size; } catch { continue; }
    const sha = (readText(path.join(dir, n + '.sha256')) || '').split(/\s/)[0] || null;
    const meta = readJsonFile(path.join(dir, n + '.meta'));
    files.push({ name: n, kind: a.kind, ts: a.ts, size, sha256: sha, meta });
  }
  return files.sort((x, y) => (x.ts < y.ts ? 1 : -1));
}
async function nextRun(p, unit) {
  const r = await run(p.systemctl, ['show', unit, '-p', 'NextElapseUSecRealtime', '--value']);
  const s = r.code === 0 ? r.out.trim() : '';
  const d = s && s !== 'n/a' ? new Date(s.replace(/^[A-Z][a-z]{2} /, '').replace(/ ([A-Z]{2,5})$/, '')) : null;
  return d && !Number.isNaN(+d) ? d.toISOString() : null;
}
export async function refreshStatus(p = agentPaths()) {
  const local = inventory(p.backupDir);
  const dests = {};
  for (const d of DESTS) {
    const list = readText(path.join(p.backupDir, '.offsite', d + '.list'));
    if (list !== null) dests[d] = list.split('\n').filter(n => parseArtifact(n));
  }
  let disk = null;
  try { const s = fs.statfsSync(p.backupDir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { /* missing */ }
  const pub = readText(p.sshKey + '.pub');
  let sshFp = null, hostFp = null;
  if (pub) { const r = await run('ssh-keygen', ['-l', '-f', p.sshKey + '.pub']); if (r.code === 0) sshFp = r.out.split(/\s+/)[1] || null; }
  const cfg = (await query('SELECT config FROM backup_config WHERE id=1')).rows[0]?.config || DEFAULT_CONFIG;
  if (cfg.ssh?.target && fs.existsSync(p.knownHosts)) {
    const host = cfg.ssh.target.split('@')[1].split(':')[0];
    const r = await run('ssh-keygen', ['-l', '-F', cfg.ssh.port === 22 ? host : `[${host}]:${cfg.ssh.port}`, '-f', p.knownHosts]);
    if (r.code === 0) hostFp = r.out.split('\n').filter(l => l && !l.startsWith('#')).map(l => { const f = l.trim().split(/\s+/); return `${f[1]} (${f[f.length - 1]})`; }).join(' ');
  }
  const dir = cfg.ssh?.target?.split(':')[1];
  const data = {
    generated_at: new Date().toISOString(), hostname: hostname(), ips: ips(), backup_dir: p.backupDir, disk, local, destinations: dests,
    next_backup: await nextRun(p, 'ets-backup.timer'), next_verify: await nextRun(p, 'ets-backup-verify.timer'),
    ssh: pub ? { public_key: pub.trim(), fingerprint: sshFp, authorized_keys_line: `restrict,command="rrsync ${dir && dir.startsWith('/') ? dir.replace(/\/$/, '') : '/srv/backups/ets'}" ${pub.trim()}`,
      host_fingerprint: hostFp } : null,
    key_id: (readText(p.backupKey + '.id') || '').trim() || null,
    rclone: fs.existsSync(p.rcloneConf),
  };
  await query(`INSERT INTO backup_status(id, data, agent_seen_at) VALUES (1, $1, now())
    ON CONFLICT (id) DO UPDATE SET data=$1, agent_seen_at=now(), updated_at=now()`, [JSON.stringify(data)]);
  return data;
}

// ---------------------------------------------------------------- jobs
async function setJob(id, fields) {
  const keys = Object.keys(fields);
  await query(`UPDATE backup_jobs SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`,
    [id, ...keys.map(k => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]))]).catch(() => {});
}
// progress of a job: written to its row at most once a second
export function progressWriter(id, tracker) {
  let last = 0;
  return (force = false) => {
    const now = Date.now();
    if (!force && now - last < 1000) return;
    last = now;
    setJob(id, { progress: tracker.snapshot(now) });
  };
}
const RESULT = out => { const m = /^RESULT (\{.*\})$/m.exec(out); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };

const HANDLERS = {
  async backup_now(job, p) {
    const t = new Tracker({ kind: 'backup', sizes: { db_bytes: job.params.db_bytes || 0 } });
    const w = progressWriter(job.id, t);
    t.begin('dump'); w(true);
    const iv = setInterval(() => { t.advance(t.current, Math.min(0.95, (t.phase(t.current)?.frac || 0) + 0.02)); w(); }, 1000);
    let dests = 0, seen = 0;
    const r = await run(p.backupCmd, [], { env: { ETS_BACKUP_LOCK_WAIT: '600' }, onLine: line => {
      if (/^configuration (bundle|unchanged)/.test(line)) { t.done('dump'); t.done('bundle'); t.begin('logs'); }
      else if (/^logs bundle/.test(line)) t.done('logs');
      else if (/^retention:/.test(line)) t.done('retention');
      else if (/ backup ok: /.test(line)) { t.begin('offsite'); dests = +(job.params.dests || 0); }
      else if (/ offsite \w+ /.test(line)) { seen++; if (dests) t.advance('offsite', seen / dests); }
      w();
    } });
    clearInterval(iv);
    t.finish(r.code === 0 ? 'done' : 'failed'); w(true);
    return { ok: r.code === 0, log: r.out, result: { exit: r.code, file: (/backup ok: (\S+)/.exec(r.out) || [])[1] || null } };
  },
  async verify_now(job, p) {
    const t = new Tracker({ kind: 'verify', sizes: job.params.sizes || {} });
    const w = progressWriter(job.id, t);
    const out = path.join(p.run, `verify-${job.id}.json`);
    fs.mkdirSync(p.run, { recursive: true, mode: 0o700 });
    t.begin('checksum'); w(true);
    const steps = [[/^checksum|^no checksum/, 'checksum', 'decrypt'], [/^decrypted/, 'decrypt', 'createdb'], [/^temporary database/, 'createdb', 'restore_data'],
      [/^restored into/, 'restore_index', 'migrate'], [/^(schema up to date|migrations applied)/, 'migrate', 'verify'], [/^audit chains|^FAILED: audit/, 'verify', 'counts'], [/^counts:/, 'counts', 'drop']];
    const r = await run(p.verifyCmd, ['--json', out], { onLine: line => {
      for (const [re, done, next] of steps) if (re.test(line)) { t.done(done); t.begin(next); }
      w();
    } });
    const res = readJsonFile(out); fs.rmSync(out, { force: true });
    t.finish(r.code === 0 ? 'done' : 'failed'); w(true);
    return { ok: r.code === 0, log: r.out, result: res || { exit: r.code } };
  },
  async test_destination(job, p) {
    const r = await run(p.backupCmd, ['--test', job.params.dest], { timeoutMs: 5 * 60_000 });
    const res = RESULT(r.out) || { ok: false, error: 'no result' };
    return { ok: r.code === 0 && res.ok, log: r.out.replace(/^RESULT .*$/m, ''), result: res };
  },
  async generate_ssh_key(job, p) {
    const r = await run(p.backupCmd, ['--ssh-key', ...(job.params.rotate ? ['--rotate'] : [])]);
    const res = RESULT(r.out) || { ok: false };
    return { ok: r.code === 0 && res.ok, log: r.out.replace(/^RESULT .*$/m, ''), result: res };
  },
  // a new backup passphrase / key: new backups use it; older backups still need the old key (kept in escrow)
  async set_passphrase(job, p) {
    const secret = takeSecret(p, job.params.token, job.params.ck);
    await setJob(job.id, { params: { ...job.params, ck: null, token: null } });
    const problem = passphraseProblem(secret);
    if (problem) return { ok: false, result: { error: 'weak_passphrase', reason: problem } };
    const oldId = (readText(p.backupKey + '.id') || '').trim() || (fs.existsSync(p.backupKey) ? keyId(fs.readFileSync(p.backupKey, 'utf8')) : null);
    if (fs.existsSync(p.backupKey)) {
      // the previous key stays on the server (root only) so the local backups it encrypted can still be restored
      const keep = `${p.backupKey}.${oldId || 'old'}.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
      fs.copyFileSync(p.backupKey, keep); fs.chmodSync(keep, 0o600);
    }
    writeAllowed(p, p.backupKey, secret + '\n', 0o600);
    const id = keyId(secret);
    writeAllowed(p, p.backupKey + '.id', id + '\n', 0o600);
    await query('UPDATE backup_config SET key_id=$1, key_changed_at=now(), escrow_confirmed_at=NULL, escrow_confirmed_by=NULL WHERE id=1', [id]);
    return { ok: true, result: { key_id: id, previous_key_id: oldId } };
  },
  restore_inspect: (job, p) => restoreInspect(job, p, { setJob }),
  restore_run: (job, p) => restoreRun(job, p, { setJob }),
};

export async function runJob(job, p = agentPaths()) {
  if (!JOB_KINDS.includes(job.kind) || !HANDLERS[job.kind]) {
    await setJob(job.id, { status: 'failed', finished_at: new Date(), result: { error: 'unknown_job_kind' } });
    return;
  }
  say(`job ${job.id} ${job.kind} started`);
  let r;
  try { r = await HANDLERS[job.kind](job, p); } catch (e) { r = { ok: false, result: { error: String(e.message || e).slice(0, 300) } }; }
  if (r.detached) return;      // restore_run: the row is written by the restore itself (the database was replaced)
  await setJob(job.id, { status: r.ok ? 'ok' : 'failed', finished_at: new Date(), result: r.result || null,
    log: r.log ? String(r.log).slice(-20000) : null });
  say(`job ${job.id} ${job.kind} ${r.ok ? 'ok' : 'FAILED'}`);
}

// One cycle. → { ran: n } or { skipped }
export async function cycle({ p = agentPaths(), maxJobs = 20, reload = true } = {}) {
  const c = await pool.connect();
  let locked = false, released = false;
  try {
    locked = (await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!locked) return { skipped: 'locked' };
    // tables of 1.12.0 missing (database restored from an older version and not migrated yet): nothing to do
    if (!(await c.query(`SELECT to_regclass('public.backup_jobs') IS NOT NULL AS ok`)).rows[0].ok) return { skipped: 'no_tables' };
    await importOnce(p);
    const applied = await applyConfig(p, { reload });
    // single-use secrets and restore keys never live longer than 15 minutes
    sweep(p.inbox, 15 * 60_000, n => n.endsWith('.sec'));
    sweep(p.run, 15 * 60_000);
    sweep(p.upload, 24 * 3600_000);
    sweep(p.staging, 24 * 3600_000);
    // a job left "running" by an agent that stopped (the lock is ours now): failed
    await c.query(`UPDATE backup_jobs SET status='failed', finished_at=now(), result=jsonb_build_object('error','interrupted')
      WHERE status='running'`);
    let ran = 0;
    for (; ran < maxJobs; ran++) {
      const job = (await c.query(`UPDATE backup_jobs SET status='running', started_at=now()
        WHERE id = (SELECT id FROM backup_jobs WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows[0];
      if (!job) break;
      if (job.kind === 'restore_run') {
        // the restore replaces the database this connection is on: release it first
        await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]); locked = false;
        c.release(); released = true;
        await runJob(job, p);
        ran++;
        break;
      }
      await runJob(job, p);
    }
    await refreshStatus(p).catch(e => say('status not written:', e.message));
    return { ran, applied };
  } finally {
    if (!released) {
      if (locked) await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
      c.release();
    }
  }
}

export { writeAtomic };

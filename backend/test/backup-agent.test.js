// End-to-end test of the root backup agent (1.12.0) with the real scripts (ets-backup, ets-backup-verify), gpg,
// pg_dump / pg_restore and a SCRATCH database (ets_agent_e2e, created and dropped here — never the shared test
// database): configuration rendering and refusal of an injected configuration, jobs (backup, verify, destination test,
// SSH key), restore inspection with a wrong key (nothing changed), a full restore (database + APP_SECRET, verify-audit),
// a database-only and a certificate-only restore (the API is not stopped for certificates), a failure after the data
// was replaced with the automatic rollback, and the progress file going monotonically to 100 %.
//
//   ETS_AGENT_E2E=1 TEST_DATABASE_URL=postgres://ets:…@127.0.0.1:56452/ets_test node --test test/backup-agent.test.js
// Needs: gpg, pg_dump / pg_restore / psql, ssh-keygen, rsync, openssl; the database role must be able to create databases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
const skip = (!url || process.env.ETS_AGENT_E2E !== '1') && 'set ETS_AGENT_E2E=1 and TEST_DATABASE_URL';
const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'ets-agent-e2e-'));
const DB = 'ets_agent_e2e';
let agent, cfgmod, util, pool, query, server, sysLog;
const e = {};

function sh(cmd, args, opts = {}) { return execFileSync(cmd, args, { encoding: 'utf8', ...opts }); }
const u = url ? new URL(url) : null;
const psql = (db, sql) => sh('psql', ['-X', '-qtA', '-h', u.hostname, '-p', u.port, '-U', decodeURIComponent(u.username), '-d', db, '-c', sql],
  { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) } }).trim();

before(async () => {
  if (skip) return;
  for (const d of ['etc/ets', 'backups', 'log/ets', 'varlog', 'ssl', 'state/inbox', 'state/upload', 'state/restore', 'run', 'systemd', 'bin', 'nginx/sites-available', 'nginx/snippets'])
    fs.mkdirSync(path.join(R, d), { recursive: true });
  psql('postgres', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  psql('postgres', `CREATE DATABASE ${DB}`);
  psql(DB, 'CREATE EXTENSION IF NOT EXISTS citext');
  // a scratch "server": certificate, ets.env, install.conf, backup key; fake systemctl / nginx that only log
  sh('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '400', '-subj', '/CN=10.0.0.15', '-addext', 'subjectAltName=IP:10.0.0.15',
    '-keyout', path.join(R, 'ssl/ets.key'), '-out', path.join(R, 'ssl/ets.crt')], { stdio: 'ignore' });
  e.secret = crypto.randomBytes(48).toString('base64');
  e.envText = `NODE_ENV=production\nPORT=3999\nAPP_SECRET='${e.secret}'\nPGHOST=${u.hostname}\nPGPORT=${u.port}\nPGDATABASE=${DB}\nPGUSER=${decodeURIComponent(u.username)}\n` +
    `PGPASSWORD='${decodeURIComponent(u.password)}'\nLOG_DIR=${R}/log/ets\nETS_BACKUP_DIR=${R}/backups\nETS_BACKUP_KEY=${R}/etc/ets/backup.key\nPUBLIC_BASE_URL=https://10.0.0.15\nTLS_CERT_SHA256=x\n`;
  fs.writeFileSync(path.join(R, 'etc/ets/ets.env'), e.envText, { mode: 0o640 });
  fs.writeFileSync(path.join(R, 'etc/ets/install.conf'), `DEF_ADDRESS='10.0.0.15'\nDEF_TLS='existing'\nDEF_CERT='${R}/ssl/ets.crt'\nDEF_KEY='${R}/ssl/ets.key'\nDEF_DB_MODE='local'\n`);
  e.key = crypto.randomBytes(48).toString('base64');
  fs.writeFileSync(path.join(R, 'etc/ets/backup.key'), e.key + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(R, 'log/ets/app.log'), 'an application log line\n');
  sysLog = path.join(R, 'systemctl.log');
  fs.writeFileSync(path.join(R, 'bin/systemctl'), `#!/bin/sh\necho "$*" >> ${sysLog}\ncase "$1" in show) echo "Thu 2026-10-22 07:07:00 UTC" ;; esac\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(R, 'bin/nginx'), `#!/bin/sh\necho "nginx $*" >> ${sysLog}\nexit 0\n`, { mode: 0o755 });
  // the "API": answers the health check
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); }).listen(0);
  Object.assign(process.env, {
    ETS_ENV_FILE: path.join(R, 'etc/ets/ets.env'), ETS_CONF_DIR: path.join(R, 'etc/ets'), ETS_STATE_DIR: path.join(R, 'state'), ETS_RUN_DIR: path.join(R, 'run'),
    ETS_SYSTEMD_DIR: path.join(R, 'systemd'), ETS_SYSTEMCTL: path.join(R, 'bin/systemctl'), ETS_NGINX_CMD: path.join(R, 'bin/nginx'),
    ETS_BACKUP_CMD: path.join(REPO, 'deploy/scripts/backup.sh'), ETS_VERIFY_CMD: path.join(REPO, 'deploy/scripts/backup-verify.sh'),
    ETS_LOG_PROTECT_CMD: '/bin/false', ETS_APP_DIR: REPO, ETS_RUN_AS: 'root', ETS_BACKUP_DIR: path.join(R, 'backups'), ETS_LOG_DIR: path.join(R, 'log/ets'),
    ETS_SYSLOG_DIR: path.join(R, 'varlog'), ETS_NGINX_DIR: path.join(R, 'nginx'), ETS_BACKUP_LOCK: path.join(R, 'backup.lock'), ETS_SERVICE: 'ets-test',
    ETS_HEALTH_URL: `http://127.0.0.1:${server.address().port}/api/health`, ETS_VERIFY_DB: 'ets_agent_e2e_check', ETS_INSPECT_DB: 'ets_agent_e2e_check',
    ETS_TLS_CERT: path.join(R, 'ssl/ets.crt'), ETS_TLS_KEY: path.join(R, 'ssl/ets.key'),
    NODE_ENV: 'test', LOG_LEVEL: 'warn', LOG_DIR: path.join(R, 'log/ets'),
  });
  ({ pool, query } = await import('../src/db/pool.js'));
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  agent = await import('../src/backup/agent.js');
  cfgmod = await import('../src/backup/config.js');
  util = await import('../src/backup/agent-util.js');
  await query(`INSERT INTO settings(key, value) VALUES ('system.app_secret_fp', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [JSON.stringify(cfgmod.appSecretFp(e.secret))]);
  e.admin = (await query(`INSERT INTO users(username, full_name, password_hash, role_id, must_change_password) VALUES ('root','Root','x','admin',false) RETURNING id`)).rows[0].id;
});

after(async () => {
  if (skip) return;
  await pool.end();
  server.close();
  if (!process.env.ETS_AGENT_E2E_KEEP) { try { psql('postgres', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); psql('postgres', 'DROP DATABASE IF EXISTS ets_agent_e2e_check WITH (FORCE)'); } catch { /* left for inspection */ } }
  if (!process.env.ETS_AGENT_E2E_KEEP) fs.rmSync(R, { recursive: true, force: true });
});

const job = async (kind, params = {}) => (await query(`INSERT INTO backup_jobs(kind, params, requested_by) VALUES ($1,$2,$3) RETURNING id`, [kind, JSON.stringify(params), e.admin])).rows[0].id;
const jobRow = async id => (await query('SELECT * FROM backup_jobs WHERE id=$1', [id])).rows[0];
function secretParams(secret) {
  const { ck, blob } = util.sealSecret(secret);
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(path.join(R, 'state/inbox', token + '.sec'), blob, { mode: 0o600 });
  return { token, ck };
}
const list = () => fs.readdirSync(path.join(R, 'backups'));
const latest = kind => list().filter(n => cfgmod.parseArtifact(n)?.kind === kind && !/\.(sha256|meta)$/.test(n)).sort().at(-1);
const marker = async v => { if (v === undefined) return (await query(`SELECT value FROM settings WHERE key='e2e.marker'`)).rows[0]?.value ?? null;
  await query(`INSERT INTO settings(key, value) VALUES ('e2e.marker', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [JSON.stringify(v)]); };
// run a restore job while sampling the progress file
async function runRestore(inspectId, items) {
  const id = await job('restore_run', { inspect_id: inspectId, items, actor: { id: e.admin, username: 'root' } });
  const samples = [];
  const f = path.join(R, 'state/restore/status.json');
  const iv = setInterval(() => { const s = util.readJsonFile(f); if (s && s.id === id) samples.push(s); }, 200);
  await agent.cycle();
  clearInterval(iv);
  const final = util.readJsonFile(f);
  samples.push(final);
  return { id, final, samples };
}
async function inspect(items, files, key = e.key) {
  const id = await job('restore_inspect', { ...secretParams(key), source: 'local', ...files, items });
  await agent.cycle();
  return jobRow(id);
}

test('configuration: imported once, rendered, timers written; an injected configuration is refused and nothing is written', { skip }, async () => {
  const r = await agent.cycle();
  assert.equal(r.applied.applied, true);
  const conf = fs.readFileSync(path.join(R, 'etc/ets/backup.conf'), 'utf8');
  assert.match(conf, /^BACKUP_KEEP_HOURLY=48$/m);
  assert.equal(fs.statSync(path.join(R, 'etc/ets/backup.conf')).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(R, 'systemd/ets-backup.timer.d/schedule.conf'), 'utf8'), /OnCalendar=\*-\*-\* \*:07:00/);
  // someone with database access writes a malicious configuration: the agent refuses it
  const evil = { ...cfgmod.DEFAULT_CONFIG, ssh: { enabled: true, target: "x@h:/p'\nBACKUP_NAS_DIR=/etc", port: 22, prune: true } };
  await query(`UPDATE backup_config SET config=$1, version=version+1`, [JSON.stringify(evil)]);
  const before = fs.readFileSync(path.join(R, 'etc/ets/backup.conf'), 'utf8');
  await agent.cycle();
  assert.equal(fs.readFileSync(path.join(R, 'etc/ets/backup.conf'), 'utf8'), before);
  assert.match((await query('SELECT apply_error FROM backup_status')).rows[0].apply_error, /invalid ssh/);
  await query(`UPDATE backup_config SET config=$1, version=version+1`, [JSON.stringify({ ...cfgmod.DEFAULT_CONFIG, frequency_hours: 6 })]);
  await agent.cycle();
  assert.equal((await query('SELECT apply_error FROM backup_status')).rows[0].apply_error, null);
  assert.match(fs.readFileSync(path.join(R, 'systemd/ets-backup.timer.d/schedule.conf'), 'utf8'), /00\/6:07:00/);
  assert.match(fs.readFileSync(sysLog, 'utf8'), /daemon-reload/);
});

test('jobs: backup now (with progress), verify now, NAS test refused when not mounted, SSH key', { skip }, async () => {
  const b = await job('backup_now', { db_bytes: 1e6 });
  await agent.cycle();
  const br = await jobRow(b);
  assert.equal(br.status, 'ok', br.log);
  assert.equal(br.progress.percent, 100);
  assert.ok(latest('dump') && latest('config') && latest('logs'));
  const st = (await query('SELECT data FROM backup_status')).rows[0].data;
  assert.ok(st.local.some(f => f.kind === 'dump' && f.meta?.key_id && f.sha256));
  const v = await job('verify_now');
  await agent.cycle();
  const vr = await jobRow(v);
  assert.equal(vr.status, 'ok', vr.log);
  assert.equal(vr.result.ok, true); assert.equal(vr.result.audit_ok, true);
  assert.equal((await query(`SELECT count(*)::int AS n FROM system_log WHERE event='backup_verify'`)).rows[0].n, 1);
  // NAS: /mnt/ets-e2e-not-mounted is not a mount point → refused, nothing written to the root disk
  await query(`UPDATE backup_config SET config=$1, version=version+1`, [JSON.stringify({ ...cfgmod.DEFAULT_CONFIG, nas: { enabled: true, dir: '/mnt/ets-e2e-not-mounted', prune: true } })]);
  const t = await job('test_destination', { dest: 'nas' });
  await agent.cycle();
  const tr = await jobRow(t);
  assert.equal(tr.status, 'failed'); assert.match(tr.result.error, /not a mounted file system/);
  assert.equal(fs.existsSync('/mnt/ets-e2e-not-mounted'), false);
  const k = await job('generate_ssh_key');
  await agent.cycle();
  const kr = await jobRow(k);
  assert.equal(kr.status, 'ok', kr.log);
  assert.match(kr.result.public_key, /^ssh-ed25519 /);
  assert.match(kr.result.authorized_keys_line, /^restrict,command="rrsync \/srv\/backups\/ets" ssh-ed25519 /);
  assert.equal(fs.statSync(path.join(R, 'etc/ets/backup_ssh_key')).mode & 0o777, 0o600);
  await query(`UPDATE backup_config SET config=$1, version=version+1`, [JSON.stringify(cfgmod.DEFAULT_CONFIG)]);
  await agent.cycle();
});

test('restore: a wrong key is refused at the inspection, nothing is changed, the key file is gone', { skip }, async () => {
  await marker('before-wrong-key');
  const r = await inspect(['db'], { dump: latest('dump') }, 'not-the-right-key-' + 'x'.repeat(30));
  assert.equal(r.status, 'failed'); assert.equal(r.result.error, 'wrong_key');
  assert.equal(await marker(), 'before-wrong-key');
  assert.deepEqual(fs.readdirSync(path.join(R, 'run')).filter(f => f.endsWith('.key')), []);
  assert.deepEqual(fs.readdirSync(path.join(R, 'state/inbox')).filter(f => f.endsWith('.sec')), [], 'the single-use secret is deleted');
  assert.equal(r.params.ck, null, 'the channel key is wiped from the row');
});

test('restore: database + APP_SECRET with the right key — inspected, restored, migrated, verified, sessions ended, audited', { skip }, async () => {
  await marker('at-backup-time');
  const b = await job('backup_now'); await agent.cycle(); assert.equal((await jobRow(b)).status, 'ok');
  const dump = latest('dump'), conf = latest('config');
  await marker('changed-after-backup');
  // the current server got another APP_SECRET since: the restore brings back the one of the backup
  fs.writeFileSync(path.join(R, 'etc/ets/ets.env'), e.envText.replace(e.secret, 'N'.repeat(64)), { mode: 0o640 });
  await query(`INSERT INTO sessions(id, user_id, expires_at) VALUES ('s-e2e', $1, now() + interval '1 hour')`, [e.admin]).catch(() => {});
  const ins = await inspect(['db', 'env'], { dump, config: conf });
  assert.equal(ins.status, 'ok', JSON.stringify(ins.result));
  assert.equal(ins.result.dump.audit_ok, true);
  assert.ok(ins.result.dump.tables.length > 10);
  assert.equal(ins.result.config.items.includes('env'), true);
  assert.equal(ins.result.dump.newer_than_app, false);
  assert.ok(ins.result.sizes.data_bytes > 0);
  fs.writeFileSync(sysLog, '');
  const { final, samples } = await runRestore(ins.id, ['db', 'env']);
  assert.equal(final.state, 'done', JSON.stringify(final));
  assert.equal(final.percent, 100);
  assert.equal(final.audit, 'ok');
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i].percent >= samples[i - 1].percent, 'monotonic: ' + samples.map(s => s.percent));
  assert.ok(samples.length >= 3, 'progress written while running');
  assert.ok(final.counters.tables.total > 10 && final.counters.tables.done === final.counters.tables.total);
  assert.equal(await marker(), 'at-backup-time');
  assert.match(fs.readFileSync(path.join(R, 'etc/ets/ets.env'), 'utf8'), new RegExp(`APP_SECRET='${e.secret.replace(/[+/]/g, c => '\\' + c)}'`));
  assert.ok(fs.readFileSync(path.join(R, 'etc/ets/ets.env'), 'utf8').includes(`PGDATABASE=${DB}`), 'the server keeps its own database connection');
  const calls = fs.readFileSync(sysLog, 'utf8');
  assert.match(calls, /stop ets-test/); assert.match(calls, /start ets-test/);
  assert.equal((await query(`SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL`)).rows[0].n, 0, 'every session ended');
  const au = (await query(`SELECT username, new_value FROM audit_log WHERE action='restore' ORDER BY chain_seq DESC LIMIT 1`)).rows[0];
  assert.equal(au.username, 'root'); assert.deepEqual(au.new_value.items, ['db', 'env']); assert.equal(au.new_value.verify, 'ok');
  assert.equal((await query(`SELECT detail->>'state' AS s FROM system_log WHERE event='restore' ORDER BY id DESC LIMIT 1`)).rows[0].s, 'done');
  assert.ok(fs.readdirSync(path.join(R, 'backups')).some(n => n.startsWith('pre-restore-')), 'copy of the replaced files kept');
  assert.equal(fs.existsSync(path.join(R, 'state/restore/active')), false);
  assert.deepEqual(fs.readdirSync(path.join(R, 'run')).filter(f => f.endsWith('.key')), [], 'the key is deleted after the run');
});

test('restore: database only, then a failure after the data was replaced → automatic rollback to the safety backup', { skip }, async () => {
  await marker('backup-2');
  await job('backup_now'); await agent.cycle();
  const dump = latest('dump');
  await marker('current-data');
  const envBefore = fs.readFileSync(path.join(R, 'etc/ets/ets.env'), 'utf8');
  let ins = await inspect(['db'], { dump });
  assert.equal(ins.status, 'ok');
  let r = await runRestore(ins.id, ['db']);
  assert.equal(r.final.state, 'done', JSON.stringify({ error: r.final.error, rollback: r.final.rollback }));
  assert.equal(await marker(), 'backup-2');
  assert.equal(fs.readFileSync(path.join(R, 'etc/ets/ets.env'), 'utf8'), envBefore, 'ets.env untouched when not selected');
  // now a version whose migration fails: the restore replaces the data, the migration fails, the rollback puts back the safety backup
  await marker('must-survive');
  ins = await inspect(['db'], { dump });
  assert.equal(ins.status, 'ok');
  const bad = path.join(R, 'badapp');
  fs.mkdirSync(path.join(bad, 'backend'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'deploy'), path.join(bad, 'deploy'));
  for (const x of ['src', 'scripts', 'package.json', 'node_modules']) fs.symlinkSync(path.join(REPO, 'backend', x), path.join(bad, 'backend', x));
  fs.rmSync(path.join(bad, 'backend', 'src')); fs.cpSync(path.join(REPO, 'backend', 'src'), path.join(bad, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'backend/src/db/migrations/099_fail.sql'), 'SELECT 1/0;\n');
  process.env.ETS_APP_DIR = bad;
  try {
    r = await runRestore(ins.id, ['db']);
  } finally { process.env.ETS_APP_DIR = REPO; }
  assert.equal(r.final.state, 'rolled_back', JSON.stringify(r.final));
  assert.match(r.final.error, /migrations failed/);
  assert.equal(r.final.rollback.state, 'done');
  assert.ok(r.samples.some(s => s.state === 'rolling_back'), 'the rollback is shown');
  assert.equal(await marker(), 'must-survive', 'the data of before the restore is back');
  assert.equal((await query(`SELECT detail->>'state' AS s FROM system_log WHERE event='restore' ORDER BY id DESC LIMIT 1`)).rows[0].s, 'rolled_back');
  assert.match(fs.readFileSync(sysLog, 'utf8'), /start ets-test/);
});

test('restore: certificate only — no downtime (nginx reloaded, API not stopped), fingerprint updated; logs into restored-<date>', { skip }, async () => {
  await job('backup_now'); await agent.cycle();
  const conf = latest('config'), logs = latest('logs');
  const certBefore = fs.readFileSync(path.join(R, 'ssl/ets.crt'));
  // the certificate is replaced by another one meanwhile
  sh('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '10', '-subj', '/CN=other', '-keyout', path.join(R, 'ssl/ets.key'), '-out', path.join(R, 'ssl/ets.crt')], { stdio: 'ignore' });
  await marker('cert-test');
  const ins = await inspect(['tls', 'logs'], { config: conf, logs });
  assert.equal(ins.status, 'ok', JSON.stringify(ins.result));
  fs.writeFileSync(sysLog, '');
  const { final } = await runRestore(ins.id, ['tls', 'logs']);
  assert.equal(final.state, 'done', JSON.stringify(final));
  assert.deepEqual(fs.readFileSync(path.join(R, 'ssl/ets.crt')), certBefore);
  const calls = fs.readFileSync(sysLog, 'utf8');
  assert.doesNotMatch(calls, /stop ets-test/, 'the API is not stopped for a certificate');
  assert.match(calls, /nginx -t/); assert.match(calls, /reload nginx/);
  const fp = new crypto.X509Certificate(certBefore).fingerprint256.replace(/:/g, '').toLowerCase();
  assert.match(fs.readFileSync(path.join(R, 'etc/ets/ets.env'), 'utf8'), new RegExp(`^TLS_CERT_SHA256=${fp}$`, 'm'));
  assert.equal(await marker(), 'cert-test', 'the database is untouched');
  const restored = fs.readdirSync(path.join(R, 'log/ets')).find(n => n.startsWith('restored-'));
  assert.ok(restored, 'logs restored next to the current ones');
  assert.ok(fs.readFileSync(path.join(R, 'log/ets/app.log'), 'utf8').includes('an application log line'), 'current logs not overwritten');
  assert.equal(final.phases.find(p => p.key === 'stop').state, 'skipped');
});

// Backups (1.12.0): the configuration rules shared by the API and the root agent (strict validation, rendering, key
// ids, restore selection and warnings), the progress math and the pg_restore parser, and the API of Settings →
// «النسخ الاحتياطي»: permissions, re-authentication (password + 2FA), write-only secrets, the job queue and its limits,
// the restore inspection / run requests (the key never stored or logged, wrong-key lockout, confirmation phrase), the
// audit rows and the notifications S6 / S9 / S10 / S11.
// The API tests need TEST_DATABASE_URL like api.test.js (the public schema of that database is DROPPED and recreated).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/backup/config.js';
import { Tracker, planPhases, ewma, scriptLineEvent, restoreFraction, estimateSeconds, PLANS } from '../src/backup/progress.js';
import { sealSecret, openSecret, writeAllowed, agentPaths } from '../src/backup/agent-util.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ets-bk-state-'));
for (const d of ['inbox', 'upload', 'restore']) fs.mkdirSync(path.join(STATE, d), { recursive: true });
process.env.ETS_STATE_DIR = STATE;
process.env.ETS_CONF_DIR = path.join(STATE, 'etc');

// ================================================================= pure rules
test('config: defaults are valid; unknown keys, bad values and out-of-range retention are refused', () => {
  assert.ok(C.validateConfig({}).ok);
  assert.deepEqual(C.validateConfig({}).value, C.DEFAULT_CONFIG);
  const bad = (c, field) => { const r = C.validateConfig(c); assert.equal(r.ok, false, JSON.stringify(c)); if (field) assert.equal(r.field, field); };
  bad({ x: 1 }, 'config');
  bad({ frequency_hours: 3 }, 'frequency_hours');
  bad({ daily_time: '24:00' }, 'daily_time');
  bad({ logs_time: '1:00' }, 'logs_time');
  bad({ verify: { weekday: 7 } }, 'verify.weekday');
  bad({ retention: { hourly_hours: 0 } }, 'retention.hourly_hours');
  bad({ retention: { daily_days: 4000 } }, 'retention.daily_days');
  bad({ retention: { monthly_months: 12.5 } }, 'retention.monthly_months');
  bad({ ssh: { enabled: true, target: '' } }, 'ssh.target');
  bad({ cloud: { enabled: true, mode: 's3', bucket: '' } }, 'cloud.bucket');
  bad({ cloud: { enabled: true, mode: 's3', provider: 'Minio', bucket: 'ets-backups', endpoint: '' } }, 'cloud.endpoint');
  assert.ok(C.validateConfig({ frequency_hours: 6, retention: { hourly_hours: 24, daily_days: 60, weekly_weeks: 0, monthly_months: 0 } }).ok);
});

test('config: injection attempts in host, path, remote, endpoint and NAS directory are refused', () => {
  for (const t of ['ets@host:/srv;rm -rf /', 'ets@host:$(id)', 'ets@-oProxyCommand=x:/p', 'ets@host:/a/../etc', 'root@host:/p b', 'ets@host:-e',
    "ets@host:/p'", 'ets@ho`st:/p', 'ets@host', 'ets@host:/p\nBACKUP_NAS_DIR=/etc', '-e@host:/p']) {
    assert.equal(C.validSshTarget(t), false, t);
    assert.equal(C.validateConfig({ ssh: { enabled: true, target: t } }).ok, false, t);
  }
  assert.ok(C.validSshTarget('etsbackup@10.0.0.30:/srv/backups/ets'));
  for (const d of ['/', '/etc/ets', '/var/backups/ets', '/mnt', '/mnt/../etc', '/mnt/a b', '/mnt/$(id)', 'mnt/x', '/mnt/x/../../etc', "/mnt/x'", '/mnt/x\n']) {
    assert.equal(C.validateConfig({ nas: { enabled: true, dir: d } }).ok, false, d);
  }
  assert.ok(C.validateConfig({ nas: { enabled: true, dir: '/mnt/ets-backup' } }).ok);
  for (const r of ['x:b;ls', 'x:b/../c', ':b', 'x y:b', 'x:$(id)', '--config=/tmp/x:b']) assert.equal(C.validRemote(r), false, r);
  for (const e of ['http://s3.local', 'https://s3.local/;id', 'https://a b', 'file:///etc', 'https://x\n']) {
    assert.equal(C.validateConfig({ cloud: { enabled: true, mode: 's3', provider: 'Minio', bucket: 'ets-bk', endpoint: e } }).ok, false, e);
  }
  for (const b of ['A', 'Bucket', 'b;ls', 'b b', '-b']) assert.equal(C.validateConfig({ cloud: { bucket: b } }).ok, false, b);
  assert.equal(C.validSecret('cloud_secret_access_key', 'abc def ghij'), false);
  assert.equal(C.validSecret('cloud_secret_access_key', 'abcdefgh\nX=1'), false);
  assert.ok(C.validSecret('cloud_secret_access_key', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'));
});

test('config: rendering of backup.conf, rclone.conf and the timers', () => {
  const c = C.validateConfig({ frequency_hours: 4, ssh: { enabled: true, target: 'b@10.0.0.30:/srv/ets', port: 2222 },
    nas: { enabled: false, dir: '/mnt/nas' }, cloud: { enabled: true, mode: 's3', provider: 'Minio', endpoint: 'https://s3.lan:9000', bucket: 'ets-bk', path: 'srv1' } }).value;
  const t = C.renderBackupConf(c, { confDir: '/etc/ets', version: 7 });
  assert.match(t, /^BACKUP_SSH_TARGET='b@10.0.0.30:\/srv\/ets'$/m);
  assert.match(t, /^BACKUP_SSH_PORT=2222$/m);
  assert.match(t, /^BACKUP_NAS_DIR=''$/m);                         // disabled destination: empty
  assert.match(t, /^BACKUP_RCLONE_REMOTE='ets-cloud:ets-bk\/srv1'$/m);
  assert.match(t, /^BACKUP_FREQUENCY_HOURS=4$/m);
  const kv = C.parseKv(t);
  assert.equal(kv.BACKUP_KEEP_DAILY, '30');
  const rc = C.renderRcloneConf(c, { cloud_access_key_id: 'AKIAEXAMPLE1', cloud_secret_access_key: 'secret/Key+1234' });
  assert.match(rc, /^\[ets-cloud\]$/m); assert.match(rc, /^endpoint = https:\/\/s3.lan:9000$/m); assert.match(rc, /^secret_access_key = secret\/Key\+1234$/m);
  assert.throws(() => C.renderRcloneConf(c, { cloud_access_key_id: 'AKIAEXAMPLE1', cloud_secret_access_key: 'a b' }), /missing_or_invalid_secret/);
  assert.deepEqual(C.timerSchedule(c), { backup: '*-*-* 00/4:07:00', verify: 'Fri *-*-* 03:00:00' });
  assert.equal(C.timerSchedule(C.DEFAULT_CONFIG).backup, '*-*-* *:07:00');
  assert.equal(C.timerSchedule({ ...C.DEFAULT_CONFIG, frequency_hours: 24 }).backup, '*-*-* 01:30:00');
  // import of a 1.11.0 installation: ETS_BACKUP_KEEP_DAYS=60 kept as the daily tier; a hand-made rclone remote kept
  const imp = C.fromBackupConf({ BACKUP_SSH_TARGET: 'x@h:/p', BACKUP_RCLONE_REMOTE: 'wasabi:ets/x', BACKUP_NAS_DIR: '/etc' }, { keepDaysEnv: '60' });
  assert.equal(imp.retention.daily_days, 60); assert.equal(imp.ssh.enabled, true); assert.equal(imp.cloud.mode, 'rclone'); assert.equal(imp.nas.enabled, false);
});

test('agent: only the allow-listed files can be written', () => {
  const p = agentPaths({ ETS_CONF_DIR: path.join(STATE, 'etc'), ETS_SYSTEMD_DIR: path.join(STATE, 'systemd') });
  assert.throws(() => writeAllowed(p, '/etc/passwd', 'x'), /refused/);
  assert.throws(() => writeAllowed(p, path.join(STATE, 'etc', '..', 'evil'), 'x'), /refused/);
  assert.equal(writeAllowed(p, p.backupConf, 'BACKUP_KEEP_DAILY=30\n'), true);
  assert.equal(fs.statSync(p.backupConf).mode & 0o777, 0o600);
  assert.equal(writeAllowed(p, p.backupConf, 'BACKUP_KEEP_DAILY=30\n'), false);   // unchanged
});

test('keys: key id (scrypt) and APP_SECRET fingerprint are stable, short and not the secret; passphrase strength', () => {
  const k = 'Kx9fP2mQ8sLw4zVt7bN1cR6yH3jD5gA0eU2iO8pT1qW4rE6tY9uI0oP3aS5dF7gH';
  assert.match(C.keyId(k), /^[0-9a-f]{16}$/); assert.equal(C.keyId(k + '\n'), C.keyId(k)); assert.notEqual(C.keyId(k), C.keyId(k + 'x'));
  assert.match(C.appSecretFp('s'.repeat(48)), /^[0-9a-f]{16}$/);
  assert.equal(C.passphraseProblem('short'), 'too_short');
  assert.equal(C.passphraseProblem('aaaaaaaaaaaaaaaaaaaa'), 'too_weak');
  assert.equal(C.passphraseProblem('my backup password 2026!'), 'too_common');
  assert.equal(C.passphraseProblem('Correct-Horse-7-Battery'), null);
  assert.equal(C.passphraseProblem(k), null);                                        // a pasted installer key
  assert.equal(C.passphraseProblem(' Correct-Horse-7-Battery'), 'invalid_characters');
  assert.equal(C.restoreKeyProblem(''), 'required');
  assert.equal(C.restoreKeyProblem('a\nb'), 'invalid');
});

test('restore selection: nearest configuration bundle, unavailable items with reasons, dependency warnings', () => {
  const names = ['ets-20261020-010700.dump.gpg', 'ets-20261022-090700.dump.gpg', 'ets-config-20261001-000000.tar.gpg',
    'ets-config-20261021-120000.tar.gpg', 'ets-logs-20261021.tar.gpg'];
  assert.equal(C.configFor('ets-20261020-010700.dump.gpg', names), 'ets-config-20261001-000000.tar.gpg');
  assert.equal(C.configFor('ets-20261022-090700.dump.gpg', names), 'ets-config-20261021-120000.tar.gpg');
  assert.equal(C.configFor('ets-20260101-010700.dump.gpg', names), null);
  const point = { dump: 'ets-20261022-090700.dump.gpg', config: 'ets-config-20261021-120000.tar.gpg', logs: null };
  const metas = { [point.config]: { items: ['env', 'install_conf', 'tls'], hostname: 'old-srv', app_secret_fp: 'aaaa', tls_san: 'IPAddress:10.0.0.15' },
    [point.dump]: { hostname: 'old-srv', app_secret_fp: 'aaaa', app_version: '1.12.0' } };
  const av = C.availability(point, metas);
  assert.equal(av.db.available, true); assert.equal(av.env.available, true);
  assert.deepEqual(av.db_ca, { available: false, reason: 'not_in_bundle', from: point.config });
  assert.deepEqual(av.logs, { available: false, reason: 'no_logs' });
  assert.deepEqual(C.availability({ dump: point.dump, config: null, logs: null }, {}).env, { available: false, reason: 'no_config' });
  assert.equal(C.selectionProblem([], av), 'nothing_selected');
  assert.equal(C.selectionProblem(['db', 'db'], av), 'duplicate_item');
  assert.equal(C.selectionProblem(['db', 'logs'], av), 'unavailable:logs');
  assert.equal(C.selectionProblem(['db', 'evil'], av), 'unknown_item:evil');
  assert.equal(C.selectionProblem(['db', 'env'], av), null);
  const cur = { hostname: 'new-srv', ips: ['10.0.0.99'], app_secret_fp: 'bbbb', app_version: '1.12.0' };
  const codes = items => C.restoreWarnings(items, point, metas, cur).map(w => w.code).sort();
  assert.deepEqual(codes(['db']), ['db_without_env']);
  assert.deepEqual(codes(['db', 'env']), []);
  assert.deepEqual(codes(['env']), ['env_without_db']);
  assert.deepEqual(codes(['tls']), ['tls_san_mismatch']);
  assert.deepEqual(C.restoreWarnings(['tls'], point, metas, { ...cur, ips: ['10.0.0.15'] }), []);
  assert.deepEqual(C.restoreWarnings(['db'], point, metas, { ...cur, app_secret_fp: 'aaaa' }), []);   // same APP_SECRET
  const newer = C.restoreWarnings(['db'], point, { [point.dump]: { app_version: '1.13.0' } }, cur);
  assert.equal(newer[0].code, 'newer_version'); assert.equal(newer[0].blocking, true);
  assert.ok(C.confirmPhraseOk('استرجاع', 'srv')); assert.ok(C.confirmPhraseOk(' srv ', 'srv')); assert.equal(C.confirmPhraseOk('yes', 'srv'), false);
});

test('progress: weights from the size model, monotonic percentage, EWMA ETA, counters', () => {
  const ph = planPhases(PLANS.restore, { bytes: 1e9, db_bytes: 5e9, data_bytes: 4e9, rows: 3e7 });
  assert.ok(Math.abs(ph.reduce((a, p) => a + p.weight, 0) - 1) < 1e-9);
  const big = ph.find(p => p.key === 'restore_data').weight, small = ph.find(p => p.key === 'stop').weight;
  assert.ok(big > 10 * small, 'big tables weigh more than a fixed step');
  assert.equal(estimateSeconds('decrypt', { bytes: 120e6 }), 1.5);
  assert.equal(ewma(null, 5, 1), 5);
  assert.ok(Math.abs(ewma(10, 0, 10) - 10 * Math.exp(-1)) < 1e-9);
  let now = 1_000_000;
  const t = new Tracker({ kind: 'restore', sizes: { bytes: 1e6, db_bytes: 1e6, data_bytes: 1e6, rows: 1000 }, skip: ['fetch', 'logs'], now });
  const seen = [];
  const step = (fn, dt = 1000) => { now += dt; fn(); seen.push(t.snapshot(now).percent); };
  step(() => t.begin('checksum', now));
  step(() => t.advance('checksum', 0.5, now));
  step(() => t.advance('checksum', 0.2, now));            // a smaller fraction never moves the bar back
  step(() => t.done('checksum', now));
  for (const k of ['decrypt', 'safety', 'stop', 'restore_data']) { step(() => t.begin(k, now)); step(() => t.done(k, now)); }
  const e = t.eta(now);
  assert.equal(e.estimated, false); assert.ok(e.seconds > 0);
  t.count('rows', 400, 1000); t.count('rows', 300); assert.deepEqual(t.counters.rows, { done: 400, total: 1000 });
  t.count('bytes', 5e6, 1e6); assert.equal(t.counters.bytes.done, 1e6);    // capped at the total
  step(() => t.finish('done', now));
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `monotonic ${seen}`);
  assert.equal(seen.at(-1), 100);
  assert.equal(t.snapshot(now).phases.find(p => p.key === 'fetch').state, 'skipped');
  // before the first measurement the ETA comes from the model and is marked as an estimate
  const t2 = new Tracker({ kind: 'restore', sizes: { bytes: 120e6 }, now: 0 });
  t2.begin('fetch', 0);
  assert.equal(t2.eta(10).estimated, true);
});

test('progress: parser of the SQL pg_restore writes (captured sample) and the per-table fraction', () => {
  // captured from `pg_restore --no-owner --no-acl --file=- <dump>` of a test database (shortened)
  const sample = `--
-- PostgreSQL database dump
--
\\restrict 7ZqC1xQe
SET statement_timeout = 0;
CREATE TABLE public.users (
    id integer NOT NULL,
    username public.citext NOT NULL
);
COPY public.users (id, username, full_name, password_hash) FROM stdin;
1\tadmin1\tمدير النظام\t$2a$04$x
2\tsara\tSara\t$2a$04$y
\\.
COPY public.audit_log (id, ts, user_id, username, action) FROM stdin;
1\t2026-10-20 09:27:32+00\t1\tadmin1\tlogin
\\.
SELECT pg_catalog.setval('public.users_id_seq', 2, true);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX users_email_lower_uniq ON public.users USING btree (lower((email)::text));
CREATE TRIGGER ets_chain BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.ets_log_chain_insert();`.split('\n');
  let inCopy = false; const ev = [];
  for (const l of sample) { const e = scriptLineEvent(l, inCopy); if (e?.type === 'data') inCopy = true; else if (e?.type === 'end') inCopy = false; if (e) ev.push(e.type + (e.table ? ':' + e.table : '')); }
  assert.deepEqual(ev, ['data:users', 'row', 'row', 'end', 'data:audit_log', 'row', 'end', 'post', 'post', 'post']);
  assert.equal(scriptLineEvent('CREATE TABLE public.users (', false), null);
  assert.deepEqual(scriptLineEvent('COPY public."user presence" (a) FROM stdin;', false), { type: 'data', table: 'user' });   // quoted names stop at a space
  const tables = [{ table: 'users', rows: 10, bytes: 1000 }, { table: 'audit_log', rows: 90, bytes: 9000 }];
  const f = restoreFraction(tables, new Set(['users']), { table: 'audit_log', tuples: 45 });
  assert.ok(Math.abs(f.frac - 0.55) < 1e-9); assert.equal(f.rows, 55); assert.equal(f.rowsTotal, 100); assert.equal(f.tables, 1); assert.equal(f.tablesTotal, 2);
  assert.equal(restoreFraction(tables, new Set(['users', 'audit_log']), null).frac, 1);
});

test('secret channel: sealed with a one-time key, nothing readable without both halves', () => {
  const { ck, blob } = sealSecret('my-old-backup-key');
  assert.ok(!blob.includes('my-old-backup-key'));
  assert.equal(openSecret(blob, ck), 'my-old-backup-key');
  assert.throws(() => openSecret(blob, sealSecret('x').ck));
});

// ================================================================= API
let server, base, pool, ids = {}, scan, totp, cryptoSvc;
before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none', ETS_BACKUP_JOB_LIMIT: '10', ETS_RESTORE_LIMIT: '1000',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  for (const [u, role] of [['root', 'admin'], ['root2', 'admin'], ['pm1', 'pm'], ['twofa', 'admin']]) {
    ids[u] = (await pool.query(`INSERT INTO users(username, full_name, password_hash, role_id, must_change_password, language)
      VALUES ($1,$2,$3,$4,false,'ar') RETURNING id`, [u, 'User ' + u, h, role])).rows[0].id;
  }
  // a project manager with the cfg permission (an override) is still not an administrator
  await pool.query(`INSERT INTO user_permission_overrides(user_id, permission, granted) VALUES ($1,'cfg',true)`, [ids.pm1]).catch(() => {});
  scan = await import('../src/services/notify-scan.js');
  totp = await import('../src/services/totp.js');
  cryptoSvc = await import('../src/services/crypto.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (skip) return;
  server.closeAllConnections?.(); server.close();
  await new Promise(r => setTimeout(r, 200));
  await pool.end();
  fs.rmSync(STATE, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const raw = body instanceof Buffer;
    const res = await fetch(base + p, { method, headers: { 'x-requested-with': 'ets', 'content-type': raw ? 'application/octet-stream' : 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }) };
}
const as = async u => { const c = client(); assert.equal((await c.login(u)).status, 200, 'login ' + u); return c; };
const PW = { password: 'Passw0rd-123' };

test('permissions: administrators only (cfg + admin role); a cfg override does not open it', { skip }, async () => {
  assert.equal((await client().get('/backups')).status, 401);
  const pm = await as('pm1');
  assert.equal((await pm.get('/backups')).status, 403);
  assert.equal((await pm.post('/backups/jobs', { kind: 'backup_now' })).status, 403);
  assert.equal((await pm.post('/backups/restore/inspect', { ...PW, key: 'x', source: 'local', items: ['db'] })).status, 403);
  const root = await as('root');
  const g = await root.get('/backups');
  assert.equal(g.status, 200);
  assert.deepEqual(g.data.config, C.DEFAULT_CONFIG);
  assert.equal(g.data.escrow.due, true);
  assert.deepEqual(g.data.secrets, { cloud_access_key_id: false, cloud_secret_access_key: false });
});

test('configuration: validation, re-authentication for destinations, write-only secrets, readable audit', { skip }, async () => {
  const root = await as('root');
  const cfg = structuredClone(C.DEFAULT_CONFIG);
  // schedule / retention: no password needed
  let r = await root.put('/backups/config', { config: { ...cfg, frequency_hours: 2, retention: { ...cfg.retention, daily_days: 45 } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await root.put('/backups/config', { config: { ...cfg, retention: { ...cfg.retention, daily_days: 0 } } });
  assert.equal(r.status, 400); assert.equal(r.data.key, 'retention.daily_days');
  r = await root.put('/backups/config', { config: { ...cfg, ssh: { enabled: true, target: 'x@h:/a;id', port: 22, prune: true } }, ...PW });
  assert.equal(r.status, 400); assert.equal(r.data.key, 'ssh.target');
  // a destination: password again
  const withSsh = { ...cfg, frequency_hours: 2, retention: { ...cfg.retention, daily_days: 45 }, ssh: { enabled: true, target: 'etsbak@10.0.0.30:/srv/ets', port: 22, prune: true } };
  r = await root.put('/backups/config', { config: withSsh });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'wrong_password');
  r = await root.put('/backups/config', { config: withSsh, password: 'wrong-password-1' });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'wrong_password');
  r = await root.put('/backups/config', { config: withSsh, ...PW });
  assert.equal(r.status, 200);
  // cloud credentials: required for s3, stored encrypted, never returned
  const cloud = { ...withSsh, cloud: { ...cfg.cloud, enabled: true, mode: 's3', provider: 'Minio', endpoint: 'https://s3.lan:9000', bucket: 'ets-bk', path: 'srv1' } };
  r = await root.put('/backups/config', { config: cloud, ...PW });
  assert.equal(r.status, 400); assert.equal(r.data.reason, 'required');
  const SECRET = 'TopSecretKey/abc+123456';
  r = await root.put('/backups/config', { config: cloud, secrets: { cloud_access_key_id: 'AKIAEXAMPLE99', cloud_secret_access_key: SECRET }, ...PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const g = (await root.get('/backups')).data;
  assert.deepEqual(g.secrets, { cloud_access_key_id: true, cloud_secret_access_key: true });
  assert.ok(!JSON.stringify(g).includes(SECRET) && !JSON.stringify(g).includes('AKIAEXAMPLE99'));
  const row = (await pool.query('SELECT secrets FROM backup_config')).rows[0].secrets;
  assert.match(row.cloud_secret_access_key, /^v2:/);
  assert.equal(cryptoSvc.decrypt(row.cloud_secret_access_key, 'backup:cloud_secret_access_key'), SECRET);
  // an empty value keeps the saved secret (no password needed when nothing else changes)
  r = await root.put('/backups/config', { config: cloud, secrets: { cloud_secret_access_key: '' } });
  assert.equal(r.status, 200); assert.equal(r.data.unchanged, true);
  // the change history: old → new, secrets masked
  const au = (await pool.query(`SELECT old_value, new_value, context FROM audit_log WHERE entity='backup_config' AND action='update' ORDER BY chain_seq`)).rows;
  assert.ok(au.length >= 3);
  assert.deepEqual([au[0].old_value['retention.daily_days'], au[0].new_value['retention.daily_days']], [30, 45]);
  assert.equal(au.at(-1).new_value['cloud.cloud_secret_access_key'], '•••• (changed)');
  const all = JSON.stringify((await pool.query(`SELECT old_value, new_value, context, summary FROM audit_log`)).rows);
  assert.ok(!all.includes(SECRET) && !all.includes('AKIAEXAMPLE99'), 'no secret in the change history');
  // back to local only (password again: destinations change)
  assert.equal((await root.put('/backups/config', { config: cfg, secrets: { cloud_access_key_id: null, cloud_secret_access_key: null }, ...PW })).status, 200);
});

test('2FA: with two-step verification on, destinations and restore need a current code as well', { skip }, async () => {
  const c = await as('twofa');
  const secret = totp.generateSecret();
  await pool.query('UPDATE users SET totp_enabled=true, totp_secret=$2, totp_last_step=NULL WHERE id=$1', [ids.twofa, cryptoSvc.encrypt(secret)]);
  const cfg = { ...C.DEFAULT_CONFIG, nas: { enabled: true, dir: '/mnt/ets-backup', prune: true } };
  let r = await c.put('/backups/config', { config: cfg, ...PW });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'mfa_code_required');
  r = await c.put('/backups/config', { config: cfg, ...PW, code: '000000' });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'invalid_code');
  r = await c.put('/backups/config', { config: cfg, ...PW, code: totp.totp(secret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await c.post('/backups/restore/inspect', { ...PW, key: 'k'.repeat(64), source: 'local', items: ['logs'] });
  assert.equal(r.status, 400);     // nothing available locally (and no code): refused before anything is queued
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM backup_jobs WHERE kind='restore_inspect'`)).rows[0].n, 0);
  await pool.query('UPDATE users SET totp_enabled=false, totp_secret=NULL WHERE id=$1', [ids.twofa]);
  await (await as('root')).put('/backups/config', { config: C.DEFAULT_CONFIG, ...PW });
});

test('jobs: whitelisted kinds only, one open job per kind, rate limit, audit', { skip }, async () => {
  const root = await as('root2');
  assert.equal((await root.post('/backups/jobs', { kind: 'rm -rf' })).status, 400);
  assert.equal((await root.post('/backups/jobs', { kind: 'restore_run' })).status, 400);
  assert.equal((await root.post('/backups/jobs', { kind: 'test_destination', dest: 'ftp' })).status, 400);
  const a = await root.post('/backups/jobs', { kind: 'backup_now' });
  assert.equal(a.status, 202); assert.equal(a.data.job.status, 'queued');
  assert.equal((await root.post('/backups/jobs', { kind: 'backup_now' })).status, 409);       // already queued
  assert.equal((await root.post('/backups/jobs', { kind: 'test_destination', dest: 'nas' })).status, 202);
  assert.equal((await root.post('/backups/jobs', { kind: 'generate_ssh_key' })).status, 400);  // password needed
  assert.equal((await root.post('/backups/jobs', { kind: 'generate_ssh_key', ...PW })).status, 202);
  const j = await root.get('/backups/jobs/' + a.data.job.id);
  assert.equal(j.status, 200); assert.equal(j.data.job.kind, 'backup_now');
  assert.ok(fs.existsSync(path.join(STATE, 'inbox', '.wake')), 'the agent is woken up');
  const au = (await pool.query(`SELECT summary FROM audit_log WHERE action='backup_job' ORDER BY chain_seq`)).rows.map(x => x.summary);
  assert.deepEqual(au, ['backup_now', 'test_destination', 'generate_ssh_key']);
  // rate limit (10 requests per 10 minutes in this test)
  let last;
  for (let i = 0; i < 4 && last?.status !== 429; i++) last = await root.post('/backups/jobs', { kind: 'verify_now' });
  assert.equal(last.status, 429);
  await pool.query(`DELETE FROM backup_jobs`);
});

test('escrow: attested with a date, asked again after a year and after the key changes', { skip }, async () => {
  const root = await as('root');
  assert.equal((await root.post('/backups/escrow', {})).status, 400);
  assert.equal((await root.post('/backups/escrow', { confirmed: true })).status, 200);
  let e = (await root.get('/backups')).data.escrow;
  assert.equal(e.due, false); assert.equal(e.confirmed_by, ids.root);
  await pool.query(`UPDATE backup_config SET escrow_confirmed_at = now() - interval '366 days'`);
  assert.equal((await root.get('/backups')).data.escrow.due, true);
  await pool.query(`UPDATE backup_config SET escrow_confirmed_at = now() - interval '1 day', key_changed_at = now()`);
  e = (await root.get('/backups')).data.escrow;
  assert.equal(e.due, true);
});

test('passphrase: strength, password again, never stored, the escrow is asked again by the agent', { skip }, async () => {
  const root = await as('root');
  assert.equal((await root.post('/backups/passphrase', { passphrase: 'short', ...PW })).status, 400);
  assert.equal((await root.post('/backups/passphrase', { passphrase: 'Correct-Horse-7-Battery' })).status, 400);
  const r = await root.post('/backups/passphrase', { passphrase: 'Correct-Horse-7-Battery', ...PW });
  assert.equal(r.status, 202);
  const job = (await pool.query(`SELECT params FROM backup_jobs WHERE id=$1`, [r.data.job.id])).rows[0];
  assert.ok(job.params.ck && job.params.token);
  const f = path.join(STATE, 'inbox', job.params.token + '.sec');
  assert.ok(fs.existsSync(f)); assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(f, 'utf8').includes('Correct-Horse'));
  assert.equal(openSecret(fs.readFileSync(f, 'utf8'), job.params.ck), 'Correct-Horse-7-Battery');
  const everything = JSON.stringify([(await pool.query('SELECT * FROM backup_jobs')).rows, (await pool.query('SELECT * FROM audit_log')).rows,
    (await pool.query('SELECT * FROM system_log')).rows]);
  assert.ok(!everything.includes('Correct-Horse'), 'the passphrase is not in the database');
  assert.ok(!r.data.job.params.ck && !r.data.job.params.token, 'the API never returns the channel key');
  await pool.query(`DELETE FROM backup_jobs`); fs.rmSync(f);
});

// a fake inventory, as the agent writes it
async function inventory() {
  const meta = (kind, extra = {}) => ({ format: 1, kind, key_id: 'aaaaaaaaaaaaaaaa', hostname: 'old-server', app_secret_fp: 'ffffffffffffffff', app_version: '1.11.0', ...extra });
  const local = [
    { name: 'ets-20261022-090700.dump.gpg', kind: 'dump', ts: '20261022-090700', size: 1000, sha256: 'a'.repeat(64), meta: meta('dump') },
    { name: 'ets-20261021-090700.dump.gpg', kind: 'dump', ts: '20261021-090700', size: 1000, sha256: 'b'.repeat(64), meta: meta('dump') },
    { name: 'ets-config-20261021-120000.tar.gpg', kind: 'config', ts: '20261021-120000', size: 30, meta: meta('config', { items: ['env', 'install_conf', 'tls'], tls_san: 'IPAddress:10.9.9.9' }) },
    { name: 'ets-logs-20261021.tar.gpg', kind: 'logs', ts: '20261021-235959', size: 10, meta: meta('logs') },
  ];
  await pool.query(`INSERT INTO backup_status(id, data, agent_seen_at) VALUES (1,$1,now()) ON CONFLICT (id) DO UPDATE SET data=$1, agent_seen_at=now()`,
    [JSON.stringify({ local, destinations: { nas: local.map(f => f.name).slice(0, 2) } })]);
}

test('restore plan: available items with reasons, nearest bundle, dependency warnings, unknown files refused', { skip }, async () => {
  await inventory();
  const root = await as('root');
  let r = await root.post('/backups/restore/plan', { source: 'local', dump: 'ets-20261022-090700.dump.gpg', items: ['db'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.point.config, 'ets-config-20261021-120000.tar.gpg');
  assert.equal(r.data.available.db.available, true);
  assert.deepEqual(r.data.available.db_ca, { available: false, reason: 'not_in_bundle', from: 'ets-config-20261021-120000.tar.gpg' });
  assert.equal(r.data.available.logs.reason, 'no_logs');
  assert.deepEqual(r.data.warnings.map(w => w.code), ['db_without_env']);       // another server's APP_SECRET
  r = await root.post('/backups/restore/plan', { source: 'local', dump: 'ets-20261022-090700.dump.gpg', items: ['db', 'env', 'tls'] });
  assert.deepEqual(r.data.warnings.map(w => w.code), ['tls_san_mismatch']);
  r = await root.post('/backups/restore/plan', { source: 'local', dump: 'ets-20261021-090700.dump.gpg', items: ['db'] });
  assert.equal(r.data.point.config, null);                                       // no bundle at or before that time
  assert.equal(r.data.available.env.reason, 'no_config');
  r = await root.post('/backups/restore/plan', { source: 'local', dump: 'ets-20261021-090700.dump.gpg', logs: 'ets-logs-20261021.tar.gpg', items: ['db', 'logs'] });
  assert.equal(r.data.problem, null);
  r = await root.post('/backups/restore/plan', { source: 'local', dump: '../../etc/passwd', items: ['db'] });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'backup_file_not_found');
  r = await root.post('/backups/restore/plan', { source: 'nas', dump: 'ets-20261022-090700.dump.gpg', items: ['db', 'env'] });
  assert.equal(r.data.problem, 'unavailable:env');                               // the bundle is not on the NAS
  r = await root.post('/backups/restore/plan', { source: 'ftp', items: ['db'] });
  assert.equal(r.status, 400);
});

test('restore inspect: three factors, the key never stored or logged, wrong-key lockout, one at a time', { skip }, async () => {
  await inventory();
  const root = await as('root');
  const KEY = 'OLD-backup-key-' + 'Z9'.repeat(20);
  const body = { source: 'local', dump: 'ets-20261022-090700.dump.gpg', items: ['db', 'env'], key: KEY };
  let r = await root.post('/backups/restore/inspect', { ...body });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'wrong_password');
  r = await root.post('/backups/restore/inspect', { ...body, ...PW, key: '' });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'backup_key_required');
  r = await root.post('/backups/restore/inspect', { ...body, ...PW, items: ['db', 'logs'] });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'invalid_restore_selection');
  r = await root.post('/backups/restore/inspect', { ...body, ...PW });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const id = r.data.job.id;
  assert.deepEqual(r.data.job.params.items, ['db', 'env']);
  assert.equal(r.data.job.params.dump, 'ets-20261022-090700.dump.gpg');
  assert.equal(r.data.job.params.config, 'ets-config-20261021-120000.tar.gpg');
  assert.equal((await root.post('/backups/restore/inspect', { ...body, ...PW })).status, 409);   // one restore at a time
  const dump = JSON.stringify([(await pool.query('SELECT * FROM backup_jobs')).rows, (await pool.query('SELECT * FROM audit_log')).rows,
    (await pool.query('SELECT * FROM system_log')).rows, (await pool.query('SELECT * FROM auth_log')).rows]);
  assert.ok(!dump.includes(KEY), 'the backup key is not in the database');
  for (const f of fs.readdirSync(new URL('../logs-test', import.meta.url))) {
    assert.ok(!fs.readFileSync(new URL('../logs-test/' + f, import.meta.url), 'utf8').includes(KEY), 'the backup key is not in the file log ' + f);
  }
  // the run needs a finished inspection, the same user and the confirmation phrase
  assert.equal((await root.post('/backups/restore/run', { inspect_id: id, items: ['db'], confirm: 'استرجاع' })).status, 409);
  await pool.query(`UPDATE backup_jobs SET status='ok', finished_at=now(), result=$2 WHERE id=$1`,
    [id, JSON.stringify({ items: ['db', 'env'], source: 'local', blocking: [], files: { dump: { name: 'ets-20261022-090700.dump.gpg' } }, dump: { created: '2026-10-22T09:07:00Z' } })]);
  assert.equal((await (await as('root2')).post('/backups/restore/run', { inspect_id: id, items: ['db'], confirm: 'استرجاع' })).status, 404);
  assert.equal((await root.post('/backups/restore/run', { inspect_id: id, items: ['db'], confirm: 'yes' })).data.error, 'confirmation_phrase_mismatch');
  assert.equal((await root.post('/backups/restore/run', { inspect_id: id, items: ['logs'], confirm: 'استرجاع' })).data.reason, 'items_not_inspected');
  r = await root.post('/backups/restore/run', { inspect_id: id, items: ['db'], confirm: 'استرجاع' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.deepEqual(r.data.job.params.items, ['db']);
  // every administrator is told (S11), the change history says who and what
  const n = (await pool.query(`SELECT user_id, params FROM notifications WHERE type='restore_event'`)).rows;
  assert.deepEqual(n.map(x => x.user_id).sort(), [ids.root, ids.root2, ids.twofa].sort());
  assert.equal(n[0].params.stage, 'started');
  const au = (await pool.query(`SELECT action, new_value FROM audit_log WHERE action IN ('restore_inspect','restore_start') ORDER BY chain_seq`)).rows;
  assert.deepEqual(au.map(a => a.action), ['restore_inspect', 'restore_start']);
  assert.deepEqual(au[1].new_value.items, ['db']);
  await pool.query(`DELETE FROM backup_jobs`); await pool.query(`DELETE FROM notifications`);
  // three wrong keys within 15 minutes → no new attempt for 15 minutes
  for (let i = 0; i < 3; i++) {
    await pool.query(`INSERT INTO backup_jobs(kind, status, finished_at, result, requested_by) VALUES ('restore_inspect','failed', now(), '{"error":"wrong_key"}', $1)`, [ids.root]);
  }
  r = await root.post('/backups/restore/inspect', { ...body, ...PW });
  assert.equal(r.status, 429); assert.equal(r.data.error, 'restore_locked'); assert.ok(r.data.retry_after > 800);
  await pool.query(`UPDATE backup_jobs SET finished_at = now() - interval '16 minutes'`);
  assert.equal((await root.post('/backups/restore/inspect', { ...body, ...PW })).status, 202);
  await pool.query(`DELETE FROM backup_jobs`);
  for (const f of fs.readdirSync(path.join(STATE, 'inbox'))) fs.rmSync(path.join(STATE, 'inbox', f));
});

test('upload: admin only, artifact names only, size limit, stored for the agent', { skip }, async () => {
  const root = await as('root');
  let r = await root.post('/backups/upload?name=evil.sh', Buffer.from('x'));
  assert.equal(r.status, 400);
  r = await root.post('/backups/upload?name=ets-20261022-090700.dump.gpg', Buffer.from('encrypted-bytes'));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.upload_id;
  r = await root.post(`/backups/upload?name=ets-20261022-090700.dump.gpg.meta&upload_id=${id}`, Buffer.from('{"kind":"dump"}'));
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(STATE, 'upload', id, 'ets-20261022-090700.dump.gpg'), 'utf8'), 'encrypted-bytes');
  assert.equal(fs.statSync(path.join(STATE, 'upload', id, 'ets-20261022-090700.dump.gpg')).mode & 0o777, 0o600);
  r = await root.post('/backups/restore/plan', { source: 'upload', uploads: { 'ets-20261022-090700.dump.gpg': id }, dump: 'ets-20261022-090700.dump.gpg', items: ['db'] });
  assert.equal(r.status, 200); assert.equal(r.data.available.db.available, true);
  r = await root.post(`/backups/upload?name=ets-20261022-090700.dump.gpg.meta&upload_id=${id}`, Buffer.alloc(70 * 1024));
  assert.equal(r.status, 413);
  assert.equal((await (await as('pm1')).post('/backups/upload?name=ets-20261022-090700.dump.gpg', Buffer.from('x'))).status, 403);
});

test('notifications: S6 (interval-aware), S9 per destination, S10 failed / missing test restore, S11 restore finished', { skip }, async () => {
  await pool.query(`DELETE FROM notifications`); await pool.query(`DELETE FROM system_log`); await pool.query(`DELETE FROM notify_state`);
  await pool.query(`INSERT INTO system_log(ts, event, message) VALUES (now() - interval '20 days', 'startup', 'old')`);
  const open = async type => (await pool.query(`SELECT * FROM notifications WHERE user_id=$1 AND type=$2 AND read_at IS NULL`, [ids.root, type])).rows;
  // a backup 3 h ago, hourly: late (threshold 2 h); with backups every 4 h it is not (threshold 5 h)
  await pool.query(`INSERT INTO system_log(ts, event, message, detail) VALUES (now() - interval '3 hours', 'backup', 'ok', '{"offsite":["ssh","nas"]}')`);
  await scan.runScan();
  assert.equal((await open('backup_missing')).length, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE type='backup_missing' AND user_id=$1`, [ids.pm1])).rows[0].n, 0);
  await pool.query(`UPDATE backup_config SET config = jsonb_set(config, '{frequency_hours}', '4')`);
  await scan.runScan();
  assert.equal((await open('backup_missing')).length, 0, 'closed when the interval allows it');
  await pool.query(`UPDATE backup_config SET config = jsonb_set(config, '{frequency_hours}', '1')`);
  // S9: ssh copied 1 h ago; nas failing for 5 h → only nas
  await pool.query(`INSERT INTO system_log(ts, event, message, detail) VALUES
    (now() - interval '1 hour', 'backup', 'ok', '{"offsite":["ssh","nas"]}'),
    (now() - interval '1 hour', 'backup_offsite', 'x', '{"dest":"ssh","ok":true}'),
    (now() - interval '5 hours', 'backup_offsite', 'x', '{"dest":"nas","ok":false,"error":"not mounted"}'),
    (now() - interval '1 hour', 'backup_offsite', 'x', '{"dest":"nas","ok":false,"error":"/mnt/ets-backup is not a mounted file system"}')`);
  await scan.runScan();
  const s9 = await open('backup_offsite');
  assert.equal(s9.length, 1); assert.equal(s9[0].params.dest, 'nas'); assert.equal(s9[0].severity, 'critical');
  const t = (await (await as('root')).get('/notifications?lang=ar')).data.items.find(i => i.type === 'backup_offsite');
  assert.match(t.title, /النسخة الخارجية متأخرة أو فشلت/);
  // a destination switched off is no longer reported
  await pool.query(`INSERT INTO system_log(ts, event, message, detail) VALUES (now(), 'backup', 'ok', '{"offsite":["ssh"]}')`);
  await scan.runScan();
  assert.equal((await open('backup_offsite')).length, 0);
  // S10: the newest test restore failed
  await pool.query(`INSERT INTO system_log(ts, event, level, message, detail) VALUES (now(), 'backup_verify', 'error', 'x', '{"ok":false,"error":"audit chain check failed"}')`);
  await scan.runScan();
  const s10 = await open('backup_verify');
  assert.equal(s10.length, 1); assert.equal(s10[0].params.stage, 'failed');
  await pool.query(`INSERT INTO system_log(ts, event, message, detail) VALUES (now(), 'backup_verify', 'x', '{"ok":true}')`);
  await scan.runScan();
  assert.equal((await open('backup_verify')).length, 0);
  // S11: a restore written by the agent into the restored database is announced once
  await pool.query(`INSERT INTO system_log(ts, event, message, detail) VALUES (now(), 'restore', 'x', '{"ok":true,"state":"done","by":{"username":"root"},"items":["db"]}')`);
  await scan.runScan(); await scan.runScan();
  const s11 = (await pool.query(`SELECT params FROM notifications WHERE type='restore_event' AND user_id=$1`, [ids.root])).rows;
  assert.equal(s11.length, 1); assert.equal(s11[0].params.stage, 'done');
  // thresholds are settings with bounds
  const root = await as('root');
  assert.equal((await root.put('/settings', { 'notify.offsite_max_age_hours': 1 })).status, 400);
  assert.equal((await root.put('/settings', { 'notify.offsite_max_age_hours': 6 })).status, 200);
  assert.equal((await root.put('/settings', { 'notify.policy': { backup_offsite: { roles: { admin: false } } } })).status, 400);   // mandatory
});

test('migration 021: the old 26 h default becomes 2 h, a customised value is kept', { skip }, async () => {
  const sql = fs.readFileSync(new URL('../src/db/migrations/021_backup_center.sql', import.meta.url), 'utf8');
  const upd = sql.match(/UPDATE settings[\s\S]*?;/)[0];
  await pool.query(`INSERT INTO settings(key, value) VALUES ('notify.backup_max_age_hours', '26') ON CONFLICT (key) DO UPDATE SET value='26'`);
  await pool.query(upd);
  assert.equal((await pool.query(`SELECT value FROM settings WHERE key='notify.backup_max_age_hours'`)).rows[0].value, 2);
  await pool.query(`UPDATE settings SET value='30' WHERE key='notify.backup_max_age_hours'`);
  await pool.query(upd);
  assert.equal((await pool.query(`SELECT value FROM settings WHERE key='notify.backup_max_age_hours'`)).rows[0].value, 30);
});

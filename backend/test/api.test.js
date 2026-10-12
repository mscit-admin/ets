// API integration tests — run against a dedicated, disposable PostgreSQL database:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool, totp, decrypt;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '3', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  ({ totp } = await import('../src/services/totp.js'));
  ({ decrypt } = await import('../src/services/crypto.js'));
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('root','Root Admin',$1,'admin',false), ('tester','QA',$1,'qa',false), ('hred','HR Editor',$1,'ed',false),
    ('newbie','New',$1,'obs',true), ('locky','Lock',$1,'obs',false)`, [h]);
  const hred = (await pool.query(`SELECT id FROM users WHERE username='hred'`)).rows[0].id;
  await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,'department','hr')`, [hred]);
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  server.close();
  await new Promise(r => setTimeout(r, 200)); // let pending log writes finish
  await pool.end();
});

// Minimal cookie-keeping client
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}

const secretOf = async u => decrypt((await pool.query('SELECT totp_secret FROM users WHERE username=$1', [u])).rows[0].totp_secret);
const setMfa = mode => pool.query(`UPDATE settings SET value=$1 WHERE key='mfa.mode'`, [JSON.stringify(mode)]);
const waitSettingsCache = () => import('../src/services/settings.js').then(m => m.invalidateSettings());

test('health endpoint', { skip }, async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
});

test('login: wrong password, unknown user, success', { skip }, async () => {
  const c = client();
  assert.equal((await c.login('root', 'nope')).status, 401);
  assert.equal((await c.login('ghost')).data.error, 'invalid_credentials');
  const ok = await c.login('root');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.stage, 'done');
  const me = await c.get('/auth/me');
  assert.equal(me.data.user.username, 'root');
  assert.ok(me.data.user.permissions.includes('usr'));
});

test('state-changing requests require the CSRF header', { skip }, async () => {
  const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('account locks after repeated failures', { skip }, async () => {
  const c = client();
  for (let i = 0; i < 3; i++) await c.login('locky', 'bad');
  const r = await c.login('locky');
  assert.equal(r.status, 423);
  const ev = (await pool.query(`SELECT event FROM auth_log WHERE username='locky' ORDER BY id`)).rows.map(x => x.event);
  assert.ok(ev.includes('account_locked'));
});

test('unauthenticated access is refused', { skip }, async () => {
  assert.equal((await client().get('/tracker/summary')).status, 401);
});

test('2FA: required policy → enrol, verify, replay blocked, recovery code', { skip }, async () => {
  await setMfa('required'); await waitSettingsCache();
  const c = client();
  assert.equal((await c.login('tester')).data.stage, 'enroll');
  assert.equal((await c.get('/tracker/summary')).status, 401);           // partial session is not enough
  const setup = await c.post('/auth/2fa/setup');
  assert.match(setup.data.uri, /^otpauth:\/\/totp\//);
  const en = await c.post('/auth/2fa/enable', { code: totp(setup.data.secret) });
  assert.equal(en.data.recovery_codes.length, 10);
  assert.equal((await c.get('/tracker/summary')).status, 200);

  // new login → verify stage; same code again is a replay
  const c2 = client();
  assert.equal((await c2.login('tester')).data.stage, 'verify');
  assert.equal((await c2.post('/auth/2fa/verify', { code: totp(await secretOf('tester')) })).data.error, 'invalid_code');
  // recovery code works once
  const code = en.data.recovery_codes[0];
  assert.equal((await c2.post('/auth/2fa/verify', { recovery_code: code })).data.stage, 'done');
  const c3 = client();
  await c3.login('tester');
  assert.equal((await c3.post('/auth/2fa/verify', { recovery_code: code })).status, 400);
});

test('2FA: admin exemption and global off', { skip }, async () => {
  const admin = client(); await admin.login('root');            // root not enrolled: policy 'required' → enroll
  await setMfa('off'); await waitSettingsCache();
  const a2 = client();
  assert.equal((await a2.login('root')).data.stage, 'done');
  assert.equal((await a2.login('tester')).data.stage, 'done');   // enrolled user skips 2FA when off
  await setMfa('required'); await waitSettingsCache();
  const tid = (await pool.query(`SELECT id FROM users WHERE username='tester'`)).rows[0].id;
  // exempt via API as root (needs a full session: enrol root first)
  const r = client();
  await r.login('root');
  const s = await r.post('/auth/2fa/setup');
  await r.post('/auth/2fa/enable', { code: totp(s.data.secret) });
  const bulk = await r.post('/users/bulk-2fa', { user_ids: [tid], exempt: true });
  assert.equal(bulk.data.updated, 1);
  assert.equal((await client().login('tester')).data.stage, 'done');
  await r.post('/users/bulk-2fa', { all: true, exempt: true });  // later tests log in without codes
});

test('permissions: tester may set test status but not progress', { skip }, async () => {
  const c = client(); await c.login('tester');
  const f = (await pool.query(`SELECT id FROM functions WHERE app_id='per' AND code='D0'`)).rows[0];
  assert.equal((await c.patch('/tracker/functions/' + f.id, { progress: 50 })).status, 403);
  const ok = await c.patch('/tracker/functions/' + f.id, { test_status: 2, note: 'checked' });
  assert.equal(ok.status, 200);
  const audit = (await pool.query(`SELECT * FROM audit_log WHERE entity='function' AND entity_id=$1`, [String(f.id)])).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].new_value, { test_status: 2, note: 'checked' });
});

test('scope: HR editor cannot see or edit finance', { skip }, async () => {
  const c = client(); await c.login('hred');
  const sum = await c.get('/tracker/summary');
  assert.deepEqual(sum.data.departments.map(d => d.id), ['hr']);
  assert.equal((await c.get('/tracker/applications/acc')).status, 403);
  const fin = (await pool.query(`SELECT id FROM functions WHERE app_id='acc' LIMIT 1`)).rows[0];
  assert.equal((await c.patch('/tracker/functions/' + fin.id, { progress: 10 })).status, 403);
  const hr = (await pool.query(`SELECT id FROM functions WHERE app_id='pay' AND enabled LIMIT 1`)).rows[0];
  assert.equal((await c.patch('/tracker/functions/' + hr.id, { progress: 60 })).status, 200);
  const denied = (await pool.query(`SELECT count(*)::int n FROM auth_log WHERE username='hred' AND event='access_denied'`)).rows[0].n;
  assert.ok(denied >= 2);
});

test('must_change_password blocks the API until changed', { skip }, async () => {
  const c = client(); await c.login('newbie');
  assert.equal((await c.get('/tracker/summary')).data.error, 'password_change_required');
  assert.equal((await c.post('/auth/change-password', { current_password: 'Passw0rd-123', new_password: 'short' })).data.error, 'weak_password');
  assert.equal((await c.post('/auth/change-password', { current_password: 'Passw0rd-123', new_password: 'BrandNew-2026' })).status, 200);
  assert.equal((await c.get('/tracker/summary')).status, 200);
});

test('users: create, last-admin protection, reset password', { skip }, async () => {
  const c = client(); await c.login('root');
  const created = await c.post('/users', { username: 'fin.mgr', full_name: 'Finance Manager', role_id: 'mgr', password: 'Finance-2026x',
    scopes: [{ kind: 'department', ref_id: 'fin' }] });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.scopes.length, 1);
  assert.equal((await c.post('/users', { username: 'fin.mgr', full_name: 'X', role_id: 'obs', password: 'Finance-2026x' })).data.error, 'username_taken');
  const rootId = (await pool.query(`SELECT id FROM users WHERE username='root'`)).rows[0].id;
  assert.equal((await c.patch('/users/' + rootId, { role_id: 'obs' })).data.error, 'cannot_change_own_role');
  const r = await c.post(`/users/${created.data.user.id}/reset-password`, { password: 'Another-2026x' });
  assert.equal(r.status, 200);
  assert.equal((await client().login('fin.mgr', 'Another-2026x')).status, 200);
  // a non-admin cannot reach user management
  const t = client(); await t.login('tester');
  assert.equal((await t.get('/users')).status, 403);
});

test('settings validation and audit', { skip }, async () => {
  const c = client(); await c.login('root');
  assert.equal((await c.put('/settings', { 'mfa.mode': 'sometimes' })).status, 400);
  assert.equal((await c.put('/settings', { 'logs.retention_days': 400 })).status, 200);
  const a = (await pool.query(`SELECT * FROM audit_log WHERE entity='setting' AND entity_id='logs.retention_days'`)).rows;
  assert.equal(a.length, 1);
});

test('legacy import from the original tracker file', { skip }, async () => {
  const c = client(); await c.login('root');
  const html = fs.readFileSync(new URL('../../reference/erp-tracker-original.html', import.meta.url), 'utf8');
  const r = await c.post('/tracker/import', { content: html });
  assert.equal(r.status, 200);
  assert.equal(r.data.counts.functions, 513);
  const s = await c.get('/tracker/summary');
  const inf = s.data.departments.find(d => d.id === 'inf');
  assert.equal(Math.round(inf.pct * 100) / 100, 52.78);
});

test('logs API: filters and CSV export', { skip }, async () => {
  const c = client(); await c.login('root');
  const r = await c.get('/logs/auth?success=false&limit=5');
  assert.equal(r.status, 200);
  assert.ok(r.data.rows.every(x => x.success === false));
  const csv = await c.get('/logs/audit/export');
  assert.match(csv.data, /action/);
  const t = client(); await t.login('tester');
  assert.equal((await t.get('/logs/auth')).status, 403);
});

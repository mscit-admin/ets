// Maintenance mode (1.12.38) — against a dedicated, disposable PostgreSQL database:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_maint npm test
// Covers: the admin-only toggle (enable/disable, since/by, audit rows maintenance_on/maintenance_off), the login gate
// (a would-be-successful non-admin login is refused with 503 maintenance_mode carrying the message, while an admin
// still signs in), the toggle being admin-only (403 for a non-admin), the PUBLIC state endpoint returning only
// { enabled, message } (no since/by), the non-admin API gate (503 while on, admin exempt, the alert channel exempt),
// and that enabling fires a mandatory alert to active non-admin users (reusing the alert broadcast). The maintenance
// state lives in the EXISTING settings table (no migration). Skipped when the variable is unset. Schema is DROPPED.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool;
const id = {};

async function mkUser(username, role, { perms = [] } = {}) {
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  const u = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password)
    VALUES ($1,$2,$3,$4,false) RETURNING id`, [username, username + ' name', h, role])).rows[0].id;
  for (const [p, g] of perms) await pool.query(`INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,$2,$3)`, [u, p, g]);
  id[username] = u;
  return u;
}

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', LOGIN_IP_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  await mkUser('root', 'admin');
  await mkUser('alice', 'member');
  await mkUser('bob', 'member');
  await mkUser('cfgmgr', 'mgr', { perms: [['cfg', true]] });   // has cfg but is NOT admin → still cannot toggle
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  // leave maintenance off so a re-run starts clean (the schema is dropped anyway)
  server.close();
  await new Promise(r => setTimeout(r, 200));
  await pool.end();
});

function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return {
    get: p => call('GET', p), put: (p, b = {}) => call('PUT', p, b), post: (p, b = {}) => call('POST', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}
const as = async u => { const c = client(); const r = await c.login(u); return { c, r }; };

async function setMaintenance(enabled, message) {
  const { c } = await as('root');
  return c.put('/maintenance', { enabled, message });
}

test('admin can enable and disable; GET reflects state with since/by; audit rows are written', { skip }, async () => {
  const { c: admin } = await as('root');
  const on = await admin.put('/maintenance', { enabled: true, message: 'Upgrading now' });
  assert.equal(on.status, 200);
  assert.equal(on.data.enabled, true);
  assert.equal(on.data.message, 'Upgrading now');
  assert.ok(on.data.since, 'since set');
  assert.equal(on.data.by, 'root');
  const get = await admin.get('/maintenance');
  assert.equal(get.data.enabled, true);
  assert.equal(get.data.by, 'root');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action='maintenance_on'`)).rows[0].n >= 1, true);
  // disable
  const off = await admin.put('/maintenance', { enabled: false });
  assert.equal(off.data.enabled, false);
  assert.equal(off.data.since, null);
  assert.equal(off.data.by, null);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action='maintenance_off'`)).rows[0].n >= 1, true);
});

test('while on, a non-admin login is refused (503 maintenance_mode + message); an admin still signs in', { skip }, async () => {
  await setMaintenance(true, 'Back at 5pm');
  const nonAdmin = client();
  const r = await nonAdmin.login('alice');
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'maintenance_mode');
  assert.equal(r.data.message, 'Back at 5pm');
  // an admin signs in normally
  const admin = client();
  const ar = await admin.login('root');
  assert.equal(ar.status, 200);
  assert.equal(ar.data.stage, 'done');
  await setMaintenance(false);
});

test('a wrong password still gets the generic 401, not the maintenance 503 (no extra account disclosure)', { skip }, async () => {
  await setMaintenance(true, 'x');
  const c = client();
  const r = await c.login('alice', 'wrong-password');
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'invalid_credentials');
  await setMaintenance(false);
});

test('the toggle is admin-only: a non-admin (even with cfg) gets 403 on GET and PUT', { skip }, async () => {
  const { c: mgr } = await as('cfgmgr');
  assert.equal((await mgr.get('/maintenance')).status, 403);
  assert.equal((await mgr.put('/maintenance', { enabled: true })).status, 403);
  // and maintenance stayed off
  assert.equal((await mgr.get('/maintenance/public')).data.enabled, false);
});

test('the public endpoint returns only { enabled, message } — no since/by', { skip }, async () => {
  await setMaintenance(true, 'public msg');
  const anon = client();                 // no login
  const r = await anon.get('/maintenance/public');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['enabled', 'message']);
  assert.equal(r.data.enabled, true);
  assert.equal(r.data.message, 'public msg');
  await setMaintenance(false);
  // when off, message is blanked
  const off = await anon.get('/maintenance/public');
  assert.equal(off.data.enabled, false);
  assert.equal(off.data.message, '');
});

test('non-admin API requests are refused with 503 while on; admins are exempt; the alert channel stays open', { skip }, async () => {
  // sign a non-admin in BEFORE maintenance (they could not sign in afterwards)
  const { c: alice } = await as('alice');
  assert.equal((await alice.get('/counts')).status, 200, 'works before maintenance');
  await setMaintenance(true, 'maint');
  // the existing non-admin session is now short-circuited on a normal API call
  const blocked = await alice.get('/counts');
  assert.equal(blocked.status, 503);
  assert.equal(blocked.data.error, 'maintenance_mode');
  // but the mandatory-alert channel stays open so the popup can load/respond, and /auth/me still works
  assert.equal((await alice.get('/messages/pending-alert')).status, 200);
  assert.equal((await alice.get('/auth/me')).status, 200);
  // an admin is never blocked
  const { c: admin } = await as('root');
  assert.equal((await admin.get('/counts')).status, 200);
  await setMaintenance(false);
  assert.equal((await alice.get('/counts')).status, 200, 'works again after maintenance');
});

test('enabling fires a mandatory alert to active non-admin users (alert_received + pending alert thread)', { skip }, async () => {
  // clean any prior alert threads for a precise assertion
  await pool.query('DELETE FROM message_posts');
  await pool.query('DELETE FROM message_threads');
  await pool.query('DELETE FROM message_broadcasts');
  await pool.query('DELETE FROM notifications');
  const r = await setMaintenance(true, 'Freeze: upgrading');
  assert.equal(r.data.enabled, true);
  // a non-admin recipient got an alert thread + an alert_received notification; the admin sender did not
  const aliceThreads = (await pool.query(
    `SELECT kind, response_status FROM message_threads WHERE recipient_id=$1`, [id.alice])).rows;
  assert.ok(aliceThreads.some(t => t.kind === 'alert' && t.response_status === null), 'alice has a pending alert');
  const aliceNotif = (await pool.query(`SELECT type FROM notifications WHERE user_id=$1`, [id.alice])).rows;
  assert.ok(aliceNotif.some(n => n.type === 'alert_received'), 'alice alert_received');
  const adminThreads = (await pool.query(`SELECT count(*)::int n FROM message_threads WHERE recipient_id=$1`, [id.root])).rows[0].n;
  assert.equal(adminThreads, 0, 'admin (sender) is not a recipient');
  // the alert body is the maintenance message, authored by the admin, kind alert
  const b = (await pool.query(`SELECT author_id, body, kind FROM message_broadcasts ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(b.kind, 'alert');
  assert.equal(b.author_id, id.root);
  assert.equal(b.body, 'Freeze: upgrading');
  await setMaintenance(false);
});

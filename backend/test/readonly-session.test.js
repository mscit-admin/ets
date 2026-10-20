// Read-only sessions of the Android app (1.11.0, migration 020): a sign-in whose User-Agent carries the
// "ETSAlerts/<version> (Android)" marker gets a session with client 'mobile', readonly = true. It reads like any session
// of the account (same permissions and scope), and every change is refused with 403 readonly_session except signing in
// and out, the 2FA step, a forced password change, the language and the user's own alerts. A browser session is
// unaffected. Needs TEST_DATABASE_URL like api.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';
const APP_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546E; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 ETSAlerts/1.1.0 (Android)';
const WEB_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

let server, base, pool, totp, encrypt, live, ids = {}, fnId, appId;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  ({ totp } = await import('../src/services/totp.js'));
  ({ encrypt } = await import('../src/services/crypto.js'));
  live = await import('../src/services/live.js');
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword(PW);
  for (const [u, role] of [['root', 'admin'], ['lead', 'lead'], ['mem', 'member'], ['tfa', 'member'], ['fresh', 'member'], ['newpw', 'member']]) {
    ids[u] = (await pool.query(`INSERT INTO users(username, full_name, password_hash, role_id, must_change_password)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`, [u, 'Full ' + u, h, role, u === 'newpw'])).rows[0].id;
    if (role !== 'admin') await pool.query(`INSERT INTO user_scopes VALUES ($1,'department','hr')`, [ids[u]]);
  }
  await pool.query(`UPDATE settings SET value='"optional"' WHERE key='mfa.mode'`);
  (await import('../src/services/settings.js')).invalidateSettings();
  ({ id: fnId, app_id: appId } = (await pool.query(`SELECT f.id, f.app_id FROM functions f JOIN applications a ON a.id=f.app_id
    WHERE a.department_id='hr' AND f.enabled AND f.removed_at IS NULL ORDER BY f.id LIMIT 1`)).rows[0]);
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  live.closeAllStreams();
  server.closeAllConnections?.();
  server.close();
  await pool.end();
});

function client(ua) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', 'user-agent': ua, cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b = {}) => call('PUT', p, b),
    patch: (p, b = {}) => call('PATCH', p, b), del: p => call('DELETE', p),
    login: (u, pw = PW) => call('POST', '/auth/login', { username: u, password: pw }) };
}
const signIn = async (u, ua) => { const c = client(ua); const r = await c.login(u); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; };
const phone = u => signIn(u, APP_UA);
const browser = u => signIn(u, WEB_UA);
const lastSession = async u => (await pool.query('SELECT client, readonly, mfa_passed FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [ids[u]])).rows[0];
const refused = (r, what) => {
  assert.equal(r.status, 403, `${what}: ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.error, 'readonly_session', what);
};

test('a sign-in with the app marker creates a read-only mobile session; /auth/me reports it; audit detail client=mobile', { skip }, async () => {
  const c = await phone('mem');
  assert.equal((await c.login('mem')).data.stage, 'done');
  assert.deepEqual(await lastSession('mem'), { client: 'mobile', readonly: true, mfa_passed: true });
  const me = (await c.get('/auth/me')).data;
  assert.equal(me.readonly, true);
  assert.equal(me.client, 'mobile');
  assert.equal(me.user.readonly, true);
  // same permissions as a browser session: read-only hides the controls, it does not take permissions away
  assert.ok(me.user.permissions.includes('pct'));
  const log = (await pool.query(`SELECT detail FROM auth_log WHERE user_id=$1 AND event='login' ORDER BY id DESC LIMIT 1`, [ids.mem])).rows[0];
  assert.equal(log.detail.client, 'mobile');
  assert.equal(log.detail.readonly, true);
  // a marker elsewhere in the string, or a different product name, is not the app
  for (const ua of ['ETSAlerts (Android)', 'Mozilla/5.0 NotETSAlerts/1.0', 'ETSAlerts/1.0 (iOS)']) {
    await signIn('mem', ua);
    assert.equal((await lastSession('mem')).readonly, false, ua);
  }
});

test('a browser session is unaffected: web client, not read-only, edits work, no client in the audit detail', { skip }, async () => {
  const c = await browser('lead');
  assert.deepEqual(await lastSession('lead'), { client: 'web', readonly: false, mfa_passed: true });
  const me = (await c.get('/auth/me')).data;
  assert.equal(me.readonly, false);
  assert.equal(me.client, 'web');
  const r = await c.patch(`/tracker/functions/${fnId}`, { progress: 40 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const app = (await c.get(`/tracker/applications/${appId}`)).data;
  assert.equal(app.can.pct, true);
  const log = (await pool.query(`SELECT detail FROM auth_log WHERE user_id=$1 AND event='login' ORDER BY id DESC LIMIT 1`, [ids.lead])).rows[0];
  assert.equal(log.detail.client, undefined);
});

test('read-only session: GET requests work and the pages are told nothing is editable', { skip }, async () => {
  const c = await phone('lead');
  for (const p of ['/tracker/summary', '/tracker/departments/hr', `/tracker/applications/${appId}`, '/tracker/project-status',
    '/tracker/weights', '/tracker/schedule', '/tracker/reports', '/approvals', '/imports', '/notifications?limit=10', '/notifications/count',
    '/notifications/prefs', '/devices']) {
    assert.equal((await c.get(p)).status, 200, p);
  }
  const app = (await c.get(`/tracker/applications/${appId}`)).data;
  assert.deepEqual(app.can, { pct: false, wgt: false, tst: false, tog: false, ren: false, mov: false, rep: false });
  assert.equal((await c.get('/tracker/reports')).data.can.rep, false);
  assert.equal((await c.get('/tracker/schedule')).data.can.sch, false);
  assert.equal((await c.get('/imports')).data.can_import, false);
  // Excel exports are GET and keep their own permission check (exp): the lead has it
  const x = await c.get('/export/summary.xlsx');
  assert.equal(x.status, 200);
  // and the scope is the account's own: a department outside it stays out of reach
  assert.equal((await c.get('/tracker/departments/fin')).status, 403);
});

test('read-only session: every change is refused with 403 readonly_session and logged', { skip }, async () => {
  const lead = await phone('lead');
  const root = await phone('root');
  const before = (await pool.query(`SELECT progress FROM functions WHERE id=$1`, [fnId])).rows[0].progress;
  refused(await lead.patch(`/tracker/functions/${fnId}`, { progress: 90 }), 'PATCH function');
  refused(await lead.patch(`/tracker/functions/${fnId}`, { name_ar: 'اسم جديد', rename_reason: 'تجربة الإعادة' }), 'rename');
  refused(await lead.post(`/tracker/applications/${appId}/bulk`, { field: 'progress', value: 100 }), 'bulk');
  refused(await lead.post(`/tracker/functions/${fnId}/move`, { to_app_id: appId, reason: 'x'.repeat(20) }), 'move');
  refused(await lead.post(`/tracker/applications/${appId}/bulk-move`, { to_app_id: appId, function_ids: [fnId], reason: 'x'.repeat(20) }), 'bulk-move');
  refused(await lead.post(`/tracker/applications/${appId}/functions`, { name_ar: 'بند' }), 'add function');
  refused(await lead.post(`/tracker/functions/${fnId}/remove`, { reason: 'x' }), 'remove');
  refused(await lead.post('/approvals/1/approve'), 'approvals approve');
  refused(await lead.post('/approvals/approve-all'), 'approve-all');
  refused(await lead.post('/imports/1/approve', {}), 'import approve');
  refused(await lead.post('/devices/pair-code', { password: PW }), 'pair code');
  refused(await lead.post('/auth/change-password', { current_password: PW, new_password: 'An0ther-Passw0rd!' }), 'change password (not forced)');
  refused(await lead.post('/auth/2fa/setup', { password: PW }), '2fa setup from a full session');
  refused(await root.put('/settings', { 'mfa.mode': 'off' }), 'settings PUT');
  refused(await root.patch(`/users/${ids.mem}`, { full_name: 'Changed' }), 'user PATCH');
  refused(await root.post('/users', { username: 'x1', full_name: 'X', password: 'Abcdef-12345!', role_id: 'member' }), 'user create');
  refused(await root.put('/tracker/weights', { weights: {} }), 'weights PUT');
  refused(await root.put('/tracker/schedule', {}), 'schedule PUT');
  refused(await root.del(`/devices/1`), 'device DELETE');
  // tricks with the path's case or a trailing slash change nothing
  refused(await lead.patch(`/TRACKER/functions/${fnId}/`, { progress: 91 }), 'PATCH upper case');
  refused(await lead.post('/auth/logout/../../tracker/applications/' + appId + '/bulk', { field: 'progress', value: 100 }), 'dot segments');
  assert.equal((await pool.query(`SELECT progress FROM functions WHERE id=$1`, [fnId])).rows[0].progress, before);
  assert.equal((await pool.query(`SELECT full_name FROM users WHERE id=$1`, [ids.mem])).rows[0].full_name, 'Full mem');
  const n = (await pool.query(`SELECT count(*)::int AS n FROM auth_log WHERE user_id=$1 AND event='readonly_rejected'`, [ids.lead])).rows[0].n;
  assert.ok(n >= 10, `readonly_rejected rows: ${n}`);
});

test('read-only session: the allow-listed actions work (alerts, preferences, language, logout)', { skip }, async () => {
  const c = await phone('mem');
  const nid = (await pool.query(`INSERT INTO notifications(user_id, type, severity, category, params, link, dept_id, app_id, dedupe_key)
    VALUES ($1,'stuck','warning','tracking','{}','/', 'hr', $2, 'ro-test') RETURNING id`, [ids.mem, appId])).rows[0].id;
  const rd = await c.post(`/notifications/${nid}/read`);
  assert.equal(rd.status, 200);
  assert.equal(rd.data.marked, 1);
  assert.ok((await pool.query('SELECT read_at FROM notifications WHERE id=$1', [nid])).rows[0].read_at);
  assert.equal((await c.post(`/notifications/${nid}/unread`)).status, 200);
  assert.equal((await c.post('/notifications/read-all')).status, 200);
  const prefs = await c.put('/notifications/prefs', { digest: true });
  assert.equal(prefs.status, 200, JSON.stringify(prefs.data));
  assert.equal((await c.put('/auth/language', { language: 'en' })).status, 200);
  assert.equal((await c.post('/auth/logout')).status, 200);
  assert.equal((await c.get('/auth/me')).data.authenticated, false);
});

test('read-only sign-in with 2FA: the verify step works and the full session stays read-only', { skip }, async () => {
  const secret = (await import('../src/services/totp.js')).generateSecret();
  await pool.query('UPDATE users SET totp_secret=$2, totp_enabled=true, totp_last_step=NULL WHERE id=$1', [ids.tfa, encrypt(secret)]);
  const c = client(APP_UA);
  assert.equal((await c.login('tfa')).data.stage, 'verify');
  assert.deepEqual(await lastSession('tfa'), { client: 'mobile', readonly: true, mfa_passed: false });
  assert.equal((await c.get('/auth/me')).data.readonly, true);
  const v = await c.post('/auth/2fa/verify', { code: totp(secret) });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.deepEqual(await lastSession('tfa'), { client: 'mobile', readonly: true, mfa_passed: true });
  refused(await c.patch(`/tracker/functions/${fnId}`, { progress: 5 }), 'after 2FA');
  const rows = (await pool.query(`SELECT event, detail FROM auth_log WHERE user_id=$1 AND event IN ('password_ok_mfa_pending','login') ORDER BY id`, [ids.tfa])).rows;
  assert.deepEqual(rows.map(r => [r.event, r.detail.client]), [['password_ok_mfa_pending', 'mobile'], ['login', 'mobile']]);
});

test('read-only sign-in: 2FA enrolment at sign-in and a forced password change are allowed', { skip }, async () => {
  const settings = await import('../src/services/settings.js');
  await pool.query(`UPDATE settings SET value='"required"' WHERE key='mfa.mode'`);
  settings.invalidateSettings();
  try {
    const c = client(APP_UA);
    assert.equal((await c.login('fresh')).data.stage, 'enroll');
    const s = await c.post('/auth/2fa/setup');
    assert.equal(s.status, 200, JSON.stringify(s.data));
    const e = await c.post('/auth/2fa/enable', { code: totp(s.data.secret) });
    assert.equal(e.status, 200, JSON.stringify(e.data));
    assert.deepEqual(await lastSession('fresh'), { client: 'mobile', readonly: true, mfa_passed: true });
  } finally {
    await pool.query(`UPDATE settings SET value='"optional"' WHERE key='mfa.mode'`);
    settings.invalidateSettings();
  }
  const p = await phone('newpw');
  assert.equal((await p.get('/auth/me')).data.user.must_change_password, true);
  const r = await p.post('/auth/change-password', { current_password: PW, new_password: 'An0ther-Passw0rd!x' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // once changed, the session is an ordinary read-only one again
  refused(await p.post('/auth/change-password', { current_password: 'An0ther-Passw0rd!x', new_password: 'Third-Passw0rd!xy' }), 'second change');
});

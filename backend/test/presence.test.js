// Online users (1.11.0, migration 020): POST /api/presence, GET /api/presence(/count), ending one session, clean-up.
// Needs TEST_DATABASE_URL like api.test.js: the public schema of that database is DROPPED and recreated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool, presence, presenceRoute, crypto, totp, sha256;
const ids = {};
let appId, deptId, appName;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', LOGIN_IP_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none', PRESENCE_MIN_INTERVAL_SECONDS: '1',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  const u = await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('root','Root Admin',$1,'admin',false), ('root2','Second Admin',$1,'admin',false), ('hred','HR Editor',$1,'ed',false),
    ('capper','Cap Viewer',$1,'obs',false), ('gone','To Be Deleted',$1,'ed',false), ('twofa','Two Factor',$1,'ed',false)
    RETURNING id, username`, [h]);
  for (const x of u.rows) ids[x.username] = x.id;
  await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) SELECT id,'department','hr' FROM users WHERE username IN ('hred','capper','gone','twofa')`);
  const a = (await pool.query(`SELECT id, department_id, name_ar FROM applications WHERE department_id='hr' ORDER BY sort LIMIT 1`)).rows[0];
  appId = a.id; deptId = a.department_id; appName = a.name_ar;
  presence = await import('../src/services/presence.js');
  presenceRoute = await import('../src/routes/presence.js');
  ({ sha256 } = await import('../src/services/crypto.js'));
  crypto = await import('../src/services/crypto.js');
  totp = await import('../src/services/totp.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  presence.resetPresenceState();
  server.closeAllConnections?.();
  server.close();
  await new Promise(r => setTimeout(r, 100));
  await pool.end();
});

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
  const c = {
    get cookie() { return cookie; },
    get sessionId() { return sha256(decodeURIComponent(cookie.split('=')[1])); },
    get: (p, h) => call('GET', p, undefined, h), post: (p, b = {}, h) => call('POST', p, b, h), del: (p, b) => call('DELETE', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
    // a presence report as the web app sends it (X-ETS-Live: 1)
    report: (screen, ref, path = '/', h = {}) => call('POST', '/presence', { path, screen, ...(ref !== undefined ? { ref } : {}) }, { 'x-ets-live': '1', ...h }),
  };
  return c;
}
const row = async sid => (await pool.query('SELECT * FROM user_presence WHERE session_id=$1', [sid])).rows[0];
const signedIn = async name => { const c = client(); assert.equal((await c.login(name)).status, 200); return c; };
const fresh = () => presence.resetPresenceState();     // forget the per-session write throttle between steps
const wait = ms => new Promise(r => setTimeout(r, ms));

test('POST /presence stores the caller\'s own session (upsert, client, user agent, ip)', { skip }, async () => {
  fresh();
  const c = await signedIn('hred');
  const r = await c.report('application', appId, '/app/' + appId);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { stored: true });
  let p = await row(c.sessionId);
  assert.equal(p.user_id, ids.hred);
  assert.equal(p.current_screen, 'application');
  assert.equal(p.screen_ref, appId);
  assert.equal(p.current_path, '/app/' + appId);
  assert.equal(p.client, 'web');
  assert.ok(p.ip);
  // a second report updates the same row (one row per session)
  fresh();
  assert.equal((await c.report('dashboard', undefined, '/', { 'x-ets-client': 'mobile' })).status, 200);
  p = await row(c.sessionId);
  assert.equal(p.current_screen, 'dashboard');
  assert.equal(p.screen_ref, null);
  assert.equal(p.client, 'mobile');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_presence WHERE user_id=$1', [ids.hred])).rows[0].n, 1);
  // nothing in the body can name another session or user
  fresh();
  await c.post('/presence', { path: '/', screen: 'dashboard', session_id: 'x', user_id: ids.root }, { 'x-ets-live': '1' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_presence WHERE user_id=$1', [ids.root])).rows[0].n, 0);
  // signed out → 401
  assert.equal((await client().report('dashboard')).status, 401);
});

test('screen_since moves only when the screen (key or id) changes', { skip }, async () => {
  fresh();
  const c = await signedIn('hred');
  await c.report('application', appId, '/app/' + appId);
  await pool.query(`UPDATE user_presence SET screen_since = now() - interval '10 minutes', last_seen = now() - interval '1 minute' WHERE session_id=$1`, [c.sessionId]);
  fresh();
  await c.report('application', appId, '/app/' + appId);                 // heartbeat on the same screen
  let p = await row(c.sessionId);
  assert.ok(Date.now() - new Date(p.screen_since).getTime() > 9 * 60_000, 'same screen: screen_since kept');
  assert.ok(Date.now() - new Date(p.last_seen).getTime() < 5000, 'last_seen moves');
  fresh();
  await c.report('department', deptId, '/department/' + deptId);          // another screen
  p = await row(c.sessionId);
  assert.ok(Date.now() - new Date(p.screen_since).getTime() < 5000, 'new screen: screen_since restarts');
  await pool.query(`UPDATE user_presence SET screen_since = now() - interval '10 minutes' WHERE session_id=$1`, [c.sessionId]);
  fresh();
  await c.report('reports_dept', deptId, '/reports/' + deptId);           // same id, other key → a change too
  p = await row(c.sessionId);
  assert.ok(Date.now() - new Date(p.screen_since).getTime() < 5000);
});

test('reports are rate-limited per session and coalesced (latest one written when the interval ends)', { skip }, async () => {
  fresh();
  const c = await signedIn('hred');
  assert.equal((await c.report('dashboard', undefined, '/')).status, 200);
  const r2 = await c.report('weights', undefined, '/weights');
  const r3 = await c.report('schedule', undefined, '/schedule');
  assert.equal(r2.status, 202);
  assert.deepEqual(r3.data, { stored: false, coalesced: true });
  assert.equal((await row(c.sessionId)).current_screen, 'dashboard', 'nothing written inside the interval');
  await wait(1400);                                                        // PRESENCE_MIN_INTERVAL_SECONDS=1
  const p = await row(c.sessionId);
  assert.equal(p.current_screen, 'schedule', 'the latest report is written afterwards');
  // screen_since is when the screen was reported, not when the coalesced write ran
  assert.ok(p.last_seen.getTime() - p.screen_since.getTime() > 500, `${p.screen_since.toISOString()} ${p.last_seen.toISOString()}`);
  // another session has its own budget
  const d = await signedIn('capper');
  assert.equal((await d.report('dashboard')).status, 200);
});

test('a presence report never extends the idle timeout (with or without X-ETS-Live)', { skip }, async () => {
  fresh();
  const c = await signedIn('hred');
  await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '30 minutes' WHERE id=$1`, [c.sessionId]);
  const before = (await pool.query('SELECT last_seen_at FROM sessions WHERE id=$1', [c.sessionId])).rows[0].last_seen_at;
  assert.equal((await c.report('dashboard')).status, 200);
  fresh();
  assert.equal((await c.post('/presence', { path: '/', screen: 'weights' })).status, 200);   // no X-ETS-Live header
  const after = (await pool.query('SELECT last_seen_at FROM sessions WHERE id=$1', [c.sessionId])).rows[0].last_seen_at;
  assert.equal(after.getTime(), before.getTime());
  // a request marked as user activity does count (control; 1.12.2: only X-ETS-Activity: 1 extends a session)
  await c.get('/auth/me', { 'x-ets-activity': '1' });
  await wait(200);
  const later = (await pool.query('SELECT last_seen_at FROM sessions WHERE id=$1', [c.sessionId])).rows[0].last_seen_at;
  assert.ok(later.getTime() > before.getTime());
  // presence reports are not written to access_log (one per minute and tab); the user's requests are
  const n = (await pool.query(`SELECT count(*)::int AS n FROM access_log WHERE path LIKE '/api/presence%' AND method='POST' AND status < 300`)).rows[0].n;
  assert.equal(n, 0);
});

test('reading presence: administrators only (403 for everyone else, 401 signed out)', { skip }, async () => {
  for (const u of ['hred', 'capper']) {
    const c = await signedIn(u);
    assert.equal((await c.get('/presence')).status, 403, u);
    assert.equal((await c.get('/presence/count')).status, 403, u);
  }
  // an 'usr' override on a non-admin never opens it (loadUserContext drops it)
  await pool.query(`INSERT INTO user_permissions(user_id, permission, granted) VALUES ($1, 'usr', true) ON CONFLICT DO NOTHING`, [ids.capper]);
  const c = await signedIn('capper');
  assert.equal((await c.get('/presence')).status, 403);
  await pool.query(`DELETE FROM user_permissions WHERE user_id=$1`, [ids.capper]);
  assert.equal((await client().get('/presence')).status, 401);
});

test('admin list: rows, labels built on the server, online / idle thresholds, counts', { skip }, async () => {
  await pool.query('DELETE FROM user_presence');
  fresh();
  const admin = await signedIn('root');
  const ed = await signedIn('hred');
  const obs = await signedIn('capper');
  await admin.report('online_users', undefined, '/online');
  fresh();
  await ed.report('application', appId, '/app/' + appId);
  fresh();
  await obs.report('department', deptId, '/department/' + deptId);
  // capper: 5 minutes ago → idle; and a session last seen 20 minutes ago is not listed at all
  await pool.query(`UPDATE user_presence SET last_seen = now() - interval '5 minutes' WHERE session_id=$1`, [obs.sessionId]);
  const old = await signedIn('twofa');
  fresh();
  await old.report('dashboard');
  await pool.query(`UPDATE user_presence SET last_seen = now() - interval '20 minutes' WHERE session_id=$1`, [old.sessionId]);
  // just inside / outside the 2-minute line
  await pool.query(`UPDATE user_presence SET last_seen = now() - interval '110 seconds' WHERE session_id=$1`, [ed.sessionId]);

  const r = await admin.get('/presence');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.rows.map(x => [x.user.username, x]));
  assert.deepEqual(Object.keys(by).sort(), ['capper', 'hred', 'root']);
  assert.equal(by.hred.status, 'online');
  assert.equal(by.capper.status, 'idle');
  assert.equal(by.root.status, 'online');
  assert.equal(by.root.is_me, true);
  assert.equal(by.hred.is_me, false);
  assert.equal(by.hred.screen.key, 'application');
  assert.equal(by.hred.screen.name_ar, appName);
  assert.equal(by.hred.screen.dept_id, deptId);
  assert.equal(by.hred.screen.link, '/app/' + encodeURIComponent(appId));
  assert.equal(by.capper.screen.key, 'department');
  assert.equal(by.capper.screen.link, '/department/' + deptId);
  assert.equal(by.root.screen.link, '/online');
  assert.equal(by.hred.user.role, 'ed');
  assert.deepEqual(by.hred.scope, { full: false, departments: ['hr'] });
  assert.equal(by.root.scope.full, true);
  assert.ok(by.hred.ip, 'IP shown to administrators');
  assert.equal(by.hred.client, 'web');
  assert.equal(by.hred.session_ref, ed.sessionId.slice(0, 16));
  assert.ok(by.hred.login_at && by.hred.screen_since && by.hred.last_seen);
  assert.equal(typeof by.hred.active_today_s, 'number');
  assert.deepEqual({ online: r.data.counts.online, idle: r.data.counts.idle, users: r.data.counts.users }, { online: 2, idle: 1, users: 3 });
  assert.ok(r.data.counts.sessions >= 4);
  assert.deepEqual(await (await admin.get('/presence/count')).data, { online: 2, idle: 1 });
  // 3 minutes → idle
  await pool.query(`UPDATE user_presence SET last_seen = now() - interval '3 minutes' WHERE session_id=$1`, [ed.sessionId]);
  assert.equal((await admin.get('/presence')).data.rows.find(x => x.user.username === 'hred').status, 'idle');
  // an idle-timed-out session (sessions.last_seen_at too old) is no longer listed
  await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id=$1`, [obs.sessionId]);
  assert.ok(!(await admin.get('/presence')).data.rows.some(x => x.user.username === 'capper'));
});

test('active time today counts the time between reports at most 90 s apart, once for several sessions', { skip }, async () => {
  await pool.query('DELETE FROM user_activity_daily');
  fresh();
  const a = await signedIn('hred');
  const b = await signedIn('hred');
  await a.report('dashboard');
  await pool.query(`UPDATE user_activity_daily SET last_at = now() - interval '60 seconds' WHERE user_id=$1`, [ids.hred]);
  await b.report('weights');                    // other session: +60 s (not +60 s per session)
  let s = (await pool.query('SELECT seconds FROM user_activity_daily WHERE user_id=$1', [ids.hred])).rows[0].seconds;
  assert.ok(s >= 59 && s <= 62, String(s));
  await pool.query(`UPDATE user_activity_daily SET last_at = now() - interval '10 minutes' WHERE user_id=$1`, [ids.hred]);
  fresh();
  await a.report('dashboard');                  // after a 10-minute gap (tab hidden): nothing added
  s = (await pool.query('SELECT seconds FROM user_activity_daily WHERE user_id=$1', [ids.hred])).rows[0].seconds;
  assert.ok(s >= 59 && s <= 62, String(s));
});

test('labels: unknown screen keys and ids that do not exist become «unknown»; bad input → 400', { skip }, async () => {
  fresh();
  const c = await signedIn('hred');
  await c.report('application', 'no_such_app', '/app/no_such_app');
  let p = await row(c.sessionId);
  assert.deepEqual([p.current_screen, p.screen_ref], ['unknown', null]);
  fresh();
  await c.report('department', undefined, '/department/x');              // id missing
  assert.equal((await row(c.sessionId)).current_screen, 'unknown');
  fresh();
  await c.report('user', '999999', '/users/999999');
  assert.equal((await row(c.sessionId)).current_screen, 'unknown');
  fresh();
  await c.report('import', 'abc', '/imports/abc');
  assert.equal((await row(c.sessionId)).current_screen, 'unknown');
  fresh();
  await c.report('somewhere_new', undefined, '/new');
  assert.equal((await row(c.sessionId)).current_screen, 'unknown');
  fresh();
  await c.report('dashboard', 'ignored', '/');                            // a screen without an id drops it
  p = await row(c.sessionId);
  assert.deepEqual([p.current_screen, p.screen_ref], ['dashboard', null]);
  for (const body of [
    { path: 'no-slash', screen: 'dashboard' }, { path: '/' + 'a'.repeat(250), screen: 'dashboard' }, { path: '/a b', screen: 'dashboard' },
    { path: '/<script>', screen: 'dashboard' }, { path: '/', screen: 'Dash-Board' }, { path: '/', screen: 'x'.repeat(31) },
    { path: '/', screen: 'application', ref: '../../etc' }, { path: '/', screen: 'application', ref: 'x'.repeat(41) },
    { path: '/', screen: 'application', ref: { a: 1 } }, { path: 42, screen: 'dashboard' }, {},
  ]) {
    fresh();
    const r = await c.post('/presence', body, { 'x-ets-live': '1' });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.data.error, 'invalid_value');
  }
  // an id that pointed to something that no longer exists reads «unknown» in the list (names are looked up, not stored)
  await pool.query(`UPDATE user_presence SET current_screen='application', screen_ref='vanished_app' WHERE session_id=$1`, [c.sessionId]);
  const admin = await signedIn('root');
  const mine = (await admin.get('/presence')).data.rows.find(x => x.session_ref === c.sessionId.slice(0, 16));
  assert.equal(mine.screen.key, 'unknown');
  assert.equal(mine.screen.link, null);
  assert.equal(mine.screen.name_ar, null);
});

test('sign-out removes the row; so does every other way a session ends', { skip }, async () => {
  fresh();
  const c = await signedIn('hred');
  await c.report('dashboard');
  assert.ok(await row(c.sessionId));
  const sid = c.sessionId;
  assert.equal((await c.post('/auth/logout')).status, 200);
  assert.equal(await row(sid), undefined);
  // a coalesced report waiting for its interval cannot bring the row back after the sign-out
  fresh();
  const d = await signedIn('hred');
  await d.report('dashboard');
  await d.report('weights');                                               // pending (202)
  const dsid = d.sessionId;
  await d.post('/auth/logout');
  await wait(1400);
  assert.equal(await row(dsid), undefined);
  // revoked by an administrator (all sessions) / password reset
  fresh();
  const e = await signedIn('hred');
  await e.report('dashboard');
  const admin = await signedIn('root');
  assert.equal((await admin.post(`/users/${ids.hred}/revoke-sessions`)).status, 200);
  assert.equal(await row(e.sessionId), undefined);
});

test('a deleted user disappears from the list', { skip }, async () => {
  fresh();
  const c = await signedIn('gone');
  await c.report('dashboard');
  assert.ok(await row(c.sessionId));
  const admin = await signedIn('root');
  const r = await admin.del('/users/' + ids.gone, { reason: 'left the project' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await row(c.sessionId), undefined);
  assert.ok(!(await admin.get('/presence')).data.rows.some(x => x.user.id === ids.gone));
  assert.equal((await c.report('dashboard')).status, 401);
});

test('clean-up: stale rows, rows of expired sessions, old daily activity; one process at a time', { skip }, async () => {
  fresh();
  const a = await signedIn('hred');
  const b = await signedIn('capper');
  const keep = await signedIn('root');
  await a.report('dashboard'); fresh();
  await b.report('dashboard'); fresh();
  await keep.report('dashboard');
  await pool.query(`UPDATE user_presence SET last_seen = now() - interval '16 minutes' WHERE session_id=$1`, [a.sessionId]);
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id=$1`, [b.sessionId]);   // no trigger: expiry not yet noticed
  await pool.query(`INSERT INTO user_activity_daily(user_id, day, seconds) VALUES ($1, current_date - 30, 100) ON CONFLICT DO NOTHING`, [ids.hred]);
  // another process holds the lock → skipped
  const other = await pool.connect();
  await other.query('SELECT pg_advisory_lock(hashtext($1))', [presence.LOCK_KEY]);
  assert.deepEqual(await presence.cleanupPresence(), { skipped: 'locked' });
  await other.query('SELECT pg_advisory_unlock(hashtext($1))', [presence.LOCK_KEY]);
  other.release();
  const out = await presence.cleanupPresence();
  assert.ok(out.presence >= 2, JSON.stringify(out));
  assert.ok(out.daily >= 1);
  assert.equal(await row(a.sessionId), undefined);
  assert.equal(await row(b.sessionId), undefined);
  assert.ok(await row(keep.sessionId), 'a current row stays');
});

test('«إنهاء الجلسة»: ends that one session (audited), not the user\'s others nor the admin\'s own', { skip }, async () => {
  fresh();
  const one = await signedIn('hred');
  const two = await signedIn('hred');
  await one.report('dashboard'); fresh();
  await two.report('weights'); fresh();
  const admin = await signedIn('root');
  await admin.report('online_users', undefined, '/online');
  const ref = one.sessionId.slice(0, 16);
  const r = await admin.post(`/users/${ids.hred}/revoke-sessions`, { session_ref: ref });
  assert.equal(r.status, 200);
  assert.equal(r.data.revoked, 1);
  assert.equal(await row(one.sessionId), undefined);
  assert.ok(await row(two.sessionId), 'the other session stays');
  assert.equal((await one.get('/auth/me')).data.authenticated, false);
  assert.equal((await two.get('/auth/me')).data.authenticated, true);
  const audit = (await pool.query(`SELECT * FROM audit_log WHERE action='revoke_sessions' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [String(ids.hred)])).rows[0];
  assert.equal(audit.username, 'root');
  assert.deepEqual(audit.new_value, { count: 1, session_ref: ref, source: 'online_users' });
  const auth = (await pool.query(`SELECT * FROM auth_log WHERE event='sessions_revoked_by_admin' AND user_id=$1 ORDER BY id DESC LIMIT 1`, [ids.hred])).rows[0];
  assert.equal(auth.detail.session_ref, ref);
  // again → 404; malformed → 400; own session → 400; another user's id with this ref → 404; non-admin → 403
  assert.equal((await admin.post(`/users/${ids.hred}/revoke-sessions`, { session_ref: ref })).data.error, 'session_not_found');
  for (const bad of ['xyz', 'ABCDEF0123456789', 12, '0123456789abcdef0']) {
    assert.equal((await admin.post(`/users/${ids.hred}/revoke-sessions`, { session_ref: bad })).status, 400, String(bad));
  }
  assert.equal((await admin.post(`/users/${ids.root}/revoke-sessions`, { session_ref: admin.sessionId.slice(0, 16) })).data.error, 'cannot_end_own_session');
  assert.equal((await admin.post(`/users/${ids.capper}/revoke-sessions`, { session_ref: two.sessionId.slice(0, 16) })).status, 404);
  assert.ok(await row(two.sessionId));
  assert.equal((await two.post(`/users/${ids.hred}/revoke-sessions`, { session_ref: two.sessionId.slice(0, 16) })).status, 403);
});

test('viewing the list is recorded at most once per 15 minutes per administrator', { skip }, async () => {
  presenceRoute.resetViewThrottle();
  const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='view' AND entity='presence'`)).rows[0].n;
  const n0 = await count();
  const a = await signedIn('root');
  const b = await signedIn('root2');
  await a.get('/presence');
  await a.get('/presence');
  await a.get('/presence', { 'x-ets-live': '1' });
  assert.equal(await count(), n0 + 1);
  await b.get('/presence');
  assert.equal(await count(), n0 + 2, 'each administrator has their own row');
  await a.get('/presence/count');
  assert.equal(await count(), n0 + 2, 'the count is not a view of who is online');
  const last = (await pool.query(`SELECT * FROM audit_log WHERE action='view' AND entity='presence' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(last.entity_id, 'online_users');
  assert.equal(last.username, 'root2');
});

test('session duration starts at the password step when 2FA replaces the session (sessions.login_at)', { skip }, async () => {
  const secret = totp.generateSecret();
  await pool.query('UPDATE users SET totp_enabled=true, totp_secret=$2 WHERE id=$1', [ids.twofa, crypto.encrypt(secret)]);
  const c = client();
  assert.equal((await c.login('twofa')).data.stage, 'verify');
  const partial = c.sessionId;
  await pool.query(`UPDATE sessions SET created_at = now() - interval '4 minutes', login_at = now() - interval '4 minutes' WHERE id=$1`, [partial]);
  const v = await c.post('/auth/2fa/verify', { code: totp.totp(secret) });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.notEqual(c.sessionId, partial);
  const s = (await pool.query('SELECT created_at, login_at FROM sessions WHERE id=$1', [c.sessionId])).rows[0];
  assert.ok(s.created_at.getTime() - s.login_at.getTime() > 3.5 * 60_000, 'login_at = the password step');
  fresh();
  await c.report('dashboard');
  const admin = await signedIn('root');
  const mine = (await admin.get('/presence')).data.rows.find(x => x.user.username === 'twofa');
  assert.equal(new Date(mine.login_at).getTime(), s.login_at.getTime());
  // a plain sign-in: login_at = created_at
  const p = await signedIn('capper');
  const q = (await pool.query('SELECT created_at, login_at FROM sessions WHERE id=$1', [p.sessionId])).rows[0];
  assert.equal(q.login_at.getTime(), q.created_at.getTime());
});

// Session expiry (1.12.2): only genuine user activity extends the idle timeout; an expired session is refused for
// good (every route, every reload); the web app's idle sign-out revokes the session on the server.
// Needs TEST_DATABASE_URL like api.test.js: the public schema of that database is DROPPED and recreated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool, sha256, presence, live;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', LOGIN_IP_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none', PRESENCE_MIN_INTERVAL_SECONDS: '1',
    LIVE_HEARTBEAT_SECONDS: '1',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('root','Root Admin',$1,'admin',false), ('hred','HR Editor',$1,'ed',false)`, [h]);
  await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) SELECT id,'department','hr' FROM users WHERE username='hred'`);
  ({ sha256 } = await import('../src/services/crypto.js'));
  presence = await import('../src/services/presence.js');
  live = await import('../src/services/live.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  presence.resetPresenceState();
  await live.closeAllStreams();
  server.closeAllConnections?.();
  server.close();
  await new Promise(r => setTimeout(r, 200));
  await pool.end();
});

// A browser-like client: keeps the cookie, drops it when the server clears it.
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const v = sc.split(';')[0];
      cookie = /^[^=]+=$/.test(v) || /expires=Thu, 01 Jan 1970/i.test(sc) ? '' : v;
    }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, setCookie: sc };
  };
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    get: (p, h) => call('GET', p, undefined, h), post: (p, b = {}, h) => call('POST', p, b, h),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}
const ACT = { 'x-ets-activity': '1' };
const LIVE = { 'x-ets-live': '1' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const sidOf = c => sha256(decodeURIComponent(c.cookie.split('=')[1]));
const sess = async id => (await pool.query('SELECT * FROM sessions WHERE id=$1', [id])).rows[0];
const signedIn = async name => { const c = client(); assert.equal((await c.login(name)).status, 200); return c; };
const ageBy = (id, minutes) => pool.query(`UPDATE sessions SET last_seen_at = now() - make_interval(mins => $2) WHERE id=$1`, [id, minutes]);

test('background traffic never extends the idle timeout: polls, data reloads, /auth/me checks, presence, the live stream', { skip }, async () => {
  presence.resetPresenceState();
  const c = await signedIn('root');
  const id = sidOf(c);
  await ageBy(id, 50);
  const before = (await sess(id)).last_seen_at.getTime();
  // what the browser sends on its own while nobody touches it
  assert.equal((await c.get('/backups')).status, 200);                 // Settings → backups: 30 s poll (untagged)
  assert.equal((await c.get('/tracker/summary')).status, 200);         // a screen's data load
  assert.equal((await c.get('/auth/me')).data.authenticated, true);   // the app's session check
  assert.equal((await c.get('/notifications/count', LIVE)).status, 200);
  assert.equal((await c.post('/presence', { path: '/', screen: 'dashboard' }, LIVE)).status, 200);
  const ac = new AbortController();
  const ev = await fetch(base + '/events', { headers: { cookie: c.cookie, accept: 'text/event-stream', ...ACT }, signal: ac.signal });
  assert.equal(ev.status, 200);
  ac.abort();
  await wait(300);                                                     // the activity write is fire-and-forget
  assert.equal((await sess(id)).last_seen_at.getTime(), before, 'last_seen_at must not move without user activity');
});

test('an idle-expired session is refused everywhere and for good; the cookie is cleared; a reload lands on sign-in', { skip }, async () => {
  const c = await signedIn('hred');
  const id = sidOf(c);
  const token = c.cookie;
  // background traffic kept coming the whole time …
  await ageBy(id, 59);
  await c.get('/tracker/summary');
  await c.get('/notifications/count', LIVE);
  await wait(200);
  // … and the idle limit (60 min) passes
  await ageBy(id, 61);
  const r = await c.get('/tracker/summary');
  assert.equal(r.status, 401);
  assert.match(r.setCookie || '', /ets_sid=;/, 'the cookie is cleared');
  assert.equal(c.cookie, '');
  const s = await sess(id);
  assert.ok(s.revoked_at);
  assert.equal(s.revoke_reason, 'expired');
  // the same token presented again (a browser that kept it, a soft or hard reload): refused on every kind of route
  c.cookie = token;
  assert.equal((await c.get('/auth/me')).data.authenticated, false);
  c.cookie = token;
  assert.equal((await c.get('/auth/me', ACT)).data.authenticated, false);
  c.cookie = token;
  assert.equal((await c.post('/auth/activity', {}, ACT)).status, 401);
  c.cookie = token;
  assert.equal((await c.post('/presence', { path: '/', screen: 'dashboard' }, LIVE)).status, 401);
  c.cookie = token;
  assert.equal((await c.get('/tracker/summary', ACT)).status, 401);
  const ev = await fetch(base + '/events', { headers: { cookie: token, accept: 'text/event-stream' } });
  assert.equal(ev.status, 401);
  await ev.body?.cancel();
  assert.equal((await sess(id)).revoke_reason, 'expired', 'still ended, never revived');
});

test('genuine user activity (X-ETS-Activity: 1) extends the idle timeout; POST /auth/activity is the ping', { skip }, async () => {
  const c = await signedIn('hred');
  const id = sidOf(c);
  await ageBy(id, 50);
  const r = await c.post('/auth/activity', {}, ACT);
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.idle_expires_at, 'string');
  await wait(200);
  const after = (await sess(id)).last_seen_at.getTime();
  assert.ok(Date.now() - after < 10_000, 'the ping moved last_seen_at to now');
  assert.ok(Math.abs(new Date((await c.get('/auth/me')).data.session.idle_expires_at).getTime() - (after + 60 * 60_000)) < 2000);
  // any request the user makes carries the header too
  await ageBy(id, 50);
  assert.equal((await c.get('/tracker/summary', ACT)).status, 200);
  await wait(200);
  assert.ok(Date.now() - (await sess(id)).last_seen_at.getTime() < 10_000);
  // X-ETS-Live wins over X-ETS-Activity (an automatic reload is never activity); presence never counts
  await ageBy(id, 50);
  const aged = (await sess(id)).last_seen_at.getTime();
  presence.resetPresenceState();
  await c.get('/tracker/summary', { ...ACT, ...LIVE });
  await c.post('/presence', { path: '/', screen: 'dashboard' }, ACT);
  await wait(200);
  assert.equal((await sess(id)).last_seen_at.getTime(), aged);
  // the ping needs a session
  assert.equal((await client().post('/auth/activity', {}, ACT)).status, 401);
});

test('the absolute limit ends a session however active it is', { skip }, async () => {
  const c = await signedIn('hred');
  const id = sidOf(c);
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id=$1`, [id]);
  const r = await c.post('/auth/activity', {}, ACT);
  assert.equal(r.status, 401);
  assert.equal((await sess(id)).revoke_reason, 'expired');
  assert.equal((await c.get('/auth/me')).data.authenticated, false);
});

test('the web app\'s idle sign-out revokes the session on the server and clears the cookie', { skip }, async () => {
  const c = await signedIn('hred');
  const id = sidOf(c);
  const token = c.cookie;
  const r = await c.post('/auth/logout', { reason: 'idle' });
  assert.equal(r.status, 200);
  assert.match(r.setCookie || '', /ets_sid=;/);
  const s = await sess(id);
  assert.ok(s.revoked_at);
  assert.equal(s.revoke_reason, 'idle_timeout');
  const log = (await pool.query(`SELECT detail FROM auth_log WHERE event='logout' AND username='hred' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(log.detail?.reason, 'idle');
  c.cookie = token;
  assert.equal((await c.get('/auth/me')).data.authenticated, false);
  c.cookie = token;
  assert.equal((await c.get('/tracker/summary', ACT)).status, 401);
  // an unknown reason is an ordinary sign-out
  const d = await signedIn('hred');
  const did = sidOf(d);
  await d.post('/auth/logout', { reason: 'whatever' });
  assert.equal((await sess(did)).revoke_reason, 'logout');
});

test('/auth/me tells the app the idle limit and when the session ends; reading it is not activity', { skip }, async () => {
  const c = await signedIn('hred');
  const id = sidOf(c);
  await ageBy(id, 10);
  const before = (await sess(id)).last_seen_at.getTime();
  const me = (await c.get('/auth/me')).data;
  assert.equal(me.session.idle_minutes, 60);
  assert.ok(Math.abs(new Date(me.session.idle_expires_at).getTime() - (before + 60 * 60_000)) < 2000);
  assert.ok(new Date(me.session.expires_at) > new Date());
  assert.ok(Math.abs(new Date(me.session.server_now).getTime() - Date.now()) < 5000);
  await wait(200);
  assert.equal((await sess(id)).last_seen_at.getTime(), before);
});

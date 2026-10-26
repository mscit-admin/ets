// Dashboard users-overview aggregate (1.12.9): GET /api/dashboard/users-overview — counts only, and gated by the
// same permission as the Users screen ('usr' + the admin role). Needs TEST_DATABASE_URL like api.test.js: the
// public schema of that database is DROPPED and recreated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool, sha256;
const ids = {};

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
  ({ sha256 } = await import('../src/services/crypto.js'));
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  // root: admin (tfa off). ed1: editor, 2FA enabled, scoped to hr. obs1: observer, 2FA-exempt, scoped to hr.
  // qa1: tester, DISABLED, scoped to hr. del1: editor, soft-deleted.
  const u = await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password,is_active,totp_enabled,totp_exempt) VALUES
    ('root','Root Admin',$1,'admin',false,true,false,false),
    ('ed1','Editor One',$1,'ed',false,true,true,false),
    ('obs1','Observer One',$1,'obs',false,true,false,true),
    ('qa1','Tester One',$1,'qa',false,false,false,false),
    ('del1','Deleted One',$1,'ed',false,true,false,false)
    RETURNING id, username`, [h]);
  for (const x of u.rows) ids[x.username] = x.id;
  await pool.query(`UPDATE users SET deleted_at=now(), deleted_by=$1, delete_reason='test' WHERE username='del1'`, [ids.root]);
  await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) SELECT id,'department','hr' FROM users WHERE username IN ('ed1','obs1','qa1')`);
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
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
  return {
    get sessionId() { return sha256(decodeURIComponent(cookie.split('=')[1])); },
    get: (p, h) => call('GET', p, undefined, h),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}
const signedIn = async name => { const c = client(); assert.equal((await c.login(name)).status, 200); return c; };

test('GET /dashboard/users-overview: shape and counts on seeded data', { skip }, async () => {
  const admin = await signedIn('root');
  const r = await admin.get('/dashboard/users-overview');
  assert.equal(r.status, 200);
  const d = r.data;
  // lifecycle (del1 excluded from total/active; counted as deleted)
  assert.equal(d.total, 4);
  assert.equal(d.active, 3);
  assert.equal(d.inactive, 1);
  assert.equal(d.deleted, 1);
  // 2FA split over the 4 non-deleted accounts
  assert.deepEqual(d.tfa, { enabled: 1, exempt: 1, off: 2 });
  // roles cover every seeded role and sum to the non-deleted total; no per-user data leaks in
  const byRole = Object.fromEntries(d.roles.map(x => [x.id, x.count]));
  assert.equal(byRole.admin, 1); assert.equal(byRole.ed, 1); assert.equal(byRole.obs, 1); assert.equal(byRole.qa, 1);
  assert.equal(byRole.mgr, 0);
  assert.equal(d.roles.reduce((a, x) => a + x.count, 0), 4);
  for (const x of d.roles) { assert.ok(x.name_ar && x.name_en); assert.ok(!('username' in x) && !('email' in x)); }
  // departments: active, non-deleted, scoped users per department (ed1 + obs1 in hr; qa1 disabled, del1 deleted)
  const hr = d.departments.find(x => x.id === 'hr');
  assert.equal(hr.count, 2);
  assert.ok(d.departments.every(x => typeof x.count === 'number'));
  // presence: no sessions online yet
  assert.equal(d.online, 0);
  assert.equal(d.offline, d.active);
});

test('online count reflects a valid, recently-seen session (distinct users)', { skip }, async () => {
  // a valid session + presence row for root, seen just now → online = 1, offline = active - 1
  const sid = sha256('online-session-token');
  await pool.query(`INSERT INTO sessions(id,user_id,mfa_passed,expires_at,last_seen_at,login_at)
    VALUES ($1,$2,true, now()+interval '1 hour', now(), now())`, [sid, ids.root]);
  await pool.query(`INSERT INTO user_presence(session_id,user_id,client,current_path,current_screen,last_seen)
    VALUES ($1,$2,'web','/','dashboard', now())`, [sid, ids.root]);
  const admin = await signedIn('root');
  const d = (await admin.get('/dashboard/users-overview')).data;
  assert.equal(d.online, 1);
  assert.equal(d.offline, d.active - 1);
});

test("'usr' + admin role is enforced (non-admin 403, signed-out 401)", { skip }, async () => {
  // obs1 is a fully signed-in non-admin (no 2FA) and holds no 'usr' (only the admin role does) → 403
  const obs = await signedIn('obs1');
  assert.equal((await obs.get('/dashboard/users-overview')).status, 403);
  // signed out → 401
  assert.equal((await client().get('/dashboard/users-overview')).status, 401);
});

// Bulk user import (POST /api/users/import/preview and /api/users/import). Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const LOG_DIR = new URL('../logs-test', import.meta.url).pathname;

let server, base, pool, checkPolicy, verifyPassword;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '50', LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  let hashPassword;
  ({ hashPassword, checkPolicy, verifyPassword } = await import('../src/services/passwords.js'));
  const h = await hashPassword('Passw0rd-123');
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('root','Root Admin',$1,'admin',false), ('pmu','PM',$1,'pm',false), ('Existing.User','Existing',$1,'obs',false)`, [h]);
  await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) SELECT id,'department','hr' FROM users WHERE username='Existing.User'`);
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  server.close();
  await new Promise(r => setTimeout(r, 200));
  await pool.end();
});

function client() {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const row = (username, extra = {}) => ({ username, full_name: 'Name ' + username, role: 'obs', departments: 'hr', ...extra });
const countUsers = async () => (await pool.query('SELECT count(*)::int n FROM users')).rows[0].n;
const errorsOf = r => r.data.results.map(x => x.errors);

test('preview: every error code, nothing written', { skip }, async () => {
  const root = await as('root');
  const before = await countUsers();
  const rows = [
    row('good.one'),                                              // 0 ok
    row('existing.user'),                                         // 1 username_taken (case-insensitive)
    row('Dup.Name'), row('dup.name'),                             // 2,3 duplicate_in_file
    row('x'),                                                     // 4 invalid_username
    row('bad name!'),                                             // 5 invalid_username
    row('noname', { full_name: '   ' }),                         // 6 full_name_required
    row('bademail', { email: 'not-an-email' }),                   // 7 invalid_email
    row('badrole', { role: 'superuser' }),                        // 8 invalid_role
    row('badlang', { language: 'fr' }),                           // 9 invalid_language
    row('badscope', { departments: 'hr, nope' }),                 // 10 invalid_scope
    row('noscope', { departments: '' }),                          // 11 scope_required
    row('usrgrant', { overrides: [{ permission: 'usr', granted: true }] }),   // 12 usr_admin_only
    row('pm.ok', { role: 'pm', departments: '' }),                // 13 ok: full-scope role needs no scope
    row('apps.ok', { role: 'member', departments: '', applications: 'per,rec' }),  // 14 ok
    row('AdminNew', { role: 'admin', departments: '', language: 'EN', email: ' a@b.ly ' }), // 15 ok
    'not an object',                                              // 16 invalid_row
  ];
  const r = await root.post('/users/import/preview', { rows });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = errorsOf(r);
  assert.deepEqual(e[0], []);
  assert.deepEqual(e[1], ['username_taken']);
  assert.deepEqual(e[2], ['duplicate_in_file']);
  assert.deepEqual(e[3], ['duplicate_in_file']);
  assert.deepEqual(e[4], ['invalid_username']);
  assert.deepEqual(e[5], ['invalid_username']);
  assert.deepEqual(e[6], ['full_name_required']);
  assert.deepEqual(e[7], ['invalid_email']);
  assert.deepEqual(e[8], ['invalid_role']);
  assert.deepEqual(e[9], ['invalid_language']);
  assert.deepEqual(e[10], ['invalid_scope']);
  assert.deepEqual(e[11], ['scope_required']);
  assert.deepEqual(e[12], ['usr_admin_only']);
  assert.deepEqual(e[13], []);
  assert.deepEqual(e[14], []);
  assert.deepEqual(e[15], []);
  assert.deepEqual(e[16], ['invalid_row']);
  assert.equal(r.data.ok, 4);
  assert.equal(r.data.errors, rows.length - 4);
  assert.equal(r.data.results[0].status, 'ok');
  assert.equal(r.data.results[1].status, 'error');
  // the answer never carries passwords or the values to insert
  assert.ok(!JSON.stringify(r.data).includes('password'));
  assert.equal(await countUsers(), before);
  // an administrator may grant 'usr' to an admin row; a bidi control character is removed like everywhere else
  const ok = await root.post('/users/import/preview', { rows: [row('adm‮in', { role: 'admin', overrides: [{ permission: 'usr', granted: true }] })] });
  assert.deepEqual(ok.data.results[0], { index: 0, username: 'admin', status: 'ok', errors: [] });
});

test('request shape and size: no rows, > 500 rows, larger body only after admin auth', { skip }, async () => {
  const root = await as('root');
  for (const p of ['/users/import/preview', '/users/import']) {
    assert.equal((await root.post(p, { rows: [] })).data.error, 'invalid_value', p);
    assert.equal((await root.post(p, { rows: 'x' })).data.error, 'invalid_value', p);
    const many = await root.post(p, { rows: Array.from({ length: 501 }, (_, i) => row('u' + i)) });
    assert.equal(many.status, 400, p);
    assert.equal(many.data.error, 'too_many_rows');
    assert.equal(many.data.max, 500);
  }
  // 500 rows with long names: more than the global 100 kB, accepted on this route
  const big = Array.from({ length: 500 }, (_, i) => row('big' + i, { full_name: 'ن'.repeat(110) }));
  assert.ok(Buffer.byteLength(JSON.stringify({ rows: big })) > 100 * 1024);
  const pv = await root.post('/users/import/preview', { rows: big });
  assert.equal(pv.status, 200);
  assert.equal(pv.data.ok, 500);
  // over 1 MB → 413
  const huge = JSON.stringify({ rows: [row('h1', { full_name: 'x'.repeat(1_100_000) })] });
  assert.equal((await root.post('/users/import/preview', huge)).status, 413);
  // a non-administrator is refused before the large body is read
  const pm = await as('pmu');
  assert.equal((await pm.post('/users/import/preview', huge)).status, 403);
  assert.equal((await pm.post('/users/import/preview', { rows: [row('pm.try')] })).status, 403);
  assert.equal((await pm.post('/users/import', { rows: [row('pm.try')] })).status, 403);
  assert.equal((await client().post('/users/import', { rows: [row('anon.try')] })).status, 401);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE username IN ('pm.try','anon.try')`)).rows[0].n, 0);
});

test('import is all-or-nothing: one bad row → nothing created, errors returned', { skip }, async () => {
  const root = await as('root');
  const before = await countUsers();
  const auditBefore = (await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n;
  const r = await root.post('/users/import', { rows: [row('ok.a'), row('ok.b'), row('EXISTING.USER')] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'import_has_errors');
  assert.deepEqual(errorsOf(r), [[], [], ['username_taken']]);
  assert.ok(!('users' in r.data));
  assert.equal(await countUsers(), before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n, auditBefore);
  // duplicate inside the file, scope missing, usr for a non-admin: refused the same way at commit
  for (const rows of [[row('d1'), row('D1')], [row('s1', { departments: '' })], [row('g1', { overrides: [{ permission: 'usr', granted: true }] })]]) {
    const x = await root.post('/users/import', { rows });
    assert.equal(x.data.error, 'import_has_errors', JSON.stringify(rows));
  }
  assert.equal(await countUsers(), before);
});

test('import creates every row once, with one-time passwords, forced change and audit rows without passwords', { skip }, async () => {
  const root = await as('root');
  const rows = [
    row('imp.ali', { full_name: 'علي محمد', email: 'ali@example.ly', language: 'en', departments: 'hr، fin' }),
    row('imp.sara', { role: 'member', departments: '', applications: 'per' }),
    row('imp.admin', { role: 'admin', departments: '' }),
    row('imp.lead', { role: 'lead', departments: ['fin'], overrides: [{ permission: 'tst', granted: false }] }),
  ];
  const r = await root.post('/users/import', { rows });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.created, 4);
  const pws = Object.fromEntries(r.data.users.map(u => [u.username, u.temporary_password]));
  assert.deepEqual(Object.keys(pws), ['imp.ali', 'imp.sara', 'imp.admin', 'imp.lead']);
  for (const [u, pw] of Object.entries(pws)) {
    assert.deepEqual(checkPolicy(pw, { minLength: 10, username: u, admin: u === 'imp.admin' }), [], u);
    assert.ok(pw.length >= 16 && /^[a-km-zA-HJ-NP-Z2-9]+$/.test(pw), pw);   // no 0 O o 1 l I
  }
  assert.equal(new Set(Object.values(pws)).size, 4);
  const db = (await pool.query(`SELECT u.*, (SELECT json_agg(s.kind||':'||s.ref_id ORDER BY s.kind, s.ref_id) FROM user_scopes s WHERE s.user_id=u.id) AS sc,
      (SELECT json_agg(p.permission||':'||p.granted) FROM user_permissions p WHERE p.user_id=u.id) AS ov
    FROM users u WHERE username LIKE 'imp.%' ORDER BY username`)).rows;
  const by = Object.fromEntries(db.map(u => [u.username, u]));
  for (const u of db) {
    assert.equal(u.must_change_password, true);
    assert.equal(u.is_active, true);
    assert.ok(u.password_hash.startsWith('$2'));
    assert.ok(await verifyPassword(pws[u.username], u.password_hash));
  }
  assert.equal(by['imp.ali'].full_name, 'علي محمد');
  assert.equal(by['imp.ali'].email, 'ali@example.ly');
  assert.equal(by['imp.ali'].language, 'en');
  assert.deepEqual(by['imp.ali'].sc, ['department:fin', 'department:hr']);
  assert.equal(by['imp.sara'].language, 'ar');                 // Settings → default language
  assert.deepEqual(by['imp.sara'].sc, ['application:per']);
  assert.equal(by['imp.admin'].sc, null);
  assert.deepEqual(by['imp.lead'].ov, ['tst:false']);

  // the same file again: every row is now taken
  const again = await root.post('/users/import/preview', { rows });
  assert.deepEqual(errorsOf(again), [['username_taken'], ['username_taken'], ['username_taken'], ['username_taken']]);

  // sign in with the temporary password: the change is forced before anything else
  const c = client();
  assert.equal((await c.login('imp.ali', pws['imp.ali'])).data.stage, 'done');
  assert.equal((await c.get('/tracker/summary')).data.error, 'password_change_required');
  assert.equal((await c.post('/auth/change-password', { current_password: pws['imp.ali'], new_password: 'Ali-Own-Pass-2026' })).status, 200);
  assert.equal((await c.get('/tracker/summary')).status, 200);
  const adm = client();
  assert.equal((await adm.login('imp.admin', pws['imp.admin'])).data.stage, 'done');
  assert.equal((await adm.get('/users')).data.error, 'password_change_required');

  // audit: one create row per user (same shape as a single create) + one bulk_create row, no password anywhere
  const audit = (await pool.query(`SELECT * FROM audit_log WHERE entity='user' AND action IN ('create','bulk_create') ORDER BY chain_seq`)).rows;
  const creates = audit.filter(a => a.action === 'create');
  assert.deepEqual(creates.map(a => a.summary), ['imp.ali', 'imp.sara', 'imp.admin', 'imp.lead']);
  assert.deepEqual(creates.map(a => a.entity_id), ['imp.ali', 'imp.sara', 'imp.admin', 'imp.lead'].map(u => String(by[u].id)));
  const nv = creates[0].new_value;
  assert.deepEqual(Object.keys(nv).sort(), ['email', 'full_name', 'is_active', 'language', 'must_change_password', 'overrides', 'role_id', 'scopes', 'totp_exempt', 'username']);
  assert.deepEqual(creates[0].context, { via: 'bulk_import' });
  const bulk = audit.filter(a => a.action === 'bulk_create');
  assert.equal(bulk.length, 1);
  assert.equal(bulk[0].new_value.count, 4);
  assert.deepEqual(bulk[0].new_value.usernames, ['imp.ali', 'imp.sara', 'imp.admin', 'imp.lead']);
  assert.equal(bulk[0].username, 'root');
  const everything = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows) +
    JSON.stringify((await pool.query('SELECT * FROM auth_log')).rows) +
    JSON.stringify((await pool.query('SELECT * FROM access_log')).rows) +
    fs.readdirSync(LOG_DIR).map(f => fs.readFileSync(path.join(LOG_DIR, f), 'utf8')).join('\n');
  for (const pw of Object.values(pws)) assert.ok(!everything.includes(pw), 'temporary password found in a log');
  for (const a of audit) assert.ok(!/password_hash|temporary_password|"password"/.test(JSON.stringify(a)));
});

test('a username taken while the import runs (unique key) rolls everything back', { skip }, async () => {
  const root = await as('root');
  const before = await countUsers();
  const auditBefore = (await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n;
  // the checks pass, then the 30th insert hits the unique key, as when another administrator created that name meanwhile
  await pool.query(`CREATE FUNCTION race_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.username = 'race29' THEN RAISE EXCEPTION 'duplicate' USING ERRCODE = 'unique_violation'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER race_tr BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION race_fn();`);
  try {
    const r = await root.post('/users/import', { rows: Array.from({ length: 30 }, (_, i) => row('race' + i)) });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'import_has_errors');
    assert.ok(!('users' in r.data));
  } finally {
    await pool.query('DROP TRIGGER race_tr ON users; DROP FUNCTION race_fn();');
  }
  assert.equal(await countUsers(), before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_log')).rows[0].n, auditBefore);
});

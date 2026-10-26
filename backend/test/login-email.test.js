// Sign-in with the username OR the e-mail address (1.6.0): lookup rules, one answer for every failure, one
// failure counter per account whichever name is typed, unique e-mail addresses (users API, import, migration 014).
// Same disposable database as api.test.js (its public schema is DROPPED and recreated):
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Kestrel-2026x';
const ENV = {
  DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
  LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
  MAX_FAILED_LOGINS: '3', LOCK_MINUTES: '15', LOCKOUT_RESET_MINUTES: '60', LOGIN_RATE_LIMIT: '20', LOGIN_IP_RATE_LIMIT: '20', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000',
  ETS_ENV_FILE: 'none',
};

let server, base, pool, migrate, totp, encrypt;

before(async () => {
  if (skip) return;
  Object.assign(process.env, ENV);
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  ({ migrate } = await import('../src/db/migrate.js'));
  await migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  ({ totp } = await import('../src/services/totp.js'));
  ({ encrypt } = await import('../src/services/crypto.js'));
  const h = await (await import('../src/services/passwords.js')).hashPassword(PW);
  const users = [
    ['boss', 'boss@ets.ly', 'admin', true, false], ['Sara.K', 'sara.k@ets.ly', 'qa', true, false],
    ['lockme', 'lockme@ets.ly', 'qa', true, false], ['gone', 'gone@ets.ly', 'qa', false, false],
    ['twofa', 'twofa@ets.ly', 'qa', true, false], ['newbie', 'newbie@ets.ly', 'qa', true, true],
    ['dup1', 'dup1@ets.ly', 'qa', true, false], ['dup2', 'dup2@ets.ly', 'qa', true, false],
    ['noemail', null, 'qa', true, false],
  ];
  for (const [n, e, role, active, mustChange] of users) {
    await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id,is_active,must_change_password)
      VALUES ($1,$7,$2,$3,$4,$5,$6)`, [n, e, h, role, active, mustChange, n]);
  }
  await pool.query(`UPDATE settings SET value='"optional"' WHERE key='mfa.mode'`);
  (await import('../src/services/settings.js')).invalidateSettings();
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

// Cookie-keeping client, each from its own address so the per-IP limiter of one test does not touch the others.
let ipSeq = 0;
function client(ip = `10.14.${Math.floor(++ipSeq / 250)}.${ipSeq % 250 + 1}`) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', 'x-forwarded-for': ip, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b = {}) => call('PATCH', p, b),
    login: (u, pw = PW) => call('POST', '/auth/login', { username: u, password: pw }),
  };
}
const user = async n => (await pool.query('SELECT * FROM users WHERE username=$1', [n])).rows[0];
const lastAuth = async (event, extra = '') =>
  (await pool.query(`SELECT * FROM auth_log WHERE event=$1 ${extra} ORDER BY id DESC LIMIT 1`, [event])).rows[0];
const indexExists = async () => (await pool.query(`SELECT to_regclass('users_email_lower_uniq') IS NOT NULL AS ok`)).rows[0].ok;
const admin = async () => { const c = client(); assert.equal((await c.login('boss')).data.stage, 'done'); return c; };

test('login by username still works, and is logged with via=username', { skip }, async () => {
  const c = client();
  const r = await c.login('sara.k');                    // case-insensitive as before
  assert.equal(r.status, 200);
  assert.equal(r.data.stage, 'done');
  assert.equal((await c.get('/auth/me')).data.user.username, 'Sara.K');
  const row = await lastAuth('login', `AND username='Sara.K'`);
  assert.deepEqual({ via: row.detail.via, identifier: row.detail.identifier }, { via: 'username', identifier: 'sara.k' });
});

test('login by e-mail: any case, surrounding spaces; logged with the resolved account and via=email', { skip }, async () => {
  for (const typed of ['sara.k@ets.ly', '  SARA.K@Ets.LY  ', '\tSara.K@ets.ly ']) {
    const c = client();
    const r = await c.login(typed);
    assert.equal(r.status, 200, typed);
    assert.equal(r.data.stage, 'done');
    const me = (await c.get('/auth/me')).data;
    assert.equal(me.user.username, 'Sara.K');
  }
  const u = await user('Sara.K');
  const row = await lastAuth('login', `AND user_id=${u.id}`);
  assert.equal(row.username, 'Sara.K');
  assert.deepEqual({ via: row.detail.via, identifier: row.detail.identifier }, { via: 'email', identifier: 'sara.k@ets.ly' });
  assert.ok(u.last_login_at);
});

test('every failure gets the same answer: wrong password by e-mail / username, unknown name or e-mail, inactive', { skip }, async () => {
  const shape = r => ({ status: r.status, body: JSON.stringify(r.data), cookie: !!r.headers.get('set-cookie') });
  const answers = [
    await client().login('dup1', 'Wrong-pass-2026'),
    await client().login('dup1@ets.ly', 'Wrong-pass-2026'),
    await client().login('no.such.user', 'Wrong-pass-2026'),
    await client().login('nobody@ets.ly', 'Wrong-pass-2026'),
    await client().login('gone', PW),                       // inactive, right password
    await client().login('GONE@ets.ly', PW),
  ];
  const first = shape(answers[0]);
  assert.deepEqual(first, { status: 401, body: JSON.stringify({ error: 'invalid_credentials' }), cookie: false });
  for (const a of answers) assert.deepEqual(shape(a), first);
  // the unknown e-mail is masked in the log like an unknown username (it may be a password typed in the wrong field)
  const unknown = await lastAuth('login_unknown_user');
  assert.match(unknown.username, /^\?\*\*\*#[0-9a-f]{12}$/);
  assert.deepEqual(unknown.detail, { via: 'email' });
  const inactive = await lastAuth('login_inactive_user');
  assert.equal(inactive.detail.via, 'email');
  await pool.query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE username='dup1'`);
});

test('the account lockout counts failures through the username and the e-mail address together', { skip }, async () => {
  // MAX_FAILED_LOGINS=3: one failure by username, one by e-mail, one by username → paused
  assert.equal((await client().login('lockme', 'bad-1')).status, 401);
  assert.equal((await client().login('LockMe@ets.ly', 'bad-2')).status, 401);
  assert.equal((await user('lockme')).failed_attempts, 2);
  assert.equal((await client().login('LOCKME', 'bad-3')).status, 401);
  const u = await user('lockme');
  assert.equal(u.failed_attempts, 3);
  assert.ok(new Date(u.locked_until) > new Date());
  // while paused the right password fails by either name, with the same answer
  for (const n of ['lockme', 'lockme@ets.ly']) {
    const r = await client().login(n);
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'invalid_credentials');
  }
  const fails = (await pool.query(`SELECT detail->>'via' AS via FROM auth_log WHERE user_id=$1 AND event='login_bad_password' ORDER BY id`, [u.id])).rows;
  assert.deepEqual(fails.map(x => x.via), ['username', 'email', 'username']);
  assert.equal((await lastAuth('login_while_locked', `AND user_id=${u.id}`)).detail.via, 'email');
  // pause over: the e-mail address signs in and clears the counter
  await pool.query(`UPDATE users SET locked_until=now() - interval '1 second' WHERE username='lockme'`);
  assert.equal((await client().login('lockme@ets.ly')).data.stage, 'done');
  assert.equal((await user('lockme')).failed_attempts, 0);
});

test('the per-name rate limit treats case and spaces of the typed name as the same name', { skip }, async () => {
  // LOGIN_RATE_LIMIT=20 failed attempts per name; every attempt from a different address
  const variants = ['ghost@ets.ly', ' GHOST@ets.ly', 'Ghost@Ets.Ly  '];
  let last;
  for (let i = 0; i < 21; i++) last = await client().login(variants[i % 3], 'x-wrong-x');
  assert.equal(last.status, 429);
  assert.equal(last.data.error, 'too_many_attempts');
});

test('2FA users signing in by e-mail still get the 2FA step', { skip }, async () => {
  const secret = (await import('../src/services/totp.js')).generateSecret();
  await pool.query('UPDATE users SET totp_secret=$2, totp_enabled=true WHERE username=$1', ['twofa', encrypt(secret)]);
  const c = client();
  const r = await c.login(' TwoFA@ets.ly ');
  assert.equal(r.data.stage, 'verify');
  const me = (await c.get('/auth/me')).data;
  assert.equal(me.stage, 'verify');
  assert.equal(me.user.username, 'twofa');
  assert.equal((await lastAuth('password_ok_mfa_pending')).detail.via, 'email');
  assert.equal((await c.post('/auth/2fa/verify', { code: totp(secret) })).data.stage, 'done');
  assert.equal((await c.get('/auth/me')).data.stage, 'done');
});

test('a forced password change still applies after signing in by e-mail', { skip }, async () => {
  const c = client();
  assert.equal((await c.login('newbie@ets.ly')).data.stage, 'done');
  assert.equal((await c.get('/auth/me')).data.user.must_change_password, true);
  assert.equal((await c.get('/users')).status, 403);
});

test('an e-mail address shared by two accounts (index missing) signs nobody in by e-mail; usernames still work', { skip }, async () => {
  assert.ok(await indexExists(), 'clean database: migration 014 created the index');
  await assert.rejects(pool.query(`UPDATE users SET email='DUP1@ets.ly' WHERE username='dup2'`), e => e.code === '23505');
  await pool.query('DROP INDEX users_email_lower_uniq');
  await pool.query(`UPDATE users SET email='Shared@ets.ly' WHERE username='dup1'`);
  await pool.query(`UPDATE users SET email='shared@ets.ly' WHERE username='dup2'`);
  try {
    const r = await client().login('shared@ets.ly');
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { error: 'invalid_credentials' });
    const row = await lastAuth('login_ambiguous_email');
    assert.equal(row.user_id, null);
    assert.equal(row.detail.via, 'email');
    // neither account counts a failure
    assert.equal((await user('dup1')).failed_attempts, 0);
    assert.equal((await user('dup2')).failed_attempts, 0);
    assert.equal((await client().login('dup1')).data.stage, 'done');
    assert.equal((await client().login('dup2')).data.stage, 'done');
    // an administrator can still edit such an account (unchanged address) and give it its own address
    const boss = await admin();
    const id = (await user('dup2')).id;
    assert.equal((await boss.patch('/users/' + id, { full_name: 'Dup Two', email: 'shared@ets.ly' })).status, 200);
    assert.equal((await boss.patch('/users/' + id, { email: 'SHARED@ets.ly' })).status, 200);
    const other = (await user('dup1')).id;
    assert.equal((await boss.patch('/users/' + other, { email: 'dup2@ets.ly' })).status, 200);
    // shared@ets.ly is dup2's alone now: dup1 cannot take it back
    assert.equal((await boss.patch('/users/' + other, { email: 'Shared@ets.ly' })).data.error, 'email_taken');
  } finally {
    await pool.query(`UPDATE users SET email='dup1@ets.ly' WHERE username='dup1'`);
    await pool.query(`UPDATE users SET email='dup2@ets.ly' WHERE username='dup2'`);
    await pool.query('SELECT ets_ensure_email_unique_index()');
  }
  assert.ok(await indexExists());
});

test('migration 014 on data with duplicate e-mails: no failure, a NOTICE, no index; the next run creates it', { skip }, async () => {
  // back to the state before 014, with two accounts sharing an address in different case
  await pool.query('DROP INDEX users_email_lower_uniq');
  await pool.query('DROP FUNCTION ets_ensure_email_unique_index()');
  await pool.query(`DELETE FROM schema_migrations WHERE version='014_login_email.sql'`);
  await pool.query(`UPDATE users SET email='Same@ets.ly' WHERE username='dup1'`);
  await pool.query(`UPDATE users SET email='same@ETS.ly' WHERE username='dup2'`);
  const lines = [];
  const applied = await migrate({ log: m => lines.push(m) });
  assert.deepEqual(applied, ['014_login_email.sql']);
  assert.equal(await indexExists(), false);
  const notice = lines.find(l => l.startsWith('notice:'));
  assert.match(notice, /1 e-mail address\(es\) are used by more than one account; the unique e-mail index was not created/);
  assert.match(notice, /same@ets\.ly/);
  const warn = (await pool.query(`SELECT * FROM system_log WHERE event='email_index_skipped' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(warn.level, 'warn');
  assert.deepEqual(warn.detail.duplicates, [{ email: 'same@ets.ly', accounts: 2 }]);
  // still duplicated: a later run changes nothing and says so again
  const again = [];
  assert.deepEqual(await migrate({ log: m => again.push(m) }), []);
  assert.equal(await indexExists(), false);
  assert.ok(again.some(l => l.startsWith('notice:')));
  // duplicates fixed: the next run (every update runs it) creates the index
  await pool.query(`UPDATE users SET email='dup2@ets.ly' WHERE username='dup2'`);
  const fixed = [];
  await migrate({ log: m => fixed.push(m) });
  assert.ok(await indexExists());
  assert.ok(fixed.includes('created the unique e-mail index (users_email_lower_uniq)'));
  await pool.query(`UPDATE users SET email='dup1@ets.ly' WHERE username='dup1'`);
});

test('users API: e-mail stored trimmed in lower case, duplicates (any case) and "@" in usernames refused', { skip }, async () => {
  const boss = await admin();
  const base = { full_name: 'New Person', role_id: 'obs', password: 'Harbour-Lantern-77', scopes: [{ kind: 'department', ref_id: 'hr' }] };
  const created = await boss.post('/users', { ...base, username: 'new.person', email: '  New.Person@ETS.ly ' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.email, 'new.person@ets.ly');
  // create: taken address in another case; "@" in the username
  assert.equal((await boss.post('/users', { ...base, username: 'other.one', email: 'SARA.K@ets.ly' })).data.error, 'email_taken');
  assert.equal((await boss.post('/users', { ...base, username: 'x@ets.ly', email: '' })).data.error, 'invalid_username');
  assert.equal((await boss.post('/users', { ...base, username: 'a@b' })).data.error, 'invalid_username');
  // update: taken address; "@" in a new username; own address in another case is fine
  const id = created.data.user.id;
  assert.equal((await boss.patch('/users/' + id, { email: 'Boss@ets.ly' })).data.error, 'email_taken');
  assert.equal((await boss.patch('/users/' + id, { username: 'new@person' })).data.error, 'invalid_username');
  const same = await boss.patch('/users/' + id, { email: 'NEW.PERSON@ets.ly' });
  assert.equal(same.status, 200);
  assert.equal(same.data.user.email, 'new.person@ets.ly');
  // the new account signs in by its address
  assert.equal((await client().login('New.Person@ets.ly', 'Harbour-Lantern-77')).data.stage, 'done');
});

test('import: taken e-mail, the same e-mail twice in the file and "@" in a username are row errors', { skip }, async () => {
  const boss = await admin();
  const row = (username, extra = {}) => ({ username, full_name: 'Name ' + username, role: 'obs', departments: 'hr', ...extra });
  const r = await boss.post('/users/import/preview', { rows: [
    row('imp.one', { email: ' Twofa@ETS.ly ' }),       // 0 taken by an account (other case, spaces)
    row('imp.two', { email: 'same@file.ly' }),         // 1 + 2 the same address twice in the file
    row('imp.three', { email: 'SAME@file.ly' }),
    row('imp@four', { email: 'four@file.ly' }),        // 3 "@" in the username
    row('imp.five', { email: ' Five@File.LY ' }),      // 4 ok
  ] });
  assert.equal(r.status, 200);
  const errs = r.data.results.map(x => x.errors);
  assert.deepEqual(errs, [['email_taken'], ['duplicate_email_in_file'], ['duplicate_email_in_file'], ['invalid_username'], []]);
  assert.deepEqual(r.data.results[0].details, [{ code: 'email_taken', field: 'email', value: 'twofa@ets.ly' }]);
  const ok = await boss.post('/users/import', { rows: [row('imp.five', { email: ' Five@File.LY ' })] });
  assert.equal(ok.status, 201);
  assert.equal((await user('imp.five')).email, 'five@file.ly');
  // the whole import is refused when a row is
  const refused = await boss.post('/users/import', { rows: [row('imp.six', { email: 'five@FILE.ly' })] });
  assert.equal(refused.data.error, 'import_has_errors');
  assert.deepEqual(refused.data.results[0].errors, ['email_taken']);
});

test('an older account with "@" in its username still signs in with it, and can still be edited', { skip }, async () => {
  const h = (await user('boss')).password_hash;
  await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id) VALUES ('old@legacy.ly','Old','other@legacy.ly',$1,'qa')`, [h]);
  const c = client();
  const r = await c.login(' OLD@legacy.ly ');
  assert.equal(r.data.stage, 'done');
  assert.equal((await c.get('/auth/me')).data.user.username, 'old@legacy.ly');
  assert.equal((await lastAuth('login', `AND username='old@legacy.ly'`)).detail.via, 'username');
  // its own e-mail address works as well
  assert.equal((await client().login('other@legacy.ly')).data.stage, 'done');
  // the edit form sends the username back unchanged: accepted; a new address equal to that username is refused
  const boss = await admin();
  const id = (await user('old@legacy.ly')).id;
  assert.equal((await boss.patch('/users/' + id, { username: 'old@legacy.ly', full_name: 'Old Account' })).status, 200);
  assert.equal((await boss.patch('/users/' + (await user('noemail')).id, { email: 'Old@Legacy.ly' })).data.error, 'email_taken');
});

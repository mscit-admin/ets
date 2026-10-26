// Sign-in hardening (security remediation 1.0.0, WP1): lockout model, rate limits, session rotation,
// 2FA step-up, replay races, recovery codes. Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Kestrel-2026x';
const ENV = {
  DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
  LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
  MAX_FAILED_LOGINS: '3', LOCK_MINUTES: '15', LOCKOUT_RESET_MINUTES: '60', LOGIN_RATE_LIMIT: '20', LOGIN_IP_RATE_LIMIT: '20', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000',
  ETS_ENV_FILE: 'none',
};

let server, base, pool, totp, encrypt, hashPassword;

before(async () => {
  if (skip) return;
  Object.assign(process.env, ENV);
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  ({ totp } = await import('../src/services/totp.js'));
  ({ encrypt } = await import('../src/services/crypto.js'));
  ({ hashPassword } = await import('../src/services/passwords.js'));
  const h = await hashPassword(PW);
  const names = ['boss', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p2', 'p3', 'p4', 'e1', 'e2', 'rh', 'chg'];
  for (const n of names) {
    await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id,must_change_password) VALUES ($1,$2,$3,$4,$5,$6)`,
      [n, n, n + '@x.ly', h, n === 'boss' ? 'admin' : 'qa', n === 'chg']);
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

// Cookie-keeping client; each one comes from its own address (X-Forwarded-For is trusted from loopback),
// so the per-IP limiter of one test does not affect the others.
let ipSeq = 0;
function client(ip = `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250 + 1}`) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', 'x-forwarded-for': ip, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b),
    login: (u, pw = PW) => call('POST', '/auth/login', { username: u, password: pw }),
    get cookie() { return cookie; }, set cookie(v) { cookie = v; },
  };
}

const user = async n => (await pool.query('SELECT * FROM users WHERE username=$1', [n])).rows[0];
// Enrols 2FA directly in the database; returns the secret.
async function enrol(n) {
  const secret = (await import('../src/services/totp.js')).generateSecret();
  await pool.query('UPDATE users SET totp_secret=$2, totp_enabled=true, totp_last_step=NULL WHERE username=$1', [n, encrypt(secret)]);
  return secret;
}
// A code the server accepts once more: forget the last used step first.
const freshCode = async (n, secret) => { await pool.query('UPDATE users SET totp_last_step=NULL WHERE username=$1', [n]); return totp(secret); };

test('ETS-SEC-001: password success does not reset the counter while 2FA is pending; wrong codes add up', { skip }, async () => {
  const secret = await enrol('m1');
  for (let round = 0; round < 2; round++) {
    const c = client();
    assert.equal((await c.login('m1')).data.stage, 'verify');
    assert.equal((await c.post('/auth/2fa/verify', { code: '000000' })).data.error, 'invalid_code');
    if (round === 0) assert.equal((await c.post('/auth/2fa/verify', { code: '000001' })).data.error, 'invalid_code');
  }
  // 3 wrong codes across two logins → paused (MAX_FAILED_LOGINS=3)
  assert.equal((await user('m1')).failed_attempts, 3);
  const c = client();
  const again = await c.login('m1');
  assert.equal(again.status, 401);
  assert.equal(again.data.error, 'invalid_credentials');
  // the counter is cleared only by a complete sign-in
  await pool.query(`UPDATE users SET locked_until=now() - interval '1 second' WHERE username='m1'`);
  assert.equal((await c.login('m1')).data.stage, 'verify');
  assert.equal((await user('m1')).failed_attempts, 3);
  assert.equal((await c.post('/auth/2fa/verify', { code: await freshCode('m1', secret) })).data.stage, 'done');
  const u = await user('m1');
  assert.equal(u.failed_attempts, 0);
  assert.equal(u.locked_until, null);
});

test('ETS-SEC-001: a paused account answers 429 with retry_after at the 2FA step', { skip }, async () => {
  await enrol('m2');
  const c = client();
  await c.login('m2');
  for (let i = 0; i < 3; i++) await c.post('/auth/2fa/verify', { code: '000000' });
  const r = await c.post('/auth/2fa/verify', { code: '123456' });
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'too_many_attempts');
  assert.ok(r.data.retry_after > 0 && r.data.retry_after <= 60);   // first pause: 1 minute
});

test('ETS-SEC-002: progressive delay, expiry on its own, counter decay', { skip }, async () => {
  const c = client();
  for (let i = 0; i < 3; i++) await c.login('p1', 'wrong-one');
  let u = await user('p1');
  const firstPause = (new Date(u.locked_until) - Date.now()) / 1000;
  assert.ok(firstPause > 50 && firstPause <= 60, `first pause ${firstPause}`);
  // pause over (lock expired on its own): the right password works without an admin
  await pool.query(`UPDATE users SET locked_until=now() - interval '1 second' WHERE username='p1'`);
  // … a further failure within the reset window doubles the pause
  await c.login('p1', 'wrong-two');
  u = await user('p1');
  const second = (new Date(u.locked_until) - Date.now()) / 1000;
  assert.ok(second > 110 && second <= 120, `second pause ${second}`);
  await pool.query(`UPDATE users SET locked_until=now() - interval '1 second' WHERE username='p1'`);
  assert.equal((await c.login('p1')).status, 200);
  assert.equal((await user('p1')).failed_attempts, 0);

  // the pause is capped at LOCK_MINUTES
  await pool.query(`UPDATE users SET failed_attempts=30, last_failed_at=now(), locked_until=NULL WHERE username='p2'`);
  await c.login('p2', 'wrong');
  const capped = (new Date((await user('p2')).locked_until) - Date.now()) / 60000;
  assert.ok(capped > 14.9 && capped <= 15, `capped ${capped}`);

  // decay: the last failure is older than LOCKOUT_RESET_MINUTES → one wrong password does not pause again
  await pool.query(`UPDATE users SET failed_attempts=7, last_failed_at=now() - interval '61 minutes',
    locked_until=now() - interval '46 minutes' WHERE username='p3'`);
  await c.login('p3', 'wrong');
  u = await user('p3');
  assert.equal(u.failed_attempts, 1);
  assert.ok(!u.locked_until || new Date(u.locked_until) < new Date());
  assert.equal((await c.login('p3')).status, 200);
});

test('ETS-SEC-014: paused, unknown and wrong-password logins look the same', { skip }, async () => {
  const seen = { real: [], ghost: [] };
  for (const [who, name] of [['real', 'p4'], ['ghost', 'nobody-here']]) {
    const c = client();
    for (let i = 0; i < 6; i++) { const r = await c.login(name, 'nope-' + i); seen[who].push([r.status, JSON.stringify(r.data)]); }
    const right = await c.login(name);                    // right password while paused / unknown user
    seen[who].push([right.status, JSON.stringify(right.data)]);
  }
  assert.deepEqual(seen.real, seen.ghost);
  assert.ok(seen.real.every(([s, b]) => s === 401 && b === '{"error":"invalid_credentials"}'));
});

test('ETS-SEC-003: per-account limit applies to existing and unknown usernames alike', { skip }, async () => {
  const statuses = { e1: [], 'ghost-user-2': [] };
  for (const name of Object.keys(statuses)) {
    for (let i = 0; i < 21; i++) statuses[name].push((await client().login(name, 'bad-' + i)).status);   // a new IP each time
  }
  assert.deepEqual(statuses.e1, statuses['ghost-user-2']);
  assert.equal(statuses.e1.at(-1), 429);
  assert.ok(statuses.e1.slice(0, 20).every(s => s === 401));
});

test('ETS-SEC-003: per-IP limit on the password / code check endpoints', { skip }, async () => {
  const c = client('10.77.0.1');
  const st = [];
  for (let i = 0; i < 21; i++) st.push((await c.login('ip-probe-' + i, 'x')).status);
  assert.ok(st.slice(0, 20).every(s => s === 401));
  const r = await c.login('another', 'x');
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'too_many_attempts');
  assert.ok(r.data.retry_after > 0);
});

test('ETS-SEC-003: wrong current password on change-password / 2FA endpoints pauses the account and ends the session', { skip }, async () => {
  for (const [path, body] of [
    ['/auth/change-password', { current_password: 'guess', new_password: 'Whatever-2026x' }],
    ['/auth/2fa/recovery-codes', { password: 'guess', code: '000000' }],
    ['/auth/2fa/disable', { password: 'guess', code: '000000' }],
  ]) {
    await pool.query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE username='e2'`);
    const secret = await enrol('e2');
    const c = client();
    assert.equal((await c.login('e2')).data.stage, 'verify');
    await c.post('/auth/2fa/verify', { code: totp(secret) });
    assert.equal((await c.get('/auth/me')).data.stage, 'done');
    const res = [];
    for (let i = 0; i < 4; i++) res.push(await c.post(path, body));
    // 3rd failure (MAX_FAILED_LOGINS) → paused and this session ended; the next request is no longer signed in
    assert.deepEqual(res.map(r => r.status), [400, 400, 429, 401], path);
    assert.equal(res[0].data.error, 'wrong_password');
    assert.equal((await c.get('/auth/me')).data.authenticated, false, path + ': session ended');
  }
  const ev = (await pool.query(`SELECT event FROM auth_log WHERE username='e2'`)).rows.map(x => x.event);
  assert.ok(ev.includes('mfa_recovery_codes_bad_password'));     // now logged
  assert.ok(ev.includes('password_change_bad_current'));
});

test('ETS-SEC-015: new token when 2FA completes; the pre-2FA token and an earlier session stop working', { skip }, async () => {
  const secret = await enrol('m3');
  const old = client();
  assert.equal((await old.login('m3')).data.stage, 'verify');
  await old.post('/auth/2fa/verify', { code: await freshCode('m3', secret) });
  const c = client();
  await c.login('m3');
  const partial = c.cookie;
  assert.equal((await c.post('/auth/2fa/verify', { code: totp(secret, Date.now() + 30_000) })).data.stage, 'done');
  assert.notEqual(c.cookie, partial);
  assert.equal((await c.get('/tracker/summary')).status, 200);
  const thief = client(); thief.cookie = partial;
  assert.equal((await thief.get('/auth/me')).data.authenticated, false);
  assert.equal((await thief.get('/tracker/summary')).status, 401);
  // signing in again from the same browser replaces (revokes) the session it had
  const before = old.cookie;
  await pool.query(`UPDATE settings SET value='"off"' WHERE key='mfa.mode'`);
  (await import('../src/services/settings.js')).invalidateSettings();
  try {
    assert.equal((await old.login('m3')).data.stage, 'done');
    const stale = client(); stale.cookie = before;
    assert.equal((await stale.get('/auth/me')).data.authenticated, false);
  } finally {
    await pool.query(`UPDATE settings SET value='"optional"' WHERE key='mfa.mode'`);
    (await import('../src/services/settings.js')).invalidateSettings();
  }
});

test('ETS-SEC-021: one TOTP code sent in parallel is accepted only once', { skip }, async () => {
  const secret = await enrol('m4');
  const clients = Array.from({ length: 8 }, () => client());
  for (const c of clients) assert.equal((await c.login('m4')).data.stage, 'verify');
  const code = await freshCode('m4', secret);
  const res = await Promise.all(clients.map(c => c.post('/auth/2fa/verify', { code })));
  assert.equal(res.filter(r => r.status === 200).length, 1);
  assert.ok(res.filter(r => r.status !== 200).every(r => r.data.error === 'invalid_code' || r.data.error === 'too_many_attempts'));
});

test('ETS-SEC-021/030: a recovery code sent in parallel is accepted once; legacy SHA-256 codes still work', { skip }, async () => {
  await enrol('m5');
  const u = await user('m5');
  const legacy = 'abcd-efgh';
  await pool.query('INSERT INTO user_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [u.id, crypto.createHash('sha256').update(legacy).digest('hex')]);
  const clients = Array.from({ length: 5 }, () => client());
  for (const c of clients) await c.login('m5');
  const res = await Promise.all(clients.map(c => c.post('/auth/2fa/verify', { recovery_code: legacy.toUpperCase() })));
  assert.equal(res.filter(r => r.status === 200).length, 1);
  await pool.query(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1`, [u.id]);
});

test('ETS-SEC-030/016: regenerated recovery codes are keyed hashes and need password + code', { skip }, async () => {
  const secret = await enrol('m6');
  const id = (await user('m6')).id;
  await pool.query('INSERT INTO user_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [id, crypto.createHash('sha256').update('zzzz-zzzz').digest('hex')]);
  const c = client();
  await c.login('m6');
  await c.post('/auth/2fa/verify', { code: await freshCode('m6', secret) });
  assert.equal((await c.get('/auth/me')).data.user.recovery_codes_outdated, true);
  assert.equal((await c.post('/auth/2fa/recovery-codes', { password: PW })).data.error, 'mfa_code_required');
  const r = await c.post('/auth/2fa/recovery-codes', { password: PW, code: totp(secret, Date.now() + 30_000) });
  assert.equal(r.status, 200);
  assert.equal(r.data.recovery_codes.length, 10);
  assert.match(r.data.recovery_codes[0], /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  const rows = (await pool.query('SELECT code_hash FROM user_recovery_codes WHERE user_id=$1', [id])).rows;
  assert.ok(rows.every(x => /^h1:[0-9a-f]{64}$/.test(x.code_hash)));
  assert.ok(!rows.some(x => x.code_hash.includes(crypto.createHash('sha256').update(r.data.recovery_codes[0]).digest('hex'))));
  const me = (await c.get('/auth/me')).data.user;
  assert.equal(me.recovery_codes_outdated, false);
  assert.equal(me.recovery_codes_left, 10);
  // a new code signs in
  const c2 = client();
  await c2.login('m6');
  assert.equal((await c2.post('/auth/2fa/verify', { recovery_code: r.data.recovery_codes[3] })).data.stage, 'done');
});

test('ETS-SEC-016/018: 2FA setup needs the password; disable needs password + code and signs out other sessions', { skip }, async () => {
  const c = client();
  assert.equal((await c.login('m7')).data.stage, 'done');                 // optional mode, not enrolled
  assert.equal((await c.post('/auth/2fa/setup')).data.error, 'wrong_password');
  const s = await c.post('/auth/2fa/setup', { password: PW });
  assert.equal(s.status, 200);
  assert.equal((await c.post('/auth/2fa/enable', { code: totp(s.data.secret, Date.now() - 30_000) })).status, 200);
  const other = client();
  await other.login('m7');
  await other.post('/auth/2fa/verify', { code: totp(s.data.secret) });
  assert.equal((await other.get('/tracker/summary')).status, 200);
  assert.equal((await c.post('/auth/2fa/disable', { password: PW })).data.error, 'mfa_code_required');
  assert.equal((await c.post('/auth/2fa/disable', { password: PW, code: '000000' })).data.error, 'invalid_code');
  assert.equal((await c.post('/auth/2fa/disable', { password: PW, code: totp(s.data.secret, Date.now() + 30_000) })).status, 200);
  assert.equal((await user('m7')).totp_enabled, false);
  assert.equal((await other.get('/tracker/summary')).status, 401);       // other session signed out
  assert.equal((await c.get('/tracker/summary')).status, 200);           // this one kept
});

test('ETS-SEC-017: before 2FA, /auth/me returns only what the 2FA screen needs', { skip }, async () => {
  const c = client();
  assert.equal((await c.login('m1')).data.stage, 'verify');
  const me = (await c.get('/auth/me')).data;
  assert.equal(me.stage, 'verify');
  assert.deepEqual(Object.keys(me.user).sort(), ['language', 'username']);
  assert.equal(me.mfa_mode, undefined);
  assert.ok(!JSON.stringify(me).includes('permissions'));
});

test('ETS-SEC-018/055: admin 2FA reset ends the user\'s sessions; a pending 2FA step answers 400, not 500', { skip }, async () => {
  const secret = await enrol('rh');
  const victim = client();
  await victim.login('rh');
  await victim.post('/auth/2fa/verify', { code: await freshCode('rh', secret) });
  assert.equal((await victim.get('/tracker/summary')).status, 200);
  const pending = client();
  assert.equal((await pending.login('rh')).data.stage, 'verify');
  const admin = client();
  assert.equal((await admin.login('boss')).data.stage, 'done');
  assert.equal((await admin.post(`/users/${(await user('rh')).id}/reset-2fa`)).status, 200);
  assert.equal((await victim.get('/tracker/summary')).status, 401);
  const r = await pending.post('/auth/2fa/verify', { code: '123456' });
  assert.equal(r.status, 401);                                           // partial session revoked as well
  // a partial session that survives (e.g. made just after the reset) gets a clean 400
  await enrol('rh');
  const p2 = client();
  await p2.login('rh');
  await pool.query(`UPDATE users SET totp_enabled=false, totp_secret=NULL WHERE username='rh'`);
  const r2 = await p2.post('/auth/2fa/verify', { code: '123456' });
  assert.equal(r2.status, 400);
  assert.equal(r2.data.error, 'mfa_not_pending');
});

test('ETS-SEC-018/019: create-admin CLI applies the admin policy and signs out the account\'s sessions', { skip }, async () => {
  const c = client();
  await c.login('boss');
  assert.equal((await c.get('/tracker/summary')).status, 200);
  const run = password => spawnSync(process.execPath, ['scripts/create-admin.js', '--username', 'boss', '--name', 'Boss'],
    { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, ...ENV, ETS_ADMIN_PASSWORD: password }, encoding: 'utf8' });
  const weak = run('Short-2026');                                       // 10 chars: below the admin minimum of 12
  assert.notEqual(weak.status, 0);
  assert.match(weak.stderr, /password_too_short/);
  const common = run('Password-2026');
  assert.match(common.stderr, /password_too_common/);
  const ok = run('Kestrel-Admin-2026');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal((await c.get('/tracker/summary')).status, 401);
  assert.equal((await client().login('boss', 'Kestrel-Admin-2026')).status, 200);
});

test('ETS-SEC-019/020: a hash made with another bcrypt cost is upgraded at the next sign-in', { skip }, async () => {
  const bcrypt = (await import('bcryptjs')).default;
  await pool.query(`UPDATE users SET password_hash=$1 WHERE username='p4'`, [await bcrypt.hash(PW, 5)]);
  await pool.query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE username='p4'`);
  assert.equal((await client().login('p4')).status, 200);
  assert.equal(bcrypt.getRounds((await user('p4')).password_hash), 4);
});

test('ETS-SEC-019/054: forced password change — policy for admins, only the password endpoints are open', { skip }, async () => {
  const c = client();
  assert.equal((await c.login('chg')).data.stage, 'done');
  assert.equal((await c.get('/tracker/summary')).status, 403);
  assert.equal((await c.post('/auth/2fa/setup', { password: PW })).data.error, 'password_change_required');
  const weak = await c.post('/auth/change-password', { current_password: PW, new_password: 'Password12345' });
  assert.equal(weak.data.error, 'weak_password');
  assert.ok(weak.data.reasons.includes('password_too_common'));
  assert.equal((await c.post('/auth/change-password', { current_password: PW, new_password: 'Nightjar-2026q' })).status, 200);
  assert.equal((await c.get('/tracker/summary')).status, 200);
});

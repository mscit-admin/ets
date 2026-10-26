// Unit tests for the password policy, recovery codes, cookie naming and the general API limiter (no database).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let pw, config, authMw, makeApiLimiter, express;

before(async () => {
  Object.assign(process.env, { APP_SECRET: 'unit-secret-'.padEnd(48, 'u'), NODE_ENV: 'test', BCRYPT_ROUNDS: '4', ETS_ENV_FILE: 'none',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', COOKIE_SECURE: 'false' });
  pw = await import('../src/services/passwords.js');
  ({ config } = await import('../src/config.js'));
  authMw = await import('../src/middleware/auth.js');
  ({ makeApiLimiter } = await import('../src/middleware/ratelimit.js'));
  express = (await import('express')).default;
});

test('policy: minimum length floor, administrator minimum, letters + digits, username', () => {
  assert.deepEqual(pw.checkPolicy('Tripoli2026x', { minLength: 8 }), []);
  assert.ok(pw.checkPolicy('Ab3defgh9', { minLength: 8 }).includes('password_too_short'));     // 9 < floor 10
  assert.ok(pw.checkPolicy('Tripoli2026', { admin: true }).includes('password_too_short'));    // 11 < 12 for admins
  assert.deepEqual(pw.checkPolicy('Tripoli2026x', { admin: true }), []);
  assert.ok(pw.checkPolicy('abcdefghijkl').includes('password_needs_letters_digits'));
  assert.ok(pw.checkPolicy('xjohnsmith99z', { username: 'JohnSmith' }).includes('password_contains_username'));
  assert.deepEqual(pw.checkPolicy('مكتبةطرابلس2026'), []);                                      // Arabic letters count
});

test('policy: common passwords are refused (denylist with digits/symbols stripped)', () => {
  for (const p of ['Password1234', 'Passw0rd-123', 'Qwerty123456', 'Welcome2026!', 'Admin12345678', 'aaaaaaaaaa11']) {
    assert.ok(pw.checkPolicy(p).includes('password_too_common'), p);
  }
  assert.ok(!pw.checkPolicy('BrandNew-2026').includes('password_too_common'));
});

test('policy: more than 72 bytes is refused (bcrypt would silently ignore the rest)', () => {
  const ascii72 = 'Ab1' + 'x'.repeat(69);
  assert.equal(Buffer.byteLength(ascii72), 72);
  assert.ok(!pw.checkPolicy(ascii72).includes('password_too_long'));
  assert.ok(pw.checkPolicy(ascii72 + 'y').includes('password_too_long'));
  assert.ok(pw.checkPolicy('ع'.repeat(36) + '1').includes('password_too_long'));               // 73 bytes in UTF-8
});

test('bcrypt cost: rehash needed when the stored cost differs from BCRYPT_ROUNDS', async () => {
  assert.equal(pw.needsRehash(await pw.hashPassword('Something-2026')), false);
  const bcrypt = (await import('bcryptjs')).default;
  assert.equal(pw.needsRehash(await bcrypt.hash('Something-2026', 5)), true);
  assert.equal(pw.needsRehash('not-a-hash'), false);
});

test('recovery codes: 12 characters, unbiased alphabet, keyed hash (not plain SHA-256)', () => {
  const codes = pw.generateRecoveryCodes(200);
  assert.equal(new Set(codes).size, 200);
  const counts = {};
  for (const c of codes) {
    assert.match(c, /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    for (const ch of c.replace(/-/g, '')) counts[ch] = (counts[ch] || 0) + 1;
  }
  assert.equal(Object.keys(counts).length, 31);                  // every letter of the alphabet appears
  const h = pw.hashRecoveryCode(codes[0]);
  assert.match(h, /^h1:[0-9a-f]{64}$/);
  assert.notEqual(h.slice(3), crypto.createHash('sha256').update(codes[0]).digest('hex'));
  assert.equal(pw.hashRecoveryCode(' ' + codes[0].toUpperCase() + ' '), h);   // typed in capitals / with spaces
  // legacy (pre-1.0.0) codes are still found through their plain SHA-256
  assert.equal(pw.recoveryCodeHashes('abcd-efgh')[1], crypto.createHash('sha256').update('abcd-efgh').digest('hex'));
});

test('BCRYPT_ROUNDS is clamped', () => {
  assert.ok(Number.isInteger(config.security.bcryptRounds) && config.security.bcryptRounds <= 14);
});

test('session cookie: __Host- prefix when Secure; production refuses insecure cookies', () => {
  assert.equal(authMw.cookieName(), 'ets_sid');
  const { secure } = config.session, env = config.env;
  try {
    config.session.secure = true;
    assert.equal(authMw.cookieName(), '__Host-ets_sid');
    config.session.secure = false; config.env = 'production';
    assert.throws(() => authMw.assertCookieConfig(), /COOKIE_SECURE=false is not allowed/);
    process.env.ALLOW_INSECURE_COOKIES = 'true';
    assert.doesNotThrow(() => authMw.assertCookieConfig());
  } finally {
    config.session.secure = secure; config.env = env; delete process.env.ALLOW_INSECURE_COOKIES;
  }
});

test('general /api limiter answers 429 too_many_requests with retry_after', async () => {
  const app = express();
  // anonymous requests (no session middleware here) are keyed by IP and bounded by ipLimit (1.12.30 options object)
  app.use('/api', makeApiLimiter({ ipLimit: 3, userLimit: 3, windowMs: 60_000 }));
  app.get('/api/x', (req, res) => res.json({ ok: true }));
  const srv = app.listen(0);
  try {
    const url = `http://127.0.0.1:${srv.address().port}/api/x`;
    const st = [];
    for (let i = 0; i < 4; i++) st.push(await fetch(url));
    assert.deepEqual(st.map(r => r.status), [200, 200, 200, 429]);
    const body = await st[3].json();
    assert.equal(body.error, 'too_many_requests');
    assert.ok(body.retry_after > 0 && body.retry_after <= 60);
  } finally { srv.close(); }
});

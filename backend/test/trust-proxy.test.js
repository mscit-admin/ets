// Trust-proxy / rate-limit spoofing (defensive hardening 1.12.3): with the default TRUST_PROXY=loopback, as the
// running server uses it, a client-supplied X-Forwarded-For must NOT change req.ip, so it cannot win a fresh per-IP
// login rate-limit bucket. This mirrors production: nginx on this server (a trusted loopback hop) appends the real
// client address on the RIGHT of X-Forwarded-For ($proxy_add_x_forwarded_for), and Express with trust proxy
// 'loopback' takes that right-most untrusted address as req.ip. Anything the client itself put to the LEFT is ignored.
//
// The per-IP test deliberately uses trust proxy = the default (loopback), NOT true: if someone later changes the code
// so req.ip follows the client-supplied X-Forwarded-For under the default config (e.g. TRUST_PROXY=true or a broken
// key generator), every request gets a different bucket and the 429 never arrives — this test then FAILS.
//
// Same disposable database as the other backend tests:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Kestrel-2026x';
const LIMIT = 5;        // LOGIN_RATE_LIMIT for this test (small, so we send a handful of requests, not thousands)
const MAX_FAILED = 3;   // MAX_FAILED_LOGINS: per-account lockout triggers below the rate limit
const ENV = {
  DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
  LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
  MAX_FAILED_LOGINS: String(MAX_FAILED), LOCK_MINUTES: '15', LOCKOUT_RESET_MINUTES: '60',
  LOGIN_RATE_LIMIT: String(LIMIT), LOGIN_IP_RATE_LIMIT: String(LIMIT), API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
};

let server, base, pool, config;

before(async () => {
  if (skip) return;
  // No TRUST_PROXY here: config falls back to its default ('loopback'), exactly as the running server bootstraps it.
  delete process.env.TRUST_PROXY;
  Object.assign(process.env, ENV);
  ({ config } = await import('../src/config.js'));
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword(PW);
  await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id) VALUES ('victim','Victim','victim@x.ly',$1,'qa')`, [h]);
  // The default is what the server actually runs with; this test must not be let through by a stray env setting.
  assert.equal(config.security.trustProxy, 'loopback', 'test must run with the default trust-proxy setting');
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

// One failed login attempt. The X-Forwarded-For header is built as production nginx builds it: whatever the client
// supplied (`spoof`) followed by the real client address appended on the right (`realIp`). Omit realIp to send only
// the raw client value (as if nginx appended nothing).
async function attempt({ username, password = 'wrong-password', spoof, realIp }) {
  const xff = realIp === undefined ? spoof : `${spoof}, ${realIp}`;
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ username, password }),
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

test('TRUST_PROXY=loopback: a varying client X-Forwarded-For does not win a fresh per-IP login bucket', { skip }, async () => {
  // The real client address (what nginx appends on the right) stays the same; only the spoofed left part varies.
  const realIp = '203.0.113.7';
  const statuses = [];
  for (let i = 0; i <= LIMIT; i++) {
    // distinct username each time so the PER-ACCOUNT limiter never accumulates — only the per-IP limiter can answer 429
    const r = await attempt({ username: `ip-probe-${i}`, spoof: `10.${i}.${i}.${i}`, realIp });
    statuses.push(r.status);
    if (r.status === 429) assert.equal(r.data.error, 'too_many_attempts');
  }
  // The first LIMIT attempts are plain failures; the next is blocked. If changing the spoofed header granted a fresh
  // bucket (the misconfiguration this guards against), every attempt would be 401 and this assertion would fail.
  assert.ok(statuses.slice(0, LIMIT).every(s => s === 401), `expected ${LIMIT}×401 then 429, got ${statuses}`);
  assert.equal(statuses[LIMIT], 429, `per-IP limit must still fire though the spoofed XFF changed each time; got ${statuses}`);

  // Sanity: the limiter really is per real-IP — a genuinely different appended client address gets its own bucket.
  const fresh = await attempt({ username: 'ip-probe-fresh', spoof: `10.${LIMIT + 1}.0.0`, realIp: '203.0.113.99' });
  assert.equal(fresh.status, 401, 'a different real client IP (right-most) still has its own fresh bucket');
});

test('TRUST_PROXY=loopback: the per-account limit still fires whatever the header says', { skip }, async () => {
  // Every request carries a completely different X-Forwarded-For (both the spoofed part and the appended real IP), so
  // the per-IP limiter never accumulates; only the per-account limiter (keyed on the typed username) can answer 429.
  const statuses = [];
  for (let i = 0; i <= LIMIT; i++) {
    const r = await attempt({ username: 'acct-probe', spoof: `172.16.${i}.${i}`, realIp: `10.50.${i}.${i}` });
    statuses.push(r.status);
  }
  assert.ok(statuses.slice(0, LIMIT).every(s => s === 401), `expected ${LIMIT}×401 then 429, got ${statuses}`);
  assert.equal(statuses[LIMIT], 429, `per-account limit must fire regardless of the (always different) IP; got ${statuses}`);
});

test('TRUST_PROXY=loopback: per-account lockout triggers regardless of a spoofed / changing IP', { skip }, async () => {
  await pool.query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE username='victim'`);
  // MAX_FAILED wrong passwords, each from a different (spoofed + appended) address — below the rate limit, so the only
  // thing that can pause the account is the per-account lockout (services/lockout.js), which keys on the account.
  for (let i = 0; i < MAX_FAILED; i++) {
    const r = await attempt({ username: 'victim', password: 'nope-' + i, spoof: `192.0.2.${i}`, realIp: `10.60.${i}.${i}` });
    assert.equal(r.status, 401, `failure ${i} should look like invalid credentials, got ${r.status}`);
  }
  const u = (await pool.query(`SELECT failed_attempts, locked_until FROM users WHERE username='victim'`)).rows[0];
  assert.ok(u.failed_attempts >= MAX_FAILED, `account failures counted (${u.failed_attempts}) despite changing IPs`);
  assert.ok(u.locked_until && new Date(u.locked_until) > new Date(), 'account is paused despite each attempt using a different IP');
});

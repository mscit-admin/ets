// Shared-office-friendly per-IP LOGIN limiter (1.12.30). The password/2FA checking endpoints keep a coarse per-IP
// budget (LOGIN_IP_RATE_LIMIT), but it is deliberately set MUCH higher than the per-account budget (LOGIN_RATE_LIMIT)
// so a whole office behind one NAT address is not throttled while its staff sign in. The real brute-force defence is
// the per-ACCOUNT lockout (services/lockout.js) + per-account budget, both keyed by the account — not the shared IP.
// This file proves the relaxation does not weaken that account-keyed defence.
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Kestrel-2026x';
const ACCOUNT_LIMIT = 10;   // LOGIN_RATE_LIMIT: failures per account per 15 min
const IP_LOGIN_LIMIT = 40;  // LOGIN_IP_RATE_LIMIT: coarse per-IP budget, higher than the per-account one
const OFFICE_IP = '10.63.7.21';
const ENV = {
  DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
  LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
  // MAX_FAILED_LOGINS high so the per-account lockout does not mask the rate limiters we are isolating here; the
  // per-account LOCKOUT itself is proven (independent of IP) in trust-proxy.test.js.
  MAX_FAILED_LOGINS: '100', LOGIN_RATE_LIMIT: String(ACCOUNT_LIMIT), LOGIN_IP_RATE_LIMIT: String(IP_LOGIN_LIMIT),
  API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
};

let server, base, pool;

before(async () => {
  if (skip) return;
  Object.assign(process.env, ENV);
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword(PW);
  await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id) VALUES ('target','Target','target@x.ly',$1,'qa')`, [h]);
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

async function login({ username, password = 'wrong-password', ip }) {
  const res = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ username, password }),
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

// Relaxation: many DISTINCT accounts signing in (even failing) from the ONE office IP are NOT blocked by the per-IP
// login limit, although their number far exceeds the per-ACCOUNT budget. This is the shared-office fix.
test('many distinct accounts from one office IP are not blocked at the per-account threshold', { skip }, async () => {
  const statuses = [];
  // well above ACCOUNT_LIMIT (10), still below IP_LOGIN_LIMIT (40): each username is a different account, so the
  // per-account budget never accrues, and the per-IP budget is not yet reached.
  for (let i = 0; i < 35; i++) statuses.push((await login({ username: `staff-${i}`, ip: OFFICE_IP })).status);
  assert.ok(statuses.every(s => s === 401),
    `35 distinct-account logins from one office IP must all be plain 401 (not 429), got ${statuses.join(',')}`);
});

// …but the per-IP budget is still a real (coarse) guard: a single IP that keeps hammering is bounded at
// LOGIN_IP_RATE_LIMIT, so a scripted flood from one address is still stopped.
test('the per-IP login budget still fires at the configured (higher) threshold', { skip }, async () => {
  // continue from the 35 above on the SAME IP until the per-IP budget (40) is crossed
  let last = null;
  for (let i = 35; i <= IP_LOGIN_LIMIT; i++) last = await login({ username: `staff-${i}`, ip: OFFICE_IP });
  assert.equal(last.status, 429, 'crossing LOGIN_IP_RATE_LIMIT on one IP → 429');
  assert.equal(last.data.error, 'too_many_attempts');
  assert.ok(last.data.retry_after > 0);
});

// The per-ACCOUNT budget still catches a single account hammered from MANY different IPs (brute force on one
// account), even though the per-IP budget is now relaxed — because it is keyed by the account, not the IP.
test('the per-account login budget still catches one account hammered from many IPs', { skip }, async () => {
  const statuses = [];
  for (let i = 0; i <= ACCOUNT_LIMIT; i++) {
    statuses.push((await login({ username: 'target', password: 'nope-' + i, ip: `203.0.113.${i + 1}` })).status);
  }
  assert.ok(statuses.slice(0, ACCOUNT_LIMIT).every(s => s === 401), `first ${ACCOUNT_LIMIT} are 401, got ${statuses}`);
  const r = await login({ username: 'target', password: 'again', ip: '203.0.113.200' });
  assert.equal(r.status, 429, 'the per-account budget fires regardless of the (always different) IP');
  assert.equal(r.data.error, 'too_many_attempts');
});

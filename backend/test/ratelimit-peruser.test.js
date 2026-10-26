// Per-USER general API rate limiting (1.12.30). The general /api ceiling is keyed by the authenticated user, with a
// per-IP fallback only for anonymous requests. This is the fix for a shared-office / NAT deployment where every staff
// member egresses from ONE address (10.63.x): an IP key used to put the whole office in a single bucket, so one busy
// user (or the Messages/Alerts/Notifications polling) throttled everyone. The per-account lockout stays the brute-force
// defence (see trust-proxy.test.js); this file proves the per-user API budgets.
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Kestrel-2026x';
const USER_LIMIT = 6;    // API_USER_RATE_LIMIT: per authenticated user per minute
const IP_LIMIT = 12;     // API_RATE_LIMIT: per anonymous IP per minute
const OFFICE_IP = '10.63.4.9';   // the single NAT address the whole office egresses from
const ENV = {
  DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
  LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
  MAX_FAILED_LOGINS: '100', LOGIN_RATE_LIMIT: '200', LOGIN_IP_RATE_LIMIT: '200',
  API_RATE_LIMIT: String(IP_LIMIT), API_USER_RATE_LIMIT: String(USER_LIMIT), ETS_ENV_FILE: 'none',
};

let server, base, pool;

before(async () => {
  if (skip) return;
  Object.assign(process.env, ENV);
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  await pool.query(`UPDATE settings SET value='"off"' WHERE key='mfa.mode'`);
  (await import('../src/services/settings.js')).invalidateSettings();
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword(PW);
  await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id) VALUES
    ('alpha','Alpha','alpha@x.ly',$1,'qa'), ('beta','Beta','beta@x.ly',$1,'qa')`, [h]);
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

// A cookie-keeping client that always presents the given client IP (trusted from loopback).
function client(ip) {
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
    get: p => call('GET', p),
    login: (u) => call('POST', '/auth/login', { username: u, password: PW }),
  };
}

// THE regression proof: two different authenticated users egressing from the SAME office IP get SEPARATE API
// budgets. One user hammering their own budget to 429 does not consume or block the other's.
test('two authenticated users on one office IP have separate API budgets', { skip }, async () => {
  const a = client(OFFICE_IP), b = client(OFFICE_IP);
  assert.equal((await a.login('alpha')).data.stage, 'done');
  assert.equal((await b.login('beta')).data.stage, 'done');

  // User alpha spends their whole per-user budget on authenticated requests until the limiter answers 429.
  const aStatuses = [];
  for (let i = 0; i < USER_LIMIT + 1; i++) aStatuses.push((await a.get('/auth/me')).status);
  assert.ok(aStatuses.slice(0, USER_LIMIT).every(s => s === 200), `alpha first ${USER_LIMIT} ok, got ${aStatuses}`);
  const flooded = await a.get('/auth/me');
  assert.equal(flooded.status, 429, `alpha past budget → 429, got ${aStatuses}`);
  assert.equal(flooded.data.error, 'too_many_requests');
  assert.ok(flooded.data.retry_after > 0, 'a truly flooding user still gets 429 + retry_after');

  // beta — same office IP, different user — is untouched: their own fresh budget still serves requests.
  for (let i = 0; i < USER_LIMIT; i++) {
    assert.equal((await b.get('/auth/me')).status, 200, 'beta keeps their own budget despite alpha being throttled');
  }
});

// Anonymous (no session) requests are still keyed and bounded by client IP (API_RATE_LIMIT), preserving the
// trust-proxy handling for the anonymous case.
test('anonymous requests are still IP-limited', { skip }, async () => {
  const anon = client('198.51.100.7');   // its own fresh IP bucket
  const statuses = [];
  for (let i = 0; i < IP_LIMIT + 1; i++) statuses.push((await anon.get('/auth/public-info')).status);
  assert.ok(statuses.slice(0, IP_LIMIT).every(s => s === 200), `first ${IP_LIMIT} anonymous ok, got ${statuses}`);
  const r = await anon.get('/auth/public-info');
  assert.equal(r.status, 429, `anonymous IP bucket fills at ${IP_LIMIT}, got ${statuses}`);
  assert.equal(r.data.error, 'too_many_requests');
});

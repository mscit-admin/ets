// Phones (Android app, 1.9.0): pairing code (re-authentication, one-time, 10-minute lifetime, hashed), pairing (rate
// limit), the device token (Bearer, /api/m only, hashed), the phone's view of the alerts (phone-allowed types,
// generic text for mandatory in-app-only types), its live stream, revocation (by the user, an administrator, and
// automatically with the account) and the audit rows. Needs TEST_DATABASE_URL like api.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const CERT = 'ab'.repeat(32);

let server, base, pool, notify, live, mobile, scan, ids = {};

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none', LIVE_HEARTBEAT_SECONDS: '1',
    PUBLIC_BASE_URL: 'https://ets.example.ly/', TLS_CERT_SHA256: CERT.toUpperCase().match(/../g).join(':'), PAIR_RATE_LIMIT: '5',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  for (const [u, role, lang] of [['root', 'admin', 'ar'], ['ahmad', 'member', 'en'], ['sara', 'member', 'ar'], ['omar', 'member', 'ar'], ['huda', 'member', 'ar']]) {
    ids[u] = (await pool.query(`INSERT INTO users(username, full_name, password_hash, role_id, must_change_password, language)
      VALUES ($1,$2,$3,$4,false,$5) RETURNING id`, [u, 'Full ' + u, h, role, lang])).rows[0].id;
    if (role === 'member') await pool.query(`INSERT INTO user_scopes VALUES ($1,'department','hr')`, [ids[u]]);
  }
  notify = await import('../src/services/notify.js');
  live = await import('../src/services/live.js');
  mobile = await import('../src/routes/mobile.js');
  scan = await import('../src/services/notify-scan.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  await live.closeAllStreams();
  server.closeAllConnections?.();
  server.close();
  await new Promise(r => setTimeout(r, 300));
  await pool.end();
});

function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get cookie() { return cookie; }, get: (p, h) => call('GET', p, undefined, h), post: (p, b = {}, h) => call('POST', p, b, h),
    put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p, b) => call('DELETE', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }) };
}
const as = async u => { const c = client(); assert.equal((await c.login(u)).status, 200); return c; };
// the phone: no cookie, no X-Requested-With
const phone = (token, path, { method = 'GET', body } = {}) => fetch(base + path, { method,
  headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, data: r.status === 204 ? null : await r.json().catch(() => null) }));
const pairWith = (code, extra = {}) => fetch(base + '/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, device_name: 'Samsung A54', platform: 'android', app_version: '1.0.0', ...extra }) })
  .then(async r => ({ status: r.status, data: await r.json() }));
const resetLimit = () => mobile.pairLimiter.resetKey('::ffff:127.0.0.1') && mobile.pairLimiter.resetKey('127.0.0.1');
async function newCode(user, c = null) {
  c ||= await as(user);
  const r = await c.post('/devices/pair-code', { password: 'Passw0rd-123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function paired(user) {
  resetLimit();
  const { code } = await newCode(user);
  const r = await pairWith(code);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('pairing code: signed in, password again, 10 characters, 10 minutes, stored hashed; QR payload', { skip }, async () => {
  assert.equal((await fetch(base + '/devices/pair-code', { method: 'POST', headers: { 'x-requested-with': 'ets', 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const c = await as('ahmad');
  assert.equal((await c.post('/devices/pair-code', { password: 'nope' })).data.error, 'wrong_password');
  const r = await newCode('ahmad', c);
  assert.match(r.code, /^[A-HJKMNP-Z2-9]{10}$/);
  const ttl = new Date(r.expires_at) - Date.now();
  assert.ok(ttl > 9 * 60_000 && ttl <= 10 * 60_000 + 5000, String(ttl));
  const p = JSON.parse(r.payload);
  assert.deepEqual(p, { v: 1, url: 'https://ets.example.ly', code: r.code, cert_sha256: CERT });
  const stored = (await pool.query('SELECT code_hash FROM device_pair_codes WHERE user_id=$1', [ids.ahmad])).rows;
  assert.equal(stored.length, 1);
  assert.ok(stored[0].code_hash.startsWith('h1:') && !stored[0].code_hash.includes(r.code));
  // a new code replaces the unused one
  const r2 = await newCode('ahmad', c);
  resetLimit();
  assert.equal((await pairWith(r.code)).data.error, 'invalid_code');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_pair_codes WHERE user_id=$1', [ids.ahmad])).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM auth_log WHERE event='mobile_pair_code_issued' AND user_id=$1`, [ids.ahmad])).rows[0].n, 2);
  assert.ok(r2.code);
});

test('pair: one-time, expires, validates the body; returns the token once and stores only its hash; audited', { skip }, async () => {
  resetLimit();
  const { code } = await newCode('ahmad');
  assert.equal((await pairWith(code, { platform: 'ios' })).status, 400);
  assert.equal((await pairWith(code, { device_name: '' })).data.error, 'missing_fields');
  const r = await pairWith(code.toLowerCase().replace(/(.{5})/, '$1-'));       // typed by hand: case and a dash do not matter
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.device_id > 0);
  assert.match(r.data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r.data.user, { full_name: 'Full ahmad', lang: 'en' });
  const d = (await pool.query('SELECT * FROM mobile_devices WHERE id=$1', [r.data.device_id])).rows[0];
  assert.equal(d.name, 'Samsung A54'); assert.equal(d.platform, 'android'); assert.equal(d.app_version, '1.0.0');
  assert.ok(d.token_hash.startsWith('h1:') && d.token_hash !== r.data.token && !d.token_hash.includes(r.data.token));
  resetLimit();
  assert.equal((await pairWith(code)).data.error, 'invalid_code', 'one-time');
  // expired
  resetLimit();
  const { code: c2 } = await newCode('ahmad');
  await pool.query(`UPDATE device_pair_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
  assert.equal((await pairWith(c2)).data.error, 'invalid_code', 'expired');
  const au = (await pool.query(`SELECT * FROM audit_log WHERE entity='device' AND action='pair' AND entity_id=$1`, [String(r.data.device_id)])).rows[0];
  assert.equal(au.user_id, ids.ahmad); assert.equal(au.new_value.name, 'Samsung A54'); assert.equal(au.context.cert_sha256, CERT);
  const al = (await pool.query(`SELECT * FROM auth_log WHERE event='mobile_device_paired' AND user_id=$1`, [ids.ahmad])).rows[0];
  assert.equal(al.detail.name, 'Samsung A54');
  assert.ok((await pool.query(`SELECT 1 FROM auth_log WHERE event='mobile_pair_rejected'`)).rowCount >= 2);
  const own = (await (await as('ahmad')).get('/devices')).data.devices;
  assert.equal(own.length, 1); assert.equal(own[0].id, r.data.device_id); assert.equal(own[0].token_hash, undefined);
});

test('pair is rate limited per address (PAIR_RATE_LIMIT, refused attempts included)', { skip }, async () => {
  resetLimit();
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await pairWith('WRONGCODE' + i)).status);
  assert.deepEqual(codes, [400, 400, 400, 400, 400]);
  const r = await pairWith('WRONGCODE5');
  assert.equal(r.status, 429); assert.equal(r.data.error, 'too_many_attempts');
  resetLimit();
});

test('device token: Bearer on /api/m only; never on the web API; no cookie on /api/m; me; last use recorded', { skip }, async () => {
  const { token, device_id } = await paired('sara');
  const me = await phone(token, '/m/me');
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.data).sort(), ['full_name', 'lang', 'server_version']);
  assert.equal(me.data.full_name, 'Full sara'); assert.equal(me.data.lang, 'ar'); assert.match(me.data.server_version, /^\d+\.\d+\.\d+$/);
  // the web API ignores the token
  for (const p of ['/tracker/summary', '/auth/me', '/notifications', '/devices']) {
    const r = await phone(token, p);
    assert.ok(r.status === 401 || r.data?.authenticated === false, p + ' ' + r.status);
  }
  // /api/m ignores the session cookie
  const c = await as('sara');
  const r = await fetch(base + '/m/me', { headers: { cookie: c.cookie } });
  assert.equal(r.status, 401); assert.equal((await r.json()).error, 'invalid_token');
  assert.equal((await phone('x'.repeat(43), '/m/me')).status, 401);
  assert.equal((await phone(token + 'x', '/m/me')).status, 401);
  assert.equal((await fetch(base + '/m/me', { headers: { authorization: 'Basic abc' } })).status, 401);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM auth_log WHERE event='mobile_token_rejected'`)).rows[0].n > 0, true);
  const d = (await pool.query('SELECT last_seen_at FROM mobile_devices WHERE id=$1', [device_id])).rows[0];
  assert.ok(Date.now() - d.last_seen_at < 60_000);
  // a POST on /api/m needs no X-Requested-With (no cookie: no CSRF)
  assert.equal((await phone(token, '/m/notifications/999999/read', { method: 'POST' })).status, 404);
});

test('the phone\'s alerts: phone-allowed types only, generic text for a mandatory in-app-only type, read → 204', { skip }, async () => {
  const { token } = await paired('root');
  await pool.query('DELETE FROM notifications');
  const [root] = await notify.activeUsers([ids.root]);
  await notify.deliver('account_locked', [{ user: root, dedupeKey: 'account_locked:user=9', link: '/logs?tab=auth', params: { username: 'victim' } }]);   // S1: in-app only
  await notify.deliver('backup_missing', [{ user: root, dedupeKey: 'backup_missing:x', link: '/logs?tab=system', params: { hours: 26 } }]);              // S6: phone allowed
  await notify.deliver('email_index', [{ user: root, dedupeKey: 'email_index:x', link: '/users' }]);                                                    // S4: phone allowed, not mandatory
  const r = await phone(token, '/m/notifications');
  assert.equal(r.status, 200);
  assert.equal(r.data.unread, 2);
  assert.deepEqual(r.data.items.map(i => i.type), ['email_index', 'backup_missing']);
  const s6 = r.data.items.find(i => i.type === 'backup_missing');
  assert.deepEqual(Object.keys(s6).sort(), ['body', 'created_at', 'id', 'link', 'read', 'severity', 'title', 'type']);
  assert.equal(s6.title, 'لا توجد نسخة احتياطية منذ أكثر من 26 ساعة');
  assert.equal(s6.body, null, 'no body for system / security alerts on the phone');
  assert.equal(s6.severity, 'critical'); assert.equal(s6.read, false);
  assert.ok(!JSON.stringify(r.data).includes('victim'));
  // the web still has all three
  assert.equal((await (await as('root')).get('/notifications/count')).data.unread, 3);
  // S6 taken off the phone by policy: mandatory → generic; S4 taken off → left out
  const admin = await as('root');
  assert.equal((await admin.put('/settings', { 'notify.policy': { backup_missing: { push: false }, email_index: { push: false } } })).status, 200);
  const g = await phone(token, '/m/notifications');
  assert.equal(g.data.unread, 1);
  assert.equal(g.data.items.length, 1);
  assert.deepEqual([g.data.items[0].type, g.data.items[0].title, g.data.items[0].body, g.data.items[0].link], ['backup_missing', 'لديك تنبيه جديد', null, '/notifications']);
  await admin.put('/settings', { 'notify.policy': { backup_missing: { push: true }, email_index: { push: true } } });
  // after_id, limit, read
  const all = (await phone(token, '/m/notifications')).data.items;
  const newer = await phone(token, `/m/notifications?after_id=${all[1].id}`);
  assert.deepEqual(newer.data.items.map(i => i.id), [all[0].id]);
  // after_id: ascending (oldest first), paging forward with limit
  const asc = (await phone(token, '/m/notifications?after_id=0&limit=1')).data.items;
  assert.deepEqual(asc.map(i => i.id), [all[1].id], 'oldest first');
  assert.deepEqual((await phone(token, `/m/notifications?after_id=${asc[0].id}&limit=1`)).data.items.map(i => i.id), [all[0].id]);
  assert.deepEqual((await phone(token, '/m/notifications?after_id=0')).data.items.map(i => i.id), [all[1].id, all[0].id]);
  assert.equal((await phone(token, '/m/notifications?limit=1')).data.items.length, 1);
  assert.equal((await phone(token, '/m/notifications?limit=0')).status, 400);
  assert.equal((await phone(token, '/m/notifications?after_id=x')).status, 400);
  const rd = await phone(token, `/m/notifications/${all[0].id}/read`, { method: 'POST' });
  assert.equal(rd.status, 204);
  assert.equal((await phone(token, '/m/notifications')).data.unread, 1);
  // an in-app-only alert cannot be read from the phone
  const s1 = (await pool.query(`SELECT id FROM notifications WHERE type='account_locked'`)).rows[0].id;
  assert.equal((await phone(token, `/m/notifications/${s1}/read`, { method: 'POST' })).status, 404);
  // a user's own phone mute (non-mandatory types)
  await admin.put('/notifications/prefs', { mobile_muted: ['email_index'] });
  await pool.query('UPDATE notifications SET read_at=NULL');
  assert.deepEqual((await phone(token, '/m/notifications')).data.items.map(i => i.type), ['backup_missing']);
  await admin.put('/notifications/prefs', { mobile_muted: [] });
});

test('phone stream: "unread" on connect, "notification" { id } for a new alert, heartbeat; revoke ends it → 401', { skip }, async () => {
  await pool.query('DELETE FROM notifications');
  const { token, device_id } = await paired('omar');
  assert.equal((await fetch(base + '/m/events')).status, 401);
  const ac = new AbortController();
  const res = await fetch(base + '/m/events', { headers: { authorization: 'Bearer ' + token }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  assert.match(res.headers.get('cache-control'), /no-cache/);
  let raw = '', ended = false;
  const reader = (async () => { try { for await (const ch of res.body) raw += new TextDecoder().decode(ch); } catch { /* aborted */ } ended = true; })();
  const waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50)); return pred(); };
  assert.ok(await waitFor(() => raw.includes('event: unread')), raw);
  assert.match(raw, /event: unread\ndata: \{"unread":0\}/);
  const [omar] = await notify.activeUsers([ids.omar]);
  const got = await notify.deliver('excluded', [{ user: omar, dedupeKey: 'excluded:app=per', appId: 'per', params: { app_id: 'per' } }]);
  const nid = got.get(ids.omar)[0];
  assert.ok(await waitFor(() => raw.includes(`event: notification\ndata: {"id":${nid}}`)), raw);
  assert.ok(await waitFor(() => /event: unread\ndata: \{"unread":1\}/.test(raw)));
  assert.ok(await waitFor(() => raw.includes(': hb')), 'heartbeat comment');
  // an in-app-only alert is not announced to the phone
  await pool.query('UPDATE notifications SET read_at=now()');
  // revoked by the user from the profile page
  const c = await as('omar');
  const before = raw.length;
  assert.equal((await c.del(`/devices/${device_id}`)).status, 200);
  assert.ok(await waitFor(() => ended), 'stream closed');
  assert.ok(!raw.slice(before).includes('session_ended'));
  await reader;
  assert.equal((await phone(token, '/m/me')).status, 401);
  assert.equal((await phone(token, '/m/notifications')).status, 401);
  const d = (await pool.query('SELECT revoked_at, revoked_by, revoke_reason FROM mobile_devices WHERE id=$1', [device_id])).rows[0];
  assert.ok(d.revoked_at); assert.equal(d.revoked_by, ids.omar); assert.equal(d.revoke_reason, 'user');
  const au = (await pool.query(`SELECT * FROM audit_log WHERE entity='device' AND action='revoke' AND entity_id=$1`, [String(device_id)])).rows[0];
  assert.equal(au.context.reason, 'user'); assert.equal(au.context.owner.id, ids.omar);
  assert.ok((await pool.query(`SELECT 1 FROM auth_log WHERE event='mobile_device_revoked' AND (detail->>'device_id')::int=$1`, [device_id])).rowCount);
  assert.equal((await c.del(`/devices/${device_id}`)).data.revoked, 0, 'already revoked');
  ac.abort();
});

test('administrator revokes a user\'s phone; another user\'s phone cannot be revoked from the profile', { skip }, async () => {
  const { token, device_id } = await paired('huda');
  assert.equal((await (await as('ahmad')).del(`/devices/${device_id}`)).status, 404);
  const admin = await as('root');
  const u = (await admin.get(`/users/${ids.huda}`)).data.user;
  assert.ok(u.devices.some(d => d.id === device_id && !d.revoked_at));
  assert.equal((await admin.del(`/users/${ids.ahmad}/devices/${device_id}`)).status, 404, 'device of another user');
  assert.equal((await admin.del(`/users/${ids.huda}/devices/${device_id}`)).data.revoked, 1);
  assert.equal((await phone(token, '/m/me')).status, 401);
  assert.equal((await pool.query('SELECT revoke_reason, revoked_by FROM mobile_devices WHERE id=$1', [device_id])).rows[0].revoke_reason, 'admin');
});

test('account changes revoke the phones in the same transaction: deactivated, password reset, deleted; paused → refused', { skip }, async () => {
  const admin = await as('root');
  // paused after failed sign-ins: refused while it lasts
  const p = await paired('ahmad');
  await pool.query(`UPDATE users SET locked_until = now() + interval '5 minutes' WHERE id=$1`, [ids.ahmad]);
  assert.equal((await phone(p.token, '/m/me')).status, 401);
  await pool.query(`UPDATE users SET locked_until = NULL WHERE id=$1`, [ids.ahmad]);
  assert.equal((await phone(p.token, '/m/me')).status, 200);
  // deactivated
  assert.equal((await admin.patch(`/users/${ids.ahmad}`, { is_active: false })).status, 200);
  assert.equal((await phone(p.token, '/m/me')).status, 401);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM mobile_devices WHERE user_id=$1 AND revoked_at IS NULL`, [ids.ahmad])).rows[0].n, 0);
  assert.ok((await pool.query(`SELECT 1 FROM mobile_devices WHERE id=$1 AND revoke_reason='user_disabled'`, [p.device_id])).rowCount);
  await admin.patch(`/users/${ids.ahmad}`, { is_active: true });
  assert.equal((await phone(p.token, '/m/me')).status, 401, 'stays revoked after reactivation');
  // password reset by an administrator
  const q = await paired('ahmad');
  assert.equal((await admin.post(`/users/${ids.ahmad}/reset-password`, { password: 'Another-Passw0rd-9', must_change: false })).status, 200);
  assert.equal((await phone(q.token, '/m/me')).status, 401);
  assert.ok((await pool.query(`SELECT 1 FROM mobile_devices WHERE id=$1 AND revoke_reason='password_reset'`, [q.device_id])).rowCount);
  await pool.query(`UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE id=$1) WHERE id=$2`, [ids.sara, ids.ahmad]);
  // deleted: revoked in the same transaction, with the audit rows
  const r = await paired('ahmad');
  const del = await admin.del(`/users/${ids.ahmad}`, { reason: 'left the company' });
  assert.equal(del.status, 200); assert.equal(del.data.devices_revoked, 1);
  assert.equal((await phone(r.token, '/m/me')).status, 401);
  const d = (await pool.query('SELECT revoke_reason, revoked_by FROM mobile_devices WHERE id=$1', [r.device_id])).rows[0];
  assert.deepEqual(d, { revoke_reason: 'user_deleted', revoked_by: ids.root });
  const au = (await pool.query(`SELECT id FROM audit_log WHERE entity='device' AND action='revoke' AND entity_id=$1`, [String(r.device_id)])).rows[0];
  const ud = (await pool.query(`SELECT id FROM audit_log WHERE entity='user' AND action='delete' AND entity_id=$1`, [String(ids.ahmad)])).rows[0];
  assert.ok(au && ud);
  // the pairing code of a deleted / deactivated account is refused
  resetLimit();
  const c = await as('sara');
  const { code } = await newCode('sara', c);
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [ids.sara]);
  assert.equal((await pairWith(code)).data.error, 'invalid_code');
  await pool.query('UPDATE users SET is_active=true WHERE id=$1', [ids.sara]);
});

test('phones unused for notify.device_idle_days are revoked by the daily check; a token under an old APP_SECRET is accepted and upgraded', { skip }, async () => {
  const { token, device_id } = await paired('sara');
  await pool.query(`UPDATE mobile_devices SET last_seen_at = now() - interval '91 days' WHERE id=$1`, [device_id]);
  await scan.runScan({ force: ['daily'] });
  const d = (await pool.query('SELECT revoke_reason, revoked_by FROM mobile_devices WHERE id=$1', [device_id])).rows[0];
  assert.deepEqual(d, { revoke_reason: 'inactive', revoked_by: null });
  assert.equal((await phone(token, '/m/me')).status, 401);
  // the hash is keyed (not a plain SHA-256); after an APP_SECRET rotation the old secret (APP_SECRET_OLD) still
  // accepts the token and the stored hash moves to the new secret
  const devices = await import('../src/services/devices.js');
  const { config } = await import('../src/config.js');
  assert.notEqual(devices.tokenHash('abc'), 'h1:' + crypto.createHash('sha256').update('abc').digest('hex'));
  const { token: t2, device_id: d2 } = await paired('sara');
  const old = config.appSecret;
  try {
    config.appSecret = 'rotated-secret-'.padEnd(48, 'q'); config.appSecretOld = [old];
    assert.equal((await phone(t2, '/m/me')).status, 200);
    const h = (await pool.query('SELECT token_hash FROM mobile_devices WHERE id=$1', [d2])).rows[0].token_hash;
    assert.equal(h, devices.tokenHash(t2), 'upgraded to the current secret');
    config.appSecretOld = [];
    assert.equal((await phone(t2, '/m/me')).status, 200);
  } finally { config.appSecret = old; config.appSecretOld = []; }
  assert.equal((await phone(t2, '/m/me')).status, 401, 'the old secret alone no longer matches the upgraded hash');
});

test('too many phones on one account → 409; the device list shows active and recently revoked ones', { skip }, async () => {
  await pool.query(`INSERT INTO mobile_devices(user_id, name, platform, token_hash) SELECT $1, 'p' || g, 'android', 'h1:fake' || g FROM generate_series(1, 10) g`, [ids.huda]);
  resetLimit();
  const { code } = await newCode('huda');
  const r = await pairWith(code);
  assert.equal(r.status, 409); assert.equal(r.data.error, 'too_many_devices');
  const list = (await (await as('huda')).get('/devices')).data.devices;
  assert.equal(list.filter(d => !d.revoked_at).length, 10);
  assert.ok(list.some(d => d.revoked_at));
});

test('DELETE /api/m/device: the phone unpairs itself → 204, token refused, audited like other revocations', { skip }, async () => {
  const { token, device_id } = await paired('omar');
  assert.equal((await phone(null, '/m/device', { method: 'DELETE' })).status, 401);
  const r = await phone(token, '/m/device', { method: 'DELETE' });
  assert.equal(r.status, 204);
  assert.equal((await phone(token, '/m/me')).status, 401);
  assert.equal((await phone(token, '/m/device', { method: 'DELETE' })).status, 401);
  const d = (await pool.query('SELECT revoke_reason, revoked_by FROM mobile_devices WHERE id=$1', [device_id])).rows[0];
  assert.deepEqual(d, { revoke_reason: 'unpaired', revoked_by: ids.omar });
  const au = (await pool.query(`SELECT user_id, context FROM audit_log WHERE entity='device' AND action='revoke' AND entity_id=$1`, [String(device_id)])).rows[0];
  assert.equal(au.user_id, ids.omar); assert.equal(au.context.reason, 'unpaired');
  const al = (await pool.query(`SELECT detail FROM auth_log WHERE event='mobile_device_revoked' AND (detail->>'device_id')::int=$1`, [device_id])).rows[0];
  assert.equal(al.detail.reason, 'unpaired');
});

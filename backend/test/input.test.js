// Request parsing and input validation (security remediation WP3: ETS-SEC-008, 028, 029, 059, 061, 070).
// Unit tests always run; the API tests need TEST_DATABASE_URL like api.test.js (its schema is dropped and recreated).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from '../src/utils/csv.js';
import { jsonDepth, idParam, isDate, stripBidi, own } from '../src/utils/http.js';
import { cleanImage } from '../src/services/images.js';

const RLO = '\u202E', LRI = '\u2066', LRM = '\u200E';

// ---------- unit ----------
test('csvCell neutralises formula starts, also after whitespace and in full-width forms (ETS-SEC-059)', () => {
  const cell = v => csvCell(v).slice(1, -1);
  for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', '|calc', '\uFF1D1+1', '\uFF0B1', '\uFF0D1', '\uFF201', ' =1', '\n=1', '\r\n+1',
    '\t1', '\nx', '\u3000=1', '\u00A0=1', RLO + '=1', '\uFEFF=1']) {
    assert.ok(cell(v).startsWith("'"), JSON.stringify(v));
  }
  for (const v of ['abc', '1=1', 'a|b', 'محمد', '2024-01-01']) assert.equal(cell(v), v);
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell({ a: '=1' }), '"{""a"":""=1""}"');
});

test('jsonDepth counts nesting outside strings only (ETS-SEC-008)', async () => {
  // imported lazily: legacy.js loads the app config, which must not be read before the test environment is set
  const { parseLegacy } = await import('../src/services/legacy.js');
  assert.equal(jsonDepth(Buffer.from('{"a":[1,{"b":2}]}')), 3);
  assert.equal(jsonDepth('{"a":"[[[[[[\\"[[["}'), 1);
  assert.equal(jsonDepth('[]'.repeat(5)), 1);
  assert.equal(jsonDepth('['.repeat(1000) + ']'.repeat(1000)), 1000);
  assert.throws(() => parseLegacy('['.repeat(100) + ']'.repeat(100)));
  assert.throws(() => parseLegacy('<script>window.__SAVED=' + '{"f":'.repeat(100) + '1' + '}'.repeat(100) + ';</' + 'script>'));
  assert.deepEqual(parseLegacy('{"f":{}}'), { f: {} });
});

test('idParam / isDate / own / stripBidi (ETS-SEC-028, 029, 061)', () => {
  assert.equal(idParam('42'), 42);
  for (const v of ['abc', '0', '-1', '1.5', '99999999999', '2147483648', '', '1e3', undefined]) {
    assert.throws(() => idParam(v), e => e.status === 400 && e.code === 'invalid_id', String(v));
  }
  assert.ok(isDate('2024-02-29'));
  for (const v of ['2024-02-31', '2023-02-29', '2024-99-99', '2024-1-1', 20240101, null]) assert.equal(isDate(v), false, String(v));
  const rules = { a: 1 };
  for (const k of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) assert.equal(own(rules, k), undefined);
  assert.equal(own(rules, 'a'), 1);
  assert.equal(stripBidi('ab' + RLO + 'c' + LRI + 'd' + LRM), 'abcd');
});

// Minimal JPEG structure: SOI APP0 APP1(Exif) COM DQT SOF0 SOS <data> EOI <trailing>.
const seg = (m, payload) => { const p = Buffer.from(payload); const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(p.length + 2, 2); return Buffer.concat([h, p]); };
const jpeg = trailing => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
  seg(0xe1, 'Exif\0\0GPSLatitude 32.88 Camera XYZ'),
  seg(0xfe, 'author: secret person'),
  seg(0xdb, Buffer.alloc(65, 1)),
  seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
  seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),   // entropy data with a stuffed byte and a restart marker
  Buffer.from([0xff, 0xd9]),
  Buffer.from(trailing),
]);
const pngChunk = (type, data) => {
  const d = Buffer.from(data); const h = Buffer.alloc(8); h.writeUInt32BE(d.length, 0); h.write(type, 4, 'latin1');
  return Buffer.concat([h, d, Buffer.alloc(4)]);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('branding images: metadata and trailing bytes removed (ETS-SEC-070)', () => {
  const j = cleanImage(jpeg('<script>alert(1)</script>'), 'image/jpeg');
  assert.ok(j);
  assert.equal(j.includes('Exif'), false);
  assert.equal(j.includes('secret person'), false);
  assert.equal(j.includes('<script>'), false);
  assert.ok(j.includes('JFIF'));
  assert.deepEqual([...j.subarray(-2)], [0xff, 0xd9]);
  assert.ok(j.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])));   // image data untouched
  assert.equal(cleanImage(jpeg('').subarray(0, 60), 'image/jpeg'), null);            // truncated: refused

  const png = Buffer.concat([PNG_SIG, pngChunk('IHDR', Buffer.alloc(13)), pngChunk('tEXt', 'Author\0secret person'),
    pngChunk('eXIf', 'GPS'), pngChunk('IDAT', 'pixels'), pngChunk('IEND', ''), Buffer.from('<html>polyglot</html>')]);
  const p = cleanImage(png, 'image/png');
  assert.ok(p);
  assert.equal(p.includes('secret person'), false);
  assert.equal(p.includes('eXIf'), false);
  assert.equal(p.includes('polyglot'), false);
  assert.ok(p.includes('IDAT') && p.includes('IHDR'));
  assert.equal(p.subarray(-8, -4).toString('latin1'), 'IEND');
});

// ---------- API ----------
const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
let server, base, pool;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '3', LOGIN_RATE_LIMIT: '1000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('root','Root Admin',$1,'admin',false)`, [await hashPassword('Passw0rd-123')]);
  await pool.query(`UPDATE settings SET value='"off"' WHERE key='mfa.mode'`);
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
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    call, get: p => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}
const errorRows = async () => (await pool.query('SELECT count(*)::int AS n FROM error_log')).rows[0].n;

test('anonymous bodies: 100 kB limit, nesting limit, JSON only, uploads parsed only after auth (ETS-SEC-008)', { skip }, async () => {
  const c = client();
  const big = JSON.stringify({ username: 'x', password: 'y', pad: 'a'.repeat(200 * 1024) });
  assert.equal((await c.call('POST', '/auth/login', big)).status, 413);
  const deep = '['.repeat(50000) + ']'.repeat(50000);                   // 100 kB of nesting
  const t0 = Date.now();
  const r = await c.call('POST', '/auth/login', deep);
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_json');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal((await c.call('POST', '/auth/login', 'username=root', { 'content-type': 'text/plain' })).status, 415);
  // a 3 MB body to an upload route is not even read without a session: 401, not parsed
  const upload = JSON.stringify({ content: 'x'.repeat(3 * 1024 * 1024) });
  assert.equal((await c.call('POST', '/imports/preview', upload)).status, 401);
  assert.equal((await c.call('PUT', '/branding/logo', upload)).status, 401);
  assert.equal((await c.call('POST', '/tracker/import', upload)).status, 401);
  // ... and still limited to 5 MB for an admin
  const root = client(); await root.login('root');
  assert.equal((await root.call('POST', '/tracker/import', JSON.stringify({ content: 'x'.repeat(6 * 1024 * 1024) }))).status, 413);
  assert.equal((await root.call('POST', '/tracker/import', JSON.stringify({ content: '{"f":' + '['.repeat(200) + ']'.repeat(200) + '}' }))).data.error,
    'invalid_import_file');
  // a large body is accepted where it is expected (import file) but not elsewhere
  assert.equal((await root.call('PUT', '/settings', JSON.stringify({ 'app.org_name_en': 'x'.repeat(200 * 1024) }))).status, 413);
});

test('allow-lists ignore inherited names (ETS-SEC-028)', { skip }, async () => {
  const root = client(); await root.login('root');
  const before = await errorRows();
  for (const k of ['toString', 'constructor', 'valueOf', '__proto__']) {
    const r = await root.call('PUT', '/settings', `{"${k}":"x"}`);
    assert.equal(r.status, 400, k);
    assert.equal(r.data.error, 'unknown_setting');
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM settings WHERE key IN ('toString','constructor','valueOf','__proto__')`)).rows[0].n, 0);
  const app = (await root.get('/tracker/reports')).data.applications[0].id;
  assert.equal((await root.patch('/tracker/reports/' + app, { toString: 1 })).data.error, 'unknown_field');
  const fn = (await pool.query('SELECT id FROM functions ORDER BY id LIMIT 1')).rows[0].id;
  assert.equal((await root.patch('/tracker/functions/' + fn, { constructor: 1 })).data.error, 'unknown_field');
  for (const p of ['/logs/constructor', '/logs/toString', '/logs/__proto__/export', '/logs/hasOwnProperty/export']) {
    const r = await root.get(p);
    assert.equal(r.status, 400, p);
    assert.equal(r.data.error, 'unknown_log');
  }
  assert.equal(await errorRows(), before);
});

test('ids, dates, pages and shapes are validated: 400, never 500 (ETS-SEC-029)', { skip }, async () => {
  const root = client(); await root.login('root');
  const before = await errorRows();
  for (const p of ['/imports/abc', '/imports/99999999999', '/users/abc', '/users/1.5', '/users/-1']) {
    const r = await root.get(p);
    assert.equal(r.status, 400, p);
    assert.equal(r.data.error, 'invalid_id');
  }
  assert.equal((await root.post('/imports/abc/approve', { stage: 'lead' })).status, 400);
  assert.equal((await root.post('/approvals/1e3/reject', { reason: 'x' })).status, 400);
  assert.equal((await root.post('/tracker/functions/abc/remove', { reason: 'x' })).status, 400);
  assert.equal((await root.patch('/tracker/functions/99999999999', { progress: 1 })).status, 400);
  assert.equal((await root.get('/logs/audit?page=' + '9'.repeat(400))).status, 200);
  assert.equal((await root.get('/logs/audit?from=2024-02-31')).data.error, 'invalid_date');
  assert.equal((await root.get('/logs/audit?to=2024-99-99')).data.error, 'invalid_date');
  assert.equal((await root.get('/logs/audit?user_id=abc')).status, 400);
  assert.equal((await root.get('/logs/access?status=abc')).status, 400);
  assert.equal((await root.get('/logs/auth/export?user_id=99999999999')).status, 400);
  const me = (await root.get('/auth/me')).data.user.id;
  assert.equal((await root.patch('/users/' + me, { scopes: [null] })).data.error, 'invalid_scope');
  assert.equal((await root.patch('/users/' + me, { overrides: [null] })).data.error, 'invalid_permission');
  assert.equal((await root.patch('/users/' + me, { role_id: { a: 1 } })).data.error, 'invalid_role');
  assert.equal((await root.post('/users/bulk-2fa', { user_ids: [1e12], exempt: true })).status, 400);
  assert.equal((await root.post('/approvals/approve-all', { ids: [1e12] })).status, 200);
  const w = await root.call('PUT', '/tracker/weights');                                  // no body at all
  assert.ok(w.status < 500, String(w.status));
  assert.equal((await root.put('/tracker/weights', { weights: null })).status, 400);
  assert.equal((await root.post('/tracker/applications/sal/impact', { set: [{ function_id: 1e12, enabled: true }] })).status, 200);
  assert.equal((await root.post('/tracker/import', { payload: { f: { x: null, y: { C1: null } }, rep: { a: null }, sch: { start: '2024-02-31' } } })).status, 200);
  assert.equal((await pool.query('SELECT start_date FROM schedule WHERE id=1')).rows[0].start_date, null);
  const imp = await root.post('/imports', { payload: { f: {}, ts: 1e300 }, target: 'department', department_id: 'hr' });
  assert.equal(imp.status, 201);
  assert.equal(imp.data.batch.file_ts, null);
  assert.equal(await errorRows(), before);
});

test('bidi control characters are removed from stored text (ETS-SEC-061)', { skip }, async () => {
  const root = client(); await root.login('root');
  const fn = (await pool.query('SELECT id FROM functions WHERE removed_at IS NULL ORDER BY id LIMIT 1')).rows[0].id;
  const r = await root.patch('/tracker/functions/' + fn, { note: 'ok ' + RLO + 'txt.exe' + LRM });
  assert.equal(r.status, 200);
  assert.equal(r.data.function.note, 'ok txt.exe');
  // an unknown name is stored masked (ETS-SEC-051); the mask is that of 'nimda': the control character was removed first
  await client().login(RLO + 'nimda', 'x');
  const { maskUsername } = await import('../src/services/logs.js');
  const u = (await pool.query(`SELECT username FROM auth_log WHERE event='login_unknown_user' ORDER BY id DESC LIMIT 1`)).rows[0].username;
  assert.equal(u, maskUsername('nimda'));
});

test('auth-log CSV export neutralises formulas typed as a username or sent as user agent (ETS-SEC-059)', { skip }, async () => {
  await client().login('|calc', 'x');                 // unknown name: stored masked (ETS-SEC-051), never as typed
  for (const ua of ['|calc', '=1+1']) {
    await fetch(base + '/auth/login', { method: 'POST', body: JSON.stringify({ username: 'nobody.ua', password: 'x' }),
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ets', 'user-agent': ua } });
  }
  const root = client(); await root.login('root');
  const csv = (await root.get('/logs/auth/export')).data;
  assert.ok(csv.includes(`"'|calc"`));
  assert.ok(csv.includes(`"'=1+1"`));
  assert.equal(csv.includes(`"|calc"`), false);
  assert.equal(csv.includes(`"=1+1"`), false);
  // full-width variants (not possible in an HTTP header) are neutralised by the same cell function
  const { csvCell } = await import('../src/utils/csv.js');
  assert.equal(csvCell('\uFF1D1+1'), `"'\uFF1D1+1"`);
});

test('branding upload is stored without EXIF and trailing bytes (ETS-SEC-070)', { skip }, async () => {
  const root = client(); await root.login('root');
  const data = 'data:image/jpeg;base64,' + jpeg('<html><script>alert(1)</script></html>').toString('base64');
  assert.equal((await root.put('/branding/logo', { data })).status, 200);
  const buf = Buffer.from(await (await fetch(base + '/branding/logo')).arrayBuffer());
  assert.equal(buf.includes('Exif'), false);
  assert.equal(buf.includes('<script>'), false);
  assert.deepEqual([...buf.subarray(-2)], [0xff, 0xd9]);
  const broken = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 50, 1, 2]).toString('base64');
  assert.equal((await root.put('/branding/logo', { data: broken })).data.error, 'invalid_image');
});

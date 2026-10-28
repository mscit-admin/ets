// The aggregated functions_all export (routes/export.js): the per-function detail of every application under a
// department (?dept=…), of one application (?app=…), or of all applications in the reader's scope (no filter). It
// reuses the single-application functions export's row / column builder, prepending a department / application
// column, and is scope-limited exactly like function_changes — a scoped reader never gets another department's
// functions (ETS-SEC-007). Same disposable database as export.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_agentfa npm test
// The public schema is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool;
const ids = {};

// [username, role, scopes ([kind, ref])]
const USERS = [
  ['root', 'admin'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['member_hr', 'member', [['department', 'hr']]],
  ['lead_fin', 'lead', [['department', 'fin']]],
];

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '50', LOGIN_RATE_LIMIT: '1000', LOGIN_IP_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword(PW);
  for (const [u, role, scopes = []] of USERS) {
    const id = (await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id,must_change_password)
      VALUES ($1,$2,$3,$4,$5,false) RETURNING id`, [u, 'Full ' + u, u + '@example.test', h, role])).rows[0].id;
    ids[u] = id;
    for (const [k, r] of scopes) await pool.query('INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,$2,$3)', [id, k, r]);
  }
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
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : type.includes('spreadsheetml') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];

// The first sheet as { ws, title, header: [..], rows: [[..]] } (row 4 = header, data from row 5).
async function sheet(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const vals = r => { const v = ws.getRow(r).values; return Array.isArray(v) ? v.slice(1) : []; };
  const rows = [];
  for (let i = 5; i <= ws.rowCount; i++) rows.push(vals(i));
  return { ws, wb, title: ws.getCell(1, 1).value, subtitle: ws.getCell(2, 1).value, header: vals(4), rows };
}
// columns: department(0) application(1) code(2) name_ar(3) name_en(4) source(5) … (the single-app columns shifted by 2)
const DEPT = 0, APP = 1, CODE = 2;

test('functions_all with a dept spans multiple applications, each row carrying its department / application', { skip }, async () => {
  const root = await as('root');
  const apps = (await pool.query(`SELECT id, name_en FROM applications WHERE department_id='hr' ORDER BY sort`)).rows;
  const dept = await one(`SELECT name_en FROM departments WHERE id='hr'`);
  const s = await sheet((await root.get('/export/functions_all.xlsx?lang=en&dept=hr')).data);
  // the department column is the only department, and more than one application appears
  assert.ok(s.rows.length > 0);
  assert.ok(s.rows.every(r => r[DEPT] === dept.name_en), 'every row is the HR department');
  const seen = new Set(s.rows.map(r => r[APP]));
  assert.ok(seen.size > 1, `rows span multiple applications, saw ${seen.size}`);
  assert.ok([...seen].every(n => apps.some(a => a.name_en === n)), 'only HR applications');

  // the per-function columns are exactly the single-application functions export's, after department / application
  const single = await sheet((await root.get(`/export/functions.xlsx?lang=en&id=${apps[0].id}`)).data);
  assert.deepEqual(s.header.slice(0, 2), ['Department', 'Application']);
  assert.deepEqual(s.header.slice(2), single.header, 'same per-function columns and order as the single-app export');

  // rows of one application equal that application's single-app export rows (shifted by the two prepended columns)
  const mine = s.rows.filter(r => r[APP] === apps[0].name_en).map(r => r.slice(2));
  assert.deepEqual(mine, single.rows, 'per-application rows identical to the single-app export');
});

test('no filter spans multiple departments for a full-scope user', { skip }, async () => {
  const s = await sheet((await (await as('root')).get('/export/functions_all.xlsx?lang=en')).data);
  const depts = new Set(s.rows.map(r => r[DEPT]));
  assert.ok(depts.size > 1, `all-in-scope export spans multiple departments, saw ${depts.size}`);
});

test('app filter narrows to one application', { skip }, async () => {
  const root = await as('root');
  const app = await one(`SELECT id, name_en FROM applications WHERE department_id='fin' ORDER BY sort LIMIT 1`);
  const s = await sheet((await root.get(`/export/functions_all.xlsx?lang=en&app=${app.id}`)).data);
  assert.ok(s.rows.length > 0);
  assert.ok(s.rows.every(r => r[APP] === app.name_en), 'only the chosen application');
  // and matches that application's single-app export
  const single = await sheet((await root.get(`/export/functions.xlsx?lang=en&id=${app.id}`)).data);
  assert.deepEqual(s.rows.map(r => r.slice(2)), single.rows);
});

test('a per-function filter narrows rows the same way as the single-app export', { skip }, async () => {
  const root = await as('root');
  // use a per-function filter (test=0 — not tested) and compare, application by application, with the single export
  const all = await sheet((await root.get('/export/functions_all.xlsx?lang=en&dept=hr&test=0')).data);
  assert.ok(all.rows.length > 0, 'test=0 still yields rows');
  const testCol = all.header.indexOf('Test status');
  assert.ok(all.rows.every(r => r[testCol] === 'Not tested'), 'every row is "Not tested"');
  // the same narrowing per application
  const app = await one(`SELECT id, name_en FROM applications WHERE department_id='hr' ORDER BY sort LIMIT 1`);
  const single = await sheet((await root.get(`/export/functions.xlsx?lang=en&id=${app.id}&test=0`)).data);
  const mine = all.rows.filter(r => r[APP] === app.name_en).map(r => r.slice(2));
  assert.deepEqual(mine, single.rows, 'per-application filtered rows identical to the single-app export');
});

test("scope: a department-scoped user's functions_all is only their department", { skip }, async () => {
  const lead = await as('lead_hr');
  const hrApps = new Set((await pool.query(`SELECT name_en FROM applications WHERE department_id='hr'`)).rows.map(x => x.name_en));
  const finApps = new Set((await pool.query(`SELECT name_en FROM applications WHERE department_id='fin'`)).rows.map(x => x.name_en));
  const finDept = await one(`SELECT name_en FROM departments WHERE id='fin'`);

  // all-in-scope: only HR applications, never a finance one
  const s = await sheet((await lead.get('/export/functions_all.xlsx?lang=en')).data);
  assert.ok(s.rows.length > 0);
  assert.ok(s.rows.every(r => hrApps.has(r[APP])), 'only HR applications in scope');
  assert.ok(s.rows.every(r => !finApps.has(r[APP]) && r[DEPT] !== finDept.name_en), 'no finance application leaks');

  // asking for a department the reader cannot see yields no foreign rows (the filter simply matches nothing)
  const foreign = await lead.get('/export/functions_all.xlsx?lang=en&dept=fin');
  assert.equal(foreign.status, 200);
  const fs = await sheet(foreign.data);
  assert.equal(fs.rows.length, 0, 'no rows from a department out of scope');

  // asking for a finance application yields nothing either
  const finApp = await one(`SELECT id FROM applications WHERE department_id='fin' ORDER BY sort LIMIT 1`);
  const fa = await lead.get(`/export/functions_all.xlsx?lang=en&app=${finApp.id}`);
  assert.equal(fa.status, 200);
  assert.equal((await sheet(fa.data)).rows.length, 0, 'no rows from an application out of scope');
});

test('the export writes an action=export audit row (ETS-SEC-049), and needs exp', { skip }, async () => {
  const root = await as('root');
  const r = await root.get('/export/functions_all.xlsx?lang=en&dept=hr');
  assert.equal(r.status, 200);
  const a = await one(`SELECT * FROM audit_log WHERE action='export' AND entity='functions_all' ORDER BY id DESC LIMIT 1`);
  assert.equal(a.username, 'root');
  assert.equal(a.new_value.format, 'xlsx');
  assert.deepEqual(a.new_value.filters, { dept: 'hr' });
  assert.equal(a.entity_id, 'hr');

  // a member without 'exp' is refused, and no file is produced
  assert.equal((await (await as('member_hr')).get('/export/functions_all.xlsx')).data.permission, 'exp');
});

// Excel exports and the export policy (1.3.0): 'exp' for every export (also the CSV log export), the reader's
// scope, users for administrators only and without sensitive columns, strict audit rows, valid xlsx files,
// formula neutralisation. Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool;
const ids = {};

// [username, role, scopes ([kind, ref]), overrides ([permission, granted])]
const USERS = [
  ['root', 'admin'], ['pmu', 'pm'],
  ['lead_a', 'lead', [['department', 'hr']]],
  ['lead_fin', 'lead', [['department', 'fin']]],
  ['member_fin', 'member', [['department', 'fin']]],
  ['member_hr', 'member', [['department', 'hr']]],
  ['lead_noexp', 'lead', [['department', 'hr']], [['exp', false]]],
  ['pmusr', 'pm', [], [['usr', true]]],
];

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '50', LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword(PW);
  for (const [u, role, scopes = [], overrides = []] of USERS) {
    const id = (await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id,must_change_password)
      VALUES ($1,$2,$3,$4,$5,false) RETURNING id`, [u, 'Full ' + u, u + '@example.test', h, role])).rows[0].id;
    ids[u] = id;
    for (const [k, r] of scopes) await pool.query('INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,$2,$3)', [id, k, r]);
    for (const [p, g] of overrides) await pool.query('INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,$2,$3)', [id, p, g]);
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

async function failInserts(table, on) {
  await pool.query(`CREATE OR REPLACE FUNCTION test_fail_insert() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'injected log write failure'; END $$`);
  await pool.query(`DROP TRIGGER IF EXISTS zz_test_fail ON ${table}`);
  if (on) await pool.query(`CREATE TRIGGER zz_test_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail_insert()`);
}

const REPORTS = ['summary.xlsx', 'project_status.xlsx', 'department.xlsx?id=hr', 'functions.xlsx?id=APP', 'weights.xlsx', 'reports.xlsx',
  'schedule.xlsx', 'approvals.xlsx', 'imports.xlsx', 'log.xlsx?type=audit'];

test('export policy: every export needs exp — Excel reports and the CSV log export', { skip }, async () => {
  const app = (await one(`SELECT id FROM applications WHERE department_id='hr' ORDER BY sort LIMIT 1`)).id;
  // a member (no exp) and a lead whose exp was taken away by an override
  for (const u of ['member_hr', 'lead_noexp']) {
    const c = await as(u);
    for (const p of REPORTS) {
      const r = await c.get('/export/' + p.replace('APP', app));
      assert.equal(r.status, 403, `${u} ${p}`);
      assert.equal(r.data.permission, 'exp', `${u} ${p}`);
    }
  }
  const noexp = await as('lead_noexp');
  assert.equal((await noexp.get('/logs/audit')).status, 200);               // the screen stays readable with 'log'
  const csv = await noexp.get('/logs/audit/export');
  assert.equal(csv.status, 403);
  assert.equal(csv.data.permission, 'exp');
  // with exp every report is exported
  const lead = await as('lead_a');
  for (const p of REPORTS) {
    const r = await lead.get('/export/' + p.replace('APP', app));
    assert.equal(r.status, 200, p + ' ' + JSON.stringify(r.data).slice(0, 200));
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="ets-[a-z0-9.-]+\.xlsx"; filename\*=UTF-8''[^\s"]+$/);
    const s = await sheet(r.data);
    assert.ok(s.header.length > 0, p);
  }
  assert.equal((await lead.get('/logs/audit/export')).status, 200);
  assert.equal((await lead.get('/export/unknown.xlsx')).status, 404);
  assert.equal((await lead.get('/export/summary.csv')).status, 404);
  assert.equal((await lead.get('/export/__proto__.xlsx')).status, 404);
});

test('exports follow the screen\'s scope: a scoped user cannot export another department', { skip }, async () => {
  const lead = await as('lead_a');
  const finApp = (await one(`SELECT id FROM applications WHERE department_id='fin' ORDER BY sort LIMIT 1`)).id;
  assert.equal((await lead.get('/export/department.xlsx?id=fin')).status, 403);
  assert.equal((await lead.get(`/export/functions.xlsx?id=${finApp}`)).status, 403);
  assert.equal((await lead.get('/export/department.xlsx?id=nope')).status, 404);
  assert.equal((await lead.get('/export/functions.xlsx')).status, 404);
  // summary: only the departments the screen shows (+ the total row)
  const depts = (await lead.get('/tracker/summary')).data.departments.map(d => d.name_ar);
  const s = await sheet((await lead.get('/export/summary.xlsx?lang=ar')).data);
  assert.deepEqual(s.rows.map(r => r[0]).slice(0, -1), depts);
  const fin = (await one(`SELECT name_ar FROM departments WHERE id='fin'`)).name_ar;
  assert.ok(!s.rows.some(r => r[0] === fin));
  // weights and reports: only applications in scope
  const hrApps = new Set((await pool.query(`SELECT name_en FROM applications WHERE department_id='hr'`)).rows.map(x => x.name_en));
  const w = await sheet((await lead.get('/export/weights.xlsx?lang=en')).data);
  assert.ok(w.rows.length > 0);
  assert.ok(w.rows.every(r => hrApps.has(r[1])), JSON.stringify(w.rows.map(r => r[1])));
  // an edit request of the finance department is not in the HR lead's approvals export, but in the finance lead's
  const f = await one(`SELECT f.id, f.progress FROM functions f JOIN applications a ON a.id=f.app_id
    WHERE a.department_id='fin' AND f.enabled AND f.removed_at IS NULL ORDER BY f.id LIMIT 1`);
  const rq = await (await as('member_fin')).patch('/tracker/functions/' + f.id, { progress: (+f.progress + 7) % 100 });
  assert.equal(rq.status, 202);
  const mine = await sheet((await lead.get('/export/approvals.xlsx')).data);
  assert.ok(!mine.rows.some(r => r[0] === rq.data.request_id));
  const theirs = await sheet((await (await as('lead_fin')).get('/export/approvals.xlsx?status=pending&lang=en')).data);
  const row = theirs.rows.find(r => r[0] === rq.data.request_id);
  assert.ok(row, 'request in the finance lead export');
  assert.equal(theirs.header[11], 'Field');
  assert.equal(row[11], 'Progress');
  assert.equal(row[13], `${(+f.progress + 7) % 100}%`);
  // a scoped user cannot export the security logs, and gets no IP column in the audit trail
  assert.equal((await lead.get('/export/log.xlsx?type=auth')).status, 403);
  const pm = await as('pmu');
  assert.equal((await pm.get('/export/log.xlsx?type=access')).status, 403);
  const audit = await sheet((await pm.get('/export/log.xlsx?type=audit&lang=en')).data);
  assert.ok(audit.rows.length > 0);
  assert.ok(!audit.header.includes('IP address') && !audit.header.includes('Device / browser'), audit.header.join());
  const adm = await sheet((await (await as('root')).get('/export/log.xlsx?type=audit&lang=en')).data);
  assert.ok(adm.header.includes('IP address'));
  assert.equal((await lead.get('/export/log.xlsx?type=nope')).status, 400);
});

test('users export: administrators only, and only the listed columns', { skip }, async () => {
  await pool.query(`UPDATE users SET last_login_ip='10.99.0.7', failed_attempts=4, locked_until=now() + interval '1 hour',
    last_login_at=now() WHERE username='member_hr'`);
  for (const u of ['lead_a', 'pmu', 'pmusr']) {
    const r = await (await as(u)).get('/export/users.xlsx');
    assert.equal(r.status, 403, u);
  }
  const r = await (await as('root')).get('/export/users.xlsx?lang=en');
  assert.equal(r.status, 200);
  const s = await sheet(r.data);
  assert.deepEqual(s.header, ['Full name', 'Username', 'Role', 'Status', 'Two-factor authentication', 'Scope', 'Last login', 'Email']);
  const m = s.rows.find(x => x[1] === 'member_hr');
  assert.equal(m[0], 'Full member_hr');
  assert.equal(m[3], 'Active');
  assert.equal(m[4], 'Off');
  assert.ok(m[6] instanceof Date);
  assert.equal(m[7], 'member_hr@example.test');
  assert.equal(s.rows.find(x => x[1] === 'root')[5], 'All departments');
  const hr = (await one(`SELECT name_en FROM departments WHERE id='hr'`)).name_en;
  assert.equal(m[5], hr);
  // nothing sensitive anywhere in the file
  const hash = (await one(`SELECT password_hash FROM users WHERE username='member_hr'`)).password_hash;
  const text = JSON.stringify(s.rows);
  for (const bad of [hash, '$2', '10.99.0.7', 'Mozilla']) assert.equal(text.includes(bad), false, bad);
  const cells = s.rows.flat().filter(v => typeof v === 'number');
  assert.deepEqual(cells, [], 'no numeric cells (failed attempts, ids)');
  // the audit row names the report
  const a = await one(`SELECT * FROM audit_log WHERE action='export' AND entity='users' ORDER BY id DESC LIMIT 1`);
  assert.equal(a.username, 'root');
  assert.equal(a.new_value.rows, s.rows.length);
  assert.equal(a.new_value.format, 'xlsx');
});

test('xlsx files: valid workbook, RTL in Arabic, headers, percentages, title row; audit row written', { skip }, async () => {
  const root = await as('root');
  const app = await one(`SELECT id, name_ar, name_en FROM applications WHERE department_id='hr' ORDER BY sort LIMIT 1`);
  const fns = (await root.get(`/tracker/applications/${app.id}`)).data.functions.filter(f => !f.removed_at && (f.enabled || f.source !== 'experience'));
  const r = await root.get(`/export/functions.xlsx?id=${app.id}&lang=ar`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), new RegExp(`filename="ets-functions-${app.id}-\\d{4}-\\d{2}-\\d{2}\\.xlsx"`));
  assert.ok(decodeURIComponent(r.headers.get('content-disposition').split("UTF-8''")[1]).includes(app.name_ar));
  const s = await sheet(r.data);
  assert.equal(s.ws.views[0].rightToLeft, true);
  assert.equal(s.ws.views[0].state, 'frozen');
  assert.equal(s.ws.views[0].ySplit, 4);
  assert.ok(s.ws.autoFilter);
  assert.ok(String(s.title).includes(app.name_ar));
  assert.ok(String(s.subtitle).includes('Full root'));
  assert.deepEqual(s.header.slice(0, 3), ['الرمز', 'الاسم (عربي)', 'الاسم (إنجليزي)']);
  assert.ok(s.ws.getRow(4).font.bold);
  assert.equal(s.rows.length, fns.length);
  const first = fns[0];
  assert.equal(s.rows[0][0], first.code);
  assert.equal(s.rows[0][1], first.name_ar);
  const pcol = s.header.indexOf('الإنجاز') + 1;
  assert.equal(s.ws.getCell(5, pcol).value, +first.progress / 100);
  assert.equal(s.ws.getCell(5, pcol).numFmt, '0.0%');
  // English: left to right, translated headers
  const en = await sheet((await root.get(`/export/functions.xlsx?id=${app.id}&lang=en&test=0`)).data);
  assert.equal(en.ws.views[0].rightToLeft, false);
  assert.equal(en.header[0], 'Code');
  assert.ok(en.rows.every(x => x[9] === 'Not tested'));
  assert.ok(String(en.subtitle).includes('Test status: 0'));
  // the audit row: entity = report, id = application, rows and filters
  const a = await one(`SELECT * FROM audit_log WHERE action='export' AND entity='functions' ORDER BY id DESC LIMIT 1`);
  assert.equal(a.entity_id, app.id);
  assert.equal(a.new_value.rows, en.rows.length);
  assert.deepEqual(a.new_value.filters, { test: '0' });
  assert.equal(a.context.app_id, app.id);
  assert.match(a.summary, /^xlsx: \d+ rows \[test=0\]$/);
  // the schedule table and the project status: numbers stay numbers
  const sch = await sheet((await root.get('/export/schedule.xlsx?lang=en')).data);
  assert.deepEqual(sch.header, ['Period', 'Period end', 'Planned', 'Actual', 'Deviation']);
  assert.equal(sch.rows[0][0], 1);
  assert.equal(typeof sch.rows[0][2], 'number');
  const ps = await sheet((await root.get('/export/project_status.xlsx?lang=en')).data);
  assert.equal(ps.rows[0][0], 'Overall project progress');
  assert.equal(ps.ws.getCell(5, 2).numFmt, '0.0%');
});

test('xlsx exports neutralise formulas and never write formula cells (ETS-SEC-059)', { skip }, async () => {
  const f = await one(`SELECT f.id, f.app_id FROM functions f JOIN applications a ON a.id=f.app_id
    WHERE a.department_id='hr' AND f.enabled AND f.removed_at IS NULL ORDER BY f.id LIMIT 1`);
  await pool.query(`UPDATE functions SET name_ar=$2, note=$3, reference=$4 WHERE id=$1`,
    [f.id, '=HYPERLINK("http://evil.example","x")', '+cmd|calc', '​@SUM(1)']);
  const r = await (await as('root')).get(`/export/functions.xlsx?id=${f.app_id}&lang=en`);
  const s = await sheet(r.data);
  const row = s.rows.find(x => x[1]?.toString().includes('HYPERLINK'));
  assert.ok(row);
  assert.equal(row[1], '\'=HYPERLINK("http://evil.example","x")');
  assert.equal(row[4], '\'​@SUM(1)');
  assert.equal(row[13], '\'+cmd|calc');
  s.ws.eachRow(rw => rw.eachCell(c => { assert.notEqual(c.type, ExcelJS.ValueType.Formula); assert.equal(c.formula, undefined); }));
});

test('exports are refused when their audit row cannot be written (ETS-SEC-049)', { skip }, async () => {
  const root = await as('root');
  await failInserts('audit_log', true);
  try {
    for (const p of ['summary.xlsx', 'users.xlsx', 'log.xlsx?type=audit', 'department.xlsx?id=hr']) {
      const r = await root.get('/export/' + p);
      assert.equal(r.status, 500, p);
      assert.equal(Buffer.isBuffer(r.data), false, p);
    }
    assert.equal((await root.get('/logs/audit/export')).status, 500);
  } finally { await failInserts('audit_log', false); }
  assert.equal((await root.get('/export/summary.xlsx')).status, 200);
});

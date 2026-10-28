// The consolidated function_changes export (routes/export.js): the union of the three change channels (a direct
// edit → audit_log entity='function'; an approved edit request → edit_request_items.applied; an applied import →
// import_changes.applied), one row per field-change, with the reader's scope and the optional department /
// application filters. Same disposable database as export.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_agentfce npm test
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
  await seedChanges();
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

async function sheet(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const vals = r => { const v = ws.getRow(r).values; return Array.isArray(v) ? v.slice(1) : []; };
  const rows = [];
  for (let i = 5; i <= ws.rowCount; i++) rows.push(vals(i));
  return { ws, wb, title: ws.getCell(1, 1).value, header: vals(4), rows };
}
// columns: when(0) source(1) department(2) application(3) item(4) field(5) before(6) after(7) by(8) requested_by(9) ref(10)
const byRef = (s, ref) => s.rows.find(r => r[10] === ref);

const picked = {};     // the two applications / functions used by the tests
async function seedChanges() {
  picked.hrApp = await one(`SELECT id, name_en, department_id FROM applications WHERE department_id='hr' ORDER BY sort LIMIT 1`);
  picked.finApp = await one(`SELECT id, name_en, department_id FROM applications WHERE department_id='fin' ORDER BY sort LIMIT 1`);
  picked.hrFn = await one(`SELECT id, code, progress FROM functions WHERE app_id=$1 AND enabled AND removed_at IS NULL ORDER BY id LIMIT 1`, [picked.hrApp.id]);
  picked.finFn = await one(`SELECT id, code, progress FROM functions WHERE app_id=$1 AND enabled AND removed_at IS NULL ORDER BY id LIMIT 1`, [picked.finApp.id]);

  // 1) direct edit (full-scope admin → applied immediately, audit_log entity='function')
  const root = await as('root');
  const np = (+picked.hrFn.progress + 30) % 100;
  picked.directProgress = np;
  const rp = await root.patch('/tracker/functions/' + picked.hrFn.id, { progress: np });
  assert.equal(rp.status, 200, JSON.stringify(rp.data));
  picked.directRef = 'A' + (await one(`SELECT id FROM audit_log WHERE entity='function' AND action='update' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [String(picked.hrFn.id)])).id;

  // 2) approved edit request on the same HR function (test_status 1 → 2), applied
  const rq = await one(`INSERT INTO edit_requests(department_id,app_id,kind,summary,status,requested_by,decided_by,decided_at)
    VALUES ('hr',$1,'function','test',$2,$3,$4,now()) RETURNING id`, [picked.hrApp.id, 'applied', ids.member_hr, ids.lead_hr]);
  picked.apprRef = 'R' + rq.id;
  await pool.query(`INSERT INTO edit_request_items(request_id,kind,app_id,function_id,field,old_value,new_value,applied)
    VALUES ($1,'function',$2,$3,'test_status','1','2',true)`, [rq.id, picked.hrApp.id, picked.hrFn.id]);

  // 3) applied import on a FINANCE function (progress 20 → 55)
  const b = await one(`INSERT INTO import_batches(target,department_id,departments,filename,status,change_count,uploaded_by,applied_at)
    VALUES ('department','fin',ARRAY['fin'],'fin.json','applied',1,$1,now()) RETURNING id`, [ids.lead_fin]);
  picked.impRef = 'I' + b.id;
  await pool.query(`INSERT INTO import_changes(batch_id,kind,app_id,function_id,code,field,old_value,new_value,applied)
    VALUES ($1,'function',$2,$3,$4,'progress','20','55',true)`, [b.id, picked.finApp.id, picked.finFn.id, picked.finFn.code]);

  // noise that must NEVER appear: a weight-level import change, an application-level and a report-track audit row
  await pool.query(`INSERT INTO import_changes(batch_id,kind,app_id,function_id,code,field,old_value,new_value,applied)
    VALUES ($1,'weight',$2,NULL,NULL,'weight','1','"WEIGHTSENTINEL"',true)`, [b.id, picked.finApp.id]);
  await pool.query(`INSERT INTO audit_log(username,action,entity,entity_id,old_value,new_value)
    VALUES ('root','update','application',$1,'{"weight":1}','{"weight":"APPSENTINEL"}')`, [picked.finApp.id]);
  await pool.query(`INSERT INTO audit_log(username,action,entity,entity_id,old_value,new_value)
    VALUES ('root','update','report',$1,'{"status":0}','{"status":"REPORTSENTINEL"}')`, [picked.finApp.id]);
}

test('the three change channels are unioned, each with the right before / after', { skip }, async () => {
  const s = await sheet((await (await as('root')).get('/export/function_changes.xlsx?lang=en')).data);
  const direct = byRef(s, picked.directRef);
  assert.ok(direct, 'direct edit row present');
  assert.equal(direct[1], 'Direct edit');
  assert.ok(String(direct[4]).includes(picked.hrFn.code), 'item names the function');
  assert.equal(direct[5], 'Progress');
  assert.equal(direct[6], `${+picked.hrFn.progress}%`);
  assert.equal(direct[7], `${picked.directProgress}%`);
  assert.equal(direct[8], 'root');

  const appr = byRef(s, picked.apprRef);
  assert.ok(appr, 'approved edit-request row present');
  assert.equal(appr[1], 'Approved edit request');
  assert.equal(appr[5], 'Test status');
  assert.equal(appr[6], 'Passed with note');       // ts_1
  assert.equal(appr[7], 'Passed');                  // ts_2
  assert.equal(appr[8], 'Full lead_hr');            // decided_by
  assert.equal(appr[9], 'Full member_hr');          // requested_by

  const imp = byRef(s, picked.impRef);
  assert.ok(imp, 'applied import row present');
  assert.equal(imp[1], 'Applied import');
  assert.equal(imp[5], 'Progress');
  assert.equal(imp[6], '20%');
  assert.equal(imp[7], '55%');
});

test('weight changes and application / report-track audit rows never appear', { skip }, async () => {
  const s = await sheet((await (await as('root')).get('/export/function_changes.xlsx?lang=en')).data);
  const text = JSON.stringify(s.rows);
  for (const sentinel of ['WEIGHTSENTINEL', 'APPSENTINEL', 'REPORTSENTINEL']) {
    assert.equal(text.includes(sentinel), false, sentinel + ' leaked into the export');
  }
});

test('filter by application and by department', { skip }, async () => {
  const root = await as('root');
  const byApp = await sheet((await root.get(`/export/function_changes.xlsx?lang=en&app=${picked.hrApp.id}`)).data);
  assert.ok(byRef(byApp, picked.directRef) && byRef(byApp, picked.apprRef), 'HR app changes present');
  assert.ok(!byRef(byApp, picked.impRef), 'finance import excluded by app filter');
  assert.ok(byApp.rows.every(r => r[3] === picked.hrApp.name_en), 'only the chosen application');

  const byDept = await sheet((await root.get('/export/function_changes.xlsx?lang=en&dept=fin')).data);
  assert.ok(byRef(byDept, picked.impRef), 'finance import present under dept=fin');
  assert.ok(!byRef(byDept, picked.directRef) && !byRef(byDept, picked.apprRef), 'HR changes excluded by dept filter');

  // an unknown id is ignored (not an error): the full set comes back
  const bad = await root.get('/export/function_changes.xlsx?lang=en&dept=nope&app=nope');
  assert.equal(bad.status, 200);
  const s = await sheet(bad.data);
  assert.ok(byRef(s, picked.directRef) && byRef(s, picked.apprRef) && byRef(s, picked.impRef));
});

test('scope: a department-scoped user never sees another department\'s changes', { skip }, async () => {
  // HR lead: sees the HR direct edit and the HR approved request, never the finance import
  const s = await sheet((await (await as('lead_hr')).get('/export/function_changes.xlsx?lang=en')).data);
  assert.ok(byRef(s, picked.directRef), 'HR lead sees HR direct edit');
  assert.ok(byRef(s, picked.apprRef), 'HR lead sees HR approved request');
  assert.equal(byRef(s, picked.impRef), undefined, 'HR lead must NOT see the finance import');
  assert.ok(s.rows.length > 0 && s.rows.every(r => r[3] !== picked.finApp.name_en && r[10] !== picked.impRef));

  // full-scope admin sees both departments
  const all = await sheet((await (await as('root')).get('/export/function_changes.xlsx?lang=en')).data);
  assert.ok(byRef(all, picked.directRef) && byRef(all, picked.impRef), 'admin sees HR and finance');
});

test('the export writes an action=export audit row (ETS-SEC-049)', { skip }, async () => {
  const root = await as('root');
  const r = await root.get('/export/function_changes.xlsx?lang=en&dept=hr');
  assert.equal(r.status, 200);
  const a = await one(`SELECT * FROM audit_log WHERE action='export' AND entity='function_changes' ORDER BY id DESC LIMIT 1`);
  assert.equal(a.username, 'root');
  assert.equal(a.new_value.format, 'xlsx');
  assert.deepEqual(a.new_value.filters, { dept: 'hr' });

  // a member without 'exp' is refused, and no file is produced
  assert.equal((await (await as('member_hr')).get('/export/function_changes.xlsx')).data.permission, 'exp');
});

// «نجح» needs 100 % (1.8.1): the test status «نجح» (plain pass, 2) only with progress 100, and no progress below 100
// on a passed item — on every path that writes these fields: single edit, bulk set, approval requests (at submit and
// again on approval), team result imports (preview row errors, re-check when applied), the legacy tracker import.
// «نجح مع ملاحظة» (pass with note, 1) has no progress rule. Items already passed below 100 % are left as they are
// and can be fixed by either field. Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool;

// [username, role, scopes ([kind, ref])]
const USERS = [
  ['root', 'admin'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['member_hr', 'member', [['department', 'hr']]],
  ['pm1', 'pm'],
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
  for (const [u, role, scopes = []] of USERS) {
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password)
      VALUES ($1,$2,$3,$4,false) RETURNING id`, [u, 'Full ' + u, h, role])).rows[0].id;
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
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const fnRow = id => one('SELECT * FROM functions WHERE id=$1', [id]);
// The seven items of 'ess' (HR): counted, function type, given progress / test status (default 80 % / not tested), no note, nothing pending.
async function reset(progress = [], tests = []) {
  await pool.query(`UPDATE edit_requests SET status='withdrawn' WHERE status='pending'`);
  const rows = (await pool.query(`SELECT id FROM functions WHERE app_id='ess' ORDER BY sort, id`)).rows;
  for (const [i, r] of rows.entries()) {
    await pool.query(`UPDATE functions SET enabled=true, item_type='function', progress=$2, test_status=$3, note='', notif_status=0, review_status=0
      WHERE id=$1`, [r.id, progress[i] ?? 80, tests[i] ?? 0]);
  }
  return (await pool.query(`SELECT * FROM functions WHERE app_id='ess' ORDER BY sort, id`)).rows;
}

test('single edit: «نجح» needs 100 %, in both directions; «نجح مع ملاحظة» has no progress rule', { skip }, async () => {
  const [f, g, h, k] = await reset();
  const lead = await as('lead_hr');
  const p = (x, body) => lead.patch('/tracker/functions/' + x.id, body);
  // «نجح» at 80 % → refused, nothing saved
  let r = await p(f, { test_status: 2 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'pass_requires_100');
  assert.equal(r.data.progress, 80);
  assert.equal((await fnRow(f.id)).test_status, 0);
  // progress 100 first, then «نجح» → accepted
  assert.equal((await p(f, { progress: 100 })).status, 200);
  assert.equal((await p(f, { test_status: 2 })).status, 200);
  // «نجح» with progress 100 in the same request → accepted (whatever the order of the fields)
  r = await p(g, { test_status: 2, progress: 100 });
  assert.equal(r.status, 200);
  assert.deepEqual([+r.data.function.progress, r.data.function.test_status], [100, 2]);
  // «نجح» with a progress below 100 in the same request → refused
  assert.equal((await p(h, { test_status: 2, progress: 90 })).data.error, 'pass_requires_100');
  // lowering the progress of a passed item → refused, with the message's own code
  r = await p(f, { progress: 90 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'progress_below_100_while_passed');
  assert.equal(+(await fnRow(f.id)).progress, 100);
  // lowering it together with a status away from «نجح» → accepted
  r = await p(f, { progress: 90, test_status: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual([+r.data.function.progress, r.data.function.test_status], [90, 3]);
  // other fields of a passed item can still be edited
  assert.equal((await p(g, { note: 'ok', notif_status: 1 })).status, 200);
  // «نجح مع ملاحظة» at 80 % is accepted (with its note), and its progress may go down
  r = await p(k, { test_status: 1, note: 'works, report layout to fix' });
  assert.equal(r.status, 200);
  assert.deepEqual([+r.data.function.progress, r.data.function.test_status], [80, 1]);
  assert.equal((await p(k, { progress: 40 })).status, 200);
  // the bulk «نجح مع ملاحظة» has no progress rule either (every item has a note)
  await pool.query(`UPDATE functions SET note='n' WHERE app_id='ess'`);
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'test_status', value: 1 })).status, 200);
});

test('report items follow the same rule', { skip }, async () => {
  const [f] = await reset();
  const lead = await as('lead_hr');
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { item_type: 'report' })).status, 200);
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { test_status: 2 })).data.error, 'pass_requires_100');
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { progress: 100, test_status: 2 })).status, 200);
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { progress: 50 })).data.error, 'progress_below_100_while_passed');
  const row = await fnRow(f.id);
  assert.deepEqual([row.item_type, +row.progress, row.test_status], ['report', 100, 2]);
});

test('bulk set: all or nothing, with the list of the items that block it', { skip }, async () => {
  const fs = await reset([100, 80, 100, 50, 100, 100, 100], [0, 0, 0, 0, 0, 0, 0]);
  const lead = await as('lead_hr');
  let r = await lead.post('/tracker/applications/ess/bulk', { field: 'test_status', value: 2 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'pass_requires_100');
  assert.equal(r.data.count, 2);
  assert.deepEqual(r.data.items.map(x => [x.code, x.current_progress]), [[fs[1].code, 80], [fs[3].code, 50]]);
  assert.equal(r.data.list, `${fs[1].code}, ${fs[3].code}`);
  assert.equal((await one(`SELECT count(*)::int AS n FROM functions WHERE app_id='ess' AND test_status=2`)).n, 0);   // nothing changed
  // the same for a member (the request is not even created)
  const member = await as('member_hr');
  r = await member.post('/tracker/applications/ess/bulk', { field: 'test_status', value: 2 });
  assert.equal(r.data.error, 'pass_requires_100');
  assert.equal((await one(`SELECT count(*)::int AS n FROM edit_requests WHERE status='pending'`)).n, 0);
  // progress 100 for all, then «نجح» for all → accepted
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'progress', value: 100 })).data.updated, 7);
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'test_status', value: 2 })).data.updated, 7);
  // a progress below 100 on passed items → refused, listing them
  r = await lead.post('/tracker/applications/ess/bulk', { field: 'progress', value: 80 });
  assert.equal(r.data.error, 'progress_below_100_while_passed');
  assert.equal(r.data.count, 7);
  assert.equal((await one(`SELECT min(progress)::int AS m FROM functions WHERE app_id='ess'`)).m, 100);
  // an excluded item is not concerned by a bulk set (it only changes counted items)
  await pool.query(`UPDATE functions SET enabled=false, test_status=0, progress=10 WHERE id=$1`, [fs[0].id]);
  await pool.query(`UPDATE functions SET test_status=0 WHERE app_id='ess'`);
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'test_status', value: 2 })).data.updated, 6);
  assert.equal((await fnRow(fs[0].id)).test_status, 0);
});

test('approval requests: checked at submit, and again on approval against the values of the moment', { skip }, async () => {
  const [f, g, h] = await reset([80, 100, 100]);
  const member = await as('member_hr'), lead = await as('lead_hr');
  // submit: «نجح» at 80 % is refused at once, no request is created
  let r = await member.patch('/tracker/functions/' + f.id, { test_status: 2 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'pass_requires_100');
  assert.equal((await one(`SELECT count(*)::int AS n FROM edit_requests WHERE status='pending'`)).n, 0);
  // submit OK at 100 %; then the lead lowers the progress (allowed: not passed yet); approval → 409, nothing applied
  r = await member.patch('/tracker/functions/' + g.id, { test_status: 2 });
  assert.equal(r.status, 202);
  assert.equal((await lead.patch('/tracker/functions/' + g.id, { progress: 70 })).status, 200);
  let a = await lead.post(`/approvals/${r.data.request_id}/approve`);
  assert.equal(a.status, 409);
  assert.equal(a.data.error, 'pass_requires_100');
  assert.equal(a.data.code, g.code);
  assert.equal((await fnRow(g.id)).test_status, 0);
  assert.equal((await one('SELECT status FROM edit_requests WHERE id=$1', [r.data.request_id])).status, 'pending');
  // "approve all" leaves it pending too (counted as blocked)
  const all = (await lead.post('/approvals/approve-all')).data;
  assert.deepEqual([all.blocked_requests, all.applied_changes], [1, 0]);
  // back at 100 → the same request is approved
  assert.equal((await lead.patch('/tracker/functions/' + g.id, { progress: 100 })).status, 200);
  a = await lead.post(`/approvals/${r.data.request_id}/approve`);
  assert.equal(a.status, 200);
  assert.equal((await fnRow(g.id)).test_status, 2);
  // the other direction: a progress of 60 requested while not passed; the lead sets «نجح» (at 100 %); approval → 409
  r = await member.patch('/tracker/functions/' + h.id, { progress: 60 });
  assert.equal(r.status, 202);
  assert.equal((await lead.patch('/tracker/functions/' + h.id, { test_status: 2 })).status, 200);
  a = await lead.post(`/approvals/${r.data.request_id}/approve`);
  assert.equal(a.status, 409);
  assert.equal(a.data.error, 'progress_below_100_while_passed');
  assert.equal(+(await fnRow(h.id)).progress, 100);
  // submit: lowering the progress of a passed item is refused at once
  assert.equal((await member.patch('/tracker/functions/' + g.id, { progress: 50 })).data.error, 'progress_below_100_while_passed');
  // a request with «نجح» and 100 % together is applied whatever the order of its items
  const [, , , x] = await reset();
  r = await member.patch('/tracker/functions/' + x.id, { test_status: 2, progress: 100 });
  assert.equal(r.status, 202);
  assert.equal((await lead.post(`/approvals/${r.data.request_id}/approve`)).data.applied_changes, 2);
  const row = await fnRow(x.id);
  assert.deepEqual([+row.progress, row.test_status], [100, 2]);
});

test('team result import: rows breaking the rule are row errors in the preview; the part is refused', { skip }, async () => {
  const fs = await reset([80, 100, 100, 60, 100, 100, 100], [0, 0, 0, 2, 0, 0, 0]);   // fs[3]: passed at 60 % before 1.8.1
  const root = await as('root');
  const file = (await root.get('/tracker/export')).data;
  file.f.ess[fs[0].code].t = 2;                                   // «نجح» at 80 % → error
  file.f.ess[fs[1].code].t = 2;                                   // «نجح» at 100 % → fine
  file.f.ess[fs[2].code].t = 2; file.f.ess[fs[2].code].p = 100;   // unchanged progress
  file.f.ess[fs[4].code].p = 90; file.f.ess[fs[4].code].t = 1;    // «نجح مع ملاحظة» at 90 % → fine
  const content = JSON.stringify(file);
  const pv = (await root.post('/imports/preview', { content })).data;
  const hr = pv.options.find(o => o.department_id === 'hr');
  assert.deepEqual(hr.errors.map(e => [e.app_id, e.code, e.error, e.progress]), [['ess', fs[0].code, 'pass_requires_100', 80]]);
  assert.ok(pv.options.filter(o => o !== hr).every(o => Array.isArray(o.errors) && !o.errors.length));
  const r = await root.post('/imports', { content, target: 'department', department_id: 'hr' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'import_has_row_errors');
  assert.equal(r.data.count, 1);
  assert.equal(r.data.list, `ess/${fs[0].code}`);
  assert.equal((await one(`SELECT count(*)::int AS n FROM import_batches WHERE department_id='hr'`)).n, 0);
  // lowering the progress of a passed item is an error too; the legacy item the file leaves as it is, is not
  file.f.ess[fs[0].code].t = 0;
  file.f.ess[fs[1].code].p = 100;
  await pool.query('UPDATE functions SET test_status=2 WHERE id=$1', [fs[5].id]);
  file.f.ess[fs[5].code] = { ...file.f.ess[fs[5].code], t: 2, p: 70 };
  const pv2 = (await root.post('/imports/preview', { content: JSON.stringify(file) })).data;
  assert.deepEqual(pv2.options.find(o => o.department_id === 'hr').errors.map(e => [e.code, e.error]), [[fs[5].code, 'progress_below_100_while_passed']]);
  file.f.ess[fs[5].code].p = 100;
  const ok = await root.post('/imports', { content: JSON.stringify(file), target: 'department', department_id: 'hr' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.batch.status, 'pending');

  // applied after two approvals: a change made meanwhile is checked again — fs[2] lowered to 50 % before the
  // batch's «نجح» lands → its status change is put back and reported as skipped; the rest is applied
  assert.equal((await root.patch('/tracker/functions/' + fs[2].id, { progress: 50 })).status, 200);
  await (await as('lead_hr')).post(`/imports/${ok.data.batch.id}/approve`, { stage: 'lead' });
  const fin = (await (await as('pm1')).post(`/imports/${ok.data.batch.id}/approve`, { stage: 'final' })).data;
  assert.equal(fin.applied, true);
  const r2 = await fnRow(fs[2].id);
  assert.deepEqual([+r2.progress, r2.test_status], [50, 0]);
  const ch = await one(`SELECT applied, note FROM import_changes WHERE batch_id=$1 AND function_id=$2 AND field='test_status'`, [ok.data.batch.id, fs[2].id]);
  assert.deepEqual([ch.applied, ch.note], [false, 'pass_requires_100']);
  assert.equal((await fnRow(fs[1].id)).test_status, 2);
  assert.equal((await fnRow(fs[4].id)).test_status, 1);
  assert.ok(fin.skipped_changes >= 1);
});

test('legacy tracker import: refused as a whole when a row breaks the rule; legacy rows left as they are pass', { skip }, async () => {
  const fs = await reset([80, 100, 100, 60, 100, 100, 100], [0, 0, 0, 2, 0, 0, 0]);
  const root = await as('root');
  const file = (await root.get('/tracker/export')).data;
  file.f.ess[fs[0].code].t = 2;
  file.f.ess[fs[1].code].p = 75;                                  // unchanged status 0: fine
  let r = await root.post('/tracker/import', { payload: file });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'import_has_row_errors');
  assert.deepEqual(r.data.errors.map(e => [e.code, e.error]), [[fs[0].code, 'pass_requires_100']]);
  assert.equal(+(await fnRow(fs[1].id)).progress, 100);           // nothing written
  file.f.ess[fs[0].code].t = 0;
  r = await root.post('/tracker/import', { payload: file });      // fs[3] stays «نجح» at 60 %: not an error
  assert.equal(r.status, 200);
  assert.equal(+(await fnRow(fs[1].id)).progress, 75);
  const leg = await fnRow(fs[3].id);
  assert.deepEqual([+leg.progress, leg.test_status], [60, 2]);
});

test('items passed below 100 % before 1.8.1: kept, listed by the conflict filter, fixable by either field', { skip }, async () => {
  const fs = await reset([60, 30, 100, 80, 80, 80, 80], [2, 2, 2, 0, 0, 0, 0]);
  const lead = await as('lead_hr');
  // the export's «conflict» filter lists exactly the two
  const x = await lead.get('/export/functions.xlsx?id=ess&test=conflict&lang=ar');
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.data);
  const ws = wb.worksheets[0];
  const codes = [];
  ws.eachRow((row, n) => { if (n > 4) codes.push(String(row.getCell(1).value)); });
  assert.deepEqual(codes, [fs[0].code, fs[1].code]);
  assert.match(String(ws.getRow(2).getCell(1).value), /تعارض الحالة والنسبة/);
  // other edits are not blocked
  assert.equal((await lead.patch('/tracker/functions/' + fs[0].id, { note: 'to check', notif_status: 1 })).status, 200);
  // another progress below 100 is refused; 100 fixes it
  assert.equal((await lead.patch('/tracker/functions/' + fs[0].id, { progress: 70 })).data.error, 'progress_below_100_while_passed');
  assert.equal((await lead.patch('/tracker/functions/' + fs[0].id, { progress: 100 })).status, 200);
  // or the status away from «نجح» (the progress stays)
  const r = await lead.patch('/tracker/functions/' + fs[1].id, { test_status: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual([+r.data.function.progress, r.data.function.test_status], [30, 0]);
  // a member's fix through approval is applied too
  await pool.query('UPDATE functions SET test_status=2, progress=40 WHERE id=$1', [fs[3].id]);
  const member = await as('member_hr');
  const q = await member.patch('/tracker/functions/' + fs[3].id, { progress: 100 });
  assert.equal(q.status, 202);
  assert.equal((await lead.post(`/approvals/${q.data.request_id}/approve`)).status, 200);
  assert.equal(+(await fnRow(fs[3].id)).progress, 100);
  // a bulk «نجح» does not list items that are already «نجح»
  await pool.query('UPDATE functions SET test_status=2, progress=40 WHERE id=$1', [fs[4].id]);
  await pool.query(`UPDATE functions SET progress=100 WHERE app_id='ess' AND id <> $1`, [fs[4].id]);
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'test_status', value: 2 })).status, 200);
  assert.equal(+(await fnRow(fs[4].id)).progress, 40);
});

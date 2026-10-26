// Item type (1.8.0, migration 016): each item of an application is a function or a report. Report items count in the
// application's reports % (with the reports track as one more item of weight 1), not in its functions %. The type is
// changed by PATCH, by the bulk "set type" and chosen when adding; audited, sent to the team lead when edits need
// approval, exported, filtered. Same disposable database as api.test.js:
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

// [username, role, scopes ([kind, ref])]
const USERS = [
  ['root', 'admin'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['member_hr', 'member', [['department', 'hr']]],
  ['ed_hr', 'ed', [['department', 'hr']]],          // no 'tog': cannot change a type
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
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password)
      VALUES ($1,$2,$3,$4,false) RETURNING id`, [u, 'Full ' + u, h, role])).rows[0].id;
    ids[u] = id;
    for (const [k, r] of scopes) await pool.query('INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,$2,$3)', [id, k, r]);
  }
  // Fixture: 'ess' (HR, has a reports track) — 7 counted items of weight 1: five at 50 %, two at 100 %; track at 40 %.
  //          'env' (infrastructure, a base department: no reports track) — 6 items of weight 1: five at 30 %, one at 90 %.
  // Notification status "not set" everywhere, so no blending; reports share 0.15 (default).
  for (const [app, values] of [['ess', [50, 50, 50, 50, 50, 100, 100]], ['env', [30, 30, 30, 30, 30, 90]]]) {
    const rows = (await pool.query('SELECT id FROM functions WHERE app_id=$1 ORDER BY sort, id', [app])).rows;
    assert.equal(rows.length, values.length, app);
    for (const [i, r] of rows.entries()) {
      await pool.query(`UPDATE functions SET enabled=true, weight=1, progress=$2, notif_status=0 WHERE id=$1`, [r.id, values[i]]);
    }
  }
  await pool.query(`UPDATE app_reports SET progress=40 WHERE app_id='ess'`);
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
const items = async app => (await pool.query('SELECT * FROM functions WHERE app_id=$1 ORDER BY sort, id', [app])).rows;
const close = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} ≠ ${b}`);
const calcOf = async (c, app) => (await c.get('/tracker/applications/' + app)).data.application.calc;
const lastAudit = id => one(`SELECT * FROM audit_log WHERE entity='function' AND entity_id=$1 AND action='update' ORDER BY id DESC LIMIT 1`, [String(id)]);

test('the default type is function: existing items, a new item, the column constraint', { skip }, async () => {
  assert.equal((await one(`SELECT count(*)::int AS n FROM functions WHERE item_type <> 'function'`)).n, 0);
  const col = await one(`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name='functions' AND column_name='item_type'`);
  assert.match(col.column_default, /'function'/);
  assert.equal(col.is_nullable, 'NO');
  await assert.rejects(pool.query(`UPDATE functions SET item_type='other' WHERE app_id='per' AND code='D0'`), /functions_item_type_check/);
  const root = await as('root');
  const r = await root.post('/tracker/applications/rec/functions', { name_ar: 'وظيفة جديدة' });
  assert.equal(r.status, 201);
  assert.equal(r.data.function.item_type, 'function');
  const page = await root.get('/tracker/applications/rec');
  assert.ok(page.data.functions.every(f => f.item_type === 'function'));
});

test('calc: marking items as reports moves them from the functions % to the reports % (exact figures)', { skip }, async () => {
  const lead = await as('lead_hr');
  const before = await calcOf(lead, 'ess');
  // 1.7.0 rule: functions (5·50 + 2·100)/7, blended with the track at 15 %
  close(before.fnPct, 450 / 7, 'fn before');
  close(before.reportPct, 40, 'reports before');
  close(before.pct, (450 / 7) * 0.85 + 40 * 0.15, 'app before');
  assert.deepEqual(before.items, { function: 7, report: 0 });
  const sumBefore = (await lead.get('/tracker/summary')).data;
  const perBefore = sumBefore.applications.find(a => a.id === 'per').calc;
  const hrBefore = sumBefore.departments.find(d => d.id === 'hr');

  const [, , , , , f6, f7] = await items('ess');
  for (const f of [f6, f7]) assert.equal((await lead.patch('/tracker/functions/' + f.id, { item_type: 'report' })).status, 200);
  const c = await calcOf(lead, 'ess');
  close(c.fnPct, 50, 'functions: the five items at 50 %');
  close(c.reportPct, (100 + 100 + 40) / 3, 'reports: two items at 100 % + the track at 40 % (weight 1)');
  close(c.pct, 50 * 0.85 + 80 * 0.15, 'application = 54.5');
  close(c.pct, 54.5, 'application');
  assert.deepEqual([c.fnShare, c.reportShare], [0.85, 0.15]);
  assert.deepEqual(c.items, { function: 5, report: 2 });
  assert.deepEqual([c.reportItems, c.reportTrack, c.reportWeight], [2, true, 3]);
  assert.equal(c.count, 7);

  // an application without report items is unchanged; the department moves by the application's weighted change only
  const sum = (await lead.get('/tracker/summary')).data;
  assert.deepEqual(sum.applications.find(a => a.id === 'per').calc, perBefore);
  const hr = sum.departments.find(d => d.id === 'hr');
  const ess = sum.applications.find(a => a.id === 'ess');
  close(hr.pct - hrBefore.pct, (ess.calc.weight * (54.5 - before.pct)) / hr.weight, 'department change');
  assert.equal(sum.counts.report_items, 2);

  // excluded and removed report items no longer count
  assert.equal((await lead.patch('/tracker/functions/' + f7.id, { enabled: false, disabled_reason: 'not_required', disabled_note: 'not needed' })).status, 200);
  let x = await calcOf(lead, 'ess');
  close(x.reportPct, (100 + 40) / 2, 'one report item + track');
  close(x.pct, 50 * 0.85 + 70 * 0.15, 'application = 53');
  assert.equal((await lead.post(`/tracker/functions/${f6.id}/remove`, { reason: 'test' })).status, 200);
  x = await calcOf(lead, 'ess');
  close(x.reportPct, 40, 'track only');
  close(x.pct, 50 * 0.85 + 40 * 0.15, 'application = 48.5');
  assert.deepEqual([x.reportItems, x.items.report], [0, 1]);    // the excluded one is still listed (not an 'experience' item), not counted
  // restore for the next tests
  assert.equal((await lead.post(`/tracker/functions/${f6.id}/restore`)).status, 200);
  assert.equal((await lead.patch('/tracker/functions/' + f7.id, { enabled: true })).status, 200);
  close((await calcOf(lead, 'ess')).pct, 54.5, 'back to 54.5');
});

test('calc: a base department (no reports track) and an application whose items are all reports', { skip }, async () => {
  const root = await as('root');
  const before = await calcOf(root, 'env');
  assert.equal(before.reportPct, null);                 // no track, no report items: functions × 100 %
  close(before.pct, 40, 'env before');
  const list = await items('env');
  assert.equal((await root.patch('/tracker/functions/' + list[5].id, { item_type: 'report' })).status, 200);
  const c = await calcOf(root, 'env');
  close(c.fnPct, 30, 'functions');
  close(c.reportPct, 90, 'report items only (base department: no track)');
  close(c.pct, 30 * 0.85 + 90 * 0.15, 'env = 39');
  assert.equal(c.reportTrack, false);
  // every counted item a report: the application's % is its reports %
  const r = await root.post('/tracker/applications/env/bulk', { field: 'item_type', value: 'report', function_ids: list.map(f => f.id) });
  assert.deepEqual([r.status, r.data.updated], [200, 5]);
  const all = await calcOf(root, 'env');
  close(all.reportPct, (5 * 30 + 90) / 6, 'all reports');
  close(all.pct, 40, 'app = reports % (shares 0 / 1)');
  assert.deepEqual([all.fnShare, all.reportShare], [0, 1]);
  // back to functions (bulk), one report remains
  await root.post('/tracker/applications/env/bulk', { field: 'item_type', value: 'function', function_ids: list.slice(0, 5).map(f => f.id) });
  close((await calcOf(root, 'env')).pct, 39, 'env = 39 again');
});

test('PATCH item_type writes an audit row; invalid values and missing permission are refused', { skip }, async () => {
  const lead = await as('lead_hr'), ed = await as('ed_hr');
  const f = (await items('ess'))[0];
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { item_type: 'chart' })).data.error, 'invalid_value');
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { item_type: null })).status, 400);
  const denied = await ed.patch('/tracker/functions/' + f.id, { item_type: 'report' });
  assert.deepEqual([denied.status, denied.data.permission], [403, 'tog']);
  assert.equal((await ed.post('/tracker/applications/ess/bulk', { field: 'item_type', value: 'report', function_ids: [f.id] })).status, 403);
  const r = await lead.patch('/tracker/functions/' + f.id, { item_type: 'report' });
  assert.equal(r.status, 200);
  assert.equal(r.data.function.item_type, 'report');
  const au = await lastAudit(f.id);
  assert.equal(au.username, 'lead_hr');
  assert.deepEqual([au.old_value, au.new_value], [{ item_type: 'function' }, { item_type: 'report' }]);
  // the same value again: no change, no audit row
  const n = (await one(`SELECT count(*)::int AS n FROM audit_log WHERE entity='function' AND entity_id=$1`, [String(f.id)])).n;
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { item_type: 'report' })).status, 200);
  assert.equal((await one(`SELECT count(*)::int AS n FROM audit_log WHERE entity='function' AND entity_id=$1`, [String(f.id)])).n, n);
  // a removed item cannot change type
  const g = (await items('ess'))[1];
  await lead.post(`/tracker/functions/${g.id}/remove`, { reason: 'test' });
  assert.equal((await lead.patch('/tracker/functions/' + g.id, { item_type: 'report' })).data.error, 'function_removed');
  await lead.post(`/tracker/functions/${g.id}/restore`);
  await lead.patch('/tracker/functions/' + f.id, { item_type: 'function' });
});

test('approval flow: a member\'s type change waits for the team lead, shows old → new and is applied in their name', { skip }, async () => {
  const member = await as('member_hr'), lead = await as('lead_hr');
  const f = (await items('ess'))[2];
  const r = await member.patch('/tracker/functions/' + f.id, { item_type: 'report' });
  assert.equal(r.status, 202);
  assert.equal((await one('SELECT item_type FROM functions WHERE id=$1', [f.id])).item_type, 'function');
  // the application page shows the pending value; the approver sees old → new
  const page = (await member.get('/tracker/applications/ess')).data;
  assert.ok(page.pending.some(p => p.function_id === f.id && p.field === 'item_type' && p.new_value === 'report'));
  const rq = (await lead.get('/approvals?status=pending')).data.requests.find(x => x.id === r.data.request_id);
  const item = rq.items.find(i => i.field === 'item_type');
  assert.deepEqual([item.old_value, item.new_value], ['function', 'report']);
  const reqAudit = await one(`SELECT * FROM audit_log WHERE action='edit_request' AND entity_id=$1`, [String(r.data.request_id)]);
  assert.deepEqual([reqAudit.context.items[0].field, reqAudit.context.items[0].old, reqAudit.context.items[0].new], ['item_type', 'function', 'report']);
  assert.equal((await lead.post(`/approvals/${r.data.request_id}/approve`)).data.applied_changes, 1);
  assert.equal((await one('SELECT item_type FROM functions WHERE id=$1', [f.id])).item_type, 'report');
  const au = await lastAudit(f.id);
  assert.equal(au.username, 'member_hr');
  assert.equal(au.context.approved_by.username, 'lead_hr');
  assert.deepEqual([au.old_value, au.new_value], [{ item_type: 'function' }, { item_type: 'report' }]);
  // the approvals export names the field and the values
  const x = await lead.get('/export/approvals.xlsx?status=applied&lang=ar');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.data);
  const ws = wb.worksheets[0];
  let found = false;
  for (let i = 5; i <= ws.rowCount; i++) {
    const v = ws.getRow(i).values;
    if (v.includes('النوع') && v.includes('وظيفة') && v.includes('تقرير')) found = true;
  }
  assert.ok(found, 'approvals export: النوع وظيفة → تقرير');
  await lead.patch('/tracker/functions/' + f.id, { item_type: 'function' });
});

test('bulk type change: one audit row per item; a member\'s bulk goes to the team lead; only this application\'s items', { skip }, async () => {
  const lead = await as('lead_hr'), member = await as('member_hr');
  const list = await items('ess');
  const pick = [list[3].id, list[4].id];
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'item_type', value: 'x', function_ids: pick })).status, 400);
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'item_type', value: 'report' })).status, 400);
  const other = (await items('per'))[0];
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'item_type', value: 'report', function_ids: [...pick, other.id] })).status, 400);
  const r = await lead.post('/tracker/applications/ess/bulk', { field: 'item_type', value: 'report', function_ids: pick });
  assert.deepEqual([r.status, r.data.updated], [200, 2]);
  for (const id of pick) {
    const au = await lastAudit(id);
    assert.deepEqual([au.new_value.item_type, au.context.bulk, au.context.count], ['report', true, 2]);
  }
  // nothing to change → 0, no request
  assert.equal((await lead.post('/tracker/applications/ess/bulk', { field: 'item_type', value: 'report', function_ids: pick })).data.updated, 0);
  const br = await member.post('/tracker/applications/ess/bulk', { field: 'item_type', value: 'function', function_ids: pick });
  assert.deepEqual([br.status, br.data.requested], [202, 2]);
  assert.equal((await lead.post(`/approvals/${br.data.request_id}/approve`)).data.applied_changes, 2);
  assert.ok((await items('ess')).filter(f => pick.includes(f.id)).every(f => f.item_type === 'function'));
});

test('add-function chooses the type (also through a request); the impact preview counts it as a report', { skip }, async () => {
  const lead = await as('lead_hr'), member = await as('member_hr');
  assert.equal((await lead.post('/tracker/applications/ess/functions', { name_ar: 'x', item_type: 'graph' })).data.error, 'invalid_value');
  const imp = (await lead.post('/tracker/applications/ess/impact', { add: { weight: 1, progress: 100, enabled: true, item_type: 'report' } })).data;
  const c = await calcOf(lead, 'ess');
  close(imp.app.before, c.pct, 'impact before');
  const repAfter = (c.reportPct * c.reportWeight + 100) / (c.reportWeight + 1);
  close(imp.app.after, c.fnPct * 0.85 + repAfter * 0.15, 'impact after');
  const r = await lead.post('/tracker/applications/ess/functions', { name_ar: 'تقرير جديد', item_type: 'report', progress: 100 });
  assert.equal(r.status, 201);
  assert.equal(r.data.function.item_type, 'report');
  const au = await one(`SELECT * FROM audit_log WHERE action='create' AND entity='function' AND entity_id=$1`, [String(r.data.function.id)]);
  assert.equal(au.new_value.item_type, 'report');
  close((await calcOf(lead, 'ess')).pct, imp.app.after, 'the figure the preview announced');
  const req = await member.post('/tracker/applications/ess/functions', { name_ar: 'تقرير مقترح', item_type: 'report' });
  assert.equal(req.status, 202);
  assert.equal((await lead.post(`/approvals/${req.data.request_id}/approve`)).data.applied_changes, 1);
  assert.equal((await one(`SELECT item_type FROM functions WHERE app_id='ess' AND name_ar='تقرير مقترح'`)).item_type, 'report');
  // clean up: both new items removed
  for (const name of ['تقرير جديد', 'تقرير مقترح']) {
    const id = (await one(`SELECT id FROM functions WHERE app_id='ess' AND name_ar=$1`, [name])).id;
    await lead.post(`/tracker/functions/${id}/remove`, { reason: 'test' });
  }
});

test('scope: a team lead cannot change the type of another department\'s items', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = (await items('acc'))[0];
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { item_type: 'report' })).status, 403);
  assert.equal((await lead.post('/tracker/applications/acc/bulk', { field: 'item_type', value: 'report', function_ids: [f.id] })).status, 403);
  assert.equal((await lead.post('/tracker/applications/acc/functions', { name_ar: 'x', item_type: 'report' })).status, 403);
  assert.equal((await one('SELECT item_type FROM functions WHERE id=$1', [f.id])).item_type, 'function');
});

test('the functions export has the type column and the type filter; project status and reports agree', { skip }, async () => {
  const lead = await as('lead_hr');
  const list = await items('ess');
  await lead.post('/tracker/applications/ess/bulk', { field: 'item_type', value: 'report', function_ids: [list[5].id, list[6].id] });
  const r = await lead.get('/export/functions.xlsx?id=ess&lang=ar');
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.data);
  const ws = wb.worksheets[0];
  const header = ws.getRow(4).values.slice(1);
  const col = h => header.indexOf(h);
  assert.ok(col('النوع') >= 0);
  const rows = []; for (let i = 5; i <= ws.rowCount; i++) rows.push(ws.getRow(i).values.slice(1));
  assert.deepEqual(rows.map(x => x[col('النوع')]), list.filter(f => !f.removed_at).map(f => (f.item_type === 'report' || [list[5].id, list[6].id].includes(f.id) ? 'تقرير' : 'وظيفة')));
  // share of a report item: among the reports (two items of weight 1 + the track) → 33.3 %
  const share = rows.find(x => x[col('الرمز')] === list[5].code)[col('الحصة')];
  close(share, 1 / 3, 'share among the reports (percent cell stores a fraction)');
  // the filter of the screen
  const en = await lead.get('/export/functions.xlsx?id=ess&item_type=report&lang=en');
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(en.data);
  const ws2 = wb2.worksheets[0];
  const h2 = ws2.getRow(4).values.slice(1);
  const codes = []; for (let i = 5; i <= ws2.rowCount; i++) codes.push(ws2.getRow(i).values[1 + h2.indexOf('Code')]);
  assert.deepEqual(codes, [list[5].code, list[6].code]);
  assert.ok(ws2.getRow(2).values.join(' ').includes('Type: Report'));
  for (let i = 5; i <= ws2.rowCount; i++) assert.equal(ws2.getRow(i).values[1 + h2.indexOf('Type')], 'Report');
  const au = await one(`SELECT * FROM audit_log WHERE action='export' AND entity='functions' ORDER BY id DESC LIMIT 1`);
  assert.equal(au.new_value.filters.item_type, 'report');
  // project status: the report items and the tracks pooled; the reports screen: the application's reports %
  const ps = (await lead.get('/tracker/project-status')).data.counts;
  assert.equal(ps.report_items, 2);
  assert.equal(ps.reports, 2 + ps.report_tracks);
  const rp = (await lead.get('/tracker/reports')).data.applications.find(a => a.id === 'ess');
  close(rp.report_pct, (100 + 100 + 40) / 3, 'reports screen');
  assert.equal(rp.report_items, 2);
  // department export carries the report items and the reports %
  const dx = await lead.get('/export/department.xlsx?id=hr&lang=en');
  const wb3 = new ExcelJS.Workbook(); await wb3.xlsx.load(dx.data);
  const ws3 = wb3.worksheets[0];
  const h3 = ws3.getRow(4).values.slice(1);
  assert.ok(h3.includes('Report items') && h3.includes('Reports progress'));
});

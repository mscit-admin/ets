// Moving items to another application (1.10.0, migration 019): permission 'mov', scope of both applications, the
// required reason, the weight share that goes with an item in fixed mode (and none in auto mode), the new code in
// the destination, function_moves, the blocks (pending request / import, removed item, same application), the
// two-lead approval of a request, the re-checks when it is approved, bulk moves (all or nothing), the seed guard,
// code numbering, the audit rows and their sentences, the Logs of the old department, live events and the exports.
// Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool, live, settings;
const ids = {};

// [username, role, scopes ([kind, ref]), overrides ([permission, granted])]
const USERS = [
  ['root', 'admin'],
  ['pm1', 'pm'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['lead_fin', 'lead', [['department', 'fin']]],
  ['lead_both', 'lead', [['department', 'hr'], ['department', 'fin']]],
  ['mgr_both', 'mgr', [['department', 'hr'], ['department', 'fin']]],      // 'mov' without 'apv_dept': requests
  ['member_hr', 'member', [['department', 'hr']]],                           // no 'mov'
  ['member_fin', 'member', [['department', 'fin']]],
  ['ed_hr', 'ed', [['department', 'hr']]],
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
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password)
      VALUES ($1,$2,$3,$4,false) RETURNING id`, [u, 'Full ' + u, h, role])).rows[0].id;
    ids[u] = id;
    for (const [k, r] of scopes) await pool.query('INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,$2,$3)', [id, k, r]);
    for (const [p, g] of overrides) await pool.query('INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,$2,$3)', [id, p, g]);
  }
  // known numbers: «ess» (hr) weighs 7, its items 1 each but D0 = 2, D6 excluded as a duplicate of D1
  //   → counted weight 2 + 5 × 1 = 7, so D0 carries 7 × 2 / 7 = 2.00 of the application weight
  await pool.query(`UPDATE applications SET weight=7 WHERE id='ess'`);
  await pool.query(`UPDATE functions SET weight=1, enabled=true, disabled_reason=NULL, disabled_note=NULL WHERE app_id='ess'`);
  await pool.query(`UPDATE functions SET weight=2, progress=40 WHERE app_id='ess' AND code='D0'`);
  await pool.query(`UPDATE functions SET enabled=false, disabled_reason='duplicate' WHERE app_id='ess' AND code='D6'`);
  await pool.query(`INSERT INTO function_duplicates(function_id, duplicate_of_id)
    SELECT a.id, b.id FROM functions a, functions b WHERE a.app_id='ess' AND a.code='D6' AND b.app_id='ess' AND b.code='D1'`);
  live = await import('../src/services/live.js');
  settings = await import('../src/services/settings.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  await live.closeAllStreams();
  server.closeAllConnections?.();
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
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const fn = (app, code) => one('SELECT * FROM functions WHERE app_id=$1 AND code=$2', [app, code]);
const weightOf = async app => +(await one('SELECT weight FROM applications WHERE id=$1', [app])).weight;
const REASON = 'Belongs to the accounts module';

async function sheet(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const vals = r => { const v = ws.getRow(r).values; return Array.isArray(v) ? v.slice(1) : []; };
  const rows = [];
  for (let i = 5; i <= ws.rowCount; i++) rows.push(vals(i));
  return { header: vals(4), rows };
}

test('mov: granted to admin, mgr, pm, tm and lead by default; offered for per-user overrides', { skip }, async () => {
  const roles = (await pool.query('SELECT id, permissions FROM roles ORDER BY id')).rows;
  assert.deepEqual(roles.filter(r => r.permissions.includes('mov')).map(r => r.id).sort(), ['admin', 'lead', 'mgr', 'pm', 'tm']);
  const root = await as('root');
  assert.ok((await root.get('/users/meta')).data.permissions.includes('mov'));
  // the application payload says whether the reader may move items
  assert.equal((await (await as('lead_hr')).get('/tracker/applications/ess')).data.can.mov, true);
  assert.equal((await (await as('member_hr')).get('/tracker/applications/ess')).data.can.mov, false);
});

test('move: refused without "mov" (403)', { skip }, async () => {
  const f = await fn('ess', 'D0');
  const m = await as('member_hr');
  for (const [p, b] of [[`/tracker/functions/${f.id}/move`, { to_app_id: 'per', reason: REASON }], [`/tracker/functions/${f.id}/move/preview`, { to_app_id: 'per' }],
    ['/tracker/applications/ess/bulk-move', { to_app_id: 'per', function_ids: [f.id], reason: REASON }]]) {
    const r = await m.post(p, b);
    assert.equal(r.status, 403, p);
    assert.deepEqual([r.data.error, r.data.permission], ['forbidden', 'mov']);
  }
  assert.equal((await m.get(`/tracker/move-targets?function_id=${f.id}`)).status, 403);
  assert.equal((await fn('ess', 'D0')).app_id, 'ess');
});

test('move: both applications must be in scope (403); the targets list only applications in scope', { skip }, async () => {
  const f = await fn('ess', 'D0');
  const fin = await as('lead_fin');
  const r1 = await fin.post(`/tracker/functions/${f.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.equal(r1.status, 403);
  assert.equal(r1.data.error, 'out_of_scope');                       // the source
  const hr = await as('lead_hr');
  const r2 = await hr.post(`/tracker/functions/${f.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.deepEqual([r2.status, r2.data.error, r2.data.application], [403, 'out_of_scope', 'acc']);    // the destination
  const t = (await hr.get(`/tracker/move-targets?function_id=${f.id}`)).data;
  assert.deepEqual(t.current, { app_id: 'ess', department_id: 'hr' });
  assert.deepEqual(t.departments.map(d => d.id), ['hr']);
  assert.ok(!t.departments[0].applications.some(a => a.id === 'ess'));
  const all = (await (await as('root')).get(`/tracker/move-targets?function_id=${f.id}`)).data;
  assert.ok(all.departments.some(d => d.id === 'fin' && d.applications.some(a => a.id === 'acc')));
  assert.equal((await fn('ess', 'D0')).app_id, 'ess');
});

test('move: destination and reason are validated (400)', { skip }, async () => {
  const f = await fn('ess', 'D0');
  const root = await as('root');
  const go = b => root.post(`/tracker/functions/${f.id}/move`, b);
  assert.deepEqual([(await go({ reason: REASON })).data.error], ['invalid_value']);
  assert.deepEqual([(await go({ to_app_id: 'nope', reason: REASON })).data.error], ['unknown_application']);
  const same = await go({ to_app_id: 'ess', reason: REASON });
  assert.deepEqual([same.status, same.data.error], [400, 'move_same_app']);
  for (const reason of [undefined, '', '  a  b  ', 42]) {
    const r = await go({ to_app_id: 'acc', reason });
    assert.equal(r.status, 400, String(reason));
    assert.ok(['move_reason_required', 'invalid_value'].includes(r.data.error));
  }
  const long = await go({ to_app_id: 'acc', reason: 'x'.repeat(501) });
  assert.deepEqual([long.status, long.data.error, long.data.max], [400, 'invalid_value', 500]);
  assert.equal((await fn('ess', 'D0')).app_id, 'ess');
});

test('direct move (admin, fixed mode): preview, new code in the destination, weight share, function_moves, audit', { skip }, async () => {
  const f = await fn('ess', 'D0');
  const root = await as('root');
  const accSort = (await one(`SELECT max(sort) AS s FROM functions WHERE app_id='acc'`)).s;
  const pv = (await root.post(`/tracker/functions/${f.id}/move/preview`, { to_app_id: 'acc' })).data;
  assert.equal(pv.mode, 'fixed');
  assert.equal(pv.needs_approval, false);
  assert.deepEqual(pv.weight.src, { before: 7, after: 5 });
  assert.deepEqual(pv.weight.dst, { before: 10.5, after: 12.5 });
  assert.equal(pv.weight.share, 2);
  assert.equal(pv.weight.src_items_weight, 7);
  assert.deepEqual(pv.apps.map(a => [a.id, a.role]), [['ess', 'source'], ['acc', 'destination']]);
  assert.deepEqual(pv.departments.map(d => d.id), ['hr', 'fin']);
  assert.equal(pv.apps[1].count.after, pv.apps[1].count.before + 1);

  const r = await root.post(`/tracker/functions/${f.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.moved, [{ function_id: f.id, from_code: 'D0', to_code: 'C0', weight_share: 2, enabled: true }]);
  const g = await one('SELECT * FROM functions WHERE id=$1', [f.id]);
  assert.deepEqual([g.app_id, g.code, g.sort, +g.weight, +g.progress], ['acc', 'C0', accSort + 1, 2, 40]);   // same id, values kept
  // the share moved: ess 7 → 5, acc 10.5 → 12.5, the two together unchanged
  assert.deepEqual([await weightOf('ess'), await weightOf('acc')], [5, 12.5]);
  const m = await one('SELECT * FROM function_moves WHERE function_id=$1', [f.id]);
  assert.deepEqual([m.from_app_id, m.to_app_id, m.from_code, m.to_code, m.from_dept_id, m.to_dept_id, m.weight_mode, +m.weight_share, m.reason, m.moved_by, m.request_id],
    ['ess', 'acc', 'D0', 'C0', 'hr', 'fin', 'fixed', 2, REASON, ids.root, null]);
  // the project after the move is what the preview said
  const sum = (await root.get('/tracker/summary')).data;
  assert.ok(Math.abs(sum.total.pct - pv.total.after) < 1e-9);
  assert.ok(Math.abs(sum.applications.find(a => a.id === 'acc').calc.pct - pv.apps[1].pct.after) < 1e-9);

  const a = await one(`SELECT * FROM audit_log WHERE action='move' AND entity='function' AND entity_id=$1`, [String(f.id)]);
  assert.equal(a.username, 'root');
  assert.deepEqual(a.old_value, { app_id: 'ess', dept_id: 'hr', code: 'D0', app_weight_src: 7 });
  assert.deepEqual(a.new_value, { app_id: 'acc', dept_id: 'fin', code: 'C0', app_weight_dst: 12.5, weight_share: 2, reason: REASON });
  assert.deepEqual([a.context.from_app_id, a.context.from_dept_id, a.context.to_app_id, a.context.to_dept_id], ['ess', 'hr', 'acc', 'fin']);
  assert.ok(a.context.from_app_name_ar && a.context.to_dept_name_ar);
  const w = (await pool.query(`SELECT entity_id, old_value, new_value, context FROM audit_log WHERE action='update' AND entity='application'
    AND context->>'move'='true' ORDER BY entity_id`)).rows;
  assert.deepEqual(w.map(x => [x.entity_id, x.old_value.weight, x.new_value.weight]), [['acc', 10.5, 12.5], ['ess', 7, 5]]);
  assert.match(w[0].context.reason, /^نقل البند D0 من /);
});

test('an excluded item carries no weight; it keeps its reason and duplicate links', { skip }, async () => {
  const f = await fn('ess', 'D6');
  const root = await as('root');
  const r = await root.post(`/tracker/functions/${f.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.weight.share, 0);
  assert.deepEqual([await weightOf('ess'), await weightOf('acc')], [5, 12.5]);
  const g = await one('SELECT * FROM functions WHERE id=$1', [f.id]);
  assert.deepEqual([g.app_id, g.code, g.enabled, g.disabled_reason], ['acc', 'C1', false, 'duplicate']);
  assert.equal((await one('SELECT count(*)::int AS n FROM function_duplicates WHERE function_id=$1', [f.id])).n, 1);
  assert.equal(+(await one('SELECT weight_share FROM function_moves WHERE function_id=$1', [f.id])).weight_share, 0);
});

test('auto mode: no application weight changes, the calculation moves the item weight', { skip }, async () => {
  const root = await as('root');
  assert.equal((await root.put('/tracker/weights', { weight_mode: 'auto' })).status, 200);
  const f = await fn('ess', 'D1');
  const before = (await root.get('/tracker/summary')).data.applications;
  const w = id => before.find(a => a.id === id).calc.weight;
  const r = await root.post(`/tracker/functions/${f.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.equal(r.status, 200);
  assert.equal(r.data.weight.mode, 'auto');
  assert.equal(r.data.weight.share, 0);
  assert.deepEqual([await weightOf('ess'), await weightOf('acc')], [5, 12.5]);
  const now = (await root.get('/tracker/summary')).data.applications;
  const n = id => now.find(a => a.id === id).calc.weight;
  assert.equal(n('ess'), w('ess') - 1);
  assert.equal(n('acc'), w('acc') + 1);
  const m = await one('SELECT weight_mode, weight_share FROM function_moves WHERE function_id=$1', [f.id]);
  assert.deepEqual([m.weight_mode, +m.weight_share], ['auto', 0]);
  assert.equal((await root.put('/tracker/weights', { weight_mode: 'fixed' })).status, 200);
});

test('blocks: a pending request, a pending import, a removed item (409)', { skip }, async () => {
  const root = await as('root');
  const member = await as('member_hr');
  const d2 = await fn('ess', 'D2');
  const p = await member.patch(`/tracker/functions/${d2.id}`, { progress: 55 });
  assert.equal(p.status, 202);
  const r1 = await root.post(`/tracker/functions/${d2.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.deepEqual([r1.status, r1.data.error, r1.data.items[0].request_id], [409, 'move_pending_request', p.data.request_id]);
  assert.equal((await root.post(`/tracker/functions/${d2.id}/move/preview`, { to_app_id: 'acc' })).status, 409);
  assert.equal((await member.post(`/approvals/${p.data.request_id}/withdraw`)).status, 200);

  const d3 = await fn('ess', 'D3');
  const b = await one(`INSERT INTO import_batches(target, department_id, departments, filename, status, change_count, uploaded_by)
    VALUES ('department','hr','{hr}','x.json','pending',1,$1) RETURNING id`, [ids.lead_hr]);
  await pool.query(`INSERT INTO import_changes(batch_id, kind, app_id, function_id, code, field, old_value, new_value)
    VALUES ($1,'function','ess',$2,'D3','progress','0','50')`, [b.id, d3.id]);
  const r2 = await root.post(`/tracker/functions/${d3.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.deepEqual([r2.status, r2.data.error, r2.data.items[0].batch_id], [409, 'move_pending_import', b.id]);
  await pool.query(`UPDATE import_batches SET status='rejected' WHERE id=$1`, [b.id]);

  const d4 = await fn('ess', 'D4');
  assert.equal((await root.post(`/tracker/functions/${d4.id}/remove`, { reason: 'not needed' })).status, 200);
  const r3 = await root.post(`/tracker/functions/${d4.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.deepEqual([r3.status, r3.data.error], [409, 'move_function_removed']);
  for (const x of [d2, d3, d4]) assert.equal((await one('SELECT app_id FROM functions WHERE id=$1', [x.id])).app_id, 'ess');
});

test('request: source lead then destination lead; the requester and the wrong stage cannot approve; share recomputed at approval', { skip }, async () => {
  const d2 = await fn('ess', 'D2');
  const mgr = await as('mgr_both');
  // ess now counts D2, D3, D5 (weight 1 each): 5 × 1 / 3 = 1.67 when requested
  const r = await mgr.post(`/tracker/functions/${d2.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.impact.weight.share, 1.67);
  const id = r.data.request_id;
  const rq = await one('SELECT * FROM edit_requests WHERE id=$1', [id]);
  assert.deepEqual([rq.kind, rq.app_id, rq.department_id, rq.target_app_id, rq.target_department_id, rq.meta.reason, rq.meta.weight_share],
    ['move_function', 'ess', 'hr', 'acc', 'fin', REASON, 1.67]);
  // both applications' approvers are told (A1), each under the application they approve for
  await new Promise(res => setTimeout(res, 150));
  assert.equal((await one(`SELECT app_id FROM notifications WHERE user_id=$1 AND type='approval_pending'`, [ids.lead_hr])).app_id, 'ess');
  assert.equal((await one(`SELECT app_id FROM notifications WHERE user_id=$1 AND type='approval_pending'`, [ids.lead_fin])).app_id, 'acc');
  // a member of the source sees the pending move on the item
  const pend = (await (await as('member_hr')).get('/tracker/applications/ess')).data.pending;
  assert.ok(pend.some(p => p.function_id === d2.id && p.field === 'move' && p.new_value.app_id === 'acc'));

  const fin = await as('lead_fin'), hr = await as('lead_hr');
  const seen = async (c, k) => (await c.get('/approvals?status=pending')).data.requests.find(x => x.id === id)[k];
  assert.deepEqual(await seen(fin, 'can'), { approve: false, reject: true, withdraw: false, stage: 'source', approve_as: null });
  assert.equal((await fin.post(`/approvals/${id}/approve`)).status, 403);           // not yet: the source lead first
  assert.equal((await mgr.post(`/approvals/${id}/approve`)).status, 403);           // never the requester
  assert.deepEqual(await seen(hr, 'can'), { approve: true, reject: true, withdraw: false, stage: 'source', approve_as: 'source' });
  // the source application's weight changes meanwhile: 6 × 1 / 3 = 2.00 when approved
  assert.equal((await (await as('root')).put('/tracker/weights', { weights: { ess: 6 } })).status, 200);
  const now = await seen(hr, 'move_now');
  assert.deepEqual([now.share, now.src_before, now.src_after], [2, 6, 4]);

  const a1 = await hr.post(`/approvals/${id}/approve`);
  assert.equal(a1.status, 200, JSON.stringify(a1.data));
  assert.deepEqual([a1.data.applied, a1.data.stage], [false, 'source']);
  const mid = await one('SELECT * FROM edit_requests WHERE id=$1', [id]);
  assert.deepEqual([mid.status, mid.source_approved_by, mid.target_approved_by], ['pending', ids.lead_hr, null]);
  assert.equal((await one('SELECT app_id FROM functions WHERE id=$1', [d2.id])).app_id, 'ess');
  assert.equal((await hr.post(`/approvals/${id}/approve`)).status, 403);            // the source stage is signed
  assert.equal((await seen(fin, 'can')).approve_as, 'target');

  await pool.query(`DELETE FROM notifications WHERE type='moved_in'`);          // those of the earlier direct moves
  const a2 = await fin.post(`/approvals/${id}/approve`);
  assert.equal(a2.status, 200, JSON.stringify(a2.data));
  assert.deepEqual([a2.data.applied, a2.data.stage, a2.data.weight.share], [true, 'target', 2]);
  const done = await one('SELECT * FROM edit_requests WHERE id=$1', [id]);
  assert.deepEqual([done.status, done.decided_by, done.target_approved_by], ['applied', ids.lead_fin, ids.lead_fin]);
  const g = await one('SELECT app_id, code FROM functions WHERE id=$1', [d2.id]);
  assert.equal(g.app_id, 'acc');
  const m = await one('SELECT * FROM function_moves WHERE function_id=$1', [d2.id]);
  assert.deepEqual([+m.weight_share, m.request_id, m.moved_by], [2, id, ids.mgr_both]);
  assert.deepEqual([await weightOf('ess'), await weightOf('acc')], [4, 14.5]);
  // recorded in the requester's name, with both approvers in its context
  const au = await one(`SELECT * FROM audit_log WHERE action='move' AND entity_id=$1`, [String(d2.id)]);
  assert.equal(au.username, 'mgr_both');
  assert.deepEqual([au.context.via, au.context.source_approved_by.username, au.context.target_approved_by.username], ['edit_request', 'lead_hr', 'lead_fin']);
  await new Promise(res => setTimeout(res, 150));
  assert.ok(await one(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='request_decided'`, [ids.mgr_both]), 'the requester hears the decision');
  assert.ok(await one(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='moved_in' AND app_id='acc'`, [ids.member_fin]), 'T8 to the destination');
  assert.equal(await one(`SELECT 1 FROM notifications WHERE user_id=$1 AND type='moved_in'`, [ids.lead_fin]), undefined, 'not the approver');
});

test('request: one approval when the same lead approves both applications', { skip }, async () => {
  const d3 = await fn('ess', 'D3');
  const mgr = await as('mgr_both');
  const r = await mgr.post(`/tracker/functions/${d3.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.equal(r.status, 202);
  const both = await as('lead_both');
  assert.equal((await both.get('/approvals?status=pending')).data.requests.find(x => x.id === r.data.request_id).can.approve_as, 'both');
  const a = await both.post(`/approvals/${r.data.request_id}/approve`);
  assert.deepEqual([a.status, a.data.applied, a.data.stage], [200, true, 'both']);
  const rq = await one('SELECT * FROM edit_requests WHERE id=$1', [r.data.request_id]);
  assert.deepEqual([rq.status, rq.source_approved_by, rq.target_approved_by], ['applied', ids.lead_both, ids.lead_both]);
  assert.equal((await one('SELECT app_id FROM functions WHERE id=$1', [d3.id])).app_id, 'acc');
});

test('request: checked again at approval (requester rights, removed item); rejected by either lead', { skip }, async () => {
  const d5 = await fn('ess', 'D5');
  const mgr = await as('mgr_both');
  const r = await mgr.post(`/tracker/functions/${d5.id}/move`, { to_app_id: 'acc', reason: REASON });
  assert.equal(r.status, 202);
  const id = r.data.request_id;
  const hr = await as('lead_hr');
  await pool.query(`INSERT INTO user_permissions(user_id, permission, granted) VALUES ($1,'mov',false)`, [ids.mgr_both]);
  const b1 = await hr.post(`/approvals/${id}/approve`);
  assert.deepEqual([b1.status, b1.data.error, b1.data.reason], [409, 'requester_not_allowed', 'requester_lacks_permission']);
  await pool.query(`DELETE FROM user_permissions WHERE user_id=$1 AND permission='mov'`, [ids.mgr_both]);
  // the destination left the requester's scope
  await pool.query(`DELETE FROM user_scopes WHERE user_id=$1 AND ref_id='fin'`, [ids.mgr_both]);
  const b2 = await hr.post(`/approvals/${id}/approve`);
  assert.deepEqual([b2.status, b2.data.reason], [409, 'requester_out_of_scope']);
  await pool.query(`INSERT INTO user_scopes(user_id, kind, ref_id) VALUES ($1,'department','fin')`, [ids.mgr_both]);
  // removed meanwhile
  assert.equal((await (await as('root')).post(`/tracker/functions/${d5.id}/remove`, { reason: 'gone' })).status, 200);
  const b3 = await hr.post(`/approvals/${id}/approve`);
  assert.deepEqual([b3.status, b3.data.error], [409, 'move_function_removed']);
  assert.equal((await one('SELECT status FROM edit_requests WHERE id=$1', [id])).status, 'pending');
  const fin = await as('lead_fin');
  assert.equal((await fin.post(`/approvals/${id}/reject`, { reason: 'no' })).status, 200);
  assert.equal((await one('SELECT status FROM edit_requests WHERE id=$1', [id])).status, 'rejected');
  assert.equal((await (await as('root')).post(`/tracker/functions/${d5.id}/restore`)).status, 200);
});

test('bulk move: all or nothing, shares measured against the source before the move, max 200', { skip }, async () => {
  const root = await as('root');
  // «per» (hr): weight 9; every item counted with weight 1, except D0 = 1, D1 = 2, D2 = 3
  await pool.query(`UPDATE applications SET weight=9 WHERE id='per'`);
  await pool.query(`UPDATE functions SET weight=1, enabled=true WHERE app_id='per'`);
  await pool.query(`UPDATE functions SET weight=(substring(code from 2)::int + 1) WHERE app_id='per' AND code IN ('D0','D1','D2')`);
  const pick = async codes => (await pool.query(`SELECT id, code, weight FROM functions WHERE app_id='per' AND code = ANY($1)`, [codes])).rows;
  const three = await pick(['D0', 'D1', 'D2']);
  const den = +(await one(`SELECT sum(weight) AS s FROM functions WHERE app_id='per' AND enabled AND removed_at IS NULL`)).s;
  const expected = Math.round(9 * 6 / den * 100) / 100;

  // one of them has a pending request: nothing moves
  const member = await as('member_hr');
  const p = await member.patch(`/tracker/functions/${three[2].id}`, { progress: 10 });
  assert.equal(p.status, 202);
  const r0 = await root.post('/tracker/applications/per/bulk-move', { to_app_id: 'pmt', function_ids: three.map(x => x.id), reason: REASON });
  assert.deepEqual([r0.status, r0.data.error], [409, 'move_pending_request']);
  assert.equal((await one(`SELECT count(*)::int AS n FROM functions WHERE app_id='per' AND code IN ('D0','D1','D2')`)).n, 3);
  assert.equal((await member.post(`/approvals/${p.data.request_id}/withdraw`)).status, 200);
  // items of another application / too many
  const other = await fn('ess', 'D5');
  assert.equal((await root.post('/tracker/applications/per/bulk-move', { to_app_id: 'pmt', function_ids: [three[0].id, other.id], reason: REASON })).status, 400);
  const many = Array.from({ length: 201 }, (_, i) => i + 1);
  const big = await root.post('/tracker/applications/per/bulk-move', { to_app_id: 'pmt', function_ids: many, reason: REASON });
  assert.deepEqual([big.status, big.data.max], [400, 200]);

  const pv = (await root.post('/tracker/applications/per/bulk-move/preview', { to_app_id: 'pmt', function_ids: three.map(x => x.id) })).data;
  assert.deepEqual([pv.items, pv.counted, pv.weight.share, pv.weight.moved_weight, pv.weight.src_items_weight], [3, 3, expected, 6, den]);
  const pmt = await weightOf('pmt');
  const r = await root.post('/tracker/applications/per/bulk-move', { to_app_id: 'pmt', function_ids: [three[2].id, three[0].id, three[1].id], reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.weight.share, expected);
  assert.equal(r.data.moved.length, 3);
  assert.equal(Math.round(r.data.moved.reduce((s, x) => s + x.weight_share, 0) * 100) / 100, expected);
  assert.deepEqual([await weightOf('per'), await weightOf('pmt')], [Math.round((9 - expected) * 100) / 100, Math.round((pmt + expected) * 100) / 100]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM functions WHERE app_id='pmt' AND id = ANY($1)`, [three.map(x => x.id)])).n, 3);
  const audits = (await pool.query(`SELECT context FROM audit_log WHERE action='move' AND entity_id = ANY($1)`, [three.map(x => String(x.id))])).rows;
  assert.equal(audits.length, 3);
  assert.ok(audits.every(a => a.context.bulk === true && a.context.count === 3));

  // the order of the items never changes the shares
  const { weightTransfer } = await import('../src/services/move.js');
  const rows = [{ id: 1, weight: 1, enabled: true }, { id: 2, weight: 2, enabled: true }, { id: 3, weight: 3, enabled: true }, { id: 4, weight: 1.5, enabled: true },
    { id: 5, weight: 4, enabled: false }];
  const a = weightTransfer({ mode: 'fixed', srcWeight: 7.3, srcFunctions: rows, ids: [1, 2, 5] });
  const b = weightTransfer({ mode: 'fixed', srcWeight: 7.3, srcFunctions: rows, ids: [5, 2, 1] });
  assert.equal(a.share, b.share);
  assert.equal(a.share, Math.round(7.3 * 3 / 7.5 * 100) / 100);
  assert.equal(a.per.get(5), 0);
  assert.equal(Math.round((a.per.get(1) + a.per.get(2)) * 100), Math.round(a.share * 100));
  assert.equal(weightTransfer({ mode: 'fixed', srcWeight: 3, srcFunctions: [{ id: 1, weight: 0, enabled: true }], ids: [1] }).share, 0);     // zero sum
  assert.equal(weightTransfer({ mode: 'auto', srcWeight: 3, srcFunctions: rows, ids: [1] }).share, 0);
});

test('bulk move by request: one request with one line per item', { skip }, async () => {
  const two = (await pool.query(`SELECT id FROM functions WHERE app_id='per' AND code IN ('D3','D4') ORDER BY code`)).rows.map(x => x.id);
  const mgr = await as('mgr_both');
  const r = await mgr.post('/tracker/applications/per/bulk-move', { to_app_id: 'pmt', function_ids: two, reason: REASON });
  assert.equal(r.status, 202);
  const items = (await pool.query(`SELECT field, function_id, meta FROM edit_request_items WHERE request_id=$1 ORDER BY id`, [r.data.request_id])).rows;
  assert.deepEqual(items.map(i => i.field), ['move', 'move']);
  const a = await (await as('lead_both')).post(`/approvals/${r.data.request_id}/approve`);
  assert.deepEqual([a.status, a.data.applied_changes], [200, 2]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM functions WHERE app_id='pmt' AND id = ANY($1)`, [two])).n, 2);
});

test('seed guard: running the seed after a move does not re-create the item in its original application', { skip }, async () => {
  const n = (await one('SELECT count(*)::int AS n FROM functions')).n;
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  assert.equal((await one('SELECT count(*)::int AS n FROM functions')).n, n);
  for (const code of ['D0', 'D1', 'D2', 'D3', 'D6']) assert.equal(await fn('ess', code), undefined, code);
  assert.equal(await fn('per', 'D0'), undefined);
  assert.equal((await one(`SELECT app_id FROM functions f JOIN function_moves m ON m.function_id=f.id WHERE m.from_app_id='ess' AND m.from_code='D0'`)).app_id, 'acc');
  const log = await one(`SELECT detail FROM system_log WHERE event='seed' ORDER BY id DESC LIMIT 1`);
  assert.ok(log.detail.movedOut >= 8);
});

test('codes are never reused: an application whose highest C-code moved out continues after it', { skip }, async () => {
  const root = await as('root');
  const add = async () => (await root.post('/tracker/applications/ess/functions', { name_ar: 'بند مضاف', weight: 1 })).data.function;
  const c0 = await add();
  assert.equal(c0.code, 'C0');
  assert.equal((await root.post(`/tracker/functions/${c0.id}/move`, { to_app_id: 'acc', reason: REASON })).status, 200);
  assert.equal(await fn('ess', 'C0'), undefined);
  assert.equal((await add()).code, 'C1');
});

test('logs: the old department keeps the item history up to the move; names and codes as they were', { skip }, async () => {
  const root = await as('root');
  const f = await fn('per', 'D10');
  assert.equal((await root.patch(`/tracker/functions/${f.id}`, { progress: 10 })).status, 200);
  const mv = await root.post(`/tracker/functions/${f.id}/move`, { to_app_id: 'pmt', reason: REASON });
  assert.equal(mv.status, 200);
  assert.equal((await root.patch(`/tracker/functions/${f.id}`, { progress: 20 })).status, 200);
  const rows = async u => (await (await as(u)).get('/logs/audit?limit=500')).data.rows.filter(r => r.entity === 'function' && r.entity_id === String(f.id));
  const hr = await rows('lead_hr');
  assert.deepEqual(hr.map(r => r.action).sort(), ['move', 'update']);
  assert.equal(hr.find(r => r.action === 'update').new_value.progress, 10);
  assert.deepEqual([hr.find(r => r.action === 'update').fn_code, hr.find(r => r.action === 'update').app_id], ['D10', 'per']);     // as it was
  const fin = await rows('lead_fin');
  assert.deepEqual(fin.map(r => r.action).sort(), ['move', 'update', 'update']);
  // the move request rows are seen from the destination too
  const req = (await (await as('lead_fin')).get('/logs/audit?limit=500')).data.rows.filter(r => r.entity === 'edit_request' && r.context?.to_app_id === 'acc');
  assert.ok(req.length >= 1);
});

test('audit: readable sentences (Arabic and English) for the move and the weight changes', { skip }, async () => {
  const { messages } = await import('../../frontend/src/i18n/messages.js');
  const { makeAudit } = await import('../../frontend/src/lib/audit.js');
  const mk = lang => makeAudit({ lang, t: (k, v) => { let s = messages[lang][k] ?? messages.ar[k] ?? k; for (const [a, b] of Object.entries(v || {})) s = s.split('{' + a + '}').join(String(b)); return s; } });
  const f = await one(`SELECT function_id FROM function_moves WHERE from_app_id='ess' AND from_code='D0'`);
  const rows = (await (await as('root')).get('/logs/audit?limit=500')).data.rows;
  const r = rows.find(x => x.action === 'move' && x.entity_id === String(f.function_id));
  const ar = mk('ar')(r), en = mk('en')(r);
  assert.match(ar.text, /^نقل Full root البند D0 من «.+» \(.+\) إلى «.+» \(.+\) برمز C0 — نُقل وزن 2\.00 — السبب: «Belongs to the accounts module»$/);
  assert.match(en.text, /^Full root moved item D0 from “.+” \(.+\) to “.+” \(.+\) as C0 — weight 2\.00 moved — reason: “Belongs to the accounts module”$/);
  const w = rows.find(x => x.action === 'update' && x.entity === 'application' && x.context?.move);
  assert.match(mk('ar')(w).notes.join(' '), /نقل البند/);
  const ex = rows.find(x => x.action === 'move' && x.new_value?.weight_share === 0 && x.context?.weight_mode === 'fixed');
  assert.match(mk('ar')(ex).text, /لم يُنقل وزن/);
});

test('application page: the badge data (moved from), names only within scope', { skip }, async () => {
  const f = await one(`SELECT function_id FROM function_moves WHERE from_app_id='ess' AND from_code='D0'`);
  const pick = async u => (await (await as(u)).get('/tracker/applications/acc')).data.functions.find(x => x.id === f.function_id);
  const all = await pick('root');
  assert.deepEqual([all.moved_from.from_app_id, all.moved_from.from_code, all.moved_from.to_code, all.moved_from.reason, all.moved_from.moved_by_name],
    ['ess', 'D0', 'C0', REASON, 'Full root']);
  assert.ok(all.moved_from.from_app_name_ar);
  assert.equal(all.moves.length, 1);
  const fin = await pick('lead_fin');
  assert.equal(fin.moved_from.from_app_name_ar, null);           // «ess» is outside the reader's scope
  assert.equal(fin.moved_from.from_code, 'D0');
});

test('live: a move tells both applications / departments', { skip }, async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const got = [];
  c.on('notification', n => got.push(JSON.parse(n.payload)));
  await c.query('LISTEN ets_live');
  const f = await fn('per', 'D11');
  assert.equal((await (await as('root')).post(`/tracker/functions/${f.id}/move`, { to_app_id: 'pmt', reason: REASON })).status, 200);
  await new Promise(r => setTimeout(r, 300));
  await c.end();
  const changes = got.filter(m => m.t === 'tracker_changed');
  assert.ok(changes.some(m => m.dept_id === 'hr' && m.app_id === 'per'), JSON.stringify(got));
  assert.ok(changes.some(m => m.dept_id === 'fin' && m.app_id === 'pmt'), JSON.stringify(got));
});

test('exports: «منقول من» in the functions sheet, move requests in the approvals sheet', { skip }, async () => {
  const root = await as('root');
  const s = await sheet((await root.get('/export/functions.xlsx?id=acc&lang=ar&show_off=1')).data);
  const col = s.header.indexOf('منقول من');
  assert.ok(col >= 0, JSON.stringify(s.header));
  const row = s.rows.find(r => r[0] === 'C0');
  assert.match(String(row[col]), /\/D0$/);
  const plain = s.rows.find(r => /^D/.test(String(r[0])));
  assert.ok(!plain[col]);
  const ap = await sheet((await root.get('/export/approvals.xlsx?status=applied&lang=ar')).data);
  const kind = ap.header.indexOf('النوع'), to = ap.header.indexOf('التطبيق المنقول إليه'), field = ap.header.indexOf('الحقل');
  const mv = ap.rows.filter(r => r[kind] === 'نقل بنود');
  assert.ok(mv.length >= 2);
  assert.ok(mv.every(r => String(r[to]).length > 0 && r[field] === 'نقل'));
});

test('approvals off: a move is direct for anyone with "mov" and both applications in scope', { skip }, async () => {
  await pool.query(`UPDATE settings SET value='false' WHERE key='approval.edits_need_lead'`);
  settings.invalidateSettings();
  try {
    const f = await fn('per', 'D12');
    const r = await (await as('mgr_both')).post(`/tracker/functions/${f.id}/move`, { to_app_id: 'pmt', reason: REASON });
    assert.equal(r.status, 200);
  } finally {
    await pool.query(`UPDATE settings SET value='true' WHERE key='approval.edits_need_lead'`);
    settings.invalidateSettings();
  }
  // the audit chain still verifies after all of the above
  const v = await (await import('../src/services/logchain.js')).verifyAll();
  assert.ok(v.ok, JSON.stringify(v));
});

// Moving a whole application to another department ("module") (1.12.16, migration 022): permission 'mov', scope of
// both departments, the required reason, the department weight transfer in fixed mode (source − = destination +, the
// total unchanged) and none to transfer in auto mode, application_moves, the guards (same department, a pending
// request on the application or its items, a name clash), and the two-lead approval of a member's request (the
// source department's lead, then the destination's) which does NOT move the application until both have approved.
// Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  ['mover', 'member', [['department', 'hr'], ['department', 'fin']], [['mov', true]]],   // 'mov' without a lead role: requests
  ['member_hr', 'member', [['department', 'hr']]],                                        // no 'mov'
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
  live = await import('../src/services/live.js');
  settings = await import('../src/services/settings.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  await live?.closeAllStreams();
  server?.closeAllConnections?.();
  server?.close();
  await new Promise(r => setTimeout(r, 200));
  await pool?.end();
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
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const deptOf = async app => (await one('SELECT department_id FROM applications WHERE id=$1', [app])).department_id;
const deptWeight = async dept => +(await one('SELECT COALESCE(sum(weight),0) AS w FROM applications WHERE department_id=$1', [dept])).w;
const totalWeight = async () => +(await one('SELECT COALESCE(sum(weight),0) AS w FROM applications')).w;
const REASON = 'The application belongs to the Finance department per the approved structure';

test('move-dept: refused without "mov" (403); targets list only departments in scope', { skip }, async () => {
  const m = await as('member_hr');
  for (const [p, b] of [['/tracker/applications/ess/move-dept', { to_department_id: 'fin', reason: REASON }],
    ['/tracker/applications/ess/move-dept/preview', { to_department_id: 'fin' }]]) {
    const r = await m.post(p, b);
    assert.deepEqual([r.status, r.data.error, r.data.permission], [403, 'forbidden', 'mov'], p);
  }
  assert.equal((await m.get('/tracker/app-move-targets?app_id=ess')).status, 403);
  // a mover sees only the departments whose whole scope they cover, never the current one
  const t = (await (await as('mover')).get('/tracker/app-move-targets?app_id=ess')).data;
  assert.deepEqual([t.current.app_id, t.current.department_id], ['ess', 'hr']);
  assert.deepEqual(t.departments.map(d => d.id).sort(), ['fin']);
  assert.equal(await deptOf('ess'), 'hr');
});

test('move-dept: both departments must be in scope (403)', { skip }, async () => {
  const hr = await as('lead_hr');                                   // covers hr only, not the destination fin
  const r = await hr.post('/tracker/applications/ess/move-dept', { to_department_id: 'fin', reason: REASON });
  assert.deepEqual([r.status, r.data.error, r.data.department], [403, 'out_of_scope', 'fin']);
  assert.equal(await deptOf('ess'), 'hr');
});

test('move-dept: destination and reason validated; same department refused (400/409)', { skip }, async () => {
  const root = await as('root');
  const go = b => root.post('/tracker/applications/ess/move-dept', b);
  assert.equal((await go({ reason: REASON })).data.error, 'invalid_value');
  assert.equal((await go({ to_department_id: 'nope', reason: REASON })).data.error, 'unknown_department');
  const same = await go({ to_department_id: 'hr', reason: REASON });
  assert.deepEqual([same.status, same.data.error], [400, 'move_same_dept']);
  for (const reason of [undefined, '', '  a b ']) {
    const r = await go({ to_department_id: 'fin', reason });
    assert.equal(r.status, 400, String(reason));
    assert.ok(['move_reason_required', 'invalid_value'].includes(r.data.error));
  }
  assert.equal(await deptOf('ess'), 'hr');
});

test('direct move (lead of both departments, fixed mode): weight transfers with the application, total unchanged', { skip }, async () => {
  const lead = await as('lead_both');
  const hr0 = await deptWeight('hr'), fin0 = await deptWeight('fin'), total0 = await totalWeight();
  const appW = +(await one(`SELECT weight FROM applications WHERE id='ess'`)).weight;   // catalog: 5
  const pv = (await lead.post('/tracker/applications/ess/move-dept/preview', { to_department_id: 'fin' })).data;
  assert.equal(pv.needs_approval, false);
  assert.equal(pv.mode, 'fixed');
  assert.equal(pv.app_weight, appW);
  const src = pv.departments.find(d => d.role === 'source'), dst = pv.departments.find(d => d.role === 'destination');
  assert.deepEqual([src.id, dst.id], ['hr', 'fin']);
  assert.ok(Math.abs(src.weight.after - (src.weight.before - appW)) < 1e-9);
  assert.ok(Math.abs(dst.weight.after - (dst.weight.before + appW)) < 1e-9);

  const r = await lead.post('/tracker/applications/ess/move-dept', { to_department_id: 'fin', reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.moved, true);
  // the application moved, its weight unchanged; its functions came with it (application_id untouched)
  assert.equal(await deptOf('ess'), 'fin');
  assert.equal(+(await one(`SELECT weight FROM applications WHERE id='ess'`)).weight, appW);
  // the invariant: source − appW, destination + appW, the total unchanged
  assert.ok(Math.abs(await deptWeight('hr') - (hr0 - appW)) < 1e-9);
  assert.ok(Math.abs(await deptWeight('fin') - (fin0 + appW)) < 1e-9);
  assert.ok(Math.abs(await totalWeight() - total0) < 1e-9);
  // provenance + audit
  const mv = await one('SELECT * FROM application_moves WHERE app_id=$1', ['ess']);
  assert.deepEqual([mv.from_department_id, mv.to_department_id, mv.weight_mode, +mv.weight, mv.reason, mv.moved_by, mv.request_id],
    ['hr', 'fin', 'fixed', appW, REASON, ids.lead_both, null]);
  const a = await one(`SELECT * FROM audit_log WHERE action='move' AND entity='application' AND entity_id='ess'`);
  assert.deepEqual([a.old_value.department_id, a.new_value.department_id, +a.new_value.weight], ['hr', 'fin', appW]);
  const w = (await pool.query(`SELECT entity_id, old_value, new_value, context FROM audit_log WHERE action='update' AND entity='department'
    AND context->>'move'='true' AND (context->>'request_id') IS NULL ORDER BY context->>'side'`)).rows;
  assert.deepEqual(w.map(x => [x.entity_id, x.context.side]), [['fin', 'destination'], ['hr', 'source']]);
  // the application page shows the provenance badge
  const page = (await lead.get('/tracker/applications/ess')).data;
  assert.equal(page.application.moved_from.from_department_id, 'hr');
});

test('member move: a move_application request needs BOTH department leads; not moved until both approve', { skip }, async () => {
  // move 'per' (hr) → fin by a member who holds 'mov' but leads neither department
  const mover = await as('mover');
  const pv = (await mover.post('/tracker/applications/per/move-dept/preview', { to_department_id: 'fin' })).data;
  assert.equal(pv.needs_approval, true);
  const r = await mover.post('/tracker/applications/per/move-dept', { to_department_id: 'fin', reason: REASON });
  assert.deepEqual([r.status, r.data.pending], [202, true]);
  const reqId = r.data.request_id;
  const rq0 = await one('SELECT * FROM edit_requests WHERE id=$1', [reqId]);
  assert.deepEqual([rq0.kind, rq0.app_id, rq0.department_id, rq0.target_department_id, rq0.target_app_id, rq0.status],
    ['move_application', 'per', 'hr', 'fin', null, 'pending']);
  assert.equal(await deptOf('per'), 'hr');                                   // not moved yet

  // the destination lead cannot sign the first (source) stage
  const fin = await as('lead_fin');
  assert.equal((await fin.post(`/approvals/${reqId}/approve`)).status, 403);
  assert.equal(await deptOf('per'), 'hr');

  // the source lead approves → still pending, awaiting the destination
  const hr = await as('lead_hr');
  const a1 = await hr.post(`/approvals/${reqId}/approve`);
  assert.equal(a1.status, 200, JSON.stringify(a1.data));
  assert.equal(a1.data.applied, false);
  assert.equal(a1.data.stage, 'source');
  assert.equal(await deptOf('per'), 'hr');                                   // STILL not moved
  assert.equal((await one('SELECT status FROM edit_requests WHERE id=$1', [reqId])).status, 'pending');

  // the source lead cannot also sign the destination stage
  assert.equal((await hr.post(`/approvals/${reqId}/approve`)).status, 403);

  // the destination lead approves → applied in the requester's name, the application moves
  const a2 = await fin.post(`/approvals/${reqId}/approve`);
  assert.equal(a2.status, 200, JSON.stringify(a2.data));
  assert.equal(a2.data.applied, true);
  assert.equal(await deptOf('per'), 'fin');
  const mv = await one('SELECT * FROM application_moves WHERE app_id=$1', ['per']);
  assert.deepEqual([mv.from_department_id, mv.to_department_id, mv.moved_by, mv.request_id], ['hr', 'fin', ids.mover, reqId]);
  assert.equal((await one('SELECT status FROM edit_requests WHERE id=$1', [reqId])).status, 'applied');
});

test('guard: a pending request on the application or its items blocks the move (409)', { skip }, async () => {
  // a pending edit request on one of 'rec' (hr) items
  const mover = await as('mover');
  const f = await one(`SELECT f.id FROM functions f WHERE f.app_id='rec' AND f.removed_at IS NULL ORDER BY f.sort LIMIT 1`);
  const pend = await mover.patch(`/tracker/functions/${f.id}`, { progress: 33 });
  assert.equal(pend.status, 202, JSON.stringify(pend.data));                 // a member's edit becomes a request
  const r = await mover.post('/tracker/applications/rec/move-dept', { to_department_id: 'fin', reason: REASON });
  assert.deepEqual([r.status, r.data.error], [409, 'move_app_pending_request']);
  assert.equal(await deptOf('rec'), 'hr');
});

test('guard: a name clash in the destination department refuses the move (409)', { skip }, async () => {
  // give fin's 'fa' the same English name as hr's 'att', then try to move 'att' into fin
  const att = await one(`SELECT name_en FROM applications WHERE id='att'`);
  await pool.query(`UPDATE applications SET name_en=$1 WHERE id='fa'`, [att.name_en]);
  const r = await (await as('lead_both')).post('/tracker/applications/att/move-dept', { to_department_id: 'fin', reason: REASON });
  assert.deepEqual([r.status, r.data.error, r.data.application], [409, 'move_app_name_conflict', 'fa']);
  assert.equal(await deptOf('att'), 'hr');
});

test('auto weight mode: nothing to transfer; the application still moves, its weight column untouched', { skip }, async () => {
  const root = await as('root');
  assert.equal((await root.put('/tracker/weights', { weight_mode: 'auto' })).status, 200);
  settings.invalidateSettings();
  const total0 = await totalWeight();                                        // stored weights are untouched in auto mode
  const appW = +(await one(`SELECT weight FROM applications WHERE id='lev'`)).weight;
  const pv = (await root.post('/tracker/applications/lev/move-dept/preview', { to_department_id: 'fin' })).data;
  assert.equal(pv.mode, 'auto');
  const r = await root.post('/tracker/applications/lev/move-dept', { to_department_id: 'fin', reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await deptOf('lev'), 'fin');
  assert.equal(+(await one(`SELECT weight FROM applications WHERE id='lev'`)).weight, appW);   // unchanged
  const mv = await one('SELECT weight_mode FROM application_moves WHERE app_id=$1', ['lev']);
  assert.equal(mv.weight_mode, 'auto');
  // no department weight-change audit rows in auto mode
  const w = (await pool.query(`SELECT 1 FROM audit_log WHERE action='update' AND entity='department' AND (new_value->'weight') IS NOT NULL
    AND context->>'app_id'='lev'`)).rows;
  assert.equal(w.length, 0);
  assert.ok(Math.abs(await totalWeight() - total0) < 1e-9);
  assert.equal((await root.put('/tracker/weights', { weight_mode: 'fixed' })).status, 200);
  settings.invalidateSettings();
});

// keep the driver quiet about an unused import in skip mode
void pg;

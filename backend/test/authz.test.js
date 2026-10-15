// Authorization regression tests for the security remediation (ETS-SEC-004/005/006/007/023/024/025/026/027/056/058),
// following the Phase 3 scenarios P3-AUTHZ-01…10. Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool;
const ids = {};

// users: [username, role, scopes ([kind, ref]), overrides ([permission, granted])]
const USERS = [
  ['root', 'admin'], ['pmu', 'pm'], ['tmu', 'tm'],
  ['mgr_a', 'mgr', [['department', 'hr']]],
  ['lead_a', 'lead', [['department', 'hr']]],
  ['lead_x', 'lead', [['application', 'per']]],
  ['member_y', 'member', [['application', 'rec']]],
  ['member_x', 'member', [['application', 'per']]],
  ['member_hr', 'member', [['department', 'hr']]],
  ['member_hr2', 'member', [['department', 'hr']]],
  ['member_fin', 'member', [['department', 'fin']]],
  ['member_fin2', 'member', [['department', 'fin']]],
  ['lead_fin', 'lead', [['department', 'fin']]],
  ['lead_fin2', 'lead', [['department', 'fin']]],
  ['lead0', 'lead'],
  ['member0', 'member'],
  ['memusr', 'member', [['department', 'hr']], [['usr', true]]],
  ['pmusr', 'pm', [], [['usr', true]]],
  ['apvf_a', 'obs', [['department', 'hr']], [['apv_final', true]]],
  ['cfg_a', 'obs', [['department', 'hr']], [['cfg', true]]],
  ['noteuser', 'lead', [['department', 'hr']], [['tst', false]]],
];

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '50', LOGIN_RATE_LIMIT: '1000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  for (const [u, role, scopes = [], overrides = []] of USERS) {
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES ($1,$2,$3,$4,false) RETURNING id`,
      [u, u, h, role])).rows[0].id;
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
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }) };
}
const as = async (u, pw) => { const c = client(); const r = await c.login(u, pw); assert.equal(r.data.stage, 'done', u); return c; };
const fn = async (app, code) => (await pool.query('SELECT * FROM functions WHERE app_id=$1 AND code=$2', [app, code])).rows[0];
const exportFile = async () => (await (await as('root')).get('/tracker/export')).data;

test('usr is for administrators only; no self-grant (ETS-SEC-004, P3-AUTHZ-01)', { skip }, async () => {
  // a member or PM holding a stray 'usr' override gets nothing from it
  for (const u of ['memusr', 'pmusr']) {
    const c = await as(u);
    assert.ok(!(await c.get('/auth/me')).data.user.permissions.includes('usr'), u);
    assert.equal((await c.get('/users')).status, 403, u);
    assert.equal((await c.patch('/users/' + ids[u], { overrides: [{ permission: 'cfg', granted: true }] })).status, 403, u);
    assert.equal((await c.post('/users', { username: 'evil' + u, full_name: 'E', role_id: 'admin', password: 'Evil-Admin-2026' })).status, 403, u);
    assert.equal((await c.post(`/users/${ids.root}/reset-password`, { password: 'Taken-Over-2026', must_change: false })).status, 403, u);
    assert.equal((await c.post('/users/bulk-2fa', { all: true, exempt: true })).status, 403, u);
  }
  const root = await as('root');
  // 'usr' cannot be granted to another role, on create or update
  const bad = await root.post('/users', { username: 'helpdesk', full_name: 'Help', role_id: 'member', password: 'Help-Desk-2026',
    scopes: [{ kind: 'department', ref_id: 'hr' }], overrides: [{ permission: 'usr', granted: true }] });
  assert.equal(bad.status, 400); assert.equal(bad.data.error, 'usr_admin_only');
  assert.equal((await root.patch('/users/' + ids.lead_a, { overrides: [{ permission: 'usr', granted: true }] })).data.error, 'usr_admin_only');
  assert.equal((await root.patch('/users/' + ids.pmusr, { overrides: [{ permission: 'usr', granted: true }] })).data.error, 'usr_admin_only');
  // an administrator cannot widen their own permissions, scope or 2FA exemption…
  for (const body of [{ overrides: [{ permission: 'apv_final', granted: true }] }, { scopes: [{ kind: 'department', ref_id: 'hr' }] }, { totp_exempt: true }]) {
    const r = await root.patch('/users/' + ids.root, body);
    assert.equal(r.data.error, 'cannot_change_own_permissions', JSON.stringify(body));
  }
  // …but saving their own unchanged form still works
  assert.equal((await root.patch('/users/' + ids.root, { full_name: 'Root', overrides: [], scopes: [], totp_exempt: false })).status, 200);
  // administrators keep every user-administration action
  const adm = await root.post('/users', { username: 'admin2', full_name: 'Second Admin', role_id: 'admin', password: 'Second-Admin-2026', must_change_password: false });
  assert.equal(adm.status, 201);
  ids.admin2 = adm.data.user.id;
  assert.equal((await root.post(`/users/${ids.admin2}/reset-password`, { password: 'Second-Admin-2027', must_change: false })).status, 200);
  assert.equal((await root.post('/users/bulk-2fa', { user_ids: [ids.member0], exempt: true })).status, 200);
  // demoting an admin drops a stored 'usr' grant
  await pool.query(`INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,'usr',true)`, [ids.admin2]);
  assert.equal((await root.patch('/users/' + ids.admin2, { role_id: 'pm' })).status, 200);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM user_permissions WHERE user_id=$1 AND permission='usr'`, [ids.admin2])).rows[0].n, 0);
  assert.equal((await root.patch('/users/' + ids.admin2, { role_id: 'admin' })).status, 200);
});

test('last-admin protection counts overrides and is race-safe (ETS-SEC-023, P3-AUTHZ-05)', { skip }, async () => {
  const root = await as('root');
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [ids.admin2]);         // root is the only admin
  for (const p of ['usr', 'cfg']) {
    const r = await root.patch('/users/' + ids.root, { overrides: [{ permission: p, granted: false }] });
    assert.equal(r.status, 400, p); assert.equal(r.data.error, 'last_admin', p);
  }
  assert.equal((await root.get('/users')).status, 200);                                    // still in control
  // two admins demoting each other at the same moment: exactly one succeeds
  await pool.query('UPDATE users SET is_active=true WHERE id=$1', [ids.admin2]);
  const a2 = await as('admin2', 'Second-Admin-2027');
  const res = await Promise.all([root.patch('/users/' + ids.admin2, { role_id: 'obs' }), a2.patch('/users/' + ids.root, { role_id: 'obs' })]);
  assert.deepEqual(res.map(r => r.status).sort(), [200, 400], JSON.stringify(res.map(r => r.data)));
  const n = (await pool.query(`SELECT count(*)::int n FROM users WHERE role_id='admin' AND is_active`)).rows[0].n;
  assert.equal(n, 1);
  // restore both admins for later tests
  await pool.query(`UPDATE users SET role_id='admin' WHERE id = ANY($1)`, [[ids.root, ids.admin2]]);
});

test('scoped role without scope rows sees nothing (ETS-SEC-005, P3-AUTHZ-02)', { skip }, async () => {
  const lead0 = await as('lead0');
  const me = (await lead0.get('/auth/me')).data.user;
  assert.equal(me.fullScope, false);
  assert.deepEqual((await lead0.get('/tracker/summary')).data.departments, []);
  assert.equal((await lead0.get('/tracker/applications/acc')).status, 403);
  assert.equal((await lead0.get('/logs/auth')).status, 403);
  assert.equal((await lead0.get('/logs/stats')).status, 403);
  assert.equal((await lead0.get('/logs/audit')).data.rows.length, 0);
  assert.deepEqual(Object.keys((await lead0.get('/tracker/export')).data.f), []);
  assert.deepEqual((await lead0.post('/imports/preview', { payload: await exportFile() })).data.options, []);
  // cannot approve another department's request
  const f = await fn('acc', 'D0');
  const rq = await (await as('member_fin')).patch('/tracker/functions/' + f.id, { progress: 33 });
  assert.equal(rq.status, 202);
  assert.equal((await lead0.post(`/approvals/${rq.data.request_id}/approve`)).status, 403);
  assert.ok(!(await lead0.get('/approvals')).data.requests.some(x => x.id === rq.data.request_id));
  const member0 = await as('member0');
  assert.equal((await member0.get('/auth/me')).data.user.fullScope, false);
  assert.equal((await member0.patch('/tracker/functions/' + f.id, { progress: 34 })).status, 403);
  // full-scope roles are unaffected
  assert.equal((await (await as('pmu')).get('/tracker/summary')).data.departments.length, 4);
  await (await as('lead_fin')).post(`/approvals/${rq.data.request_id}/reject`, { reason: 'test cleanup' });
});

test('tracker export follows the scope (ETS-SEC-006, P3-AUTHZ-03)', { skip }, async () => {
  const exp = (await (await as('lead_a')).get('/tracker/export')).data;
  const hrApps = (await pool.query(`SELECT id FROM applications WHERE department_id='hr' ORDER BY id`)).rows.map(x => x.id);
  assert.deepEqual(Object.keys(exp.appW).sort(), hrApps);
  assert.deepEqual(Object.keys(exp.f).sort(), hrApps);
  assert.ok(Object.keys(exp.rep).every(a => hrApps.includes(a)));
  assert.equal(exp.sch, undefined);                                   // project-wide schedule: full scope only
  const full = await exportFile();
  assert.equal(Object.keys(full.appW).length, 30);
  assert.ok(full.sch && full.sch.n > 0);
});

test('application scope is not department scope: approvals and imports (ETS-SEC-007, P3-AUTHZ-04)', { skip }, async () => {
  const leadX = await as('lead_x'), memberY = await as('member_y'), memberX = await as('member_x'), leadA = await as('lead_a');
  // edit request for app rec (Y): the per (X) lead neither sees nor approves it; the department lead does
  const rec = await fn('rec', 'D0');
  const rq = await memberY.patch('/tracker/functions/' + rec.id, { progress: 21 });
  assert.equal(rq.status, 202);
  assert.ok(!(await leadX.get('/approvals')).data.requests.some(x => x.id === rq.data.request_id));
  assert.equal((await leadX.get('/approvals/pending-count')).data.awaiting_me, 0);
  assert.equal((await leadX.post(`/approvals/${rq.data.request_id}/approve`)).status, 403);
  assert.equal((await leadA.post(`/approvals/${rq.data.request_id}/approve`)).data.applied_changes, 1);
  // the per lead still approves per requests
  const per = await fn('per', 'D2');
  const rq2 = await memberX.patch('/tracker/functions/' + per.id, { progress: 22 });
  assert.equal((await leadX.post(`/approvals/${rq2.data.request_id}/approve`)).data.applied_changes, 1);

  // imports: a file touching per and rec
  const file = await exportFile();
  file.f.per.D3.p = 77; file.f.rec.D3.p = 66;
  // the per member's department upload only carries per
  const pv = (await memberX.post('/imports/preview', { payload: file })).data.options.find(o => o.target === 'department');
  assert.deepEqual([pv.department_id, pv.changes], ['hr', 1]);
  const bx = (await memberX.post('/imports', { payload: file, target: 'department', department_id: 'hr' })).data.batch;
  const bxChanges = (await pool.query('SELECT DISTINCT app_id FROM import_changes WHERE batch_id=$1', [bx.id])).rows.map(x => x.app_id);
  assert.deepEqual(bxChanges, ['per']);
  // a department member's upload carries both; the per lead may not sign it and only sees the per change
  const bh = (await (await as('member_hr')).post('/imports', { payload: file, target: 'department', department_id: 'hr' })).data.batch;
  assert.equal(bh.change_count, 2);
  const view = (await leadX.get('/imports/' + bh.id)).data;
  assert.deepEqual(view.changes.map(c => c.app_id), ['per']);
  assert.equal(view.batch.can.approve_lead, false);
  assert.ok(view.batch.summary.applications.every(a => a.id === 'per'));
  const sign = await leadX.post(`/imports/${bh.id}/approve`, { stage: 'lead' });
  assert.equal(sign.status, 403);
  assert.equal((await leadX.post(`/imports/${bh.id}/reject`, { reason: 'no' })).status, 403);
  assert.equal((await leadA.post(`/imports/${bh.id}/approve`, { stage: 'lead' })).status, 200);
  assert.equal((await (await as('pmu')).post(`/imports/${bh.id}/approve`, { stage: 'final' })).data.applied, true);
  assert.equal(+(await fn('rec', 'D3')).progress, 66);
});

test('project schedule: full-scope users only (ETS-SEC-024, P3-AUTHZ-06)', { skip }, async () => {
  const body = { periods: 11, unit: 'month', plan: null, actual: [1, 2] };
  const mgr = await as('mgr_a');
  assert.equal((await mgr.get('/tracker/schedule')).data.can.sch, false);
  const r = await mgr.put('/tracker/schedule', body);
  assert.equal(r.status, 403); assert.equal(r.data.error, 'out_of_scope');
  assert.equal((await (await as('pmu')).put('/tracker/schedule', body)).status, 200);
});

test('imports: the uploader signs no stage; scoped apv_final cannot sign another department (ETS-SEC-025, P3-AUTHZ-07)', { skip }, async () => {
  const file = await exportFile();
  file.f.acc.D1.p = 41;
  const leadFin = await as('lead_fin');
  const b = (await leadFin.post('/imports', { payload: file, target: 'department', department_id: 'fin' })).data.batch;
  assert.equal(b.status, 'pending');
  assert.equal((await leadFin.post(`/imports/${b.id}/approve`, { stage: 'lead' })).status, 403);   // own upload
  assert.equal((await (await as('apvf_a')).post(`/imports/${b.id}/approve`, { stage: 'final' })).status, 403);   // hr-scoped final approver
  const tm = await as('tmu');
  assert.equal((await tm.post(`/imports/${b.id}/approve`, { stage: 'final' })).data.applied, false);
  assert.equal((await tm.post(`/imports/${b.id}/approve`, { stage: 'lead' })).status, 403);         // same person twice
  assert.equal((await (await as('lead_fin2')).post(`/imports/${b.id}/approve`, { stage: 'lead' })).data.applied, true);
  // a full-scope uploader cannot sign the final stage of their own batch either
  file.f.acc.D2.p = 42;
  const b2 = (await tm.post('/imports', { payload: file, target: 'department', department_id: 'fin' })).data.batch;
  assert.equal((await tm.post(`/imports/${b2.id}/approve`, { stage: 'final' })).status, 403);
  assert.equal((await (await as('pmu')).post(`/imports/${b2.id}/reject`, { reason: 'cleanup' })).status, 200);
});

test('imports: superseding keeps batches another user has started signing (ETS-SEC-026, P3-AUTHZ-08)', { skip }, async () => {
  const file = await exportFile();
  const same = JSON.parse(JSON.stringify(file));                       // identical to the data: no changes
  file.f.acc.D3.p = 43;
  const a = (await (await as('member_fin')).post('/imports', { payload: file, target: 'department', department_id: 'fin' })).data.batch;
  assert.equal((await (await as('lead_fin')).post(`/imports/${a.id}/approve`, { stage: 'lead' })).status, 200);
  const status = async id => (await pool.query('SELECT status FROM import_batches WHERE id=$1', [id])).rows[0].status;
  const m2 = await as('member_fin2');
  const z = (await m2.post('/imports', { payload: same, target: 'department', department_id: 'fin' })).data.batch;
  assert.equal(z.status, 'no_changes');
  assert.equal(await status(a.id), 'pending');                        // a no-change upload never supersedes
  const b = (await m2.post('/imports', { payload: file, target: 'department', department_id: 'fin' })).data.batch;
  assert.equal(await status(a.id), 'pending');                        // signed by a lead → kept
  // an unsigned batch is replaced by a newer file
  file.f.acc.D4.p = 44;
  const c = (await (await as('member_fin')).post('/imports', { payload: file, target: 'department', department_id: 'fin' })).data.batch;
  assert.equal(await status(b.id), 'superseded');
  assert.deepEqual(c.summary.superseded, [b.id]);
  for (const id of [a.id, c.id]) await (await as('pmu')).post(`/imports/${id}/reject`, { reason: 'cleanup' });
});

test('approved requests / imports re-check the author (ETS-SEC-027, P3-AUTHZ-09)', { skip }, async () => {
  const root = await as('root'), leadA = await as('lead_a');
  const f = await fn('per', 'D5');
  // deactivation withdraws the pending request
  const r1 = await (await as('member_x')).patch('/tracker/functions/' + f.id, { progress: 70 });
  assert.equal((await root.patch('/users/' + ids.member_x, { is_active: false })).status, 200);
  assert.equal((await pool.query('SELECT status FROM edit_requests WHERE id=$1', [r1.data.request_id])).rows[0].status, 'withdrawn');
  assert.equal((await leadA.post(`/approvals/${r1.data.request_id}/approve`)).status, 400);
  // a request whose author left the application's scope is not applied
  const r2 = await (await as('member_hr2')).patch('/tracker/functions/' + f.id, { progress: 71 });
  assert.equal((await root.patch('/users/' + ids.member_hr2, { scopes: [{ kind: 'department', ref_id: 'fin' }] })).status, 200);
  const ap = await leadA.post(`/approvals/${r2.data.request_id}/approve`);
  assert.equal(ap.status, 409); assert.equal(ap.data.error, 'requester_not_allowed');
  assert.equal((await leadA.post('/approvals/approve-all', {})).data.blocked_requests, 1);
  assert.equal(+(await fn('per', 'D5')).progress, +f.progress);
  assert.equal((await pool.query('SELECT status FROM edit_requests WHERE id=$1', [r2.data.request_id])).rows[0].status, 'pending');
  await leadA.post(`/approvals/${r2.data.request_id}/reject`, { reason: 'author moved' });
  // import: uploader deactivated before the second signature → not applied
  const file = await exportFile();
  file.f.per.D6.p = 72;
  const b = (await (await as('member_hr')).post('/imports', { payload: file, target: 'department', department_id: 'hr' })).data.batch;
  assert.equal((await leadA.post(`/imports/${b.id}/approve`, { stage: 'lead' })).status, 200);
  await root.patch('/users/' + ids.member_hr, { is_active: false });
  const fin = await (await as('pmu')).post(`/imports/${b.id}/approve`, { stage: 'final' });
  assert.equal(fin.status, 409); assert.equal(fin.data.error, 'requester_not_allowed');
  assert.equal((await pool.query('SELECT status, final_by FROM import_batches WHERE id=$1', [b.id])).rows[0].final_by, null);
  assert.notEqual(+(await fn('per', 'D6')).progress, 72);
  await root.patch('/users/' + ids.member_hr, { is_active: true });
  await root.patch('/users/' + ids.member_x, { is_active: true });
});

test('note exception only with a real status change (ETS-SEC-056, P3-AUTHZ-10)', { skip }, async () => {
  const c = await as('noteuser');                                       // lead without tst
  const f = await fn('att', 'D1');
  await pool.query(`UPDATE functions SET notif_status=2, note='ORIGINAL' WHERE id=$1`, [f.id]);
  const r = await c.patch('/tracker/functions/' + f.id, { notif_status: 2, note: 'OVERWRITTEN' });
  assert.equal(r.status, 403);
  assert.equal((await fn('att', 'D1')).note, 'ORIGINAL');
  // choosing the "with notes" status still carries its note
  const g = await fn('att', 'D2');
  await pool.query(`UPDATE functions SET notif_status=0, note='' WHERE id=$1`, [g.id]);
  assert.equal((await c.patch('/tracker/functions/' + g.id, { notif_status: 2, note: 'why' })).status, 200);
  assert.equal((await fn('att', 'D2')).note, 'why');
  // two steps (status away, then back with a new note) no longer overwrite the note: it is not empty (residual)
  assert.equal((await c.patch('/tracker/functions/' + g.id, { notif_status: 0 })).status, 200);
  const two = await c.patch('/tracker/functions/' + g.id, { notif_status: 2, note: 'OVERWRITTEN_two_step' });
  assert.equal(two.status, 403);
  assert.equal((await fn('att', 'D2')).note, 'why');
  assert.equal((await c.patch('/tracker/functions/' + g.id, { notif_status: 2 })).status, 200);   // the status alone still works
  // request path: a note written meanwhile is not overwritten when the request is approved
  const h = await fn('per', 'D9');
  await pool.query(`UPDATE functions SET notif_status=0, note='' WHERE id=$1`, [h.id]);
  await pool.query(`UPDATE user_permissions SET granted=false WHERE user_id=$1 AND permission='tst'`, [ids.member_x]);
  await pool.query(`INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,'tst',false) ON CONFLICT DO NOTHING`, [ids.member_x]);
  const rq = await (await as('member_x')).patch('/tracker/functions/' + h.id, { notif_status: 2, note: 'from member' });
  assert.equal(rq.status, 202);
  await pool.query(`UPDATE functions SET note='tester note' WHERE id=$1`, [h.id]);
  const ap = await (await as('lead_a')).post(`/approvals/${rq.data.request_id}/approve`);
  assert.equal(ap.status, 409); assert.equal(ap.data.error, 'requester_not_allowed');
  assert.equal((await fn('per', 'D9')).note, 'tester note');
  await (await as('lead_a')).post(`/approvals/${rq.data.request_id}/reject`, { reason: 'cleanup' });
  await pool.query(`DELETE FROM user_permissions WHERE user_id=$1 AND permission='tst'`, [ids.member_x]);
  // race (V6-N1): a note saved by a tester at the same moment is never overwritten through the first-note exception
  const root = await as('root');
  for (let i = 0; i < 10; i++) {
    await pool.query(`UPDATE functions SET notif_status=0, note='' WHERE id=$1`, [g.id]);
    const [t, u] = await Promise.all([
      root.patch('/tracker/functions/' + g.id, { note: 'TESTER' }),
      c.patch('/tracker/functions/' + g.id, { notif_status: 2, note: 'NOTEUSER' }),
    ]);
    assert.equal(t.status, 200);
    assert.ok([200, 403, 409].includes(u.status), String(u.status));
    assert.equal((await fn('att', 'D2')).note, 'TESTER', `round ${i}`);
  }
});

test('Phase 7 leftovers: bulk-2fa self, duplicate overrides, own password reset (V2-N1, V2-N4, V2-N5)', { skip }, async () => {
  const root = await as('root');
  await pool.query('UPDATE users SET totp_exempt=false');
  // V2-N1: a list naming the caller is refused; "all" leaves the caller out; removing exemptions stays allowed
  const self = await root.post('/users/bulk-2fa', { user_ids: [ids.member0, ids.root], exempt: true });
  assert.equal(self.status, 400); assert.equal(self.data.error, 'cannot_change_own_permissions');
  assert.equal((await pool.query('SELECT count(*)::int n FROM users WHERE totp_exempt')).rows[0].n, 0);
  const all = await root.post('/users/bulk-2fa', { all: true, exempt: true });
  assert.equal(all.status, 200);
  const ex = id => pool.query('SELECT totp_exempt FROM users WHERE id=$1', [id]).then(r => r.rows[0].totp_exempt);
  assert.equal(await ex(ids.root), false);
  assert.equal(await ex(ids.member0), true);
  assert.equal(all.data.updated, (await pool.query('SELECT count(*)::int n FROM users')).rows[0].n - 1);
  await pool.query('UPDATE users SET totp_exempt=true WHERE id=$1', [ids.root]);
  assert.equal((await root.post('/users/bulk-2fa', { user_ids: [ids.root], exempt: false })).status, 200);
  assert.equal(await ex(ids.root), false);
  assert.equal((await root.post('/users/bulk-2fa', { all: true, exempt: false })).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int n FROM users WHERE totp_exempt')).rows[0].n, 0);
  // V2-N4: a duplicate permission is a 400, not a 500 (create and update)
  const dupe = [{ permission: 'rep', granted: true }, { permission: 'rep', granted: false }];
  let r = await root.patch('/users/' + ids.lead_a, { overrides: dupe });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'invalid_permission');
  r = await root.post('/users', { username: 'dupe1', full_name: 'D', role_id: 'member', password: 'Dupe-User-2026', overrides: dupe });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'invalid_permission');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE username='dupe1'`)).rows[0].n, 0);
  // V2-N5: an administrator's own password changes through /auth/change-password (current password asked)
  r = await root.post(`/users/${ids.root}/reset-password`, { password: 'Self-Reset-2026x', must_change: false });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'use_change_password');
  assert.equal((await root.get('/auth/me')).status, 200);                  // nothing changed, session still valid
  await as('root');                                                       // old password still works
  assert.equal((await root.post(`/users/${ids.admin2}/reset-password`, { password: 'Second-Admin-2028', must_change: false })).status, 200);
});

test('partial readers: batch figures and pending counts follow the scope (V2-N2, V2-N3)', { skip }, async () => {
  const leadX = await as('lead_x');
  // V2-N3: a pending request on rec (not lead_x's) is not counted for lead_x
  const rec = await fn('rec', 'D8');
  const rq = await (await as('member_y')).patch('/tracker/functions/' + rec.id, { progress: 9 });
  assert.equal(rq.status, 202);
  const before = (await leadX.get('/tracker/project-status')).data.pending;
  assert.equal((await (await as('lead_a')).get('/tracker/project-status')).data.pending.edits >= 1, true);
  // V2-N2: a batch touching per and rec, read by the per lead
  const file = await exportFile();
  file.f.per.D9.p = 19; file.f.rec.D9.p = 29; file.f.rec.D10.p = 39;
  const b = (await (await as('member_hr')).post('/imports', { payload: file, target: 'department', department_id: 'hr' })).data.batch;
  assert.equal(b.change_count, 3);
  const view = (await leadX.get('/imports/' + b.id)).data;
  assert.equal(view.batch.change_count, 1);
  assert.equal(view.batch.summary.project, null);
  assert.deepEqual(view.batch.summary.departments, []);                    // hr is not fully in lead_x's scope
  assert.equal(view.batch.summary.counts.total, 1);
  assert.deepEqual(view.batch.summary.applications.map(a => a.id), ['per']);
  const listed = (await leadX.get('/imports')).data.batches.find(x => x.id === b.id);
  assert.equal(listed.change_count, 1); assert.equal(listed.summary.project, null);
  // the department lead (covers hr) and full-scope users still get the whole figures
  const full = (await (await as('lead_a')).get('/imports/' + b.id)).data.batch;
  assert.equal(full.change_count, 3); assert.ok(full.summary.project); assert.equal(full.summary.departments.length, 1);
  assert.ok((await (await as('pmu')).get('/imports/' + b.id)).data.batch.summary.project);
  // pending counts: the batch counts for lead_x (one change is theirs); the rec-only request does not
  const after = (await leadX.get('/tracker/project-status')).data.pending;
  assert.equal(after.edits, before.edits);
  assert.equal(after.imports, before.imports + 1);
  const recOnly = (await (await as('member_y')).post('/imports', { payload: file, target: 'department', department_id: 'hr' })).data.batch;
  assert.equal(recOnly.change_count, 2);
  assert.equal((await leadX.get('/tracker/project-status')).data.pending.imports, after.imports);
  for (const id of [b.id, recOnly.id]) await (await as('pmu')).post(`/imports/${id}/reject`, { reason: 'cleanup' });
  await (await as('lead_a')).post(`/approvals/${rq.data.request_id}/reject`, { reason: 'cleanup' });
});

test('migration 009 is accurate and idempotent on a fresh install (V2-N6)', { skip }, async () => {
  const sql = (await import('node:fs')).readFileSync(new URL('../src/db/migrations/009_usr_admin_only.sql', import.meta.url), 'utf8');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = (await c.query(`INSERT INTO users(username,full_name,password_hash,role_id) VALUES ('m009','m','x','lead') RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,'usr',true),($1,'cfg',true)`, [u]);
    await c.query(`DELETE FROM system_log WHERE event='scope_fail_closed'`);
    await c.query(sql); await c.query(sql);
    const a = (await c.query(`SELECT old_value, new_value FROM audit_log WHERE entity='user' AND entity_id=$1 AND username='system'`, [String(u)])).rows;
    assert.equal(a.length, 1);
    assert.deepEqual(a[0].new_value, { overrides: [{ permission: 'cfg', granted: true }] });
    assert.deepEqual(a[0].old_value.overrides.map(o => o.permission), ['cfg', 'usr']);
    assert.equal((await c.query(`SELECT count(*)::int n FROM system_log WHERE event='scope_fail_closed'`)).rows[0].n, 1);
    assert.deepEqual((await c.query('SELECT permission FROM user_permissions WHERE user_id=$1', [u])).rows.map(x => x.permission), ['cfg']);
  } finally { await c.query('ROLLBACK'); c.release(); }
});

test('minor scope tidy-ups (ETS-SEC-058)', { skip }, async () => {
  assert.equal((await (await as('cfg_a')).get('/settings')).status, 403);   // project-wide settings: full scope
  // impact preview ignores functions of other applications
  const other = await fn('acc', 'D7');
  const imp = (await (await as('lead_a')).post('/tracker/applications/per/impact', { set: [{ function_id: other.id, enabled: false }] })).data;
  assert.equal(imp.total.before, imp.total.after);
});

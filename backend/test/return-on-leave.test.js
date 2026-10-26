// Rejecting a lead's edit-request approval RETURNS it (1.12.28, migration 027): to the requester, or — when the
// requester is on leave with a pre-assigned substitute — to that substitute, who can then resubmit or withdraw it on
// their behalf. Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool, live;
const ids = {};

const USERS = [
  ['root', 'admin'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['member_hr', 'member', [['department', 'hr']]],
  ['sub_hr', 'member', [['department', 'hr']]],
  ['other_hr', 'member', [['department', 'hr']]],
];

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
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const fn = (app, code) => one('SELECT * FROM functions WHERE app_id=$1 AND code=$2', [app, code]);
const st = async id => (await one('SELECT * FROM edit_requests WHERE id=$1', [id]));
// a fresh pending request by member_hr on an hr application
async function request(code = 'D2') {
  const f = await fn('per', code);
  const mh = await as('member_hr');
  const r = await mh.patch('/tracker/functions/' + f.id, { progress: +f.progress === 30 ? 31 : 30 });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  return r.data.request_id;
}
const returnedNotifs = async userId => (await pool.query(
  `SELECT * FROM notifications WHERE user_id=$1 AND type='request_returned'`, [userId])).rows;
const setLeave = (userId, body) => (as('root')).then(root => root.patch('/users/' + userId, body));

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
  live = await import('../src/services/live.js');
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

test('reject returns the request to its author, requires a 3–500 reason, and notifies the author', { skip }, async () => {
  const lead = await as('lead_hr');
  const id = await request('D2');
  // reason required (empty → 400), and too short (< 3 non-space chars → 400)
  assert.equal((await lead.post(`/approvals/${id}/reject`, { reason: '' })).data.error, 'reason_required');
  assert.equal((await lead.post(`/approvals/${id}/reject`, { reason: ' a ' })).data.error, 'reason_required');
  const r = await lead.post(`/approvals/${id}/reject`, { reason: 'needs more detail' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.returned, r.data.substitute], [true, false]);
  const rq = await st(id);
  assert.equal(rq.status, 'returned');
  assert.equal(rq.returned_reason, 'needs more detail');
  assert.equal(rq.returned_to, ids.member_hr);
  assert.equal(rq.decided_by, ids.lead_hr);
  // the author is notified (A7), warning severity, not on behalf
  const n = await returnedNotifs(ids.member_hr);
  assert.equal(n.length, 1); assert.equal(n[0].severity, 'warning'); assert.equal(n[0].params.on_behalf, false);
  // not in the lead's pending queue any more; closed for the approver
  assert.equal((await lead.get('/approvals/pending-count')).data.awaiting_me, 0);
  assert.deepEqual((await lead.get('/approvals?awaiting=1')).data.requests.map(x => x.id).filter(x => x === id), []);
  // it shows in the author's "returned to me" view and as returned on the screen
  const mh = await as('member_hr');
  assert.equal((await mh.get('/approvals/pending-count')).data.returned_to_me, 1);
  assert.deepEqual((await mh.get('/approvals?returned=1')).data.requests.map(x => x.id), [id]);
  assert.deepEqual((await mh.get('/approvals?status=returned')).data.requests.map(x => x.id), [id]);
  await pool.query(`UPDATE edit_requests SET status='withdrawn' WHERE id=$1`, [id]);
});

test('on leave with a substitute → the request is routed to the substitute, who is notified', { skip }, async () => {
  await pool.query(`DELETE FROM notifications WHERE type='request_returned'`);
  (await setLeave(ids.member_hr, { on_leave: true, substitute_user_id: ids.sub_hr }));
  const lead = await as('lead_hr');
  const id = await request('D3');
  const r = await lead.post(`/approvals/${id}/reject`, { reason: 'please revise' });
  assert.deepEqual([r.data.returned, r.data.substitute, r.data.returned_to], [true, true, ids.sub_hr]);
  const rq = await st(id);
  assert.equal(rq.returned_to, ids.sub_hr);
  // the substitute is notified, on behalf of the author; the author is not
  const n = await returnedNotifs(ids.sub_hr);
  assert.equal(n.length, 1); assert.equal(n[0].params.on_behalf, true);
  assert.equal((await returnedNotifs(ids.member_hr)).length, 0);
  // the substitute sees it even though they are neither the author nor an approver
  const sub = await as('sub_hr');
  assert.equal((await sub.get('/approvals/pending-count')).data.returned_to_me, 1);
  assert.deepEqual((await sub.get('/approvals?returned=1')).data.requests.map(x => x.id), [id]);
  await pool.query(`UPDATE edit_requests SET status='withdrawn' WHERE id=$1`, [id]);
  await pool.query(`DELETE FROM notifications WHERE type='request_returned'`);
});

test('on leave but the window has passed, or no substitute → falls back to the author', { skip }, async () => {
  const lead = await as('lead_hr');
  // leave window entirely in the past: on_leave true but today is outside [from, to] → author
  await setLeave(ids.member_hr, { on_leave: true, substitute_user_id: ids.sub_hr, leave_from: '2000-01-01', leave_to: '2000-01-31' });
  const id1 = await request('D4');
  const r1 = await lead.post(`/approvals/${id1}/reject`, { reason: 'outside the leave window' });
  assert.deepEqual([r1.data.substitute, r1.data.returned_to], [false, ids.member_hr]);
  // on leave with no substitute → author
  await setLeave(ids.member_hr, { on_leave: true, substitute_user_id: null, leave_from: null, leave_to: null });
  const id2 = await request('D5');
  const r2 = await lead.post(`/approvals/${id2}/reject`, { reason: 'no substitute set' });
  assert.deepEqual([r2.data.substitute, r2.data.returned_to], [false, ids.member_hr]);
  await pool.query(`UPDATE edit_requests SET status='withdrawn' WHERE id = ANY($1)`, [[id1, id2]]);
  await setLeave(ids.member_hr, { on_leave: false });
});

test('only returned_to (or the author) may resubmit or withdraw a returned request', { skip }, async () => {
  const lead = await as('lead_hr');
  await setLeave(ids.member_hr, { on_leave: true, substitute_user_id: ids.sub_hr });
  const id = await request('D6');
  await lead.post(`/approvals/${id}/reject`, { reason: 'routed to the stand-in' });
  assert.equal((await st(id)).returned_to, ids.sub_hr);
  // another member (neither author nor substitute) is refused
  const other = await as('other_hr');
  assert.equal((await other.post(`/approvals/${id}/resubmit`)).status, 403);
  assert.equal((await other.post(`/approvals/${id}/withdraw`)).status, 403);
  // the lead cannot resubmit it either
  assert.equal((await lead.post(`/approvals/${id}/resubmit`)).status, 403);
  // the substitute resubmits → back to pending, re-entering the approval flow
  const sub = await as('sub_hr');
  assert.equal((await sub.post(`/approvals/${id}/resubmit`)).data.status, 'pending');
  const back = await st(id);
  assert.equal(back.status, 'pending');
  assert.equal(back.returned_to, null); assert.equal(back.returned_reason, null);
  assert.equal((await lead.get('/approvals/pending-count')).data.awaiting_me, 1);     // back in the queue
  // return it again, then the substitute withdraws it
  await lead.post(`/approvals/${id}/reject`, { reason: 'still not right' });
  assert.equal((await sub.post(`/approvals/${id}/withdraw`)).status, 200);
  assert.equal((await st(id)).status, 'withdrawn');
  await setLeave(ids.member_hr, { on_leave: false });
});

test('resubmit re-checks the author: a no-longer-permitted change cannot be resubmitted', { skip }, async () => {
  const lead = await as('lead_hr');
  const id = await request('D7');
  await lead.post(`/approvals/${id}/reject`, { reason: 'please re-check' });
  // the author loses the progress permission while the request is returned
  await pool.query(`INSERT INTO user_permissions(user_id, permission, granted) VALUES ($1,'pct',false)
    ON CONFLICT (user_id, permission) DO UPDATE SET granted=false`, [ids.member_hr]);
  const mh = await as('member_hr');
  const r = await mh.post(`/approvals/${id}/resubmit`);
  assert.equal(r.status, 409); assert.equal(r.data.error, 'requester_not_allowed');
  assert.equal((await st(id)).status, 'returned');     // stays returned, not pending
  await pool.query(`DELETE FROM user_permissions WHERE user_id=$1 AND permission='pct'`, [ids.member_hr]);
  await pool.query(`UPDATE edit_requests SET status='withdrawn' WHERE id=$1`, [id]);
});

test('setting on_leave / substitute is administrators only, and the substitute must be valid', { skip }, async () => {
  // a team lead (not an admin) cannot reach the user editor at all
  const lead = await as('lead_hr');
  assert.equal((await lead.patch('/users/' + ids.member_hr, { on_leave: true })).status, 403);
  const root = await as('root');
  // a user cannot be their own substitute, and an unknown id is refused
  assert.equal((await root.patch('/users/' + ids.member_hr, { substitute_user_id: ids.member_hr })).data.error, 'invalid_substitute');
  assert.equal((await root.patch('/users/' + ids.member_hr, { substitute_user_id: 9999999 })).data.error, 'invalid_substitute');
  // a valid admin change persists and is read back
  assert.equal((await root.patch('/users/' + ids.member_hr, { on_leave: true, substitute_user_id: ids.sub_hr, leave_from: '2026-01-01', leave_to: '2026-12-31' })).status, 200);
  const u = (await root.get('/users/' + ids.member_hr)).data.user;
  assert.equal(u.on_leave, true); assert.equal(u.substitute_user_id, ids.sub_hr); assert.equal(u.substitute_name, 'Full sub_hr');
  await root.patch('/users/' + ids.member_hr, { on_leave: false, substitute_user_id: null, leave_from: null, leave_to: null });
});

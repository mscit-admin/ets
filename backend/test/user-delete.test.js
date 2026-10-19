// Deleting users (1.7.0, migration 015): a soft delete that keeps the history. Only administrators; never oneself,
// never the last administrator; a reason of 3–500 characters; bulk = all or nothing. A deleted user cannot sign in,
// loses every session and live stream, disappears from the list / export / import check, keeps their name in the
// history; their pending requests are closed with an audit row; the username can be reused; the account can be
// restored with a new temporary password while its username is free. Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool, live, verifyAll;
const ids = {};

// [username, role, scopes ([kind, ref])]
const USERS = [
  ['root', 'admin'], ['root2', 'admin'], ['pmu', 'pm'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['member_hr', 'member', [['department', 'hr']]],
  ['salem', 'member', [['department', 'hr']]],
  ['bulk1', 'obs'], ['bulk2', 'obs'], ['bulk3', 'obs'],
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
    const id = (await pool.query(`INSERT INTO users(username,full_name,email,password_hash,role_id,must_change_password)
      VALUES ($1,$2,$3,$4,$5,false) RETURNING id`, [u, 'Full ' + u, u + '@example.ly', h, role])).rows[0].id;
    ids[u] = id;
    for (const [k, r] of scopes) await pool.query('INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,$2,$3)', [id, k, r]);
  }
  ({ verifyAll } = await import('../src/services/logchain.js'));
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
  return {
    get cookie() { return cookie; },
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p, b) => call('DELETE', p, b),
    login: (u, pw = PW) => call('POST', '/auth/login', { username: u, password: pw }),
  };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const REASON = 'left the project';

// Minimal SSE reader: resolves true when the stream ends (closed by the server).
async function openStream(c) {
  const ac = new AbortController();
  const res = await fetch(base + '/events', { headers: { cookie: c.cookie, accept: 'text/event-stream' }, signal: ac.signal });
  assert.equal(res.status, 200);
  const s = { raw: '', ended: false };
  s.done = (async () => {
    const dec = new TextDecoder();
    try { for await (const chunk of res.body) s.raw += dec.decode(chunk, { stream: true }); } catch { /* aborted */ }
    s.ended = true;
  })();
  s.close = () => ac.abort();
  s.waitEnd = async ms => { const t0 = Date.now(); while (!s.ended && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50)); return s.ended; };
  s.waitFor = async (text, ms) => { const t0 = Date.now(); while (!s.raw.includes(text) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50)); return s.raw.includes(text); };
  return s;
}

test('only administrators delete users (403 for anyone else)', { skip }, async () => {
  for (const u of ['pmu', 'lead_hr', 'member_hr']) {
    const c = await as(u);
    assert.equal((await c.del('/users/' + ids.bulk1, { reason: REASON })).status, 403, u);
    assert.equal((await c.post('/users/bulk-delete', { ids: [ids.bulk1], reason: REASON })).status, 403, u);
    assert.equal((await c.post(`/users/${ids.bulk1}/restore`, { reason: REASON })).status, 403, u);
    assert.equal((await c.get('/users?deleted=1')).status, 403, u);
  }
  assert.equal((await client().del('/users/' + ids.bulk1, { reason: REASON })).status, 401);
  assert.equal((await one('SELECT deleted_at FROM users WHERE id=$1', [ids.bulk1])).deleted_at, null);
});

test('a reason of 3–500 characters is required (400)', { skip }, async () => {
  const root = await as('root');
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'ab' }, { reason: ' a b ' }, { reason: 42 }, { reason: null }]) {
    const r = await root.del('/users/' + ids.bulk1, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error, 'delete_reason_required');
    assert.equal(r.data.min, 3);
  }
  const long = await root.del('/users/' + ids.bulk1, { reason: 'x'.repeat(501) });
  assert.equal(long.status, 400);
  assert.equal(long.data.error, 'delete_reason_too_long');
  const b = await root.post('/users/bulk-delete', { ids: [ids.bulk1, ids.bulk2], reason: 'no' });
  assert.equal(b.status, 400);
  assert.equal(b.data.error, 'delete_reason_required');
  for (const bad of [[], ['1'], [0], [ids.bulk1, ids.bulk1], 'x', Array.from({ length: 201 }, (_, i) => i + 1)]) {
    assert.equal((await root.post('/users/bulk-delete', { ids: bad, reason: REASON })).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await one('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NOT NULL')).n, 0);
});

test('nobody deletes themselves; the last administrator is never deleted', { skip }, async () => {
  const root = await as('root');
  const self = await root.del('/users/' + ids.root, { reason: REASON });
  assert.equal(self.status, 400);
  assert.equal(self.data.error, 'cannot_delete_self');
  const selfBulk = await root.post('/users/bulk-delete', { ids: [ids.bulk1, ids.root], reason: REASON });
  assert.equal(selfBulk.status, 400);
  assert.equal(selfBulk.data.error, 'bulk_delete_refused');
  assert.deepEqual(selfBulk.data.errors.map(e => [e.id, e.error]), [[ids.root, 'cannot_delete_self']]);

  // root2 is the only other admin: make root no longer an effective admin (override revokes 'cfg') →
  // root2 is the last effective admin and cannot be deleted, even by root (who still holds usr + admin role)
  await pool.query(`INSERT INTO user_permissions(user_id, permission, granted) VALUES ($1,'cfg',false)`, [ids.root]);
  try {
    const last = await root.del('/users/' + ids.root2, { reason: REASON });
    assert.equal(last.status, 400);
    assert.equal(last.data.error, 'last_admin');
    const lastBulk = await root.post('/users/bulk-delete', { ids: [ids.bulk1, ids.root2], reason: REASON });
    assert.equal(lastBulk.data.error, 'bulk_delete_refused');
    assert.deepEqual(lastBulk.data.errors.map(e => [e.id, e.error]), [[ids.root2, 'last_admin']]);
  } finally {
    await pool.query(`DELETE FROM user_permissions WHERE user_id=$1`, [ids.root]);
  }
  assert.equal((await one('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NOT NULL')).n, 0);
  assert.equal((await root.del('/users/2000000000', { reason: REASON })).status, 404);
  assert.equal((await root.del('/users/abc', { reason: REASON })).status, 400);
});

test('single delete: login refused, sessions and live stream end, hidden, history intact, audited, chain verified', { skip }, async () => {
  const root = await as('root');
  const salem = await as('salem');
  const second = await as('salem');                   // two sessions
  const stream = await openStream(salem);
  assert.ok(await stream.waitFor('event: ready', 3000));
  // history written by salem: a direct function change (as a team member it waits for the lead → a request)
  // and an applied value carrying salem as updated_by
  const f = await one(`SELECT id FROM functions WHERE app_id IN (SELECT id FROM applications WHERE department_id='hr') AND enabled ORDER BY id LIMIT 1`);
  await pool.query('UPDATE functions SET updated_by=$2, disabled_by=$2 WHERE id=$1', [f.id, ids.salem]);
  const auditBefore = (await one('SELECT count(*)::int AS n FROM audit_log WHERE user_id=$1', [ids.salem])).n;

  const r = await root.del('/users/' + ids.salem, { reason: '  ' + REASON + '  ' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.deleted, [{ id: ids.salem, username: 'salem' }]);

  const row = await one('SELECT * FROM users WHERE id=$1', [ids.salem]);
  assert.ok(row.deleted_at);
  assert.equal(row.deleted_by, ids.root);
  assert.equal(row.delete_reason, REASON);
  assert.equal(row.full_name, 'Full salem');                     // the row and its name stay
  assert.equal(row.totp_enabled, false);
  // sessions: every one revoked, and the open requests of these sessions now fail
  assert.equal((await one(`SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`, [ids.salem])).n, 0);
  assert.equal((await one(`SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoke_reason='user_deleted'`, [ids.salem])).n, 2);
  assert.equal((await salem.get('/tracker/summary')).status, 401);
  assert.equal((await second.get('/auth/me')).data.authenticated, false);
  assert.ok(await stream.waitEnd(4000), 'live stream closed');
  assert.ok(stream.raw.includes('session_ended'));
  // sign-in refused with the generic answer, whatever the password
  const login = await client().login('salem');
  assert.equal(login.status, 401);
  assert.equal(login.data.error, 'invalid_credentials');
  // hidden from the list, the detail and the actions; listed among the deleted users
  const list = (await root.get('/users')).data.users;
  assert.ok(!list.some(u => u.id === ids.salem));
  assert.equal((await root.get('/users/' + ids.salem)).status, 404);
  assert.equal((await root.patch('/users/' + ids.salem, { full_name: 'x' })).status, 404);
  assert.equal((await root.post(`/users/${ids.salem}/reset-password`, { password: 'Another-Passw0rd-1' })).status, 404);
  const deleted = (await root.get('/users?deleted=1')).data.users;
  const d = deleted.find(u => u.id === ids.salem);
  assert.equal(d.delete_reason, REASON);
  assert.equal(d.deleted_by_name, 'Full root');
  assert.equal(d.username_taken, false);
  // deleting again: already deleted
  const again = await root.del('/users/' + ids.salem, { reason: REASON });
  assert.equal(again.status, 400);
  assert.equal(again.data.error, 'already_deleted');
  // history: names still resolve
  const fr = await one(`SELECT u.full_name FROM functions f JOIN users u ON u.id=f.updated_by WHERE f.id=$1`, [f.id]);
  assert.equal(fr.full_name, 'Full salem');
  assert.ok((await one('SELECT count(*)::int AS n FROM audit_log WHERE user_id=$1', [ids.salem])).n >= auditBefore);
  // the audit row, strict, in the administrator's name
  const au = await one(`SELECT * FROM audit_log WHERE action='delete' AND entity='user' AND entity_id=$1`, [String(ids.salem)]);
  assert.equal(au.user_id, ids.root);
  assert.equal(au.summary, 'salem');
  assert.equal(au.context.reason, REASON);
  assert.equal(au.context.target.full_name, 'Full salem');
  assert.equal(au.context.sessions_revoked, 2);
  assert.deepEqual(au.old_value.scopes, [{ kind: 'department', ref_id: 'hr' }]);
  const auth = await one(`SELECT * FROM auth_log WHERE event='user_deleted_by_admin' AND user_id=$1`, [ids.salem]);
  assert.equal(auth.detail.by, 'root');
  // the audit log view shows the deleted author's rows with the marker flag
  const logs = (await root.get('/logs/audit?limit=200')).data.rows;
  assert.ok(logs.filter(x => x.user_id === ids.salem).every(x => x.user_deleted === true));
  assert.ok(logs.filter(x => x.user_id === ids.root).every(x => x.user_deleted === false));
  // the users export leaves the deleted user out; ?deleted=1 lists them
  const wb = async q => { const x = await root.get('/export/users.xlsx' + q); assert.equal(x.status, 200); const w = new ExcelJS.Workbook(); await w.xlsx.load(x.data); return JSON.stringify(w.worksheets[0].getSheetValues()); };
  assert.ok(!(await wb('?lang=en')).includes('"salem"'));
  const dx = await wb('?lang=en&deleted=1');
  assert.ok(dx.includes('"salem"') && dx.includes(REASON));
  // the hash chains are intact (the deletion only appended rows)
  const v = await verifyAll();
  assert.equal(v.ok, true, JSON.stringify(v.tables.map(t => t.breaks)));
});

test('a session of a deleted user is refused on every path (2FA step, re-authentication, API), even if not revoked', { skip }, async () => {
  const { sha256 } = await import('../src/services/crypto.js');
  // sessions written straight into the table after the deletion (as if one had survived): pending 2FA and full
  const call = async (token, method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie: 'ets_sid=' + token },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  for (const [token, mfa, stage] of [['partial-' + Date.now(), false, 'verify'], ['full-' + Date.now(), true, null]]) {
    await pool.query(`INSERT INTO sessions(id, user_id, mfa_passed, mfa_stage, expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 hour')`,
      [sha256(token), ids.salem, mfa, stage]);
    assert.equal((await call(token, 'GET', '/auth/me')).data.authenticated, false);
    assert.equal((await call(token, 'POST', '/auth/2fa/verify', { code: '123456' })).status, 401);
    assert.equal((await call(token, 'POST', '/auth/2fa/setup', { password: PW })).status, 401);
    assert.equal((await call(token, 'POST', '/auth/change-password', { current_password: PW, new_password: 'Brand-New-Passw0rd-9' })).status, 401);
    assert.equal((await call(token, 'POST', '/auth/2fa/disable', { password: PW, code: '123456' })).status, 401);
    assert.equal((await call(token, 'GET', '/tracker/summary')).status, 401);
  }
  // the old password still in the row never signs in
  assert.equal((await client().login('salem')).data.error, 'invalid_credentials');
});

test('pending requests and import files of a deleted user are closed with an audit row', { skip }, async () => {
  const root = await as('root');
  const member = await as('member_hr');
  const f = await one(`SELECT f.id, f.progress FROM functions f JOIN applications a ON a.id=f.app_id
    WHERE a.department_id='hr' AND f.enabled AND f.removed_at IS NULL ORDER BY f.id DESC LIMIT 1`);
  const r = await member.patch('/tracker/functions/' + f.id, { progress: Number(f.progress) === 40 ? 41 : 40 });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const rqId = r.data.request_id;
  const app = await one(`SELECT id FROM applications WHERE department_id='hr' ORDER BY sort LIMIT 1`);
  const batch = (await pool.query(`INSERT INTO import_batches(target, department_id, departments, filename, status, change_count, uploaded_by)
    VALUES ('department','hr','{hr}','hr.json','pending',1,$1) RETURNING id`, [ids.member_hr])).rows[0].id;
  await pool.query(`INSERT INTO import_changes(batch_id, kind, app_id, field, old_value, new_value) VALUES ($1,'weight',$2,'weight','1','2')`, [batch, app.id]);
  const lead = await as('lead_hr');
  assert.ok((await lead.get('/approvals?status=pending')).data.requests.some(x => x.id === rqId));

  const d = await root.del('/users/' + ids.member_hr, { reason: REASON });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(d.data.requests_withdrawn, 1);
  assert.equal(d.data.imports_rejected, 1);
  const rq = await one('SELECT * FROM edit_requests WHERE id=$1', [rqId]);
  assert.equal(rq.status, 'withdrawn');
  assert.equal(rq.decided_by, ids.root);
  assert.match(rq.reason, /^user deleted: /);
  const b = await one('SELECT * FROM import_batches WHERE id=$1', [batch]);
  assert.equal(b.status, 'rejected');
  assert.equal(b.rejected_by, ids.root);
  // nothing left waiting for the lead; the approvals screen still names the (deleted) author
  assert.ok(!(await lead.get('/approvals?status=pending')).data.requests.some(x => x.id === rqId));
  const hist = (await lead.get('/approvals')).data.requests.find(x => x.id === rqId);
  assert.equal(hist.requested_by_name, 'Full member_hr');
  // one audit row each, with the request's items and the author
  const a1 = await one(`SELECT * FROM audit_log WHERE action='edit_withdraw' AND entity_id=$1`, [String(rqId)]);
  assert.equal(a1.context.user_deleted, true);
  assert.equal(a1.context.requested_by.username, 'member_hr');
  assert.equal(a1.context.items.length, 1);
  const a2 = await one(`SELECT * FROM audit_log WHERE action='import_reject' AND entity_id=$1`, [String(batch)]);
  assert.equal(a2.context.user_deleted, true);
  assert.equal(a2.context.uploaded_by.username, 'member_hr');
  const del = await one(`SELECT * FROM audit_log WHERE action='delete' AND entity_id=$1`, [String(ids.member_hr)]);
  assert.deepEqual(del.context.requests_withdrawn, [rqId]);
  assert.deepEqual(del.context.imports_rejected, [batch]);
});

test('bulk delete is all or nothing, with the reason of each refused id', { skip }, async () => {
  const root = await as('root');
  const before = (await one('SELECT count(*)::int AS n FROM audit_log')).n;
  const bad = await root.post('/users/bulk-delete', { ids: [ids.bulk1, ids.bulk2, ids.salem, 1999999999, ids.root], reason: REASON });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'bulk_delete_refused');
  assert.deepEqual(bad.data.errors.map(e => [e.id, e.error]),
    [[ids.salem, 'already_deleted'], [1999999999, 'not_found'], [ids.root, 'cannot_delete_self']]);
  assert.equal((await one('SELECT count(*)::int AS n FROM users WHERE id = ANY($1) AND deleted_at IS NOT NULL', [[ids.bulk1, ids.bulk2]])).n, 0);
  assert.equal((await one('SELECT count(*)::int AS n FROM audit_log')).n, before, 'nothing written');

  const b1 = await as('bulk1');
  const ok = await root.post('/users/bulk-delete', { ids: [ids.bulk1, ids.bulk2], reason: REASON });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.deleted.map(x => x.username), ['bulk1', 'bulk2']);
  assert.equal((await b1.get('/auth/me')).data.authenticated, false);
  const rows = (await pool.query(`SELECT action, entity_id, context FROM audit_log WHERE action IN ('delete','bulk_delete') AND id > (
    SELECT max(id) FROM audit_log WHERE action='delete' AND entity_id=$1) ORDER BY id`, [String(ids.member_hr)])).rows;
  assert.deepEqual(rows.map(x => [x.action, x.entity_id]), [['delete', String(ids.bulk1)], ['delete', String(ids.bulk2)], ['bulk_delete', null]]);
  assert.equal(rows[0].context.bulk, true);
  assert.deepEqual(rows[2].context.users.map(u => u.username), ['bulk1', 'bulk2']);
  for (const u of ['bulk1', 'bulk2']) assert.equal((await client().login(u)).status, 401);
  assert.equal((await verifyAll()).ok, true);
});

test('the username (and e-mail) of a deleted user can be used again; restore needs them free', { skip }, async () => {
  const root = await as('root');
  // bulk import: the deleted name is not "taken"
  const pv = await root.post('/users/import/preview', { rows: [{ username: 'bulk2', full_name: 'New Bulk Two', role: 'pm' }] });
  assert.equal(pv.data.ok, 1, JSON.stringify(pv.data));
  // a new account with the same username (other case too: citext) and e-mail
  const c = await root.post('/users', { username: 'SALEM', full_name: 'Salem the second', email: 'salem@example.ly', role_id: 'obs',
    password: 'New-Passw0rd-2026', must_change_password: false });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const newId = c.data.user.id;
  assert.notEqual(newId, ids.salem);
  // the new account signs in; the deleted one stays deleted
  assert.equal((await client().login('salem', 'New-Passw0rd-2026')).data.stage, 'done');
  assert.equal((await client().login('salem', PW)).status, 401);
  // a second live account with that name is still refused
  const dup = await root.post('/users', { username: 'salem', full_name: 'x', role_id: 'obs', password: 'New-Passw0rd-2026' });
  assert.equal(dup.data.error, 'username_taken');
  // restore refused while the name is taken (409), allowed once the new account is gone
  const listed = (await root.get('/users?deleted=1')).data.users.find(u => u.id === ids.salem);
  assert.equal(listed.username_taken, true);
  const r409 = await root.post(`/users/${ids.salem}/restore`, { reason: 'came back' });
  assert.equal(r409.status, 409);
  assert.equal(r409.data.error, 'username_taken');
  assert.equal((await root.del('/users/' + newId, { reason: 'test account' })).status, 200);
  assert.equal((await root.post(`/users/${ids.salem}/restore`, { reason: 'x' })).status, 400);       // reason required
  const ok = await root.post(`/users/${ids.salem}/restore`, { reason: 'came back' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.user.must_change_password, true);
  assert.equal(typeof ok.data.temporary_password, 'string');
  assert.ok(ok.data.temporary_password.length >= 16);
  assert.equal((await root.post(`/users/${ids.salem}/restore`, { reason: 'came back' })).data.error, 'not_deleted');
  // scopes came back with the account; the old password no longer works; the temporary one does (change required)
  assert.deepEqual((await root.get('/users/' + ids.salem)).data.user.scopes, [{ kind: 'department', ref_id: 'hr' }]);
  assert.equal((await client().login('salem', PW)).status, 401);
  const s = client();
  assert.equal((await s.login('salem', ok.data.temporary_password)).data.stage, 'done');
  assert.equal((await s.get('/tracker/summary')).data.error, 'password_change_required');
  assert.ok((await root.get('/users')).data.users.some(u => u.id === ids.salem));
  const au = await one(`SELECT * FROM audit_log WHERE action='restore' AND entity='user' AND entity_id=$1`, [String(ids.salem)]);
  assert.equal(au.context.reason, 'came back');
  assert.ok(!JSON.stringify(au).includes(ok.data.temporary_password), 'the temporary password is never logged');
  assert.equal((await verifyAll()).ok, true);
});

test('the unique e-mail index (migration 014) only covers accounts that are not deleted, also when rebuilt later', { skip }, async () => {
  const idx = async c => (await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname='users_email_lower_uniq'`)).rows[0]?.indexdef;
  const root = await as('root');
  // a deleted account keeps its address; a new account may take it (bulk1 was deleted above)
  const nb = await root.post('/users', { username: 'bulk1new', full_name: 'Bulk One New', email: 'BULK1@example.ly', role_id: 'pm',
    password: 'New-Passw0rd-2026', must_change_password: false });
  assert.equal(nb.status, 201, JSON.stringify(nb.data));
  assert.equal((await client().login('bulk1@example.ly', 'New-Passw0rd-2026')).data.stage, 'done');      // sign-in by e-mail
  assert.equal((await client().login('bulk1@example.ly', PW)).status, 401);                              // never the deleted one
  // a second live account with that address is refused; restoring the deleted owner is refused (409)
  assert.equal((await root.post('/users', { username: 'other1', full_name: 'x', email: 'bulk1@example.ly', role_id: 'pm',
    password: 'New-Passw0rd-2026' })).data.error, 'email_taken');
  const r409 = await root.post(`/users/${ids.bulk1}/restore`, { reason: 'came back' });
  assert.equal(r409.status, 409);
  assert.equal(r409.data.error, 'email_taken');
  assert.equal((await root.get('/users?deleted=1')).data.users.find(u => u.id === ids.bulk1).email_taken, true);

  const c = await pool.connect();
  try {
    assert.match(await idx(c), /WHERE \(\(email IS NOT NULL\) AND \(email <> ''::citext\) AND \(deleted_at IS NULL\)\)/);
    assert.match((await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname='users_username_live_key'`)).rows[0].indexdef, /WHERE \(deleted_at IS NULL\)/);
    await c.query('BEGIN');
    // the 1.6.0 shape (built by 014 before 015): rebuilt with the deleted_at condition by the function migrate.js calls
    await c.query('DROP INDEX users_email_lower_uniq');
    await c.query(`UPDATE users SET email=NULL WHERE deleted_at IS NOT NULL`);
    await c.query(`CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email::text)) WHERE email IS NOT NULL AND email <> ''`);
    assert.equal((await c.query('SELECT ets_ensure_email_unique_index() AS ok')).rows[0].ok, true);
    assert.match(await idx(c), /AND \(deleted_at IS NULL\)\)$/);
    const def = await idx(c);
    assert.equal((await c.query('SELECT ets_ensure_email_unique_index() AS ok')).rows[0].ok, true);     // already right: unchanged
    assert.equal(await idx(c), def);
    // index missing (skipped for duplicates): a duplicate held only by a deleted account does not block it
    await c.query('DROP INDEX users_email_lower_uniq');
    await c.query(`UPDATE users SET email='dup@example.ly' WHERE id IN ($1, $2)`, [ids.bulk2, ids.bulk3]);   // bulk2 is deleted
    assert.equal((await c.query('SELECT ets_ensure_email_unique_index() AS ok')).rows[0].ok, true);
    assert.equal(await idx(c), def);
    // the migration file itself is re-runnable
    const fs = await import('node:fs');
    await c.query(fs.readFileSync(new URL('../src/db/migrations/015_user_delete.sql', import.meta.url), 'utf8'));
    assert.equal(await idx(c), def);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

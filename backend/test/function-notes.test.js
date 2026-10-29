// Notes history (migration 031): an append-only log of a function / report item's notes, replacing the single
// overwritten functions.note. Adding a note appends to the history (old notes are never overwritten); the author
// toggles `done`; the team lead (apv_dept scoped to the item's application) approves («معتمدة للعمل») / rejects
// («مرفوضة»); a non-lead cannot decide (403); deletion needs the team lead's approval (a member's request does NOT
// remove the note, and after approval it is hidden but still in the database); scope is enforced on every route;
// the "with-notes status requires a note" rule still holds; and functions.note stays the latest active note.
// Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool;
const ids = {};

// [username, role, scopes ([kind, ref])]
const USERS = [
  ['root', 'admin'],
  ['lead_hr', 'lead', [['department', 'hr']]],       // team lead of HR (apv_dept + scope)
  ['member_hr', 'member', [['department', 'hr']]],   // author (tst, no apv_dept)
  ['member2_hr', 'member', [['department', 'hr']]],  // another HR member
  ['member_fin', 'member', [['department', 'fin']]], // out of scope for HR notes
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
  // a team lead does not need approval, so their edits apply directly — keep the setting on (the default) to exercise it
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword(PW);
  for (const [u, role, scopes = []] of USERS) {
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password)
      VALUES ($1,$2,$3,$4,false) RETURNING id`, [u, 'Full ' + u, h, role])).rows[0].id;
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
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
// a brand-new HR ('ess') function for each test, so the tests are fully independent (no shared note state)
let seq = 0;
const freshFn = async () => (await one(
  `INSERT INTO functions(app_id, code, source, name_ar) VALUES ('ess', $1, 'custom', 'بند اختبار') RETURNING id`,
  [`NT${++seq}`])).id;
const noteText = async id => (await one('SELECT note FROM functions WHERE id=$1', [id])).note;

test('adding notes appends to history; old notes are NOT overwritten; functions.note is the latest active note', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  const a = await member.post(`/tracker/functions/${fn}/notes`, { body: 'أول ملاحظة' });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await member.post(`/tracker/functions/${fn}/notes`, { body: 'ملاحظة ثانية' });
  assert.equal(b.status, 201);
  const hist = await member.get(`/tracker/functions/${fn}/notes`);
  assert.equal(hist.status, 200);
  const bodies = hist.data.notes.map(n => n.body);
  // both notes are kept, oldest first — the first is not overwritten
  assert.deepEqual(bodies, ['أول ملاحظة', 'ملاحظة ثانية']);
  // functions.note mirrors the latest active note
  assert.equal(await noteText(fn), 'ملاحظة ثانية');
  assert.equal((await one('SELECT count(*)::int n FROM function_notes WHERE function_id=$1', [fn])).n, 2);
});

test('the author toggles done on their own note; a non-author cannot', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  const created = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'ملاحظة للإنهاء' })).data.note;
  const toggled = await member.patch(`/tracker/notes/${created.id}`, { done: true });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.note.done, true);
  // another member cannot toggle someone else's note
  const other = await as('member2_hr');
  const bad = await other.patch(`/tracker/notes/${created.id}`, { done: false });
  assert.equal(bad.status, 403);
  assert.equal((await one('SELECT done FROM function_notes WHERE id=$1', [created.id])).done, true);
});

test('the team lead approves / rejects; a non-lead cannot set a decision (403)', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  const n1 = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'للاعتماد' })).data.note;
  const n2 = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'للرفض' })).data.note;
  // a member cannot decide
  const denied = await member.patch(`/tracker/notes/${n2.id}`, { decision: 'approved' });
  assert.equal(denied.status, 403);
  const lead = await as('lead_hr');
  assert.equal((await lead.patch(`/tracker/notes/${n1.id}`, { decision: 'approved' })).status, 200);
  assert.equal((await lead.patch(`/tracker/notes/${n2.id}`, { decision: 'rejected' })).status, 200);
  const row1 = await one('SELECT decision, decided_by FROM function_notes WHERE id=$1', [n1.id]);
  assert.equal(row1.decision, 'approved');
  assert.equal(row1.decided_by, ids.lead_hr);
  assert.equal((await one('SELECT decision FROM function_notes WHERE id=$1', [n2.id])).decision, 'rejected');
  // a rejected note is no longer active: functions.note falls back to the latest active (the approved one)
  assert.equal(await noteText(fn), 'للاعتماد');
});

test('a rejected note may be replaced by a follow-up note (the chain)', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  const lead = await as('lead_hr');
  const bad = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'مسودة' })).data.note;
  await lead.patch(`/tracker/notes/${bad.id}`, { decision: 'rejected' });
  // replacing a note that is not rejected is refused
  const good = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'نسخة أخرى' })).data.note;
  assert.equal((await member.post(`/tracker/functions/${fn}/notes`, { body: 'x', replaces: good.id })).status, 400);
  // a valid follow-up of the rejected note
  const follow = await member.post(`/tracker/functions/${fn}/notes`, { body: 'المعالجة النهائية', replaces: bad.id });
  assert.equal(follow.status, 201);
  assert.equal(follow.data.note.replaces, bad.id);
});

test('deletion requires team lead approval: a member request does NOT remove the note; after approval it is hidden but kept', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  const n = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'للحذف' })).data.note;
  assert.equal(await noteText(fn), 'للحذف');
  // a member requests deletion — nothing is hidden yet
  const req = await member.patch(`/tracker/notes/${n.id}`, { request_delete: true });
  assert.equal(req.status, 200);
  let row = await one('SELECT delete_requested_by, deleted_at FROM function_notes WHERE id=$1', [n.id]);
  assert.equal(row.delete_requested_by, ids.member_hr);
  assert.equal(row.deleted_at, null);                 // still present, still the active note
  assert.equal(await noteText(fn), 'للحذف');
  // a member cannot approve the deletion
  assert.equal((await member.patch(`/tracker/notes/${n.id}`, { approve_delete: true })).status, 403);
  // the team lead approves — the note is hidden but the row survives in the database
  const lead = await as('lead_hr');
  assert.equal((await lead.patch(`/tracker/notes/${n.id}`, { approve_delete: true })).status, 200);
  row = await one('SELECT deleted_by, deleted_at, body FROM function_notes WHERE id=$1', [n.id]);
  assert.equal(row.deleted_by, ids.lead_hr);
  assert.ok(row.deleted_at);
  assert.equal(row.body, 'للحذف');                    // never hard-deleted (the audit trail survives)
  assert.equal(await noteText(fn), '');               // no other active note left
  // the note is still returned by the history (with its deletion state), so the audit stays visible
  const hist = await lead.get(`/tracker/functions/${fn}/notes`);
  assert.ok(hist.data.notes.some(x => x.id === n.id && x.deleted_at));
});

test('scope is enforced: a user cannot read or act on another department\'s function notes', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  const n = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'خاصّ بالموارد البشرية' })).data.note;
  const outsider = await as('member_fin');            // scoped to finance only
  assert.equal((await outsider.get(`/tracker/functions/${fn}/notes`)).status, 403);
  assert.equal((await outsider.post(`/tracker/functions/${fn}/notes`, { body: 'تسلل' })).status, 403);
  assert.equal((await outsider.patch(`/tracker/notes/${n.id}`, { request_delete: true })).status, 403);
});

test('the "with-notes status requires a note" rule still holds, and writing the note syncs functions.note and the history', { skip }, async () => {
  const fn = await freshFn();
  const lead = await as('lead_hr');                   // a lead applies directly (no approval queue)
  // «نجح مع ملاحظة» (test_status 1) without a note is refused
  const bad = await lead.patch(`/tracker/functions/${fn}`, { test_status: 1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'note_required');
  // the same status with a note is accepted, functions.note is set, and the note is appended to the history
  const ok = await lead.patch(`/tracker/functions/${fn}`, { test_status: 1, note: 'ملاحظة مع الحالة' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(await noteText(fn), 'ملاحظة مع الحالة');
  const hist = await lead.get(`/tracker/functions/${fn}/notes`);
  assert.ok(hist.data.notes.some(x => x.body === 'ملاحظة مع الحالة'));
});

test('an empty note body is refused', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  assert.equal((await member.post(`/tracker/functions/${fn}/notes`, { body: '   ' })).status, 400);
});

// functions.note active-note sync invariant (review A2 / DB-1). functions.note is a DENORMALIZED copy of the item's
// "current active note", kept in step with the function_notes history ONLY by application code (services/notes.js:
// syncFunctionNote / recordNoteHistory). There is NO DB trigger or constraint behind it, so any write path that
// forgets to sync would leave functions.note stale — and the "a with-notes status requires a note" rule and every
// other reader of functions.note would then trust a wrong value (the deferred DB-level hardening is tracked as
// DB-2/DB-1; this test is the app-level guard until then).
//
// The invariant, stated independently of the code under test: functions.note equals the body of the most recent
// ACTIVE note — active = `deleted_at IS NULL AND decision IS DISTINCT FROM 'rejected'`, newest by (created_at, id) —
// or '' when the item has no active note. This test drives the REAL routes/service across the full note lifecycle
// (add, reject, approve, the with-notes status edit path, request + approve deletion, the rejected-note chain) and
// re-checks the invariant after every mutation, computing the expected value with its own SQL oracle (not by calling
// activeNoteText, so the oracle can't drift with the code it guards). A future regression in the sync logic fails it.
//
// Isolated database, same disposable DB as api.test.js (its public schema is DROPPED and recreated):
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// Skipped when the variable is unset.
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
  ['lead_hr', 'lead', [['department', 'hr']]],       // team lead of HR (apv_dept + scope): decides, applies directly
  ['member_hr', 'member', [['department', 'hr']]],   // author (tst, no apv_dept)
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
let seq = 0;
const freshFn = async () => (await one(
  `INSERT INTO functions(app_id, code, source, name_ar) VALUES ('ess', $1, 'custom', 'بند اختبار') RETURNING id`,
  [`AN${++seq}`])).id;

// The invariant oracle, computed straight from the active-note definition (NOT via services/notes.js), so it checks
// the code rather than restating it. Asserts functions.note === the body of the newest active note, or '' when none.
async function assertInvariant(fnId, label) {
  const row = await one(
    `SELECT f.note AS stored,
            COALESCE((SELECT n.body FROM function_notes n
                        WHERE n.function_id = f.id
                          AND n.deleted_at IS NULL AND n.decision IS DISTINCT FROM 'rejected'
                        ORDER BY n.created_at DESC, n.id DESC LIMIT 1), '') AS expected
       FROM functions f WHERE f.id = $1`, [fnId]);
  assert.equal(row.stored, row.expected, `functions.note out of sync with the active note after: ${label}`);
}

test('invariant holds across the note lifecycle (add / reject / approve / with-notes status / delete)', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  const lead = await as('lead_hr');

  // 0. a brand-new item has no note: functions.note === '' === (no active note)
  await assertInvariant(fn, 'fresh item (no notes)');

  // 1. add note A → it is the newest active note
  const a = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'ملاحظة A' })).data.note;
  await assertInvariant(fn, 'added note A');
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, 'ملاحظة A');

  // 2. add note B → newest active moves to B
  const b = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'ملاحظة B' })).data.note;
  await assertInvariant(fn, 'added note B');
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, 'ملاحظة B');

  // 3. lead REJECTS B → B is no longer active, the active note falls back to A
  assert.equal((await lead.patch(`/tracker/notes/${b.id}`, { decision: 'rejected' })).status, 200);
  await assertInvariant(fn, 'rejected note B');
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, 'ملاحظة A');

  // 4. lead APPROVES A → still active, still the current note (no change expected, but sync must keep it right)
  assert.equal((await lead.patch(`/tracker/notes/${a.id}`, { decision: 'approved' })).status, 200);
  await assertInvariant(fn, 'approved note A');

  // 5. a follow-up note C that REPLACES the rejected B → newest active becomes C
  const c = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'ملاحظة C', replaces: b.id })).data.note;
  assert.equal(c.replaces, b.id);
  await assertInvariant(fn, 'added follow-up note C (replaces rejected B)');
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, 'ملاحظة C');

  // 6. the with-notes status EDIT path (routes/tracker.js → services/edits.js) writes functions.note directly and
  //    records a history row; the newest active note must still equal functions.note
  const sv = await lead.patch(`/tracker/functions/${fn}`, { test_status: 1, note: 'ملاحظة الحالة D' });
  assert.equal(sv.status, 200, JSON.stringify(sv.data));
  await assertInvariant(fn, 'with-notes status edit (note D)');
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, 'ملاحظة الحالة D');

  // 7. member requests deletion of the current active note D, lead approves → D hidden, active falls back to C
  const dId = (await one(
    'SELECT id FROM function_notes WHERE function_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [fn])).id;
  assert.equal((await member.patch(`/tracker/notes/${dId}`, { request_delete: true })).status, 200);
  await assertInvariant(fn, 'deletion of D requested (not yet approved)');
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, 'ملاحظة الحالة D'); // still active until approved
  assert.equal((await lead.patch(`/tracker/notes/${dId}`, { approve_delete: true })).status, 200);
  await assertInvariant(fn, 'deletion of D approved');
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, 'ملاحظة C');
});

test('invariant holds when every note becomes inactive: functions.note falls back to \'\'', { skip }, async () => {
  const fn = await freshFn();
  const member = await as('member_hr');
  const lead = await as('lead_hr');
  const n1 = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'واحدة' })).data.note;
  const n2 = (await member.post(`/tracker/functions/${fn}/notes`, { body: 'اثنتان' })).data.note;
  await assertInvariant(fn, 'two notes added');
  // reject the newest, delete the remaining one → no active note left
  assert.equal((await lead.patch(`/tracker/notes/${n2.id}`, { decision: 'rejected' })).status, 200);
  await assertInvariant(fn, 'newest rejected');
  assert.equal((await member.patch(`/tracker/notes/${n1.id}`, { request_delete: true })).status, 200);
  assert.equal((await lead.patch(`/tracker/notes/${n1.id}`, { approve_delete: true })).status, 200);
  await assertInvariant(fn, 'last active note deleted');
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, '');
});

test('invariant respects the (created_at, id) tie-break when notes share a timestamp', { skip }, async () => {
  // Two active notes with the SAME created_at: the active note is the one with the greater id (the ORDER BY tie-break).
  // Insert directly so the timestamps are identical, then sync through the real service and compare to the oracle.
  const fn = await freshFn();
  const ts = (await one('SELECT now() AS t')).t;
  const lo = (await one(
    `INSERT INTO function_notes(function_id, body, author_id, created_at) VALUES ($1,'older-id',$2,$3) RETURNING id`,
    [fn, ids.member_hr, ts])).id;
  const hi = (await one(
    `INSERT INTO function_notes(function_id, body, author_id, created_at) VALUES ($1,'newer-id',$2,$3) RETURNING id`,
    [fn, ids.member_hr, ts])).id;
  assert.ok(hi > lo);
  const { syncFunctionNote } = await import('../src/services/notes.js');
  await syncFunctionNote(pool, fn, ids.member_hr);
  await assertInvariant(fn, 'tie-break on equal created_at');
  // and concretely: the greater-id row wins
  assert.equal((await one('SELECT note FROM functions WHERE id=$1', [fn])).note, 'newer-id');
});

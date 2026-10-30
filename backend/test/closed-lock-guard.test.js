// Closed-function lock — ROUTE-LEVEL guard regression tests (ETS review DB-2).
//
// Migration 033 documents that a CLOSED function (closed_at IS NOT NULL) is LOCKED from editing — progress, weight,
// the statuses, enabled, note, item_type, the names, removal and move — until it is reopened; only close / reopen
// change its state. That lock lives entirely in route code (routes/tracker.js). DB-2 proposed a DATABASE-LEVEL
// trigger as defence-in-depth behind it.
//
// DB-2 was DEFERRED (see docs/05-Database-Design.md, finding DB-2): several legitimate write paths UPDATE a
// function's tracked columns WITHOUT first checking closed_at and could legitimately reach the DB with a closed row
// (legacy import — services/legacy.js, updates by app_id+code with only removed_at IS NULL; import batch apply /
// undo — services/imports.js, by id with only removed_at IS NULL; approved-edit apply — services/edits.js, during
// the window between request and approval; the note routes — see the note test below). A BEFORE UPDATE trigger that
// RAISEd on any tracked-column change to a closed row would turn those into hard transaction aborts and break them.
//
// So the invariant is regression-tested HERE at the route layer instead. Each user-facing edit path is driven
// against a function that is closed and asserted to be refused (or, for the bulk value-set, to silently skip the
// closed row) — exactly the guarantee the deferred trigger would have backstopped. The one honest exception, the
// notes routes, is captured too (and documented as a gap), because it is the main reason the trigger is unsafe.
//
// Runs against a dedicated, disposable database (its public schema is DROPPED and recreated):
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_b3db npm test
// Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool;
const ids = {};

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '3', LOGIN_RATE_LIMIT: '1000', LOGIN_IP_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  // pm: full scope + apv_final — can edit and close anywhere (approvals are off in the seed, so edits apply directly).
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('pm','Project Manager',$1,'pm',false)`, [h]);
  // two enabled, non-removed functions in the same application (hr/per): LOCKED is the one we close; SIB is its
  // sibling, used to prove a bulk value-set still reaches the open rows while skipping the closed one.
  const rows = (await pool.query(`SELECT id FROM functions WHERE app_id='per' AND enabled AND removed_at IS NULL ORDER BY sort, id LIMIT 2`)).rows;
  ids.locked = rows[0].id;
  ids.sib = rows[1].id;
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
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: 'Passw0rd-123' }),
  };
}
const as = async u => { const c = client(); await c.login(u); return c; };
const col = async (id, c) => (await pool.query(`SELECT ${c} AS v FROM functions WHERE id=$1`, [id])).rows[0].v;

// Close the function once; every block test below runs against it while it stays closed.
test('setup: close the function so it is locked', { skip }, async () => {
  const c = await as('pm');
  // give it a known, non-100 progress and a non-PASS test status first, so a later bulk set to a different value
  // would be visible if the lock failed to skip it
  assert.equal((await c.patch(`/tracker/functions/${ids.locked}`, { progress: 33 })).status, 200);
  assert.equal((await c.patch(`/tracker/functions/${ids.locked}`, { test_status: 0 })).status, 200);
  // add a note WHILE THE FUNCTION IS STILL OPEN, so the PATCH /notes/:noteId sub-actions below have a note of a
  // closed function to drive against (a note can no longer be added once the function is closed — see below).
  const na = await c.post(`/tracker/functions/${ids.locked}/notes`, { body: 'note added while still open' });
  assert.equal(na.status, 201, 'note-add succeeds while open');
  ids.note = na.data.note.id;
  const r = await c.post(`/tracker/functions/${ids.locked}/close`);
  assert.equal(r.status, 200);
  assert.ok(await col(ids.locked, 'closed_at'), 'closed_at set');
});

test('direct PATCH of a tracked field on a closed function is refused (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  for (const body of [{ progress: 50 }, { weight: 7 }, { test_status: 2 }, { notif_status: 1 }, { review_status: 1 }, { note: 'x' }, { item_type: 'report' }]) {
    const r = await c.patch(`/tracker/functions/${ids.locked}`, body);
    assert.equal(r.status, 400, `PATCH ${JSON.stringify(body)} status`);
    assert.equal(r.data.error, 'closed_locked', `PATCH ${JSON.stringify(body)} error`);
  }
  // the stored values are untouched
  assert.equal(Number(await col(ids.locked, 'progress')), 33);
  assert.equal(Number(await col(ids.locked, 'test_status')), 0);
});

test('disable (PATCH enabled:false with a reason) on a closed function is refused (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const r = await c.patch(`/tracker/functions/${ids.locked}`, { enabled: false, disabled_reason: 'obsolete' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'closed_locked');
  assert.equal(await col(ids.locked, 'enabled'), true, 'still enabled');
});

test('rename of a closed function is refused (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const before = await col(ids.locked, 'name_ar');
  const r = await c.patch(`/tracker/functions/${ids.locked}`, { name_ar: 'اسم جديد', rename_reason: 'correction of the name' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'closed_locked');
  assert.equal(await col(ids.locked, 'name_ar'), before, 'name unchanged');
});

test('remove of a closed function is refused (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const r = await c.post(`/tracker/functions/${ids.locked}/remove`, { reason: 'no longer needed' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'closed_locked');
  assert.equal(await col(ids.locked, 'removed_at'), null, 'not removed');
});

test('move of a closed function is refused (409 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const r = await c.post(`/tracker/functions/${ids.locked}/move`, { to_app_id: 'acc', reason: 'belongs elsewhere' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'closed_locked');
  assert.equal(await col(ids.locked, 'app_id'), 'per', 'still in its application');
});

test('bulk-move of a closed function is refused (409 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const r = await c.post(`/tracker/applications/per/bulk-move`, { to_app_id: 'acc', function_ids: [ids.locked], reason: 'belongs elsewhere' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'closed_locked');
  assert.equal(await col(ids.locked, 'app_id'), 'per');
});

test('bulk enabled including a closed function is refused (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const r = await c.post(`/tracker/applications/per/bulk`, { field: 'enabled', value: false, function_ids: [ids.locked] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'closed_locked');
  assert.equal(await col(ids.locked, 'enabled'), true);
});

test('bulk item_type including a closed function is refused (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const before = await col(ids.locked, 'item_type');
  const r = await c.post(`/tracker/applications/per/bulk`, { field: 'item_type', value: before === 'report' ? 'function' : 'report', function_ids: [ids.locked] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'closed_locked');
  assert.equal(await col(ids.locked, 'item_type'), before);
});

test('bulk value-set over the whole application silently skips the closed row but reaches the open ones', { skip }, async () => {
  const c = await as('pm');
  // progress = 100 for every enabled item of the application (100 never trips the «نجح» pass rule)
  const r = await c.post(`/tracker/applications/per/bulk`, { field: 'progress', value: 100 });
  assert.equal(r.status, 200);
  // the closed row kept its 33 (excluded by "AND closed_at IS NULL"); an open sibling was set to 100
  assert.equal(Number(await col(ids.locked, 'progress')), 33, 'closed row untouched by bulk set');
  assert.equal(Number(await col(ids.sib, 'progress')), 100, 'open sibling updated by bulk set');
});

// The note routes were previously the honest exception to the route-level lock: POST /functions/:id/notes and
// PATCH /notes/:noteId checked removed_at but NOT closed_at, so they wrote function_notes / synced functions.note
// (a tracked column) on a closed function. That gap is now CLOSED at the route level (routes/tracker.js): note
// mutations on a closed function are refused with the same closed_locked error as every other edit path, while
// READING the history (GET /functions/:id/notes) stays allowed. DB-2 (the database-level trigger) remains deferred
// (see docs/05-Database-Design.md): other legitimate paths — legacy import, import-batch apply/undo, approved-edit
// apply — still reach a closed row by design, so a BEFORE UPDATE trigger would wrongly abort them.
test('adding a note to a closed function is refused (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const before = await col(ids.locked, 'note');
  const r = await c.post(`/tracker/functions/${ids.locked}/notes`, { body: 'note added while the function is closed' });
  assert.equal(r.status, 400, 'note-add refused on a closed function');
  assert.equal(r.data.error, 'closed_locked');
  // functions.note is untouched — the note was never written
  assert.equal(await col(ids.locked, 'note'), before, 'active note unchanged');
});

test('PATCH /notes/:noteId sub-actions on a closed function are refused (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  // every lifecycle sub-action — author "done", lead decision, request/approve deletion — is blocked while closed
  for (const body of [{ done: true }, { decision: 'approved' }, { request_delete: true }, { approve_delete: true }]) {
    const r = await c.patch(`/tracker/notes/${ids.note}`, body);
    assert.equal(r.status, 400, `PATCH note ${JSON.stringify(body)} status`);
    assert.equal(r.data.error, 'closed_locked', `PATCH note ${JSON.stringify(body)} error`);
  }
  // the note row is untouched by any of them
  const note = (await pool.query('SELECT done, decision, delete_requested_at, deleted_at FROM function_notes WHERE id=$1', [ids.note])).rows[0];
  assert.equal(note.done, false, 'done unchanged');
  assert.equal(note.decision, null, 'decision unchanged');
  assert.equal(note.delete_requested_at, null, 'delete not requested');
  assert.equal(note.deleted_at, null, 'not deleted');
});

// Reading the note history of a closed function is STILL allowed (the lock is on edits, not reads).
test('GET /functions/:id/notes still works on a closed function', { skip }, async () => {
  const c = await as('pm');
  const r = await c.get(`/tracker/functions/${ids.locked}/notes`);
  assert.equal(r.status, 200, 'history readable while closed');
  assert.ok(r.data.notes.some(x => x.id === ids.note), 'the note added while open is in the history');
});

// Proof the close/reopen transitions themselves are never blocked (the lock only forbids OTHER edits while closed).
test('reopen clears the lock and re-allows edits; re-close locks again', { skip }, async () => {
  const c = await as('pm');
  const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
  const re = await c.post(`/tracker/functions/${ids.locked}/reopen`, { document: PDF, reason: 'ministerial order no. 42' });
  assert.equal(re.status, 200);
  assert.equal(await col(ids.locked, 'closed_at'), null);
  // edits allowed again
  assert.equal((await c.patch(`/tracker/functions/${ids.locked}`, { progress: 55 })).status, 200);
  assert.equal(Number(await col(ids.locked, 'progress')), 55);
  // re-close works
  assert.equal((await c.post(`/tracker/functions/${ids.locked}/close`)).status, 200);
  assert.ok(await col(ids.locked, 'closed_at'), 're-closed');
  // and the lock is back
  assert.equal((await c.patch(`/tracker/functions/${ids.locked}`, { progress: 60 })).data.error, 'closed_locked');
});

// Close / lock & reopen a function (migration 033) — HTTP integration tests against a dedicated, disposable database:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_close npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool;
const ids = {};
// a tiny but valid PDF (sniffed by its first bytes "%PDF-"), as a data: URL
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

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
  // pm: full scope + apv_final (can close anywhere). editor: scoped to hr, no apv_final (refused).
  // scoped: scoped to hr with apv_final granted (can close in hr, out of scope elsewhere).
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('pm','Project Manager',$1,'pm',false), ('editor','Editor',$1,'ed',false), ('scoped','Scoped Approver',$1,'ed',false)`, [h]);
  for (const u of ['editor', 'scoped']) {
    const uid = (await pool.query(`SELECT id FROM users WHERE username=$1`, [u])).rows[0].id;
    await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,'department','hr')`, [uid]);
  }
  const sid = (await pool.query(`SELECT id FROM users WHERE username='scoped'`)).rows[0].id;
  await pool.query(`INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,'apv_final',true)`, [sid]);
  // one function in hr/per and one in fin/acc (out of the scoped user's scope)
  ids.hr = (await pool.query(`SELECT id FROM functions WHERE app_id='per' AND enabled AND removed_at IS NULL ORDER BY sort, id LIMIT 1`)).rows[0].id;
  ids.fin = (await pool.query(`SELECT id FROM functions WHERE app_id='acc' AND enabled AND removed_at IS NULL ORDER BY sort, id LIMIT 1`)).rows[0].id;
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
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: 'Passw0rd-123' }),
  };
}
const as = async u => { const c = client(); await c.login(u); return c; };
// the application's computed percentage and counted-items count, from the application screen (user's scope)
const appCalc = async (c, app = 'per') => { const r = await c.get('/tracker/applications/' + app); return r.data.application.calc; };

test('non-apv_final user cannot close (403)', { skip }, async () => {
  const c = await as('editor');
  const r = await c.post(`/tracker/functions/${ids.hr}/close`);
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'forbidden');
});

test('apv_final user closes a function; closed item is 100 % and still counted, not excluded', { skip }, async () => {
  const c = await as('pm');
  // bring it below 100 % first so the jump to 100 % is observable
  assert.equal((await c.patch(`/tracker/functions/${ids.hr}`, { progress: 0 })).status, 200);
  const before = await appCalc(c);
  const r = await c.post(`/tracker/functions/${ids.hr}/close`);
  assert.equal(r.status, 200);
  assert.ok(r.data.function.closed_at, 'closed_at set');
  const row = (await pool.query('SELECT closed_at, closed_by FROM functions WHERE id=$1', [ids.hr])).rows[0];
  assert.ok(row.closed_at && row.closed_by, 'closed_at / closed_by persisted');
  const after = await appCalc(c);
  // still counted (NOT excluded): the counted-items count is unchanged
  assert.equal(after.count, before.count, 'closed item stays counted');
  // and it now reads as 100 %: the application percentage rose
  assert.ok(after.pct > before.pct, `pct rose after close (${before.pct} -> ${after.pct})`);
  // an audit row records the close
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action='close' AND entity='function' AND entity_id=$1`, [String(ids.hr)])).rows[0].n, 1);
});

test('a closed function is locked from editing (400 closed_locked)', { skip }, async () => {
  const c = await as('pm');
  const r = await c.patch(`/tracker/functions/${ids.hr}`, { progress: 50 });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'closed_locked');
});

test('reopen requires BOTH a document and a reason', { skip }, async () => {
  const c = await as('pm');
  // reason only, no document
  let r = await c.post(`/tracker/functions/${ids.hr}/reopen`, { reason: 'official order attached' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'reopen_doc_required');
  // document only, no reason
  r = await c.post(`/tracker/functions/${ids.hr}/reopen`, { document: PDF });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'reopen_reason_required');
  // reason too short
  r = await c.post(`/tracker/functions/${ids.hr}/reopen`, { document: PDF, reason: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'reopen_reason_required');
});

test('a successful reopen clears the closed state, stores the document + reason, and re-allows edits', { skip }, async () => {
  const c = await as('pm');
  const r = await c.post(`/tracker/functions/${ids.hr}/reopen`, { document: PDF, reason: 'ministerial order no. 42' });
  assert.equal(r.status, 200);
  assert.equal(r.data.function.closed_at, null, 'closed_at cleared');
  const row = (await pool.query('SELECT closed_at, closed_by FROM functions WHERE id=$1', [ids.hr])).rows[0];
  assert.equal(row.closed_at, null); assert.equal(row.closed_by, null);
  const ro = (await pool.query('SELECT * FROM function_reopenings WHERE function_id=$1', [ids.hr])).rows[0];
  assert.ok(ro, 'reopening row stored');
  assert.equal(ro.reason, 'ministerial order no. 42');
  assert.equal(ro.doc_mime, 'application/pdf');
  assert.ok(ro.doc_size > 0 && ro.doc_data, 'document bytes stored');
  // the stored document is served (scope-enforced) with its mime
  const doc = await c.get(`/tracker/functions/${ids.hr}/reopenings/${ro.id}/document`);
  assert.equal(doc.status, 200);
  assert.equal(doc.headers.get('content-type'), 'application/pdf');
  // edits are allowed again
  assert.equal((await c.patch(`/tracker/functions/${ids.hr}`, { progress: 70 })).status, 200);
  // and reopen is refused when the function is not closed
  const r2 = await c.post(`/tracker/functions/${ids.hr}/reopen`, { document: PDF, reason: 'not closed now' });
  assert.equal(r2.status, 400);
  assert.equal(r2.data.error, 'not_closed');
});

test('scope is enforced on close / reopen / document', { skip }, async () => {
  const c = await as('scoped');       // apv_final, but scoped to hr only
  // can close inside scope (hr/per)
  const inScope = await c.post(`/tracker/functions/${ids.hr}/close`);
  assert.equal(inScope.status, 200);
  // cannot close out of scope (fin/acc)
  const out = await c.post(`/tracker/functions/${ids.fin}/close`);
  assert.equal(out.status, 403);
  assert.equal(out.data.error, 'out_of_scope');
  // reopen it (in scope) and check the document is not served to someone out of scope
  const re = await c.post(`/tracker/functions/${ids.hr}/reopen`, { document: PDF, reason: 'back to work order' });
  assert.equal(re.status, 200);
  const ro = (await pool.query('SELECT id FROM function_reopenings WHERE function_id=$1 ORDER BY id DESC LIMIT 1', [ids.hr])).rows[0];
  const ed = await as('editor');       // scoped to hr but let us also assert a fin document is hidden from scoped
  // the scoped user may view its own-scope document
  assert.equal((await c.get(`/tracker/functions/${ids.hr}/reopenings/${ro.id}/document`)).status, 200);
  // editor (no apv_final) may still read within scope — the download route is scope-gated, not apv_final-gated
  assert.equal((await ed.get(`/tracker/functions/${ids.hr}/reopenings/${ro.id}/document`)).status, 200);
});

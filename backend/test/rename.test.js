// Renaming a function / report item (1.9.1): PATCH /tracker/functions/:id with name_ar / name_en and a required
// rename_reason, sent on its own; audited with the old / new names and the reason; a member's rename waits for the
// team lead and carries the reason; a name changed since the request makes its approval fail (409).
// Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool, live;
const ids = {};

// [username, role, scopes ([kind, ref])]
const USERS = [
  ['root', 'admin'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['member_hr', 'member', [['department', 'hr']]],
  ['ed_hr', 'ed', [['department', 'hr']]],          // no 'tog'
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
  return { get cookie() { return cookie; }, get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const fn = (app, code) => one('SELECT * FROM functions WHERE app_id=$1 AND code=$2', [app, code]);
const lastAudit = id => one(`SELECT * FROM audit_log WHERE entity='function' AND entity_id=$1 AND action='update' ORDER BY id DESC LIMIT 1`, [String(id)]);
const REASON = 'تصحيح الاسم حسب وثيقة التصميم';

test('a rename without a valid reason is refused (400) and changes nothing', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D0');
  const p = body => lead.patch('/tracker/functions/' + f.id, body);
  const err = async (body, code) => { const r = await p(body); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.data.error, code); return r; };
  const r = await err({ name_ar: 'اسم جديد' }, 'rename_reason_required');
  assert.equal(r.data.min, 3);
  for (const reason of [null, '', '   ', ' \n\t ', ' ab ', 'a b', 'ن  ن']) await err({ name_ar: 'اسم جديد', rename_reason: reason }, 'rename_reason_required');
  await err({ name_ar: 'اسم جديد', rename_reason: 42 }, 'invalid_value');
  await err({ name_ar: 'اسم جديد', rename_reason: 'x'.repeat(501) }, 'invalid_value');
  // the reason alone renames nothing
  await err({ rename_reason: REASON }, 'invalid_value');
  assert.equal((await fn('per', 'D0')).name_ar, f.name_ar);
});

test('empty, too long or unchanged names are refused (400)', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D0');
  const p = body => lead.patch('/tracker/functions/' + f.id, { rename_reason: REASON, ...body });
  for (const v of ['', '   ', null, 7]) {
    const r = await p({ name_ar: v });
    assert.equal(r.status, 400, JSON.stringify(v));
    assert.equal(r.data.error, 'invalid_value');
    assert.equal(r.data.field, 'name_ar');
  }
  assert.equal((await p({ name_ar: 'ن'.repeat(501) })).data.error, 'invalid_value');
  assert.equal((await p({ name_en: 'x'.repeat(501) })).data.error, 'invalid_value');
  assert.equal((await p({ name_en: 5 })).data.error, 'invalid_value');
  // unchanged: the same name, or the same name with spaces around it
  let r = await p({ name_ar: f.name_ar });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'name_unchanged');
  r = await p({ name_ar: '  ' + f.name_ar + ' ', name_en: f.name_en });
  assert.equal(r.data.error, 'name_unchanged');
  assert.equal((await fn('per', 'D0')).name_ar, f.name_ar);
});

test('a rename combined with other fields is refused (400 rename_must_be_separate)', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D0');
  for (const extra of [{ progress: 50 }, { note: 'x' }, { enabled: false, disabled_reason: 'other', disabled_note: 'abc' }, { item_type: 'report' }]) {
    const r = await lead.patch('/tracker/functions/' + f.id, { name_ar: 'اسم جديد', rename_reason: REASON, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.data.error, 'rename_must_be_separate');
    assert.deepEqual(r.data.fields, Object.keys(extra));
  }
  const now = await fn('per', 'D0');
  assert.deepEqual([now.name_ar, Number(now.progress), now.enabled, now.item_type], [f.name_ar, Number(f.progress), f.enabled, f.item_type]);
});

test('renaming a removed item is refused (409)', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D9');
  assert.equal((await lead.post(`/tracker/functions/${f.id}/remove`, { reason: 'test' })).status, 200);
  const r = await lead.patch('/tracker/functions/' + f.id, { name_ar: 'اسم جديد', rename_reason: REASON });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'function_removed');
  assert.equal((await fn('per', 'D9')).name_ar, f.name_ar);
});

test('no "tog" permission → 403; an application out of scope → 403', { skip }, async () => {
  const ed = await as('ed_hr');
  const f = await fn('per', 'D0');
  let r = await ed.patch('/tracker/functions/' + f.id, { name_ar: 'اسم جديد', rename_reason: REASON });
  assert.equal(r.status, 403);
  assert.equal(r.data.permission, 'tog');
  r = await ed.patch('/tracker/functions/' + f.id, { name_en: 'New', rename_reason: REASON });
  assert.equal(r.status, 403);
  const lead = await as('lead_hr');
  const fin = await fn('acc', 'D0');                     // finance: outside the HR lead's scope
  r = await lead.patch('/tracker/functions/' + fin.id, { name_ar: 'اسم جديد', rename_reason: REASON });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'out_of_scope');
  assert.equal((await fn('acc', 'D0')).name_ar, fin.name_ar);
  assert.equal((await fn('per', 'D0')).name_ar, f.name_ar);
});

test('a direct rename updates the name, keeps the code and writes an audit row with old / new / reason', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D1');
  const r = await lead.patch('/tracker/functions/' + f.id, { name_ar: '  إدارة ملف الموظف  ', name_en: ' Employee file ', rename_reason: '  ' + REASON + '  ' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.function.name_ar, 'إدارة ملف الموظف');
  assert.equal(r.data.function.name_en, 'Employee file');
  assert.equal(r.data.warning, undefined);
  const row = await fn('per', 'D1');
  assert.deepEqual([row.code, row.name_ar, row.name_en, row.updated_by], ['D1', 'إدارة ملف الموظف', 'Employee file', ids.lead_hr]);
  const a = await lastAudit(f.id);
  assert.equal(a.user_id, ids.lead_hr);
  assert.deepEqual(a.old_value, { name_ar: f.name_ar, name_en: f.name_en });
  assert.deepEqual(a.new_value, { name_ar: 'إدارة ملف الموظف', name_en: 'Employee file', rename_reason: REASON });
  // the page shows the new name
  const page = await lead.get('/tracker/applications/per');
  assert.equal(page.data.functions.find(x => x.id === f.id).name_ar, 'إدارة ملف الموظف');
});

test('the English name can be cleared; only the changed name is audited', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D1');
  assert.ok(f.name_en);
  for (const v of [null, '', '   ']) {
    if (v !== null) {      // put it back first
      assert.equal((await lead.patch('/tracker/functions/' + f.id, { name_en: 'Employee file', rename_reason: REASON })).status, 200);
    }
    const r = await lead.patch('/tracker/functions/' + f.id, { name_ar: f.name_ar, name_en: v, rename_reason: 'لا حاجة للاسم الإنجليزي' });
    assert.equal(r.status, 200, JSON.stringify(v));
    assert.equal((await fn('per', 'D1')).name_en, null);
    const a = await lastAudit(f.id);
    assert.deepEqual(a.old_value, { name_en: 'Employee file' });
    assert.deepEqual(a.new_value, { name_en: null, rename_reason: 'لا حاجة للاسم الإنجليزي' });
  }
  // clearing it again changes nothing
  const r = await lead.patch('/tracker/functions/' + f.id, { name_en: null, rename_reason: REASON });
  assert.equal(r.data.error, 'name_unchanged');
});

test('a name used by another item of the application is allowed with a warning', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D2'), other = await fn('per', 'D3');
  const r = await lead.patch('/tracker/functions/' + f.id, { name_ar: ' ' + other.name_ar + ' ', rename_reason: REASON });
  assert.equal(r.status, 200);
  assert.equal(r.data.warning, 'duplicate_name');
  assert.equal((await fn('per', 'D2')).name_ar, other.name_ar);
});

test('a member\'s rename waits for the team lead with its reason; approval applies it and audits the reason', { skip }, async () => {
  const member = await as('member_hr'), lead = await as('lead_hr');
  const f = await fn('per', 'D4');
  const r = await member.patch('/tracker/functions/' + f.id, { name_ar: 'اسم مقترح', rename_reason: REASON });
  assert.equal(r.status, 202);
  assert.equal(r.data.pending, true);
  assert.equal((await fn('per', 'D4')).name_ar, f.name_ar);           // not yet
  // the item carries the reason; the page shows it pending; the approver sees old → new and the reason
  const it = await one('SELECT * FROM edit_request_items WHERE request_id=$1', [r.data.request_id]);
  assert.deepEqual([it.field, it.old_value, it.new_value, it.meta], ['name_ar', f.name_ar, 'اسم مقترح', { rename_reason: REASON }]);
  const page = await member.get('/tracker/applications/per');
  assert.ok(page.data.pending.some(p => p.function_id === f.id && p.field === 'name_ar' && p.meta?.rename_reason === REASON));
  const list = await lead.get('/approvals?status=pending');
  const rq = list.data.requests.find(x => x.id === r.data.request_id);
  assert.ok(rq?.can.approve);
  assert.deepEqual([rq.items[0].old_value, rq.items[0].new_value, rq.items[0].meta.rename_reason], [f.name_ar, 'اسم مقترح', REASON]);
  const ap = await lead.post(`/approvals/${rq.id}/approve`);
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.equal(ap.data.applied_changes, 1);
  const row = await fn('per', 'D4');
  assert.deepEqual([row.name_ar, row.updated_by], ['اسم مقترح', ids.member_hr]);
  // audit row in the member's name, with the reason and the approving lead
  const a = await lastAudit(f.id);
  assert.equal(a.user_id, ids.member_hr);
  assert.deepEqual(a.old_value, { name_ar: f.name_ar, rename_reason: null });
  assert.deepEqual(a.new_value, { name_ar: 'اسم مقترح', rename_reason: REASON });
  assert.equal(a.context.approved_by.id, ids.lead_hr);
});

test('approving a rename whose name changed since the request is refused (409), the request stays pending', { skip }, async () => {
  const member = await as('member_hr'), lead = await as('lead_hr');
  const f = await fn('per', 'D5');
  const r = await member.patch('/tracker/functions/' + f.id, { name_ar: 'اسم العضو', rename_reason: REASON });
  assert.equal(r.status, 202);
  // the lead renames it directly in the meantime
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { name_ar: 'اسم رئيس الفريق', rename_reason: REASON })).status, 200);
  const ap = await lead.post(`/approvals/${r.data.request_id}/approve`);
  assert.equal(ap.status, 409);
  assert.equal(ap.data.error, 'name_changed');
  assert.equal((await fn('per', 'D5')).name_ar, 'اسم رئيس الفريق');
  assert.equal((await one('SELECT status FROM edit_requests WHERE id=$1', [r.data.request_id])).status, 'pending');
  // «approve all» leaves it pending too (counted as blocked) instead of failing
  const all = await lead.post('/approvals/approve-all', { ids: [r.data.request_id] });
  assert.equal(all.status, 200);
  assert.equal(all.data.blocked_requests, 1);
  assert.equal((await one('SELECT status FROM edit_requests WHERE id=$1', [r.data.request_id])).status, 'pending');
  // it can still be rejected
  assert.equal((await lead.post(`/approvals/${r.data.request_id}/reject`, { reason: 'تغيّر الاسم' })).status, 200);
});

test('a member without a reason, or mixing fields, is refused before any request is stored', { skip }, async () => {
  const member = await as('member_hr');
  const f = await fn('per', 'D6');
  const n0 = (await one('SELECT count(*)::int AS n FROM edit_requests')).n;
  assert.equal((await member.patch('/tracker/functions/' + f.id, { name_ar: 'اسم' })).data.error, 'rename_reason_required');
  assert.equal((await member.patch('/tracker/functions/' + f.id, { name_ar: 'اسم', rename_reason: REASON, progress: 10 })).data.error, 'rename_must_be_separate');
  assert.equal((await one('SELECT count(*)::int AS n FROM edit_requests')).n, n0);
});

test('a rename sends tracker_changed after commit (ids only)', { skip }, async () => {
  const c = await as('root');
  const ac = new AbortController();
  const res = await fetch(base + '/events', { headers: { cookie: c.cookie, accept: 'text/event-stream' }, signal: ac.signal });
  assert.equal(res.status, 200);
  const events = [];
  const reading = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ event: ev, data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] || 'null'), raw: block });
        }
      }
    } catch { /* aborted */ }
  })();
  const wait = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await new Promise(r => setTimeout(r, 50)); }
    return null;
  };
  assert.ok(await wait(e => e.event === 'ready'));
  const f = await fn('rec', 'D0');
  const n0 = events.length;
  assert.equal((await c.patch('/tracker/functions/' + f.id, { name_ar: 'اسم بث مباشر', rename_reason: REASON })).status, 200);
  const e = await wait(x => events.indexOf(x) >= n0 && x.event === 'tracker_changed');
  assert.ok(e, 'tracker_changed received');
  assert.deepEqual(e.data, { type: 'tracker_changed', dept_id: 'hr', app_id: 'rec' });
  assert.ok(!e.raw.includes('اسم بث مباشر') && !e.raw.includes(REASON));
  ac.abort();
  await reading;
});

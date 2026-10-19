// Reason for excluding a function from the calculation (1.5.0, migration 013): required on every path that turns a
// function off (direct edit, bulk, approved request, import), with a note of at least 3 characters for every reason a
// user chooses (1.5.1; not for 'import', and requests submitted before 1.5.1 without a note are still approved as they
// are), duplicates name the functions they duplicate (in scope,
// not the function itself, not removed), including again clears the reason, the audit trail and the Excel export
// show it. Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool;
const ids = {};

// [username, role, scopes ([kind, ref])]
const USERS = [
  ['root', 'admin'], ['pmu', 'pm'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['member_hr', 'member', [['department', 'hr']]],
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
    const data = type.includes('json') ? await res.json() : type.includes('spreadsheetml') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const fn = (app, code) => one('SELECT * FROM functions WHERE app_id=$1 AND code=$2', [app, code]);
const links = async id => (await pool.query('SELECT duplicate_of_id FROM function_duplicates WHERE function_id=$1 ORDER BY 1', [id])).rows.map(x => x.duplicate_of_id);
const lastAudit = (entityId, extra = '') => one(`SELECT * FROM audit_log WHERE entity='function' AND entity_id=$1 ${extra} ORDER BY id DESC LIMIT 1`, [String(entityId)]);

test('exclusion without a valid reason is refused (400)', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D0'), d3 = await fn('per', 'D3');
  const p = body => lead.patch('/tracker/functions/' + f.id, { enabled: false, ...body });
  const err = async (body, code) => { const r = await p(body); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.data.error, code); return r; };
  await err({}, 'disable_reason_required');
  await err({ disabled_reason: 'whatever' }, 'invalid_value');
  // the note is required for every reason (1.5.1): missing, empty, whitespace only, fewer than 3 characters
  for (const reason of ['duplicate', 'out_of_scope', 'not_required', 'other']) {
    const dup = reason === 'duplicate' ? { duplicate_of: [d3.id] } : {};
    const r = await err({ disabled_reason: reason, ...dup }, 'disable_note_required');
    assert.equal(r.data.min, 3);
    await err({ disabled_reason: reason, disabled_note: '', ...dup }, 'disable_note_required');
    await err({ disabled_reason: reason, disabled_note: null, ...dup }, 'disable_note_required');
    await err({ disabled_reason: reason, disabled_note: '   ', ...dup }, 'disable_note_required');
    await err({ disabled_reason: reason, disabled_note: ' \n\t ', ...dup }, 'disable_note_required');
    await err({ disabled_reason: reason, disabled_note: ' ab ', ...dup }, 'disable_note_required');
    await err({ disabled_reason: reason, disabled_note: 'a b', ...dup }, 'disable_note_required');    // 2 characters + a space
  }
  await err({ disabled_reason: 'out_of_scope', disabled_note: 'x'.repeat(501) }, 'invalid_value');
  await err({ disabled_reason: 'out_of_scope', disabled_note: 42 }, 'invalid_value');
  const N = { disabled_note: 'a valid note' };
  await err({ disabled_reason: 'duplicate', ...N }, 'duplicate_of_required');
  await err({ disabled_reason: 'duplicate', duplicate_of: [], ...N }, 'duplicate_of_required');
  await err({ disabled_reason: 'duplicate', duplicate_of: ['7'], ...N }, 'invalid_value');
  await err({ disabled_reason: 'not_required', duplicate_of: [d3.id], ...N }, 'invalid_value');      // only a duplicate names functions
  // pointing at itself, outside the user's scope (finance), at a function that does not exist, at a removed one
  assert.equal((await err({ disabled_reason: 'duplicate', duplicate_of: [f.id], ...N }, 'invalid_duplicate')).data.problem, 'self');
  const fin = await fn('acc', 'D0');
  assert.equal((await err({ disabled_reason: 'duplicate', duplicate_of: [d3.id, fin.id], ...N }, 'invalid_duplicate')).data.problem, 'unavailable');
  assert.equal((await err({ disabled_reason: 'duplicate', duplicate_of: [2000000000], ...N }, 'invalid_duplicate')).data.problem, 'unavailable');
  const gone = await fn('per', 'D9');
  assert.equal((await lead.post(`/tracker/functions/${gone.id}/remove`, { reason: 'test' })).status, 200);
  assert.equal((await err({ disabled_reason: 'duplicate', duplicate_of: [gone.id], ...N }, 'invalid_duplicate')).data.problem, 'removed');
  // exactly 3 characters and exactly 500 are accepted (on another function)
  const g = await fn('per', 'D17');
  const ok3 = await lead.patch('/tracker/functions/' + g.id, { enabled: false, disabled_reason: 'other', disabled_note: '  abc  ' });
  assert.equal(ok3.status, 200);
  assert.equal((await fn('per', 'D17')).disabled_note, 'abc');
  assert.equal((await lead.patch('/tracker/functions/' + g.id, { enabled: true })).status, 200);
  assert.equal((await lead.patch('/tracker/functions/' + g.id, { enabled: false, disabled_reason: 'not_required', disabled_note: 'ن'.repeat(500) })).status, 200);
  assert.equal((await lead.patch('/tracker/functions/' + g.id, { enabled: true })).status, 200);
  // a reason without an exclusion is refused too
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { disabled_reason: 'other', disabled_note: 'x' })).status, 400);
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { progress: 10, disabled_reason: 'other', disabled_note: 'x' })).status, 400);
  // nothing changed
  assert.equal((await fn('per', 'D0')).enabled, true);
  assert.equal((await fn('per', 'D0')).disabled_reason, null);
});

test('valid exclusion stores the reason and the links; audit row; page; including again clears it', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D1'), d3 = await fn('per', 'D3'), other = await fn('att', 'D2');   // same app + another app in scope
  const weightBefore = (await lead.get('/tracker/applications/per')).data.application.calc.fnWeight;
  const r = await lead.patch('/tracker/functions/' + f.id, { enabled: false, disabled_reason: 'duplicate', disabled_note: '  same screen  ',
    duplicate_of: [d3.id, other.id, d3.id] });
  assert.equal(r.status, 200);
  assert.equal(r.data.function.enabled, false);
  assert.equal(r.data.function.disabled_reason, 'duplicate');
  const row = await fn('per', 'D1');
  assert.deepEqual([row.disabled_reason, row.disabled_note, row.disabled_by], ['duplicate', 'same screen', ids.lead_hr]);
  assert.ok(row.disabled_at);
  assert.deepEqual(await links(f.id), [d3.id, other.id].sort((a, b) => a - b));
  // audit: before → after with the reason and the codes of the duplicated functions
  const au = await lastAudit(f.id, "AND action='update'");
  assert.equal(au.username, 'lead_hr');
  assert.deepEqual(au.old_value, { enabled: true });
  assert.equal(au.new_value.enabled, false);
  assert.equal(au.new_value.disabled_reason, 'duplicate');
  assert.equal(au.new_value.disabled_note, 'same screen');
  assert.deepEqual(au.new_value.duplicate_of.map(d => `${d.app_id}/${d.code}`), ['per/D3', 'att/D2']);
  // the page lists the duplicated functions (code, application, name) and who excluded it
  const page = (await lead.get('/tracker/applications/per')).data;
  const pf = page.functions.find(x => x.id === f.id);
  assert.equal(pf.disabled_by_name, 'Full lead_hr');
  assert.deepEqual(pf.duplicate_of.map(d => `${d.app_id}/${d.code}`).sort(), ['att/D2', 'per/D3']);
  assert.ok(pf.duplicate_of.every(d => d.name_ar && d.visible));
  // functions excluded before 1.5.0 (experience items) keep working with an empty reason
  const x0 = page.functions.find(x => x.code === 'X0');
  assert.equal(x0.enabled, false);
  assert.equal(x0.disabled_reason, null);
  assert.deepEqual(x0.duplicate_of, []);
  // the excluded function no longer counts
  assert.equal(+page.application.calc.fnWeight, +weightBefore - +f.weight);

  // including again: no reason needed, active reason cleared, the history stays in the audit trail
  const on = await lead.patch('/tracker/functions/' + f.id, { enabled: true });
  assert.equal(on.status, 200);
  const back = await fn('per', 'D1');
  assert.deepEqual([back.enabled, back.disabled_reason, back.disabled_note, back.disabled_by, back.disabled_at], [true, null, null, null, null]);
  assert.deepEqual(await links(f.id), []);
  const au2 = await lastAudit(f.id, "AND action='update'");
  assert.deepEqual(au2.new_value, { enabled: true });
  assert.equal(au2.old_value.disabled_reason, 'duplicate');
  assert.equal(au2.old_value.disabled_note, 'same screen');
  assert.equal(au2.old_value.duplicate_of.length, 2);
  assert.ok(await one(`SELECT 1 FROM audit_log WHERE id=$1`, [au.id]));
});

test('restoring a removed function clears an exclusion reason', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D2');
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { enabled: false, disabled_reason: 'out_of_scope', disabled_note: 'not in phase 1' })).status, 200);
  assert.equal((await lead.post(`/tracker/functions/${f.id}/remove`, { reason: 'dropped' })).status, 200);
  assert.equal((await lead.post(`/tracker/functions/${f.id}/restore`)).status, 200);
  const r = await fn('per', 'D2');
  assert.deepEqual([r.enabled, r.disabled_reason, r.removed_at], [true, null, null]);
});

test('bulk exclusion with one reason for the chosen functions', { skip }, async () => {
  const lead = await as('lead_hr');
  const [a, b, c] = await Promise.all(['D4', 'D5', 'D6'].map(code => fn('per', code)));
  const bulk = body => lead.post('/tracker/applications/per/bulk', { field: 'enabled', value: false, function_ids: [a.id, b.id], ...body });
  assert.equal((await bulk({})).data.error, 'disable_reason_required');
  // the note is required in bulk too, for every reason
  for (const reason of ['duplicate', 'out_of_scope', 'not_required', 'other']) {
    const dup = reason === 'duplicate' ? { duplicate_of: [c.id] } : {};
    for (const note of [undefined, '', '   ', 'ab']) {
      const r = await bulk({ disabled_reason: reason, disabled_note: note, ...dup });
      assert.equal(r.status, 400, `${reason} ${JSON.stringify(note)}`);
      assert.equal(r.data.error, 'disable_note_required');
    }
  }
  assert.equal((await fn('per', 'D4')).enabled, true);
  const N = { disabled_note: 'bulk note' };
  assert.equal((await bulk({ disabled_reason: 'duplicate', ...N })).data.error, 'duplicate_of_required');
  assert.equal((await bulk({ disabled_reason: 'duplicate', duplicate_of: [b.id], ...N })).data.error, 'invalid_duplicate');    // one of the selection
  assert.equal((await bulk({ disabled_reason: 'out_of_scope', function_ids: [], ...N })).status, 400);
  const fin = await fn('acc', 'D1');
  assert.equal((await bulk({ disabled_reason: 'out_of_scope', function_ids: [a.id, fin.id], ...N })).status, 400);         // other application
  const ok = await bulk({ disabled_reason: 'duplicate', disabled_note: 'merged screens', duplicate_of: [c.id] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.updated, 2);
  for (const x of [a, b]) {
    const r = await fn('per', x.code);
    assert.deepEqual([r.enabled, r.disabled_reason, r.disabled_note], [false, 'duplicate', 'merged screens']);
    assert.deepEqual(await links(x.id), [c.id]);
    const au = await lastAudit(x.id, "AND action='update'");
    assert.equal(au.new_value.disabled_reason, 'duplicate');
    assert.deepEqual(au.new_value.duplicate_of.map(d => d.code), ['D6']);
    assert.equal(au.context.bulk, true);
  }
  // bulk include clears them
  const inc = await lead.post('/tracker/applications/per/bulk', { field: 'enabled', value: true, function_ids: [a.id, b.id] });
  assert.equal(inc.data.updated, 2);
  assert.equal((await fn('per', 'D4')).disabled_reason, null);
  assert.deepEqual(await links(b.id), []);
});

test('approval flow: the reason travels with the request and is applied on approval', { skip }, async () => {
  const member = await as('member_hr'), lead = await as('lead_hr');
  const f = await fn('per', 'D7'), d8 = await fn('per', 'D8');
  assert.equal((await member.patch('/tracker/functions/' + f.id, { enabled: false })).data.error, 'disable_reason_required');
  // a request is checked when it is submitted: no note → 400 and no request is created
  const pendingBefore = (await one(`SELECT count(*)::int AS n FROM edit_requests WHERE status='pending'`)).n;
  for (const body of [{ disabled_reason: 'duplicate', duplicate_of: [d8.id] }, { disabled_reason: 'out_of_scope', disabled_note: '  ' }]) {
    const x = await member.patch('/tracker/functions/' + f.id, { enabled: false, ...body });
    assert.equal(x.status, 400);
    assert.equal(x.data.error, 'disable_note_required');
  }
  const xb = await member.post('/tracker/applications/per/bulk', { field: 'enabled', value: false, function_ids: [f.id], disabled_reason: 'not_required' });
  assert.deepEqual([xb.status, xb.data.error], [400, 'disable_note_required']);
  assert.equal((await one(`SELECT count(*)::int AS n FROM edit_requests WHERE status='pending'`)).n, pendingBefore);
  const r = await member.patch('/tracker/functions/' + f.id, { enabled: false, disabled_reason: 'duplicate', disabled_note: 'see D8', duplicate_of: [d8.id] });
  assert.equal(r.status, 202);
  assert.equal((await fn('per', 'D7')).enabled, true);
  // the approver sees the reason and the duplicated function on the pending request
  const list = (await lead.get('/approvals?status=pending')).data.requests;
  const rq = list.find(x => x.id === r.data.request_id);
  const item = rq.items.find(i => i.field === 'enabled');
  assert.deepEqual([item.meta.disabled_reason, item.meta.disabled_note, item.meta.duplicate_of.map(d => d.code)], ['duplicate', 'see D8', ['D8']]);
  const reqAudit = await one(`SELECT * FROM audit_log WHERE action='edit_request' AND entity_id=$1`, [String(r.data.request_id)]);
  assert.equal(reqAudit.context.items[0].meta.disabled_reason, 'duplicate');
  // approval applies the exclusion with its reason, in the requester's name
  const ap = await lead.post(`/approvals/${r.data.request_id}/approve`);
  assert.equal(ap.data.applied_changes, 1);
  const row = await fn('per', 'D7');
  assert.deepEqual([row.enabled, row.disabled_reason, row.disabled_note, row.disabled_by], [false, 'duplicate', 'see D8', ids.member_hr]);
  assert.deepEqual(await links(f.id), [d8.id]);
  const au = await lastAudit(f.id, "AND action='update'");
  assert.equal(au.username, 'member_hr');
  assert.equal(au.context.approved_by.username, 'lead_hr');
  assert.deepEqual([au.new_value.enabled, au.new_value.disabled_reason, au.new_value.disabled_note], [false, 'duplicate', 'see D8']);
  assert.deepEqual(au.new_value.duplicate_of.map(d => d.code), ['D8']);

  // a bulk request by the member carries the reason too
  const [a, b] = await Promise.all(['D10', 'D11'].map(code => fn('per', code)));
  const br = await member.post('/tracker/applications/per/bulk', { field: 'enabled', value: false, function_ids: [a.id, b.id], disabled_reason: 'not_required',
    disabled_note: 'covered by HR portal' });
  assert.equal(br.status, 202);
  assert.equal(br.data.requested, 2);
  assert.equal((await lead.post(`/approvals/${br.data.request_id}/approve`)).data.applied_changes, 2);
  assert.equal((await fn('per', 'D10')).disabled_reason, 'not_required');
  assert.equal((await fn('per', 'D10')).disabled_note, 'covered by HR portal');

  // a request submitted before 1.5.1 without a note is still approved as it is (no check at approval)
  const [o1, o2] = await Promise.all(['D20', 'D21'].map(code => fn('per', code)));
  const old = await member.post('/tracker/applications/per/bulk', { field: 'enabled', value: false, function_ids: [o1.id, o2.id],
    disabled_reason: 'out_of_scope', disabled_note: 'will be cleared' });
  assert.equal(old.status, 202);
  await pool.query(`UPDATE edit_request_items SET meta = meta - 'disabled_note' WHERE request_id=$1`, [old.data.request_id]);
  assert.equal((await lead.post(`/approvals/${old.data.request_id}/approve`)).data.applied_changes, 2);
  const o = await fn('per', 'D20');
  assert.deepEqual([o.enabled, o.disabled_reason, o.disabled_note], [false, 'out_of_scope', null]);

  // a duplicated function removed after the request: the exclusion is not applied (reported as skipped)
  const g = await fn('per', 'D12'), h = await fn('per', 'D13');
  const r2 = await member.patch('/tracker/functions/' + g.id, { enabled: false, disabled_reason: 'duplicate', disabled_note: 'same as D13', duplicate_of: [h.id] });
  assert.equal(r2.status, 202);
  assert.equal((await lead.post(`/tracker/functions/${h.id}/remove`, { reason: 'gone' })).status, 200);
  const ap2 = await lead.post(`/approvals/${r2.data.request_id}/approve`);
  assert.deepEqual([ap2.data.applied_changes, ap2.data.skipped_changes], [0, 1]);
  assert.equal((await fn('per', 'D12')).enabled, true);

  // including again through a request clears the reason; the audit row keeps the old one
  const r3 = await member.patch('/tracker/functions/' + f.id, { enabled: true });
  assert.equal(r3.status, 202);
  await lead.post(`/approvals/${r3.data.request_id}/approve`);
  const back = await fn('per', 'D7');
  assert.deepEqual([back.enabled, back.disabled_reason], [true, null]);
  assert.deepEqual(await links(f.id), []);
  const au3 = await lastAudit(f.id, "AND action='update'");
  assert.equal(au3.old_value.disabled_reason, 'duplicate');
  assert.equal(au3.new_value.disabled_reason, null);
});

test('options for the duplicate picker: in scope, counted, not the excluded ones', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D14');
  const own = (await lead.get(`/tracker/function-options?app_id=per&exclude=${f.id}`)).data.options;
  assert.ok(own.length > 5);
  assert.ok(own.every(o => o.app_id === 'per' && o.id !== f.id));
  assert.ok(!own.some(o => o.code === 'X0'));            // excluded
  assert.ok(!own.some(o => o.code === 'D9'));            // removed
  const all = (await lead.get('/tracker/function-options?all=1&q=D1')).data.options;
  assert.ok(all.some(o => o.app_id !== 'per'));
  const hrApps = new Set((await pool.query(`SELECT id FROM applications WHERE department_id='hr'`)).rows.map(x => x.id));
  assert.ok(all.every(o => hrApps.has(o.app_id)));        // finance and the others are out of scope
  assert.equal((await lead.get('/tracker/function-options?app_id=acc')).status, 403);
  assert.equal((await lead.get('/tracker/function-options')).status, 400);
});

test('the functions export has the reason columns', { skip }, async () => {
  const lead = await as('lead_hr');
  const f = await fn('per', 'D15'), d16 = await fn('per', 'D16'), other = await fn('att', 'D3');
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { enabled: false, disabled_reason: 'duplicate', disabled_note: 'dup note',
    duplicate_of: [d16.id, other.id] })).status, 200);
  const r = await lead.get('/export/functions.xlsx?id=per&show_off=1&lang=ar');
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.data);
  const ws = wb.worksheets[0];
  const vals = n => { const v = ws.getRow(n).values; return Array.isArray(v) ? v.slice(1) : []; };
  const header = vals(4);
  for (const h of ['سبب الإلغاء', 'مكررة مع', 'ملاحظة الإلغاء']) assert.ok(header.includes(h), h);
  const col = h => header.indexOf(h);
  const rows = []; for (let i = 5; i <= ws.rowCount; i++) rows.push(vals(i));
  const row = rows.find(x => x[col('الرمز')] === 'D15');
  assert.equal(row[col('سبب الإلغاء')], 'مكررة');
  assert.equal(row[col('مكررة مع')], 'D16، att/D3');      // the application's order, other applications with their code
  assert.equal(row[col('ملاحظة الإلغاء')], 'dup note');
  assert.equal(rows.find(x => x[col('الرمز')] === 'X0')[col('سبب الإلغاء')], 'بدون سبب مسجّل');
  assert.ok(!rows.find(x => x[col('الرمز')] === 'D17')[col('سبب الإلغاء')]);
  // the reason filter of the screen
  const en = await lead.get('/export/functions.xlsx?id=per&show_off=1&reason=duplicate&lang=en');
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(en.data);
  const ws2 = wb2.worksheets[0];
  const h2 = ws2.getRow(4).values.slice(1);
  for (const h of ['Exclusion reason', 'Duplicate of', 'Exclusion note']) assert.ok(h2.includes(h), h);
  const codes = []; for (let i = 5; i <= ws2.rowCount; i++) codes.push(ws2.getRow(i).values[1 + h2.indexOf('Code')]);
  assert.deepEqual(codes, ['D15']);
});

test('imports that turn functions off record the reason «Import» with the batch reference', { skip }, async () => {
  const member = await as('member_hr'), lead = await as('lead_hr'), pm = await as('pmu');
  const f = await fn('per', 'D18');
  const sent = await member.post('/imports', { target: 'department', department_id: 'hr', filename: 'team.json', payload: { f: { per: { D18: { on: 0 } } } } });
  assert.equal(sent.status, 201);
  const id = sent.data.batch.id;
  assert.equal((await lead.post(`/imports/${id}/approve`, { stage: 'lead' })).status, 200);
  assert.equal((await pm.post(`/imports/${id}/approve`, { stage: 'final' })).data.applied, true);
  const row = await fn('per', 'D18');
  assert.deepEqual([row.enabled, row.disabled_reason, row.disabled_note], [false, 'import', `#${id} team.json`]);
  const au = await lastAudit(f.id, "AND action='update'");
  assert.deepEqual([au.new_value.enabled, au.new_value.disabled_reason, au.new_value.disabled_note], [false, 'import', `#${id} team.json`]);
  assert.equal(au.context.via, 'import');

  // the full legacy import (administrators): 'import' for functions it turns off, cleared for those it turns on
  const root = await as('root');
  const g = await fn('per', 'D19');
  const v = x => ({ w: +x.weight, p: +x.progress, t: x.test_status, n: x.notif_status, rv: x.review_status, nt: x.note });
  const r = await root.post('/tracker/import', { payload: { f: { per: { D19: { ...v(g), on: 0 }, D18: { ...v(row), on: 1 } } } } });
  assert.equal(r.status, 200);
  assert.equal((await fn('per', 'D19')).disabled_reason, 'import');
  const back = await fn('per', 'D18');
  assert.deepEqual([back.enabled, back.disabled_reason, back.disabled_note], [true, null, null]);
});

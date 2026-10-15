// API integration tests — run against a dedicated, disposable PostgreSQL database:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool, totp, decrypt;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '3', LOGIN_RATE_LIMIT: '1000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  ({ totp } = await import('../src/services/totp.js'));
  ({ decrypt } = await import('../src/services/crypto.js'));
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('root','Root Admin',$1,'admin',false), ('tester','QA',$1,'qa',false), ('hred','HR Editor',$1,'ed',false),
    ('newbie','New',$1,'obs',true), ('locky','Lock',$1,'obs',false)`, [h]);
  const hred = (await pool.query(`SELECT id FROM users WHERE username='hred'`)).rows[0].id;
  await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,'department','hr')`, [hred]);
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  server.close();
  await new Promise(r => setTimeout(r, 200)); // let pending log writes finish
  await pool.end();
});

// Minimal cookie-keeping client
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
    get: p => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}

const secretOf = async u => decrypt((await pool.query('SELECT totp_secret FROM users WHERE username=$1', [u])).rows[0].totp_secret);
const setMfa = mode => pool.query(`UPDATE settings SET value=$1 WHERE key='mfa.mode'`, [JSON.stringify(mode)]);
const waitSettingsCache = () => import('../src/services/settings.js').then(m => m.invalidateSettings());

test('health endpoint', { skip }, async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).version, undefined);   // public endpoint: no version disclosure (ETS-SEC-038)
});

test('login: wrong password, unknown user, success', { skip }, async () => {
  const c = client();
  assert.equal((await c.login('root', 'nope')).status, 401);
  assert.equal((await c.login('ghost')).data.error, 'invalid_credentials');
  const ok = await c.login('root');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.stage, 'done');
  const me = await c.get('/auth/me');
  assert.equal(me.data.user.username, 'root');
  assert.ok(me.data.user.permissions.includes('usr'));
});

test('state-changing requests require the CSRF header', { skip }, async () => {
  const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('account locks after repeated failures', { skip }, async () => {
  const c = client();
  for (let i = 0; i < 3; i++) await c.login('locky', 'bad');
  const r = await c.login('locky');
  assert.equal(r.status, 423);
  const ev = (await pool.query(`SELECT event FROM auth_log WHERE username='locky' ORDER BY id`)).rows.map(x => x.event);
  assert.ok(ev.includes('account_locked'));
});

test('unauthenticated access is refused', { skip }, async () => {
  assert.equal((await client().get('/tracker/summary')).status, 401);
});

test('2FA: required policy → enrol, verify, replay blocked, recovery code', { skip }, async () => {
  await setMfa('required'); await waitSettingsCache();
  const c = client();
  assert.equal((await c.login('tester')).data.stage, 'enroll');
  assert.equal((await c.get('/tracker/summary')).status, 401);           // partial session is not enough
  const setup = await c.post('/auth/2fa/setup');
  assert.match(setup.data.uri, /^otpauth:\/\/totp\//);
  const en = await c.post('/auth/2fa/enable', { code: totp(setup.data.secret) });
  assert.equal(en.data.recovery_codes.length, 10);
  assert.equal((await c.get('/tracker/summary')).status, 200);

  // new login → verify stage; same code again is a replay
  const c2 = client();
  assert.equal((await c2.login('tester')).data.stage, 'verify');
  assert.equal((await c2.post('/auth/2fa/verify', { code: totp(await secretOf('tester')) })).data.error, 'invalid_code');
  // recovery code works once
  const code = en.data.recovery_codes[0];
  assert.equal((await c2.post('/auth/2fa/verify', { recovery_code: code })).data.stage, 'done');
  const c3 = client();
  await c3.login('tester');
  assert.equal((await c3.post('/auth/2fa/verify', { recovery_code: code })).status, 400);
});

test('2FA: admin exemption and global off', { skip }, async () => {
  const admin = client(); await admin.login('root');            // root not enrolled: policy 'required' → enroll
  await setMfa('off'); await waitSettingsCache();
  const a2 = client();
  assert.equal((await a2.login('root')).data.stage, 'done');
  assert.equal((await a2.login('tester')).data.stage, 'done');   // enrolled user skips 2FA when off
  await setMfa('required'); await waitSettingsCache();
  const tid = (await pool.query(`SELECT id FROM users WHERE username='tester'`)).rows[0].id;
  // exempt via API as root (needs a full session: enrol root first)
  const r = client();
  await r.login('root');
  const s = await r.post('/auth/2fa/setup');
  await r.post('/auth/2fa/enable', { code: totp(s.data.secret) });
  const bulk = await r.post('/users/bulk-2fa', { user_ids: [tid], exempt: true });
  assert.equal(bulk.data.updated, 1);
  assert.equal((await client().login('tester')).data.stage, 'done');
  await r.post('/users/bulk-2fa', { all: true, exempt: true });  // later tests log in without codes
});

test('permissions: tester may set test status but not progress', { skip }, async () => {
  const c = client(); await c.login('tester');
  const f = (await pool.query(`SELECT id FROM functions WHERE app_id='per' AND code='D0'`)).rows[0];
  assert.equal((await c.patch('/tracker/functions/' + f.id, { progress: 50 })).status, 403);
  const ok = await c.patch('/tracker/functions/' + f.id, { test_status: 2, note: 'checked' });
  assert.equal(ok.status, 202);                                   // data-entry edit → waits for the team lead
  assert.equal(ok.data.pending, true);
  const items = (await pool.query(`SELECT field, new_value FROM edit_request_items WHERE function_id=$1 ORDER BY field`, [f.id])).rows;
  assert.deepEqual(items.map(i => [i.field, i.new_value]), [['note', 'checked'], ['test_status', 2]]);
  assert.equal((await pool.query('SELECT test_status FROM functions WHERE id=$1', [f.id])).rows[0].test_status, 0);
});

test('a "with notes" status requires a note', { skip }, async () => {
  const c = client(); await c.login('root');
  const f = (await pool.query(`SELECT id FROM functions WHERE app_id='att' AND code='D0'`)).rows[0];
  const p = body => c.patch('/tracker/functions/' + f.id, body);
  for (const body of [{ test_status: 1 }, { notif_status: 2 }, { review_status: 3 }, { test_status: 1, note: '   ' }]) {
    const r = await p(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error, 'note_required');
  }
  assert.equal((await p({ test_status: 1, note: 'login screen slow' })).status, 200);
  assert.equal((await p({ notif_status: 2 })).status, 200);               // note already present
  assert.equal((await p({ note: '' })).data.error, 'note_required');      // cannot clear it while needed
  assert.equal((await p({ test_status: 2, notif_status: 0, note: '' })).status, 200);
  assert.equal((await c.post('/tracker/applications/att/bulk', { field: 'test_status', value: 1 })).data.error, 'note_required');
});

test('scope: HR editor cannot see or edit finance', { skip }, async () => {
  const c = client(); await c.login('hred');
  const sum = await c.get('/tracker/summary');
  assert.deepEqual(sum.data.departments.map(d => d.id), ['hr']);
  assert.equal((await c.get('/tracker/applications/acc')).status, 403);
  const fin = (await pool.query(`SELECT id FROM functions WHERE app_id='acc' LIMIT 1`)).rows[0];
  assert.equal((await c.patch('/tracker/functions/' + fin.id, { progress: 10 })).status, 403);
  const hr = (await pool.query(`SELECT id FROM functions WHERE app_id='pay' AND enabled LIMIT 1`)).rows[0];
  assert.equal((await c.patch('/tracker/functions/' + hr.id, { progress: 60 })).status, 202);
  const denied = (await pool.query(`SELECT count(*)::int n FROM auth_log WHERE username='hred' AND event='access_denied'`)).rows[0].n;
  assert.ok(denied >= 2);
});

test('must_change_password blocks the API until changed', { skip }, async () => {
  const c = client(); await c.login('newbie');
  assert.equal((await c.get('/tracker/summary')).data.error, 'password_change_required');
  assert.equal((await c.post('/auth/change-password', { current_password: 'Passw0rd-123', new_password: 'short' })).data.error, 'weak_password');
  assert.equal((await c.post('/auth/change-password', { current_password: 'Passw0rd-123', new_password: 'BrandNew-2026' })).status, 200);
  assert.equal((await c.get('/tracker/summary')).status, 200);
});

test('users: create, last-admin protection, reset password', { skip }, async () => {
  const c = client(); await c.login('root');
  const created = await c.post('/users', { username: 'fin.mgr', full_name: 'Finance Manager', role_id: 'mgr', password: 'Finance-2026x',
    scopes: [{ kind: 'department', ref_id: 'fin' }] });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.scopes.length, 1);
  assert.equal((await c.post('/users', { username: 'fin.mgr', full_name: 'X', role_id: 'obs', password: 'Finance-2026x' })).data.error, 'username_taken');
  const rootId = (await pool.query(`SELECT id FROM users WHERE username='root'`)).rows[0].id;
  assert.equal((await c.patch('/users/' + rootId, { role_id: 'obs' })).data.error, 'cannot_change_own_role');
  const r = await c.post(`/users/${created.data.user.id}/reset-password`, { password: 'Another-2026x' });
  assert.equal(r.status, 200);
  assert.equal((await client().login('fin.mgr', 'Another-2026x')).status, 200);
  // a non-admin cannot reach user management
  const t = client(); await t.login('tester');
  assert.equal((await t.get('/users')).status, 403);
});

test('settings validation and audit', { skip }, async () => {
  const c = client(); await c.login('root');
  assert.equal((await c.put('/settings', { 'mfa.mode': 'sometimes' })).status, 400);
  assert.equal((await c.put('/settings', { 'logs.retention_days': 400 })).status, 200);
  const a = (await pool.query(`SELECT * FROM audit_log WHERE entity='setting' AND entity_id='logs.retention_days'`)).rows;
  assert.equal(a.length, 1);
});

test('default language setting: login screen and new users', { skip }, async () => {
  const c = client(); await c.login('root');
  assert.equal((await c.put('/settings', { 'app.default_language': 'en' })).status, 200);
  try {
    assert.equal((await client().get('/auth/public-info')).data.default_language, 'en');
    const u = await c.post('/users', { username: 'lang.default', full_name: 'Lang Default', role_id: 'obs', password: 'Language-2026x' });
    assert.equal(u.status, 201);
    assert.equal(u.data.user.language, 'en');
    // an explicit choice still wins
    const ar = await c.post('/users', { username: 'lang.ar', full_name: 'Lang Ar', role_id: 'obs', password: 'Language-2026x', language: 'ar' });
    assert.equal(ar.data.user.language, 'ar');
  } finally {
    await c.put('/settings', { 'app.default_language': 'ar' }); await waitSettingsCache();
  }
  assert.equal((await client().get('/auth/public-info')).data.default_language, 'ar');
});

test('legacy import from the original tracker file', { skip }, async () => {
  const c = client(); await c.login('root');
  const html = fs.readFileSync(new URL('../../reference/erp-tracker-original.html', import.meta.url), 'utf8');
  const r = await c.post('/tracker/import', { content: html });
  assert.equal(r.status, 200);
  assert.equal(r.data.counts.functions, 513);
  const s = await c.get('/tracker/summary');
  const inf = s.data.departments.find(d => d.id === 'inf');
  assert.equal(Math.round(inf.pct * 100) / 100, 52.78);
});

test('imports: per-department / reports options, two approvals, apply', { skip }, async () => {
  await setMfa('off'); await waitSettingsCache();
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  const mk = async (u, role, dept) => {
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id) VALUES ($1,$2,$3,$4) RETURNING id`, [u, u, h, role])).rows[0].id;
    if (dept) await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,'department',$2)`, [id, dept]);
  };
  await mk('pm1', 'pm'); await mk('tm1', 'tm'); await mk('comlead', 'lead', 'com'); await mk('hrlead', 'lead', 'hr'); await mk('commember', 'member', 'com');
  const as = async u => { const c = client(); await c.login(u); return c; };
  const root = await as('root');
  const file = (await root.get('/tracker/export')).data;               // a file shaped like the teams' exports
  const fn = async (app, code) => (await pool.query('SELECT * FROM functions WHERE app_id=$1 AND code=$2', [app, code])).rows[0];
  const salBefore = await fn('sal', 'D0'), perBefore = await fn('per', 'D1');
  file.f.sal.D0.p = 50; file.f.sal.D0.t = 2;                            // commercial change
  file.f.per.D1.p = 90;                                                 // HR change in the same file → must be ignored
  file.rep.sal = { p: 40, rs: 1, nt: '' };                              // commercial reports
  file.rep.per = { p: 70, rs: 1, nt: '' };                              // HR reports → outside the member's scope
  const content = JSON.stringify(file);

  const member = await as('commember');
  const pv = (await member.post('/imports/preview', { content })).data;
  assert.deepEqual(pv.options.map(o => o.target + ':' + (o.department_id || '')), ['department:com', 'reports:']);
  assert.equal(pv.options[0].changes, 2);
  assert.equal(pv.options[1].changes, 2);                               // sal progress + status, per ignored
  assert.equal((await member.post('/imports', { content, target: 'department' })).data.error, 'department_required');
  assert.equal((await member.post('/imports', { content, target: 'department', department_id: 'hr' })).status, 403);

  const b1 = (await member.post('/imports', { content, target: 'department', department_id: 'com', filename: 'com.json' })).data.batch;
  assert.equal(b1.status, 'pending');
  assert.equal(+(await fn('sal', 'D0')).progress, +salBefore.progress); // nothing applied yet
  const b2 = (await member.post('/imports', { content, target: 'department', department_id: 'com' })).data.batch;
  assert.equal((await root.get('/imports/' + b1.id)).data.batch.status, 'superseded');

  assert.equal((await member.post(`/imports/${b2.id}/approve`, { stage: 'lead' })).status, 403);
  assert.equal((await (await as('hrlead')).post(`/imports/${b2.id}/approve`, { stage: 'lead' })).status, 403);
  const lead = await as('comlead');
  assert.equal((await lead.post(`/imports/${b2.id}/approve`, { stage: 'lead', note: 'checked' })).data.applied, false);
  assert.equal((await lead.post(`/imports/${b2.id}/approve`, { stage: 'final' })).status, 403);
  assert.equal((await (await as('pm1')).get('/imports/pending-count')).data.awaiting_me, 1);
  const fin = (await (await as('pm1')).post(`/imports/${b2.id}/approve`, { stage: 'final' })).data;
  assert.equal(fin.applied, true);
  assert.equal(fin.applied_changes, 2);
  assert.equal(fin.skipped_changes, 0);
  assert.equal(+(await fn('sal', 'D0')).progress, 50);
  assert.equal((await fn('sal', 'D0')).test_status, 2);
  assert.equal(+(await fn('per', 'D1')).progress, +perBefore.progress); // HR untouched
  // the imported function has its own audit row: before → after, in the uploader's name, with both approvers
  const d0 = await fn('sal', 'D0');
  const imp = (await pool.query(`SELECT * FROM audit_log WHERE action='update' AND entity='function' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [String(d0.id)])).rows[0];
  assert.deepEqual([imp.new_value.progress, imp.new_value.test_status], [50, 2]);
  assert.ok('progress' in imp.old_value && 'test_status' in imp.old_value);
  assert.equal(imp.username, 'commember');
  assert.deepEqual([imp.context.via, imp.context.batch_id, imp.context.approved_by.username, imp.context.final_by.username], ['import', b2.id, 'comlead', 'pm1']);

  // reports option: only the member's departments; rejected → nothing changes
  const b3 = (await member.post('/imports', { content, target: 'reports' })).data.batch;
  assert.deepEqual(b3.departments, ['com']);
  const d3 = (await member.get('/imports/' + b3.id)).data;
  assert.ok(d3.changes.every(ch => ch.kind === 'report' && ch.app_id === 'sal'));
  assert.equal((await (await as('tm1')).post(`/imports/${b3.id}/reject`, { reason: '' })).data.error, 'reason_required');
  assert.equal((await (await as('tm1')).post(`/imports/${b3.id}/reject`, { reason: 'numbers not agreed' })).status, 200);
  assert.equal(+(await pool.query(`SELECT progress FROM app_reports WHERE app_id='sal'`)).rows[0].progress, 0);
  const audit = (await pool.query(`SELECT action FROM audit_log WHERE entity='import_batch' ORDER BY id`)).rows.map(x => x.action);
  for (const a of ['import_submit', 'import_approve_lead', 'import_approve_final', 'import_apply', 'import_reject']) assert.ok(audit.includes(a), a);
});

test('branding: upload, serve, reject non-images, reset', { skip }, async () => {
  const root = client(); await root.login('root');
  const png = 'data:image/png;base64,' + Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64').toString('base64');
  assert.equal((await fetch(base + '/branding/logo')).status, 404);                         // default until uploaded
  assert.equal((await root.put('/branding/logo', { data: png })).status, 200);
  const r = await fetch(base + '/branding/logo');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok((await client().get('/auth/public-info')).data.branding.logo > 0);
  const svg = 'data:image/png;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  assert.equal((await root.put('/branding/login_bg', { data: svg })).data.error, 'invalid_image');  // SVG refused even if labelled png
  const t = client(); await t.login('tester');
  assert.equal((await t.put('/branding/logo', { data: png })).status, 403);
  assert.equal((await root.del('/branding/logo')).status, 200);
  assert.equal((await fetch(base + '/branding/logo')).status, 404);
});

test('direct edits by data-entry users wait for the department team lead only', { skip }, async () => {
  const as = async u => { const c = client(); await c.login(u); return c; };
  const member = await as('commember'), lead = await as('comlead'), pm = await as('pm1'), hrlead = await as('hrlead');
  const fn = async code => (await pool.query(`SELECT * FROM functions WHERE app_id='sal' AND code=$1`, [code])).rows[0];
  const f = await fn('D3');
  // member edit → pending, value unchanged, lead sees it
  const r1 = await member.patch('/tracker/functions/' + f.id, { progress: 30 });
  assert.equal(r1.status, 202);
  assert.equal(+(await fn('D3')).progress, +f.progress);
  // editing the same value again replaces the earlier pending value
  const r2 = await member.patch('/tracker/functions/' + f.id, { progress: 40 });
  assert.equal((await pool.query('SELECT status FROM edit_requests WHERE id=$1', [r1.data.request_id])).rows[0].status, 'superseded');
  assert.equal((await lead.get('/approvals/pending-count')).data.awaiting_me, 1);
  assert.equal((await pm.get('/approvals/pending-count')).data.awaiting_me, 0);     // PM / TM not needed
  assert.equal((await hrlead.post(`/approvals/${r2.data.request_id}/approve`)).status, 403);  // other department's lead
  assert.equal((await member.post(`/approvals/${r2.data.request_id}/approve`)).status, 403);  // not own request
  const ap = (await lead.post(`/approvals/${r2.data.request_id}/approve`)).data;
  assert.equal(ap.applied_changes, 1);
  assert.equal(+(await fn('D3')).progress, 40);
  // audit: the request lists the item with its before → after value; the applied change has its own row in the
  // member's name, with the approving lead in its context
  const aud = async (where, args) => (await pool.query(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT 1`, args)).rows[0];
  const req2 = await aud(`action='edit_request' AND entity_id=$1`, [String(r2.data.request_id)]);
  assert.deepEqual(req2.context.items.map(i => [i.code, i.field, +i.old, i.new]), [['D3', 'progress', +f.progress, 40]]);
  const upd = await aud(`action='update' AND entity='function' AND entity_id=$1`, [String(f.id)]);
  assert.equal(upd.username, 'commember');
  assert.deepEqual([+upd.old_value.progress, upd.new_value.progress], [+f.progress, 40]);
  assert.equal(upd.context.via, 'edit_request');
  assert.equal(upd.context.approved_by.username, 'comlead');
  assert.equal(upd.context.request_id, r2.data.request_id);
  // the application page shows pending values
  const r3 = await member.patch('/tracker/functions/' + f.id, { progress: 55 });
  const page = (await member.get('/tracker/applications/sal')).data;
  assert.ok(page.needs_approval);
  assert.ok(page.pending.some(p => p.function_id === f.id && p.field === 'progress' && p.new_value === 55));
  assert.equal((await lead.post(`/approvals/${r3.data.request_id}/reject`, { reason: '' })).data.error, 'reason_required');
  assert.equal((await lead.post(`/approvals/${r3.data.request_id}/reject`, { reason: 'not tested yet' })).status, 200);
  assert.equal(+(await fn('D3')).progress, 40);
  const rej = (await pool.query(`SELECT * FROM audit_log WHERE action='edit_reject' AND entity_id=$1`, [String(r3.data.request_id)])).rows[0];
  assert.equal(rej.context.reason, 'not tested yet');
  assert.equal(rej.context.requested_by.username, 'commember');
  assert.deepEqual(rej.context.items.map(i => [i.field, i.new]), [['progress', 55]]);
  // reports and bulk by the member are pending too
  assert.equal((await member.patch('/tracker/reports/sal', { progress: 25 })).status, 202);
  const bulk = await member.post('/tracker/applications/sal/bulk', { field: 'progress', value: 100 });
  assert.equal(bulk.status, 202);
  assert.ok(bulk.data.requested > 1);
  const all = (await lead.post('/approvals/approve-all', {})).data;
  assert.equal(all.requests, 2);
  assert.equal(+(await pool.query(`SELECT progress FROM app_reports WHERE app_id='sal'`)).rows[0].progress, 25);
  // each function the bulk request changed, and the report, has its own before → after row
  const perFn = (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='update' AND entity='function'
    AND context->>'request_id'=$1 AND (new_value->>'progress')::numeric=100`, [String(bulk.data.request_id)])).rows[0].n;
  assert.equal(perFn, all.applied_changes - 1);
  const rep = (await pool.query(`SELECT * FROM audit_log WHERE action='update' AND entity='report' AND entity_id='sal' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.deepEqual(rep.new_value, { progress: 25 });
  assert.equal(rep.username, 'commember');
  // the team lead (department scope) reads these rows, with names joined for display
  const lg = (await lead.get('/logs/audit?limit=200')).data.rows;
  assert.ok(lg.some(x => x.action === 'edit_request' && x.context?.app_id === 'sal'));
  const row = lg.find(x => x.entity === 'function' && x.entity_id === String(f.id));
  assert.equal(row.fn_code, 'D3');
  assert.equal(row.app_id, 'sal');
  assert.ok(row.full_name);
  // team lead and project manager edits apply directly
  assert.equal((await lead.patch('/tracker/functions/' + f.id, { progress: 60 })).status, 200);
  assert.equal((await pm.patch('/tracker/functions/' + f.id, { progress: 65 })).status, 200);
  // the rule can be switched off
  await pool.query(`UPDATE settings SET value='false' WHERE key='approval.edits_need_lead'`); await waitSettingsCache();
  assert.equal((await member.patch('/tracker/functions/' + f.id, { progress: 70 })).status, 200);
  await pool.query(`UPDATE settings SET value='true' WHERE key='approval.edits_need_lead'`); await waitSettingsCache();
});

test('logs API: filters and CSV export', { skip }, async () => {
  const c = client(); await c.login('root');
  const r = await c.get('/logs/auth?success=false&limit=5');
  assert.equal(r.status, 200);
  assert.ok(r.data.rows.every(x => x.success === false));
  const csv = await c.get('/logs/audit/export');
  assert.match(csv.data, /action/);
  const t = client(); await t.login('tester');
  assert.equal((await t.get('/logs/auth')).status, 403);
});

test('project timeline: settings dates drive the periods; project status and snapshots', { skip }, async () => {
  const c = client(); await c.login('root');
  assert.equal((await c.put('/tracker/timeline', { start_date: '2026-03-01', end_date: '2026-02-01' })).data.error, 'end_before_start');
  assert.equal((await c.put('/tracker/timeline', { start_date: '2026-02-30', end_date: null })).status, 400);
  assert.equal((await c.put('/tracker/timeline', { start_date: null, end_date: '2027-01-01' })).data.error, 'start_required');
  const r = await c.put('/tracker/timeline', { start_date: '2026-01-31', end_date: '2027-01-31' });
  assert.equal(r.status, 200); assert.equal(r.data.periods, 12);
  const s = (await c.get('/tracker/schedule')).data;
  assert.equal(s.start_date, '2026-01-31'); assert.equal(s.end_date, '2027-01-31'); assert.equal(s.periods, 12);
  // the schedule screen cannot move the dates or the period count once a close date is set
  await c.put('/tracker/schedule', { start_date: '2025-01-01', periods: 5, unit: 'month', plan: null, actual: [5, 10] });
  const s2 = (await c.get('/tracker/schedule')).data;
  assert.equal(s2.start_date, '2026-01-31'); assert.equal(s2.periods, 12); assert.deepEqual(s2.actual.slice(0, 3), [5, 10, null]);
  // fortnights: 52 weeks → 26 periods; too long a project is refused
  await pool.query(`UPDATE schedule SET unit='fortnight'`);
  assert.equal((await c.put('/tracker/timeline', { start_date: '2026-01-01', end_date: '2026-12-31' })).data.periods, 26);
  assert.equal((await c.put('/tracker/timeline', { start_date: '2026-01-01', end_date: '2029-01-01' })).data.error, 'timeline_too_long');
  await pool.query(`UPDATE schedule SET unit='month'`);
  // a non-admin cannot change the timeline
  const t = client(); await t.login('tester');
  assert.equal((await t.put('/tracker/timeline', { start_date: '2026-01-01', end_date: '2026-06-01' })).status, 403);
  // snapshots + status payload
  await (await import('../src/services/snapshots.js')).takeSnapshot();
  const st = (await c.get('/tracker/project-status')).data;
  assert.equal(st.trend.length, 1);
  assert.ok(st.counts.functions > 0 && st.counts.done + st.counts.in_progress + st.counts.not_started === st.counts.functions);
  assert.equal(st.schedule.end_date, '2026-12-31');
  const h = client(); await h.login('hred');           // scoped user: own department only
  const sh = (await h.get('/tracker/project-status')).data;
  assert.deepEqual(sh.departments.map(d => d.id), ['hr']);
});

test('functions: add, remove (any source) and restore, with impact, approval and exclusion everywhere', { skip }, async () => {
  const as = async u => { const c = client(); await c.login(u); return c; };
  const member = await as('commember'), lead = await as('comlead'), root = await as('root'), hred = await as('hred');
  const appPct = async c => (await c.get('/tracker/applications/sal')).data.application.calc;
  // impact preview of an addition
  const imp = await lead.post('/tracker/applications/sal/impact', { add: { weight: 2, progress: 100, enabled: true } });
  assert.equal(imp.status, 200);
  assert.ok(imp.data.app.after > imp.data.app.before && imp.data.count.after === imp.data.count.before + 1);
  // validation
  assert.equal((await lead.post('/tracker/applications/sal/functions', { name_ar: '  ' })).data.error, 'name_required');
  // team lead adds directly; codes are never reused
  const before = await appPct(lead);
  const a1 = await lead.post('/tracker/applications/sal/functions', { name_ar: 'وظيفة جديدة', weight: 2, progress: 100 });
  assert.equal(a1.status, 201); assert.match(a1.data.function.code, /^C\d+$/);
  assert.ok((await appPct(lead)).pct > before.pct);
  // excluded on creation → no effect on the percentages
  const a2 = await lead.post('/tracker/applications/sal/functions', { name_ar: 'غير محسوبة', enabled: false, progress: 100 });
  assert.equal(a2.data.function.enabled, false);
  // a team member's addition waits for the team lead
  const m1 = await member.post('/tracker/applications/sal/functions', { name_ar: 'مقترح عضو', reference: 'سبب' });
  assert.equal(m1.status, 202);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM functions WHERE name_ar='مقترح عضو'`)).rows[0].n, 0);
  assert.equal((await lead.post(`/approvals/${m1.data.request_id}/approve`)).data.applied_changes, 1);
  const created = (await pool.query(`SELECT * FROM functions WHERE name_ar='مقترح عضو'`)).rows[0];
  assert.ok(created && created.source === 'custom');
  // remove a scope (catalog) function: reason required, then out of every calculation and list
  const d = (await pool.query(`SELECT * FROM functions WHERE app_id='sal' AND source<>'custom' AND enabled ORDER BY id LIMIT 1`)).rows[0];
  assert.equal((await lead.post(`/tracker/functions/${d.id}/remove`, {})).data.error, 'reason_required');
  const cnt = (await appPct(lead)).count;
  const rm = await lead.post(`/tracker/functions/${d.id}/remove`, { reason: 'خارج النطاق' });
  assert.equal(rm.status, 200); assert.ok(rm.data.impact.count.after === rm.data.impact.count.before - 1);
  assert.equal((await appPct(lead)).count, cnt - 1);
  assert.equal((await lead.patch('/tracker/functions/' + d.id, { enabled: true })).data.error, 'function_removed');
  assert.equal((await lead.post(`/tracker/functions/${d.id}/remove`, { reason: 'x' })).data.error, 'function_removed');
  const fnRow = (await lead.get('/tracker/applications/sal')).data.functions.find(f => f.id === d.id);
  assert.ok(fnRow.removed_at && fnRow.removed_reason === 'خارج النطاق' && fnRow.enabled === false);
  // the catalog seed and a full legacy import do not bring it back
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const exp = (await root.get('/tracker/export')).data;
  assert.equal(exp.f.sal[d.code], undefined);
  exp.f.sal[d.code] = { w: 1, p: 50, on: 1 };
  await root.post('/tracker/import', { payload: exp });
  assert.ok((await pool.query('SELECT removed_at FROM functions WHERE id=$1', [d.id])).rows[0].removed_at);
  // a member's restore waits; the lead approves it
  const m2 = await member.post(`/tracker/functions/${d.id}/restore`);
  assert.equal(m2.status, 202);
  await lead.post(`/approvals/${m2.data.request_id}/approve`);
  const back = (await pool.query('SELECT * FROM functions WHERE id=$1', [d.id])).rows[0];
  assert.equal(back.removed_at, null); assert.equal(back.enabled, true);
  // a member's removal of a custom function → approve → removed; new codes keep counting up
  const m3 = await member.post(`/tracker/functions/${created.id}/remove`, { reason: 'مكرر' });
  await lead.post(`/approvals/${m3.data.request_id}/approve`);
  const a3 = await lead.post('/tracker/applications/sal/functions', { name_ar: 'أخرى' });
  assert.ok(+a3.data.function.code.slice(1) > +created.code.slice(1));
  // scope: another department's application is refused
  assert.equal((await hred.post('/tracker/applications/sal/functions', { name_ar: 'x' })).status, 403);
});

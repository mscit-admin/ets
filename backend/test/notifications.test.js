// Notifications (1.9.0): generation rules of each family with exact fixtures, scope / permission at creation and at
// read, the policy matrix and mandatory types, de-duplication and the hourly cap, the scheduler's advisory lock,
// settings validation, audit rows, the live "notif_changed" event, and the shared health module.
// Needs TEST_DATABASE_URL like api.test.js (the public schema of that database is DROPPED and recreated).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool, scan, notify, live, ids = {};
const DAY = 864e5;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none', LIVE_HEARTBEAT_SECONDS: '1',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  const users = [['root', 'admin'], ['pm1', 'pm'], ['lead_hr', 'lead'], ['mem_hr', 'member'], ['qa_hr', 'qa'], ['obs_hr', 'obs'],
    ['mem_app', 'member'], ['mem_fin', 'member'], ['gone', 'member']];
  for (const [u, role] of users) {
    ids[u] = (await pool.query(`INSERT INTO users(username, full_name, password_hash, role_id, must_change_password, language)
      VALUES ($1,$2,$3,$4,false,'ar') RETURNING id`, [u, 'User ' + u, h, role])).rows[0].id;
  }
  for (const u of ['lead_hr', 'mem_hr', 'qa_hr', 'obs_hr', 'gone']) await pool.query(`INSERT INTO user_scopes VALUES ($1,'department','hr')`, [ids[u]]);
  await pool.query(`INSERT INTO user_scopes VALUES ($1,'application','rec')`, [ids.mem_app]);
  await pool.query(`INSERT INTO user_scopes VALUES ($1,'department','fin')`, [ids.mem_fin]);
  scan = await import('../src/services/notify-scan.js');
  notify = await import('../src/services/notify.js');
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
  await new Promise(r => setTimeout(r, 300));
  await pool.end();
});

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get cookie() { return cookie; }, get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b), del: (p, b) => call('DELETE', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }) };
}
const as = async u => { const c = client(); assert.equal((await c.login(u)).status, 200, 'login ' + u); return c; };
const rows = async (user, type) => (await pool.query(`SELECT * FROM notifications WHERE user_id=$1 ${type ? 'AND type=$2' : ''} ORDER BY id`,
  type ? [ids[user], type] : [ids[user]])).rows;
const open = async (user, type) => (await rows(user, type)).filter(r => !r.read_at);
const fnIds = async (app, n) => (await pool.query(`SELECT id FROM functions WHERE app_id=$1 AND enabled AND removed_at IS NULL ORDER BY sort, id LIMIT $2`, [app, n])).rows.map(r => r.id);
// sets values, then the change times (the trigger sets them to now() when progress / test status change)
async function setFns(idList, values, { progressAgo = null, testAgo = null } = {}) {
  const keys = Object.keys(values);
  if (keys.length) await pool.query(`UPDATE functions SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id = ANY($1)`, [idList, ...keys.map(k => values[k])]);
  if (progressAgo !== null) await pool.query(`UPDATE functions SET progress_changed_at = now() - make_interval(days => $2) WHERE id = ANY($1)`, [idList, progressAgo]);
  if (testAgo !== null) await pool.query(`UPDATE functions SET test_changed_at = now() - make_interval(days => $2) WHERE id = ANY($1)`, [idList, testAgo]);
}
const clean = () => pool.query('DELETE FROM notifications');
const settingsCache = () => import('../src/services/settings.js').then(m => m.invalidateSettings());
const setSetting = async (k, v) => { await pool.query(`UPDATE settings SET value=$2 WHERE key=$1`, [k, JSON.stringify(v)]); await settingsCache(); };
const digest = () => scan.runScan({ force: ['digest'] });

test('migration 017: change-time columns filled; the trigger moves them only when progress / test status change', { skip }, async () => {
  const nulls = (await pool.query('SELECT count(*)::int AS n FROM functions WHERE progress_changed_at IS NULL OR test_changed_at IS NULL')).rows[0].n;
  assert.equal(nulls, 0);
  const [id] = await fnIds('per', 1);
  await setFns([id], {}, { progressAgo: 30, testAgo: 30 });
  const t0 = (await pool.query('SELECT progress_changed_at, test_changed_at FROM functions WHERE id=$1', [id])).rows[0];
  await pool.query(`UPDATE functions SET note='x', notif_status=1 WHERE id=$1`, [id]);
  const t1 = (await pool.query('SELECT progress_changed_at, test_changed_at FROM functions WHERE id=$1', [id])).rows[0];
  assert.deepEqual(t1, t0, 'a note / notification change keeps both times');
  await pool.query(`UPDATE functions SET progress=10 WHERE id=$1`, [id]);
  const t2 = (await pool.query('SELECT progress_changed_at, test_changed_at FROM functions WHERE id=$1', [id])).rows[0];
  assert.ok(Date.now() - t2.progress_changed_at < 60_000 && +t2.test_changed_at === +t0.test_changed_at);
  await pool.query(`UPDATE functions SET test_status=3 WHERE id=$1`, [id]);
  const t3 = (await pool.query('SELECT test_changed_at FROM functions WHERE id=$1', [id])).rows[0];
  assert.ok(Date.now() - t3.test_changed_at < 60_000);
  await pool.query(`UPDATE functions SET progress=0, test_status=0, note='', notif_status=0 WHERE id=$1`, [id]);
  for (const t of ['notifications', 'notification_prefs', 'notification_user_blocks', 'notify_state', 'mobile_devices', 'device_pair_codes']) {
    assert.ok((await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [t])).rows[0].ok, t);
  }
});

test('the health calculation is the same file on the server and in the browser', { skip }, () => {
  const a = fs.readFileSync(new URL('../src/services/health.js', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../../frontend/src/lib/health.js', import.meta.url), 'utf8');
  assert.equal(a, b);
});

test('T1 stuck: per application for scoped users, per department for full scope, critical after 2N, only with pct', { skip }, async () => {
  await clean();
  const [a, b, c] = await fnIds('per', 3);
  await setFns([a, b, c], { progress: 50 }, { progressAgo: 20 });       // 20 days > 14
  const [x] = await fnIds('rec', 1);
  await setFns([x], { progress: 40 }, { progressAgo: 10 });             // 10 days: not yet
  await digest();
  const m = await open('mem_hr', 'stuck');
  assert.equal(m.length, 1);
  assert.equal(m[0].app_id, 'per'); assert.equal(m[0].count, 3); assert.equal(m[0].severity, 'warning');
  assert.equal(m[0].dedupe_key, 'stuck:app=per'); assert.equal(m[0].link, '/app/per?filter=stuck');
  assert.equal((await open('lead_hr', 'stuck')).length, 1);
  assert.equal((await open('qa_hr', 'stuck')).length, 0, 'qa has no pct');
  assert.equal((await open('obs_hr', 'stuck')).length, 0, 'observer: not eligible');
  assert.equal((await open('mem_app', 'stuck')).length, 0, 'scope rec only: nothing stuck there');
  assert.equal((await open('mem_fin', 'stuck')).length, 0, 'other department');
  assert.equal((await open('root', 'stuck')).length, 0, 'admin: off by default');
  const p = await open('pm1', 'stuck');
  assert.equal(p.length, 1); assert.equal(p[0].dept_id, 'hr'); assert.equal(p[0].app_id, null); assert.equal(p[0].count, 3);
  // the text in Arabic and English
  const ar = (await (await as('mem_hr')).get('/notifications')).data.items.find(i => i.type === 'stuck');
  assert.match(ar.title, /^3 وظائف في تطبيق .+ بلا تقدّم منذ أكثر من 14 يوماً$/);
  const en = (await (await as('mem_hr')).get('/notifications?lang=en')).data.items.find(i => i.type === 'stuck');
  assert.match(en.title, /^3 functions in .+ without progress for more than 14 days$/);
  // 2N → critical; the open summary is updated in place, never duplicated
  await setFns([a], {}, { progressAgo: 30 });
  await digest(); await digest();
  const m2 = await open('mem_hr', 'stuck');
  assert.equal(m2.length, 1); assert.equal(m2[0].id, m[0].id); assert.equal(m2[0].severity, 'critical');
  // fixed: the summary closes
  await setFns([a, b, c], { progress: 0 });
  await digest();
  assert.equal((await open('mem_hr', 'stuck')).length, 0);
  assert.ok((await rows('mem_hr', 'stuck'))[0].resolved_at);
});

test('T2 untested, T3 failed not re-tested, T4 «نجح» below 100 %: rules and recipients', { skip }, async () => {
  await clean();
  const [u1, u2, f1, c1] = await fnIds('rec', 4);
  await setFns([u1, u2], { progress: 100, test_status: 0 }, { progressAgo: 8 });
  await setFns([f1], { test_status: 3 }, { testAgo: 9 });
  await setFns([c1], { progress: 80, test_status: 2 });
  const [recent] = await fnIds('per', 1);
  await setFns([recent], { progress: 100, test_status: 0 }, { progressAgo: 2 });     // too recent
  await digest();
  for (const u of ['mem_app', 'qa_hr', 'mem_hr', 'lead_hr']) {
    const un = await open(u, 'untested');
    assert.equal(un.length, 1, u + ' untested'); assert.equal(un[0].count, 2); assert.equal(un[0].app_id, 'rec');
    const fl = await open(u, 'failed_retest');
    assert.equal(fl.length, 1, u + ' failed'); assert.equal(fl[0].severity, 'critical');
    assert.equal((await open(u, 'pass_conflict'))[0]?.count, 1, u + ' conflict');
  }
  assert.equal((await open('mem_fin', 'untested')).length, 0);
  assert.equal((await open('obs_hr', 'failed_retest')).length, 0);
  // a report item is named as such
  await pool.query(`UPDATE functions SET item_type='report' WHERE id = ANY($1)`, [[u1, u2]]);
  await digest();
  const t = (await (await as('mem_app')).get('/notifications')).data.items.find(i => i.type === 'untested');
  assert.match(t.title, /^تقريران في تطبيق .+ بنسبة 100% دون اختبار منذ أكثر من 7 أيام$/);
  await pool.query(`UPDATE functions SET item_type='function' WHERE id = ANY($1)`, [[u1, u2]]);
  await setFns([u1, u2, f1, c1, recent], { progress: 0, test_status: 0 });
});

test('a summary read is not repeated within the interval unless it grows; mark read / unread / read-all', { skip }, async () => {
  await clean();
  const [a, b] = await fnIds('per', 2);
  await setFns([a], { progress: 30 }, { progressAgo: 20 });
  await digest();
  const c = await as('mem_hr');
  const first = (await open('mem_hr', 'stuck'))[0];
  assert.equal((await c.post(`/notifications/${first.id}/read`)).data.marked, 1);
  await digest();
  assert.equal((await open('mem_hr', 'stuck')).length, 0, 'same count, read: not repeated');
  await setFns([b], { progress: 30 }, { progressAgo: 20 });
  await digest();
  const again = await open('mem_hr', 'stuck');
  assert.equal(again.length, 1); assert.equal(again[0].count, 2); assert.notEqual(again[0].id, first.id);
  assert.equal((await c.post(`/notifications/${again[0].id}/read`)).data.marked, 1);
  assert.equal((await c.post(`/notifications/${again[0].id}/unread`)).data.marked, 1);
  assert.equal((await c.get('/notifications/count')).data.unread, 1);
  assert.equal((await c.post('/notifications/read-all')).data.marked, 1);
  assert.equal((await c.get('/notifications/count')).data.unread, 0);
  // another user's alert cannot be marked
  const other = (await pool.query(`INSERT INTO notifications(user_id,type,category,severity,dedupe_key) VALUES ($1,'stuck','tracking','warning','x') RETURNING id`, [ids.lead_hr])).rows[0].id;
  assert.equal((await c.post(`/notifications/${other}/read`)).data.marked, 0);
  await setFns([a, b], { progress: 0 });
});

test('eligibility is checked again at read: scope and permission removed → hidden (not deleted), back when restored', { skip }, async () => {
  await clean();
  const [a] = await fnIds('per', 1);
  await setFns([a], { progress: 30 }, { progressAgo: 20 });
  await digest();
  const c = await as('mem_hr');
  assert.equal((await c.get('/notifications/count')).data.unread, 1);
  const root = await as('root');
  // scope moved to finance
  assert.equal((await root.patch(`/users/${ids.mem_hr}`, { scopes: [{ kind: 'department', ref_id: 'fin' }] })).status, 200);
  assert.equal((await c.get('/notifications/count')).data.unread, 0);
  assert.equal((await c.get('/notifications')).data.items.length, 0);
  assert.equal((await rows('mem_hr', 'stuck')).length, 1, 'kept in the table');
  await root.patch(`/users/${ids.mem_hr}`, { scopes: [{ kind: 'department', ref_id: 'hr' }] });
  assert.equal((await c.get('/notifications/count')).data.unread, 1);
  // permission pct revoked by an override
  await root.patch(`/users/${ids.mem_hr}`, { overrides: [{ permission: 'pct', granted: false }] });
  assert.equal((await c.get('/notifications/count')).data.unread, 0);
  await digest();
  assert.equal((await rows('mem_hr', 'stuck')).filter(r => !r.read_at).length, 0, 'not created again without pct (and closed)');
  await root.patch(`/users/${ids.mem_hr}`, { overrides: [] });
  await setFns([a], { progress: 0 });
});

test('policy matrix: switching a cell off hides and stops; ❌ cells cannot be enabled, 🔒 cells cannot be disabled; audited', { skip }, async () => {
  await clean();
  const root = await as('root');
  const meta = (await root.get('/notifications/policy-meta')).data;
  assert.ok(meta.types.find(t => t.type === 'approval_pending').locked.includes('lead'));
  assert.ok(!meta.types.find(t => t.type === 'stuck').eligible.includes('qa'));
  assert.equal(meta.policy.stuck.roles.member, true);
  assert.equal(meta.policy.account_locked.push, false, 'S1 in-app only by default');
  assert.equal((await (await as('pm1')).get('/notifications/policy-meta')).status, 403, 'cfg needed');
  const r1 = await root.put('/settings', { 'notify.policy': { stuck: { roles: { qa: true } } } });
  assert.equal(r1.status, 400); assert.equal(r1.data.key, 'notify.policy');
  assert.equal((await root.put('/settings', { 'notify.policy': { approval_pending: { roles: { lead: false } } } })).status, 400);
  assert.equal((await root.put('/settings', { 'notify.policy': { nonsense: {} } })).status, 400);
  const [a] = await fnIds('per', 1);
  await setFns([a], { progress: 30 }, { progressAgo: 20 });
  await digest();
  const c = await as('mem_hr');
  assert.equal((await c.get('/notifications/count')).data.unread, 1);
  assert.equal((await root.put('/settings', { 'notify.policy': { stuck: { roles: { member: false } } } })).status, 200);
  assert.equal((await c.get('/notifications/count')).data.unread, 0, 'hidden at read');
  await clean(); await digest();
  assert.equal((await rows('mem_hr', 'stuck')).length, 0, 'not created');
  assert.equal((await rows('lead_hr', 'stuck')).length, 1, 'other roles unchanged');
  const au = (await pool.query(`SELECT old_value, new_value FROM audit_log WHERE entity='setting' AND entity_id='notify.policy' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(au.old_value.value.stuck.roles.member, true);
  assert.equal(au.new_value.value.stuck.roles.member, false);
  assert.equal(au.new_value.value.approval_pending.roles.lead, true, 'stored complete');
  // the admin may make a type mandatory: members can no longer mute it
  await root.put('/settings', { 'notify.policy': { stuck: { roles: { member: true }, mandatory: true } } });
  assert.equal((await c.put('/notifications/prefs', { muted: ['stuck'] })).data.error, 'mandatory_type');
  await root.put('/settings', { 'notify.policy': { stuck: { roles: { member: true }, mandatory: false } } });
  await setFns([a], { progress: 0 });
});

test('preferences: non-mandatory types muted (in-app and phone) and daily summaries off; mandatory types locked', { skip }, async () => {
  await clean();
  const lead = await as('lead_hr');
  const p = (await lead.get('/notifications/prefs')).data;
  const ap = p.types.find(t => t.type === 'approval_pending');
  assert.equal(ap.mandatory, true);
  assert.ok(!p.types.some(t => t.type === 'account_locked'), 'security types are not offered to a lead');
  assert.equal((await lead.put('/notifications/prefs', { muted: ['approval_pending'] })).data.error, 'mandatory_type');
  assert.equal((await lead.put('/notifications/prefs', { mobile_muted: ['approval_pending'] })).data.error, 'mandatory_type');
  const [a] = await fnIds('per', 1);
  await setFns([a], { progress: 30 }, { progressAgo: 20 });
  assert.equal((await lead.put('/notifications/prefs', { muted: ['stuck'] })).status, 200);
  await digest();
  assert.equal((await rows('lead_hr', 'stuck')).length, 0, 'muted: not created');
  await lead.put('/notifications/prefs', { muted: [], digest: false });
  await digest();
  assert.equal((await rows('lead_hr', 'stuck')).length, 0, 'daily summaries off');
  await lead.put('/notifications/prefs', { digest: true });
  await digest();
  assert.equal((await open('lead_hr', 'stuck')).length, 1);
  assert.equal((await lead.put('/notifications/prefs', { muted: ['nope'] })).status, 400);
  await setFns([a], { progress: 0 });
});

test('per-user blocks: admin only, never on oneself, mandatory types not blockable on every channel, audited', { skip }, async () => {
  await clean();
  const root = await as('root');
  const [a] = await fnIds('per', 1);
  await setFns([a], { progress: 30 }, { progressAgo: 20 });
  await digest();
  const m = await as('mem_hr');
  assert.equal((await m.get('/notifications/count')).data.unread, 1);
  assert.equal((await root.put(`/users/${ids.mem_hr}/notify-blocks`, { blocks: [{ type: 'stuck', channel: 'all' }] })).status, 200);
  assert.equal((await m.get('/notifications/count')).data.unread, 0);
  assert.equal((await (await as('lead_hr')).put(`/users/${ids.mem_hr}/notify-blocks`, { blocks: [] })).status, 403);
  assert.equal((await root.put(`/users/${ids.root}/notify-blocks`, { blocks: [] })).data.error, 'cannot_change_own_permissions');
  assert.equal((await root.put(`/users/${ids.lead_hr}/notify-blocks`, { blocks: [{ type: 'approval_pending', channel: 'all' }] })).data.error, 'mandatory_type');
  assert.equal((await root.put(`/users/${ids.lead_hr}/notify-blocks`, { blocks: [{ type: 'approval_pending', channel: 'mobile' }] })).status, 200);
  assert.equal((await root.put(`/users/${ids.mem_hr}/notify-blocks`, { blocks: [{ type: 'x', channel: 'all' }] })).status, 400);
  const u = (await root.get(`/users/${ids.mem_hr}`)).data.user;
  assert.deepEqual(u.notify_blocks, [{ type: 'stuck', channel: 'all' }]);
  const au = (await pool.query(`SELECT old_value, new_value, context FROM audit_log WHERE entity='user' AND entity_id=$1 AND action='update'
    AND new_value ? 'notify_blocks' ORDER BY id DESC LIMIT 1`, [String(ids.mem_hr)])).rows[0];
  assert.deepEqual(au.old_value.notify_blocks, []); assert.deepEqual(au.new_value.notify_blocks, [{ type: 'stuck', channel: 'all' }]);
  await root.put(`/users/${ids.mem_hr}/notify-blocks`, { blocks: [] });
  await root.put(`/users/${ids.lead_hr}/notify-blocks`, { blocks: [] });
  assert.equal((await m.get('/notifications/count')).data.unread, 1);
  await setFns([a], { progress: 0 });
});

test('A1 / A3: a request waiting → the team lead (merged per application); decided → its author; closed when none left', { skip }, async () => {
  await clean();
  const [f1, f2] = await fnIds('per', 2);
  const mem = await as('mem_hr');
  const r1 = await mem.patch(`/tracker/functions/${f1}`, { progress: 20 });
  assert.equal(r1.status, 202);
  const lead1 = await open('lead_hr', 'approval_pending');
  assert.equal(lead1.length, 1); assert.equal(lead1[0].count, 1); assert.equal(lead1[0].dedupe_key, 'approval_pending:app=per');
  assert.equal((await rows('mem_hr', 'approval_pending')).length, 0, 'not to the author');
  assert.equal((await rows('pm1', 'approval_pending')).length, 0, 'not eligible (no apv_dept)');
  assert.equal((await rows('root', 'approval_pending')).length, 0);
  const r2 = await mem.patch(`/tracker/functions/${f2}`, { progress: 25 });
  const lead2 = await open('lead_hr', 'approval_pending');
  assert.equal(lead2.length, 1); assert.equal(lead2[0].count, 2, 'merged');
  const lead = await as('lead_hr');
  const t = (await lead.get('/notifications')).data.items[0];
  assert.match(t.title, /^طلبان تعديل جديدة بانتظار اعتمادك$/);
  assert.equal(t.link, '/approvals');
  assert.equal((await lead.post(`/approvals/${r1.data.request_id}/approve`)).status, 200);
  const dec = await open('mem_hr', 'request_decided');
  assert.equal(dec.length, 1); assert.equal(dec[0].params.decision, 'applied'); assert.equal(dec[0].severity, 'info');
  assert.equal((await open('lead_hr', 'approval_pending')).length, 1, 'one still pending');
  assert.equal((await lead.post(`/approvals/${r2.data.request_id}/reject`, { reason: 'not yet' })).status, 200);
  const rej = (await open('mem_hr', 'request_decided')).find(x => x.params.decision === 'rejected');
  assert.equal(rej.severity, 'warning'); assert.equal(rej.params.reason, 'not yet');
  assert.equal((await open('lead_hr', 'approval_pending')).length, 0, 'closed: nothing pending');
  const en = (await mem.get('/notifications?lang=en')).data.items.map(i => i.title);
  assert.ok(en.includes(`Your request #${r2.data.request_id} was rejected`));
  await setFns([f1, f2], { progress: 0 });
});

test('A4 / A5: a result file waits → whoever can sign the missing stage; outcome → uploader and first signer', { skip }, async () => {
  await clean();
  const file = (await (await as('root')).get('/tracker/export')).data;
  file.f.per.D2.p = 35;
  const content = JSON.stringify(file);
  const mem = await as('mem_hr');
  const b1 = (await mem.post('/imports', { content, target: 'department', department_id: 'hr', filename: 'a.json' })).data.batch;
  assert.equal(b1.status, 'pending');
  const lp = await open('lead_hr', 'import_pending');
  assert.equal(lp.length, 1); assert.equal(lp[0].link, `/imports/${b1.id}`); assert.deepEqual(lp[0].params.depts, ['hr']);
  assert.equal((await open('pm1', 'import_pending')).length, 1, 'either stage first: the PM too');
  assert.equal((await rows('mem_hr', 'import_pending')).length, 0, 'not the uploader');
  assert.equal((await rows('root', 'import_pending')).length, 0, 'admin: no approval permission');
  // a newer file replaces it: the old one's alerts close, its uploader hears it was replaced (not when they replaced it)
  const b2 = (await mem.post('/imports', { content, target: 'department', department_id: 'hr', filename: 'b.json' })).data.batch;
  assert.equal((await open('lead_hr', 'import_pending')).map(r => r.params.batch_id).join(), String(b2.id));
  assert.equal((await rows('mem_hr', 'import_result')).length, 0);
  // the lead signs: their alert closes, the PM's stays (now the final stage)
  assert.equal((await (await as('lead_hr')).post(`/imports/${b2.id}/approve`, { stage: 'lead' })).data.applied, false);
  assert.equal((await open('lead_hr', 'import_pending')).length, 0);
  const pmp = await open('pm1', 'import_pending');
  assert.equal(pmp.length, 1); assert.equal(pmp[0].params.stage, 'final');
  assert.equal((await (await as('pm1')).post(`/imports/${b2.id}/approve`, { stage: 'final' })).data.applied, true);
  assert.equal((await open('pm1', 'import_pending')).length, 0);
  for (const u of ['mem_hr', 'lead_hr']) {
    const r = await open(u, 'import_result');
    assert.equal(r.length, 1, u); assert.equal(r[0].params.status, 'applied'); assert.equal(r[0].params.applied, 1);
  }
  assert.equal((await rows('pm1', 'import_result')).length, 0, 'not the one who applied it');
  // rejected
  file.f.per.D2.p = 45;
  const b3 = (await mem.post('/imports', { content: JSON.stringify(file), target: 'department', department_id: 'hr' })).data.batch;
  await (await as('pm1')).post(`/imports/${b3.id}/reject`, { reason: 'wrong file' });
  const rj = (await open('mem_hr', 'import_result')).find(r => r.params.batch_id === b3.id);
  assert.equal(rj.params.status, 'rejected'); assert.equal(rj.params.reason, 'wrong file'); assert.equal(rj.severity, 'warning');
  assert.equal((await open('lead_hr', 'import_pending')).length, 0);
  await pool.query(`UPDATE functions SET progress=0 WHERE app_id='per'`);
});

test('A2: requests waiting → reminder to the lead after 48 h, escalation (critical) to the PM after 5 days', { skip }, async () => {
  await clean();
  const [f] = await fnIds('per', 1);
  const r = await (await as('mem_hr')).patch(`/tracker/functions/${f}`, { progress: 15 });
  await pool.query(`UPDATE edit_requests SET requested_at = now() - interval '3 days' WHERE id=$1`, [r.data.request_id]);
  await digest();
  const l = await open('lead_hr', 'approval_overdue');
  assert.equal(l.length, 1); assert.equal(l[0].params.stage, 'remind'); assert.equal(l[0].severity, 'warning'); assert.equal(l[0].count, 1);
  assert.equal((await open('pm1', 'approval_overdue')).length, 0, 'not escalated yet');
  await pool.query(`UPDATE edit_requests SET requested_at = now() - interval '6 days' WHERE id=$1`, [r.data.request_id]);
  await digest();
  const l2 = await open('lead_hr', 'approval_overdue');
  assert.equal(l2.length, 1); assert.equal(l2[0].params.stage, 'escalate'); assert.equal(l2[0].severity, 'critical');
  const p = await open('pm1', 'approval_overdue');
  assert.equal(p.length, 1); assert.equal(p[0].params.stage, 'escalate');
  assert.match((await (await as('pm1')).get('/notifications')).data.items.find(i => i.type === 'approval_overdue').title, /^تصعيد: /);
  await (await as('lead_hr')).post(`/approvals/${r.data.request_id}/reject`, { reason: 'x' });
  await digest();
  assert.equal((await open('lead_hr', 'approval_overdue')).length, 0);
  await setFns([f], { progress: 0 });
});

test('T7: functions excluded / removed → the application\'s users with pct / tst / tog, not who did it', { skip }, async () => {
  await clean();
  const [f1, f2] = await fnIds('rec', 2);
  const lead = await as('lead_hr');
  assert.equal((await lead.patch(`/tracker/functions/${f1}`, { enabled: false, disabled_reason: 'not_required', disabled_note: 'no need here' })).status, 200);
  assert.equal((await lead.post(`/tracker/functions/${f2}/remove`, { reason: 'gone' })).status, 200);
  const m = await open('mem_app', 'excluded');
  assert.equal(m.length, 1); assert.equal(m[0].count, 2, 'merged per application'); assert.equal(m[0].app_id, 'rec');
  assert.equal((await rows('lead_hr', 'excluded')).length, 0, 'not the person who did it');
  assert.equal((await open('qa_hr', 'excluded')).length, 1);
  assert.equal((await rows('pm1', 'excluded')).length, 0, 'pm: off by default');
  assert.equal((await rows('obs_hr', 'excluded')).length, 0);
  assert.equal((await rows('mem_fin', 'excluded')).length, 0);
  await pool.query(`UPDATE functions SET enabled=true, removed_at=NULL, disabled_reason=NULL, disabled_note=NULL WHERE id = ANY($1)`, [[f1, f2]]);
});

test('P1 department behind the plan (on change only) and P3 project status → department readers, PM / TM', { skip }, async () => {
  await clean();
  const start = new Date(Date.now() - 200 * DAY).toISOString().slice(0, 10), end = new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10);
  await pool.query(`UPDATE schedule SET start_date=$1, end_date=$2, periods=10, unit='month', plan=NULL WHERE id=1`, [start, end]);
  await digest();
  const l = await open('lead_hr', 'dept_behind');
  assert.equal(l.length, 1); assert.equal(l[0].dept_id, 'hr'); assert.equal(l[0].params.status, 'delayed'); assert.equal(l[0].severity, 'critical');
  assert.ok(l[0].params.gap < -15);
  assert.equal((await open('pm1', 'dept_behind')).length, 4, 'every department for the PM');
  assert.equal((await rows('mem_hr', 'dept_behind')).length, 0, 'member: off by default');
  assert.equal((await rows('mem_app', 'dept_behind')).length, 0);
  const ps = await open('pm1', 'project_status');
  assert.equal(ps.length, 1); assert.equal(ps[0].params.to, 'delayed');
  assert.equal((await rows('lead_hr', 'project_status')).length, 0, 'project-wide: full scope only');
  await (await as('lead_hr')).post('/notifications/read-all');
  await digest();
  assert.equal((await open('lead_hr', 'dept_behind')).length, 0, 'status unchanged: no new alert');
  // thresholds from the settings: with a 90-point delay gap HR becomes «at risk» → a new alert
  await setSetting('notify.dept_delay_gap', 95); await setSetting('notify.dept_risk_gap', 1);
  await digest();
  const l2 = await open('lead_hr', 'dept_behind');
  assert.equal(l2.length, 1); assert.equal(l2[0].params.status, 'at_risk');
  const st = (await (await as('lead_hr')).get('/tracker/project-status')).data;
  assert.deepEqual(st.health_gaps, { riskGap: 1, delayGap: 95 });
  await setSetting('notify.dept_delay_gap', 15); await setSetting('notify.dept_risk_gap', 5);
  await pool.query(`UPDATE schedule SET start_date=NULL, end_date=NULL WHERE id=1`);
  await pool.query(`DELETE FROM notify_state WHERE key IN ('dept_status','project_status')`);
});

test('S2 failed sign-ins and S6 backup missing → administrators only; S6 closes when a backup is recorded', { skip }, async () => {
  await clean();
  for (let i = 0; i < 21; i++) await pool.query(`INSERT INTO auth_log(username, event, success, ip) VALUES ('x','login_bad_password',false,'10.9.8.7')`);
  await scan.runScan({ force: [] });                           // the security job runs every time
  const s2 = await open('root', 'failed_logins');
  assert.equal(s2.length, 1); assert.equal(s2[0].count, 21); assert.equal(s2[0].params.ip, '10.9.8.7'); assert.equal(s2[0].severity, 'critical');
  assert.equal((await rows('pm1', 'failed_logins')).length, 0);
  const t = (await (await as('root')).get('/notifications')).data.items.find(i => i.type === 'failed_logins');
  assert.ok(!t.title.includes('10.9.8.7'), 'no address in the title'); assert.ok(t.body.includes('10.9.8.7'));
  // backups: the installation is older than 26 h and no backup row exists
  await pool.query(`INSERT INTO system_log(ts, event, message) VALUES (now() - interval '3 days', 'startup', 'old')`);
  await scan.runScan({ force: ['daily'] });
  const s6 = await open('root', 'backup_missing');
  assert.equal(s6.length, 1); assert.equal(s6[0].severity, 'critical');
  assert.equal((await rows('pm1', 'backup_missing')).length, 0);
  await pool.query(`INSERT INTO system_log(event, message) VALUES ('backup', 'database backup created')`);
  await scan.runScan({ force: ['daily'] });
  assert.equal((await open('root', 'backup_missing')).length, 0);
  // S3 and S6 are mandatory for the admin role: cannot be switched off
  assert.equal((await (await as('root')).put('/settings', { 'notify.policy': { backup_missing: { roles: { admin: false } } } })).status, 400);
});

test('S13 distributed login probing: total login_unknown_user across all IPs ≥ threshold → admins only, once per window; S2 unchanged', { skip }, async () => {
  await clean();
  // auth_log is strictly append-only and its BEFORE INSERT trigger forces ts := now() (no back-dated rows), so the
  // test is monotonic: one fixed fixture of 22 «login_unknown_user» attempts spread 2-per-IP across 11 IPs, and we
  // toggle firing purely via the threshold / window settings. The run takes ~100 ms, so every row stays inside the
  // window throughout.
  const base = (await pool.query(`SELECT count(*)::int AS n FROM auth_log WHERE event='login_unknown_user' AND NOT success AND ts > now() - interval '15 minutes'`)).rows[0].n;
  assert.equal(base, 0, 'no pre-existing unknown-user attempts in the window');
  for (let ip = 0; ip < 11; ip++) for (let j = 0; j < 2; j++) await pool.query(`INSERT INTO auth_log(username, event, success, ip) VALUES ('x','login_unknown_user',false,$1)`, [`10.1.0.${ip}`]);
  await setSetting('notify.distributed_login_window_min', 15);
  // S2's threshold is set HIGHER so its per-IP AND all-together branches stay silent on this spread: only S13 fires,
  // demonstrating S13 catches a distributed unknown-user attack that evades S2's general failed-login threshold.
  await setSetting('notify.failed_logins_threshold', 50);
  // below threshold: 22 < 30 → no alert
  await setSetting('notify.distributed_login_threshold', 30);
  await scan.runScan({ force: [] });
  assert.equal((await open('root', 'distributed_logins')).length, 0, 'below threshold: no alert');
  // at/over threshold: 22 ≥ 20
  await setSetting('notify.distributed_login_threshold', 20);
  await scan.runScan({ force: [] });
  const d = await open('root', 'distributed_logins');
  assert.equal(d.length, 1, 'distributed alert raised');
  assert.equal(d[0].count, 22, 'headline = total unknown-user attempts');
  assert.equal(d[0].params.ips, 11, 'distinct IP count');
  assert.equal(d[0].params.minutes, 15, 'window reported');
  assert.equal(d[0].severity, 'critical');
  assert.equal((await rows('pm1', 'distributed_logins')).length, 0, 'non-admin never receives it');
  // the in-app body names counts/IPs; the title does not
  const t = (await (await as('root')).get('/notifications')).data.items.find(i => i.type === 'distributed_logins');
  assert.ok(!t.title.includes('11') && !t.title.includes('22'), 'no counts in the title');
  assert.ok(t.body.includes('11'), 'body names the distinct IPs');
  // S2 (neither the per-IP GROUP BY ip branch nor the all-together branch) is tripped: its threshold is 50 > 22
  assert.equal((await open('root', 'failed_logins')).length, 0, 'S2 unchanged — its general threshold is not reached');
  // dedup: a second run in the same window does not create a second row
  await scan.runScan({ force: [] });
  assert.equal((await open('root', 'distributed_logins')).length, 1, 'at most once per window');
  // threshold honored: raising it above the total stops a fresh window from firing
  await clean();
  await setSetting('notify.distributed_login_threshold', 100);
  await scan.runScan({ force: [] });
  assert.equal((await open('root', 'distributed_logins')).length, 0, 'threshold honored');
  // window honored: the configured window drives the SQL interval and is reported in the alert params
  await clean();
  await setSetting('notify.distributed_login_threshold', 20);
  await setSetting('notify.distributed_login_window_min', 30);
  await scan.runScan({ force: [] });
  const d30 = await open('root', 'distributed_logins');
  assert.equal(d30.length, 1, 'fires under the wider window');
  assert.equal(d30[0].params.minutes, 30, 'configured window reported');
  await setSetting('notify.distributed_login_window_min', 15);
  await setSetting('notify.failed_logins_threshold', 20);
});

test('S1 account paused → administrators; S7 retention lowered → administrators', { skip }, async () => {
  await clean();
  const c = client();
  for (let i = 0; i < 6; i++) await c.login('obs_hr', 'wrong-password');
  const s1 = await open('root', 'account_locked');
  assert.equal(s1.length, 1); assert.ok(s1[0].count >= 1); assert.equal(s1[0].params.username, 'obs_hr');
  await pool.query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE id=$1', [ids.obs_hr]);
  const root = await as('root');
  assert.equal((await root.put('/settings', { 'logs.retention_days': 100 })).status, 200);
  const s7 = await open('root', 'retention_reduced');
  assert.equal(s7.length, 1); assert.equal(s7[0].params.from, 365); assert.equal(s7[0].params.to, 100);
  await root.put('/settings', { 'logs.retention_days': 365 });
});

test('hourly cap: new alerts above notify.rate_cap_per_hour become one «many alerts» row; mandatory ones are never held back', { skip }, async () => {
  await clean();
  await setSetting('notify.rate_cap_per_hour', 5);
  const [u] = await notify.activeUsers([ids.mem_hr]);
  for (let i = 0; i < 8; i++) await notify.deliver('excluded', [{ user: u, dedupeKey: 'excluded:test=' + i, appId: 'per', params: { app_id: 'per' } }]);
  const all = await rows('mem_hr');
  assert.equal(all.filter(r => r.type === 'excluded').length, 5);
  const capped = all.find(r => r.type === 'rate_capped');
  assert.equal(capped.count, 3);
  const [lead] = await notify.activeUsers([ids.lead_hr]);
  for (let i = 0; i < 7; i++) await notify.deliver('approval_pending', [{ user: lead, dedupeKey: 'approval_pending:t' + i, appId: 'per', params: {} }]);
  assert.equal((await rows('lead_hr', 'approval_pending')).length, 7, 'mandatory for the lead: not capped');
  await setSetting('notify.rate_cap_per_hour', 50);
});

test('deactivated / deleted / forced-password users receive nothing', { skip }, async () => {
  await clean();
  const [a] = await fnIds('per', 1);
  await setFns([a], { progress: 30 }, { progressAgo: 20 });
  await pool.query(`UPDATE users SET must_change_password=true WHERE id=$1`, [ids.mem_hr]);
  await pool.query(`UPDATE users SET is_active=false WHERE id=$1`, [ids.lead_hr]);
  const root = await as('root');
  assert.equal((await root.del(`/users/${ids.gone}`, { reason: 'left the team' })).status, 200);
  await digest();
  assert.equal((await rows('gone')).length, 0, 'deleted');
  assert.equal((await rows('mem_hr')).length, 0, 'must change the password first');
  assert.equal((await rows('lead_hr')).length, 0, 'deactivated');
  assert.equal((await rows('pm1', 'stuck')).length, 1, 'the others still do');
  await pool.query(`UPDATE users SET must_change_password=false WHERE id=$1`, [ids.mem_hr]);
  await pool.query(`UPDATE users SET is_active=true WHERE id=$1`, [ids.lead_hr]);
  await setFns([a], { progress: 0 });
});

test('the scheduler takes an advisory lock: a second run while one holds it is skipped', { skip }, async () => {
  const c = await pool.connect();
  try {
    assert.equal((await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [scan.LOCK_KEY])).rows[0].ok, true);
    assert.deepEqual(await scan.runScan({ force: ['digest'] }), { skipped: 'locked' });
    await c.query('SELECT pg_advisory_unlock(hashtext($1))', [scan.LOCK_KEY]);
  } finally { c.release(); }
  const r = await scan.runScan({ force: ['digest'] });
  assert.ok(r.jobs.digest && !r.jobs.digest.error, JSON.stringify(r));
  const [x, y] = await Promise.all([scan.runScan(), scan.runScan()]);
  assert.ok([x, y].some(v => v.skipped === 'locked') || [x, y].every(v => v.jobs), 'two at once: never both inside together');
  // schedule: daily from the digest hour, the digest on work days only (Africa/Tripoli by default)
  const s = { 'notify.digest_hour': 8, 'notify.work_days': [0, 1, 2, 3, 4] };
  assert.deepEqual(scan.dueJobs({ date: '2026-10-18', hour: 7, weekday: 0 }, s, {}), ['security', 'backups']);
  assert.deepEqual(scan.dueJobs({ date: '2026-10-18', hour: 8, weekday: 0 }, s, {}), ['security', 'backups', 'daily', 'digest', 'weekly']);
  assert.deepEqual(scan.dueJobs({ date: '2026-10-23', hour: 9, weekday: 5 }, s, { daily: { day: '2026-10-22' } }), ['security', 'backups', 'daily']);
  assert.deepEqual(scan.dueJobs({ date: '2026-10-19', hour: 9, weekday: 1 }, s, { daily: { day: '2026-10-19' }, digest: { day: '2026-10-18' }, weekly: { day: '2026-10-18' } }),
    ['security', 'backups', 'digest']);
  assert.deepEqual(scan.localParts(new Date('2026-10-18T06:30:00Z'), 'Africa/Tripoli'), { date: '2026-10-18', hour: 8, weekday: 0 });
  assert.ok((await pool.query(`SELECT count(*)::int AS n FROM system_log WHERE event='notify_scan'`)).rows[0].n > 0);
});

test('settings: notification thresholds validated (ranges, days, time zone, risk < delay) and audited', { skip }, async () => {
  const root = await as('root');
  const bad = async (body, key) => { const r = await root.put('/settings', body); assert.equal(r.status, 400, JSON.stringify(body)); if (key) assert.equal(r.data.key, key); };
  await bad({ 'notify.stuck_days': 2 }, 'notify.stuck_days');
  await bad({ 'notify.stuck_days': 14.5 });
  await bad({ 'notify.work_days': [7] }, 'notify.work_days');
  await bad({ 'notify.work_days': [] });
  await bad({ 'notify.work_days': [1, 1] });
  await bad({ 'notify.timezone': 'Mars/Olympus' }, 'notify.timezone');
  await bad({ 'notify.digest_hour': 24 });
  await bad({ 'notify.rate_cap_per_hour': 1 });
  await bad({ 'notify.dept_risk_gap': 20 }, 'notify.dept_delay_gap');                       // 20 ≥ 15
  await bad({ 'notify.approval_escalate_days': 1, 'notify.approval_remind_hours': 48 }, 'notify.approval_escalate_days');
  const ok = await root.put('/settings', { 'notify.stuck_days': 21, 'notify.work_days': [0, 1, 2, 3], 'notify.timezone': 'Africa/Cairo' });
  assert.equal(ok.status, 200);
  const g = (await root.get('/settings')).data.settings;
  assert.equal(g['notify.stuck_days'], 21); assert.deepEqual(g['notify.work_days'], [0, 1, 2, 3]); assert.equal(typeof g['notify.policy'].stuck, 'object');
  const au = (await pool.query(`SELECT old_value, new_value FROM audit_log WHERE entity='setting' AND entity_id='notify.stuck_days' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.deepEqual([au.old_value.value, au.new_value.value], [14, 21]);
  await root.put('/settings', { 'notify.stuck_days': 14, 'notify.work_days': [0, 1, 2, 3, 4], 'notify.timezone': 'Africa/Tripoli' });
});

test('live: a new alert sends "notif_changed" with only { unread, top_severity } to that user\'s stream', { skip }, async () => {
  await clean();
  const c = await as('mem_hr');
  const ac = new AbortController();
  const res = await fetch(base + '/events', { headers: { cookie: c.cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  let raw = '';
  const reader = (async () => { try { for await (const ch of res.body) raw += new TextDecoder().decode(ch); } catch { /* aborted */ } })();
  await new Promise(r => setTimeout(r, 300));
  const [u] = await notify.activeUsers([ids.mem_hr]);
  await notify.deliver('excluded', [{ user: u, dedupeKey: 'excluded:live', appId: 'per', params: { app_id: 'per', app_ar: 'سرّي' } }]);
  for (let i = 0; i < 30 && !raw.includes('notif_changed'); i++) await new Promise(r => setTimeout(r, 100));
  ac.abort(); await reader;
  const block = raw.split('\n\n').find(b => b.includes('event: notif_changed'));
  assert.ok(block, raw);
  const data = JSON.parse(/^data: (.+)$/m.exec(block)[1]);
  assert.deepEqual(data, { unread: 1, top_severity: 'info' });
  assert.ok(!raw.includes('سرّي'), 'no content in the stream');
});

test('the API: filters, paging, validation, link safety', { skip }, async () => {
  await clean();
  const [u] = await notify.activeUsers([ids.mem_hr]);
  for (let i = 0; i < 5; i++) await notify.deliver('excluded', [{ user: u, dedupeKey: 'excluded:p' + i, appId: 'per', link: i === 0 ? 'https://evil.example' : '/app/per', params: {} }]);
  const c = await as('mem_hr');
  const p1 = (await c.get('/notifications?limit=2')).data;
  assert.equal(p1.items.length, 2); assert.ok(p1.next_before);
  const p2 = (await c.get(`/notifications?limit=2&before=${p1.next_before}`)).data;
  assert.equal(p2.items.length, 2); assert.ok(p2.items[0].id < p1.items[1].id);
  assert.equal((await c.get('/notifications?category=security')).data.items.length, 0);
  assert.equal((await c.get('/notifications?category=nope')).status, 400);
  assert.equal((await c.get('/notifications?before=abc')).status, 400);
  const all = (await c.get('/notifications?limit=100')).data.items;
  assert.equal(all.find(i => i.link === null)?.link, null, 'an external link is never stored');
  assert.ok(all.every(i => i.link === null || i.link.startsWith('/')));
  assert.equal((await fetch(base + '/notifications')).status, 401);
});

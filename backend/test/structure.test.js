// Structure management (migration 037): create / edit / archive departments and applications.
// Uses the same disposable database as the other HTTP tests (TEST_DATABASE_URL): public schema dropped & recreated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool;
const ids = {};
// [username, role, scopes] — root is admin (str + full scope); obsu has neither str nor full scope.
const USERS = [
  ['root', 'admin'],
  ['obsu', 'obs', [['department', 'hr']]],
];

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '50', LOGIN_RATE_LIMIT: '1000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  for (const [u, role, scopes = []] of USERS) {
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES ($1,$2,$3,$4,false) RETURNING id`,
      [u, u, h, role])).rows[0].id;
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
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };

test('permission guard: only `str` may manage structure', { skip }, async () => {
  const obs = await as('obsu');
  assert.equal((await obs.get('/tracker/structure')).status, 403);
  assert.equal((await obs.post('/tracker/departments', { name_ar: 'x' })).status, 403);
  assert.equal((await obs.post('/tracker/departments/hr/applications', { name_ar: 'x' })).status, 403);

  const root = await as('root');
  assert.equal((await root.get('/tracker/structure')).status, 200);
});

test('create a department → slug id, appears retroactively in the summary and structure list', { skip }, async () => {
  const root = await as('root');
  const before = await root.get('/tracker/summary');
  const beforeDepts = before.data.departments.length;

  const c = await root.post('/tracker/departments', { name_ar: 'إدارة تقنية المعلومات', name_en: 'IT Department', color: '#8b5cf6', emblem: 'server' });
  assert.equal(c.status, 200);
  assert.match(c.data.department.id, /^[a-z0-9][a-z0-9_-]*$/);           // a slug, derived from name_en
  const did = c.data.department.id;

  // retroactive: the new (empty, 0%) department is in the roll-up at once
  const after = await root.get('/tracker/summary');
  assert.equal(after.data.departments.length, beforeDepts + 1);
  assert.ok(after.data.departments.find(d => d.id === did), 'new dept in summary');

  // structure list carries it (not archived) with child counts
  const st = await root.get('/tracker/structure');
  const row = st.data.departments.find(d => d.id === did);
  assert.ok(row && row.archived_at === null);
  assert.equal(row.app_count, 0);
  assert.equal(row.active_app_count, 0);
});

test('slug ids stay unique when two departments share a Latin name', { skip }, async () => {
  const root = await as('root');
  const a = await root.post('/tracker/departments', { name_ar: 'ألف', name_en: 'Shared Name' });
  const b = await root.post('/tracker/departments', { name_ar: 'باء', name_en: 'Shared Name' });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.data.department.id, b.data.department.id);
});

test('create an application under a department, add a function, and see the roll-up', { skip }, async () => {
  const root = await as('root');
  const dep = await root.post('/tracker/departments', { name_ar: 'التشغيل', name_en: 'Operations' });
  const did = dep.data.department.id;

  const app = await root.post(`/tracker/departments/${did}/applications`, { name_ar: 'نظام الدعم', name_en: 'Support', icon: 'monitor', weight: 5 });
  assert.equal(app.status, 200);
  const aid = app.data.application.id;
  assert.equal(Number(app.data.application.weight), 5);
  assert.equal(Number(app.data.application.default_weight), 5);

  // a function on the new app (the add-function feature already existed) lifts the department to its progress
  const fn = await root.post(`/tracker/applications/${aid}/functions`, { name_ar: 'تسجيل التذاكر', weight: 1, progress: 80 });
  assert.equal(fn.status, 201);                        // add-function returns 201 Created

  const sum = await root.get('/tracker/summary');
  const d = sum.data.departments.find(x => x.id === did);
  assert.ok(Math.abs(d.pct - 80) < 1e-6, `dept pct ${d.pct}`);
});

test('edit a department and an application', { skip }, async () => {
  const root = await as('root');
  const dep = await root.post('/tracker/departments', { name_ar: 'قديم', name_en: 'Old' });
  const did = dep.data.department.id;
  const up = await root.patch(`/tracker/departments/${did}`, { name_ar: 'جديد', name_en: 'New', color: '#112233', emblem: 'cloud', is_base: true });
  assert.equal(up.status, 200);
  assert.equal(up.data.department.name_ar, 'جديد');
  assert.equal(up.data.department.color, '#112233');
  assert.equal(up.data.department.is_base, true);

  const app = await root.post(`/tracker/departments/${did}/applications`, { name_ar: 'تطبيق', name_en: 'App' });
  const aid = app.data.application.id;
  const upa = await root.patch(`/tracker/applications/${aid}`, { name_ar: 'تطبيق محدّث', name_en: 'App v2', icon: 'database', sub_ar: 'وصف' });
  assert.equal(upa.status, 200);
  assert.equal(upa.data.application.name_ar, 'تطبيق محدّث');
  assert.equal(upa.data.application.icon, 'database');
  // editing meta must NOT touch the weight (that belongs to the Weights screen)
  assert.equal(Number(upa.data.application.weight), Number(app.data.application.weight));
});

test('archive takes a row out of calc & pickers but keeps it (reversible); guards hold', { skip }, async () => {
  const root = await as('root');
  const dep = await root.post('/tracker/departments', { name_ar: 'للأرشفة', name_en: 'ToArchive' });
  const did = dep.data.department.id;
  const app = await root.post(`/tracker/departments/${did}/applications`, { name_ar: 'تطبيق مؤقت', name_en: 'Temp', weight: 3 });
  const aid = app.data.application.id;
  await root.post(`/tracker/applications/${aid}/functions`, { name_ar: 'بند', weight: 1, progress: 100 });

  // cannot archive a department that still has a live application
  const blocked = await root.post(`/tracker/departments/${did}/archive`, {});
  assert.equal(blocked.status, 400);
  assert.equal(blocked.data.error, 'department_not_empty');

  // archive the application: it leaves the summary (retroactive) …
  const arA = await root.post(`/tracker/applications/${aid}/archive`, { reason: 'مكرر' });
  assert.equal(arA.status, 200);
  let sum = await root.get('/tracker/summary');
  assert.ok(!sum.data.applications.find(a => a.id === aid), 'archived app absent from summary');
  const dline = sum.data.departments.find(d => d.id === did);
  assert.ok(Math.abs(dline.pct - 0) < 1e-6, 'dept drops to 0 once its only app is archived');

  // … but it is still listed in the structure screen, flagged archived (history kept)
  const st = await root.get('/tracker/structure');
  const arow = st.data.applications.find(a => a.id === aid);
  assert.ok(arow && arow.archived_at, 'archived app still in structure list');
  assert.equal(arow.archive_reason, 'مكرر');

  // now the (empty) department archives, and leaves the summary and the move-targets
  const arD = await root.post(`/tracker/departments/${did}/archive`, {});
  assert.equal(arD.status, 200);
  sum = await root.get('/tracker/summary');
  assert.ok(!sum.data.departments.find(d => d.id === did), 'archived dept absent from summary');

  // restoring the application is refused while its department is archived
  const badRestore = await root.post(`/tracker/applications/${aid}/restore`, {});
  assert.equal(badRestore.status, 400);
  assert.equal(badRestore.data.error, 'department_archived');

  // restore the department, then the application — both back in the roll-up
  assert.equal((await root.post(`/tracker/departments/${did}/restore`, {})).status, 200);
  assert.equal((await root.post(`/tracker/applications/${aid}/restore`, {})).status, 200);
  sum = await root.get('/tracker/summary');
  assert.ok(sum.data.departments.find(d => d.id === did), 'restored dept back in summary');
  assert.ok(Math.abs(sum.data.departments.find(d => d.id === did).pct - 100) < 1e-6, 'restored dept at 100 again');
});

test('wheel fields: a department carries its wheel appearance, editable and hideable', { skip }, async () => {
  const root = await as('root');
  // seeded departments reproduce the old hardcoded wheel
  const st0 = await root.get('/tracker/structure');
  const com = st0.data.departments.find(d => d.id === 'com');
  assert.equal(com.wheel_label_ar, 'المبيعات والتسويق');
  assert.equal(com.wheel_icon, 'megaphone');
  assert.equal(com.wheel_order, 2);

  // create a department with explicit wheel appearance, hidden from the wheel
  const c = await root.post('/tracker/departments', {
    name_ar: 'التقنية', name_en: 'Tech', wheel_show: false, wheel_icon: 'server',
    wheel_label_ar: 'التقنية والبنية', wheel_label_en: 'Tech & Infra', wheel_order: 9,
  });
  assert.equal(c.status, 200);
  const did = c.data.department.id;
  assert.equal(c.data.department.wheel_show, false);
  assert.equal(c.data.department.wheel_icon, 'server');
  assert.equal(c.data.department.wheel_order, 9);

  // the summary carries the wheel fields so the client can build the wheel from the departments
  const sum = await root.get('/tracker/summary');
  const d = sum.data.departments.find(x => x.id === did);
  assert.equal(d.wheel_show, false);
  assert.equal(d.wheel_label_ar, 'التقنية والبنية');

  // editing can show it again and change its label
  const up = await root.patch(`/tracker/departments/${did}`, { name_ar: 'التقنية', wheel_show: true, wheel_label_ar: 'التقنية' });
  assert.equal(up.status, 200);
  assert.equal(up.data.department.wheel_show, true);
  assert.equal(up.data.department.wheel_label_ar, 'التقنية');
  assert.equal(up.data.department.wheel_order, 9);           // order preserved when not re-sent (COALESCE)
});

test('validation: name required, bad colour / icon rejected', { skip }, async () => {
  const root = await as('root');
  assert.equal((await root.post('/tracker/departments', { name_ar: '   ' })).status, 400);
  assert.equal((await root.post('/tracker/departments', { name_ar: 'ok', color: 'red' })).status, 400);
  assert.equal((await root.post('/tracker/departments', { name_ar: 'ok', emblem: 'Bad Icon!' })).status, 400);
  const dep = await root.post('/tracker/departments', { name_ar: 'سليمة', name_en: 'Valid' });
  assert.equal((await root.post(`/tracker/departments/${dep.data.department.id}/applications`, { name_ar: '' })).status, 400);
});

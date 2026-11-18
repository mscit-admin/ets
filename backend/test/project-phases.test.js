// Project phases progress (manual weighted model). Pure maths/validator tests always run; the HTTP permission tests
// use the same disposable database as api.test.js (TEST_DATABASE_URL), whose public schema is dropped and recreated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { projectProgress, validateProjectPhases } from '../src/services/project-phases.js';

// ---------------------------------------------------------------------------
// projectProgress() maths
// ---------------------------------------------------------------------------
test('projectProgress weights the phases and resolves the auto phase from the system %', () => {
  const phases = [
    { key: 'a', name_ar: 'أ', name_en: '', weight: 2, pct: 92, auto: false },
    { key: 'b', name_ar: 'ب', name_en: '', weight: 1, pct: 65, auto: false },
    { key: 'c', name_ar: 'ج', name_en: '', weight: 3, pct: 0, auto: true },   // auto → takes 41
    { key: 'd', name_ar: 'د', name_en: '', weight: 3, pct: 65, auto: false },
    { key: 'e', name_ar: 'هـ', name_en: '', weight: 1, pct: 0, auto: false },
  ];
  const r = projectProgress(phases, 41);
  assert.equal(r.total_weight, 10);
  // the auto phase uses 41, not its stored 0
  assert.equal(r.phases.find(p => p.key === 'c').effective_pct, 41);
  // Σ(w·eff)/Σw = (2·92 + 1·65 + 3·41 + 3·65 + 1·0)/10 = (184+65+123+195+0)/10 = 56.7
  assert.ok(Math.abs(r.pct - 56.7) < 1e-9, `pct=${r.pct}`);
  // contribution is the phase's share of the 0–100 overall; they sum to pct
  const sum = r.phases.reduce((a, p) => a + p.contribution, 0);
  assert.ok(Math.abs(sum - r.pct) < 1e-9);
  assert.ok(Math.abs(r.phases.find(p => p.key === 'a').contribution - 18.4) < 1e-9);
});

test('projectProgress with zero total weight is 0 (no division by zero)', () => {
  const r = projectProgress([{ key: 'a', name_ar: 'أ', name_en: '', weight: 0, pct: 80, auto: false }], 50);
  assert.equal(r.total_weight, 0);
  assert.equal(r.pct, 0);
  assert.equal(r.phases[0].contribution, 0);
  assert.equal(r.phases[0].effective_pct, 80);
});

// ---------------------------------------------------------------------------
// validateProjectPhases()
// ---------------------------------------------------------------------------
const okPhase = (o = {}) => ({ key: 'k', name_ar: 'اسم', name_en: 'Name', weight: 1, pct: 50, auto: false, ...o });

test('validateProjectPhases accepts a well-formed array and normalises names', () => {
  const out = validateProjectPhases([okPhase({ key: 'a', name_ar: '  التحليل  ', name_en: '  Analysis  ' }), okPhase({ key: 'b', auto: true, pct: 0 })]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name_ar, 'التحليل');       // trimmed
  assert.equal(out[0].name_en, 'Analysis');
  assert.equal(out[1].auto, true);
});

test('validateProjectPhases rejects bad input', () => {
  const reject = v => assert.throws(() => validateProjectPhases(v), e => e.status === 400 && e.code === 'invalid_value');
  reject('nope');                                              // not an array
  reject([]);                                                  // empty
  reject([okPhase({ key: 'a' }), okPhase({ key: 'a' })]);      // duplicate keys
  reject([okPhase({ key: 'Bad Key' })]);                       // key not a slug
  reject([okPhase({ auto: true }), okPhase({ key: 'b', auto: true })]); // two auto
  reject([okPhase({ weight: -1 })]);                           // negative weight
  reject([okPhase({ name_ar: '   ' })]);                       // empty name_ar
  reject([okPhase({ pct: 150 })]);                             // pct out of range
  reject([okPhase({ weight: 0 })]);                            // sum of weights is 0
  reject([okPhase({ auto: 'yes' })]);                          // auto not a boolean
});

// ---------------------------------------------------------------------------
// HTTP: permission guard + summary gating (needs the test database)
// ---------------------------------------------------------------------------
const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool;
const ids = {};
// [username, role, scopes]
const USERS = [
  ['root', 'admin'],                         // cfg + prj_view + erp_view
  ['pmu', 'pm'],                             // apv_final + prj_view + erp_view
  ['obsu', 'obs', [['department', 'hr']]],   // erp_view only: no cfg / apv_final / prj_view
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
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };

test('GET/PUT project-phases: cfg OR apv_final allowed, neither gets 403', { skip }, async () => {
  for (const u of ['root', 'pmu']) {
    const c = await as(u);
    const g = await c.get('/tracker/project-phases');
    assert.equal(g.status, 200, u);
    assert.ok(Array.isArray(g.data.phases) && g.data.phases.length === 5, u);     // the seeded default
    assert.equal(typeof g.data.system_pct, 'number', u);
    assert.equal(typeof g.data.pct, 'number', u);
    assert.equal(typeof g.data.total_weight, 'number', u);
  }
  // a reader with neither cfg nor apv_final is refused both verbs
  const obs = await as('obsu');
  assert.equal((await obs.get('/tracker/project-phases')).status, 403);
  assert.equal((await obs.put('/tracker/project-phases', { phases: [] })).status, 403);

  // a valid save round-trips and recomputes
  const root = await as('root');
  const phases = [
    { key: 'a', name_ar: 'التحليل', name_en: 'Analysis', weight: 2, pct: 100, auto: false },
    { key: 'dev', name_ar: 'التطوير', name_en: 'Dev', weight: 2, pct: 0, auto: true },
  ];
  const put = await root.put('/tracker/project-phases', { phases });
  assert.equal(put.status, 200);
  assert.equal(put.data.phases.length, 2);
  assert.equal(put.data.total_weight, 4);
  // invalid payloads are rejected
  assert.equal((await root.put('/tracker/project-phases', { phases: [{ key: 'a', name_ar: 'x', name_en: '', weight: -1, pct: 0, auto: false }] })).status, 400);
  assert.equal((await root.put('/tracker/project-phases', { phases: [] })).status, 400);
});

test('summary includes `project` only with prj_view', { skip }, async () => {
  const root = await as('root');
  const rs = await root.get('/tracker/summary');
  assert.equal(rs.status, 200);
  assert.equal(rs.data.can.prj_view, true);
  assert.equal(rs.data.can.erp_view, true);
  assert.ok(rs.data.project && typeof rs.data.project.pct === 'number');

  const obs = await as('obsu');
  const os = await obs.get('/tracker/summary');
  assert.equal(os.status, 200);
  assert.equal(os.data.can.prj_view, false);
  assert.equal(os.data.can.erp_view, true);          // every role keeps the system wheel
  assert.equal(os.data.project, undefined);          // project data withheld server-side
});

test('F3: without erp_view the system-wheel figures are withheld, structure kept', { skip }, async () => {
  // revoke erp_view from obsu via a per-user override
  await pool.query(`INSERT INTO user_permissions(user_id, permission, granted) VALUES ($1,'erp_view',false)
    ON CONFLICT (user_id, permission) DO UPDATE SET granted=false`, [ids.obsu]);
  try {
    const obs = await as('obsu');
    const s = (await obs.get('/tracker/summary')).data;
    assert.equal(s.can.erp_view, false);
    assert.equal(s.total.pct, null);                 // overall progress withheld
    assert.equal(s.total.fnPct, null);
    assert.ok(Array.isArray(s.total.tests));         // non-wheel test counts kept
    assert.ok(s.departments.length > 0);
    for (const d of s.departments) {
      assert.equal(d.pct, null);                     // per-department progress withheld
      assert.equal(d.fnPct, null);
      assert.ok(d.id && (d.name_ar || d.name_en));   // structural fields kept for the sidebar
    }
  } finally {
    await pool.query(`DELETE FROM user_permissions WHERE user_id=$1 AND permission='erp_view'`, [ids.obsu]);
  }
});

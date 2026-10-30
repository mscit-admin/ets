// BE-2 equivalence pinning test.
//
// applicationData(id) and departmentData(id) no longer load the whole project: they run summarize() over just their
// own scope (services/tracker-data.js, loadScopedCalc). The claim is that this is BYTE-IDENTICAL for their outputs,
// because every per-application figure (appCalc + appBlend) and every per-department figure is local to that scope —
// nothing reads a sibling application, a sibling department, or the project total.
//
// This test pins that claim. For a seeded project it builds a FULL-LOAD reference the old way (loadVisible + the
// whole-project summarize, which is exactly what the assemblers used to read) and asserts the OPTIMIZED
// applicationData / departmentData return the identical calc / weights / pct — in BOTH fixed and auto weight mode
// (auto is where an application's weight is derived from its own item weights, the case most at risk of leaking a
// project-wide dependency).
//
// Runs against a dedicated, disposable database (its public schema is DROPPED and recreated):
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_b3b npm test
// Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let pool, loadVisible, applicationData, departmentData, invalidateSettings;
let deptId, appId, appRow;
// full-scope reader: fullScope short-circuits every scope check, so applicationData/departmentData see the whole
// project exactly as the full-load reference does; the permissions array only feeds the `can` block.
const user = { id: 1, fullScope: true, permissions: ['pct', 'wgt', 'tst', 'tog', 'ren', 'mov', 'rep', 'apv_final', 'cfg', 'sch', 'exp', 'imp', 'apv_dept'],
  scope: { applications: [], departments: [] } };

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  ({ loadVisible, applicationData, departmentData } = await import('../src/services/tracker-data.js'));
  ({ invalidateSettings } = await import('../src/services/settings.js'));
  // the department with the most applications, and the application with the most (non-removed) functions — the
  // scopes with the most structure to roll up, so the comparison is meaningful.
  deptId = (await pool.query('SELECT department_id FROM applications GROUP BY department_id ORDER BY count(*) DESC, department_id LIMIT 1')).rows[0].department_id;
  const ap = (await pool.query(`SELECT app_id FROM functions WHERE removed_at IS NULL GROUP BY app_id ORDER BY count(*) DESC, app_id LIMIT 1`)).rows[0];
  appId = ap.app_id;
  appRow = (await pool.query('SELECT * FROM applications WHERE id=$1', [appId])).rows[0];
});

after(async () => {
  if (skip) return;
  await pool.end();
});

async function setMode(mode) {
  await pool.query(`INSERT INTO settings(key,value) VALUES('calc.weight_mode',$1)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(mode)]);
  invalidateSettings();
}

// For each weight mode, the optimized single-scope readers must match the full-project roll-up exactly.
for (const mode of ['fixed', 'auto']) {
  test(`applicationData is byte-identical to the full-load calc (${mode} weight mode)`, { skip }, async () => {
    await setMode(mode);
    const ref = (await loadVisible(user)).calc.applications.find(x => x.id === appId);
    const ad = await applicationData(user, appId);
    assert.deepEqual(ad.application.calc, ref, 'application calc identical');
    // and the mode is genuinely exercised: fixed uses the stored weight, auto the derived item-weight sum (fnWeight)
    assert.equal(ad.application.calc.weight, mode === 'auto' ? ref.fnWeight : Number(appRow.weight), 'weight follows the mode');
  });

  test(`departmentData is byte-identical to the full-load calc (${mode} weight mode)`, { skip }, async () => {
    await setMode(mode);
    const v = await loadVisible(user);
    const refDept = v.calc.departments.find(x => x.id === deptId);
    const dd = await departmentData(user, deptId);
    // the department line (weighted average of its applications)
    assert.deepEqual(
      { weight: dd.department.weight, pct: dd.department.pct, fnPct: dd.department.fnPct, apps: dd.department.apps },
      { weight: refDept.weight, pct: refDept.pct, fnPct: refDept.fnPct, apps: refDept.apps },
      'department line identical');
    assert.ok(dd.applications.length > 0, 'department has applications to compare');
    // every application calc under the department
    for (const a of dd.applications) {
      assert.deepEqual(a.calc, v.calc.applications.find(x => x.id === a.id), `app ${a.id} calc identical`);
    }
    // same calc-parameter settings surfaced
    assert.deepEqual(dd.settings, { weight_mode: mode, notif_share: v.settings['calc.notif_share'], reports_share: v.settings['calc.reports_share'] });
  });
}

// Re-seeding (npm run setup = migrate + seed, run on every deploy) must NOT revert a moved application's department.
// The catalog's department_id is initial-placement-only: it is applied on the first INSERT, but an application that
// has since been moved to another department (1.12.16, application_moves) OWNS its department_id thereafter, exactly
// as a moved catalog item is guarded by function_moves and as user-owned `weight` is never refreshed. The seed still
// refreshes catalog-owned display fields (name, icon, note, …) on every run. Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let pool, seed, catalog;
const catApp = id => catalog.applications.find(a => a.id === id);

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  ({ seed } = await import('../src/db/seed.js'));
  await seed({ log: () => {} });
  const seedDir = fileURLToPath(new URL('../src/db/seed/catalog.json', import.meta.url));
  catalog = JSON.parse(fs.readFileSync(seedDir, 'utf8'));
});

after(async () => { if (!skip) await pool?.end(); });

const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const deptOf = async app => (await one('SELECT department_id FROM applications WHERE id=$1', [app])).department_id;
const nameOf = async app => (await one('SELECT name_ar FROM applications WHERE id=$1', [app])).name_ar;

test('re-seed does not revert a moved application; catalog display fields still refresh; unmoved apps unaffected', { skip }, async () => {
  // 'ess' is catalogued in hr; 'per' (control) stays where the catalog puts it. Pick a destination that is a real
  // department and not the application's own one.
  const MOVED = 'ess', CTRL = 'per';
  const origDept = catApp(MOVED).department_id;                 // catalog placement (hr)
  const dstDept = catalog.departments.map(d => d.id).find(d => d !== origDept);
  const catName = catApp(MOVED).name_ar;                        // catalog-owned display field
  assert.ok(dstDept, 'a destination department exists');
  assert.equal(await deptOf(MOVED), origDept, 'seeded in its catalog department');

  // Simulate an admin moving the application to another department: department_id changes and the move is recorded in
  // application_moves (as services/app-move.js does). Also tamper with a catalog-owned display field so we can prove
  // it is refreshed on re-seed while the moved department is preserved.
  await pool.query('UPDATE applications SET department_id=$2, name_ar=$3 WHERE id=$1',
    [MOVED, dstDept, 'TAMPERED NAME']);
  await pool.query(`INSERT INTO application_moves(app_id, from_department_id, to_department_id, weight_mode, weight, reason, moved_by)
    VALUES ($1,$2,$3,'fixed',$4,$5,NULL)`,
    [MOVED, origDept, dstDept, catApp(MOVED).weight, 'moved per the approved structure']);
  const ctrlDeptBefore = await deptOf(CTRL);

  // Re-seed (what every deploy does).
  await seed({ log: () => {} });

  // The move is NOT reverted: department_id stays the moved-to department.
  assert.equal(await deptOf(MOVED), dstDept, 'moved department preserved across re-seed (not reverted to catalog)');
  // Catalog-owned display fields are still refreshed from the catalog.
  assert.equal(await nameOf(MOVED), catName, 'display field (name_ar) refreshed from the catalog');
  // An unmoved application is unaffected: still in its catalog department.
  assert.equal(await deptOf(CTRL), ctrlDeptBefore, 'unmoved application still in its catalog department');
  assert.equal(await deptOf(CTRL), catApp(CTRL).department_id, 'control app matches the catalog placement');
});

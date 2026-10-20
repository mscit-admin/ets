// Migration 019 (1.10.0) on a 1.9.2 database: the new permission 'mov' for admin, mgr, pm, tm and lead only (not
// copied from any per-user override: a new capability), function_moves, and the 'move_function' requests. The
// fixture puts the database back in its 1.9.2 state (019 not applied) with a pending request, and migrates it again.
// Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
let pool, migrate;
const ids = {};

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  ({ migrate } = await import('../src/db/migrate.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  // back to 1.9.2: no 'mov', no function_moves, edit_requests without the move columns, 019 not applied
  await pool.query(`UPDATE roles SET permissions = array_remove(permissions, 'mov')`);
  await pool.query(`DROP TABLE function_moves`);
  await pool.query(`ALTER TABLE edit_requests DROP CONSTRAINT edit_requests_move_target_check, DROP COLUMN target_app_id, DROP COLUMN target_department_id,
    DROP COLUMN source_approved_by, DROP COLUMN source_approved_at, DROP COLUMN target_approved_by, DROP COLUMN target_approved_at, DROP COLUMN meta`);
  await pool.query(`ALTER TABLE edit_requests DROP CONSTRAINT edit_requests_kind_check`);
  await pool.query(`ALTER TABLE edit_requests ADD CONSTRAINT edit_requests_kind_check
    CHECK (kind IN ('function','bulk','report','add_function','remove_function','restore_function'))`);
  await pool.query(`DELETE FROM schema_migrations WHERE version = '019_move_items.sql'`);
  for (const [u, role, ov] of [['lead1', 'lead', []], ['member_tog', 'member', [['tog', true]]], ['ed_ren', 'ed', [['ren', true]]]]) {
    ids[u] = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id) VALUES ($1,$2,'x',$3) RETURNING id`, [u, u, role])).rows[0].id;
    for (const [p, g] of ov) await pool.query('INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,$2,$3)', [ids[u], p, g]);
  }
  ids.rq = (await pool.query(`INSERT INTO edit_requests(department_id, app_id, kind, summary, requested_by) VALUES ('hr','per','function','x',$1) RETURNING id`,
    [ids.member_tog])).rows[0].id;
});

after(async () => { if (!skip) await pool.end(); });

test('019: applied on a 1.9.2 database; "mov" for admin, mgr, pm, tm, lead only', { skip }, async () => {
  const applied = await migrate({ log: () => {} });
  assert.deepEqual(applied, ['019_move_items.sql']);
  const roles = (await pool.query('SELECT id, permissions FROM roles ORDER BY id')).rows;
  assert.deepEqual(roles.filter(r => r.permissions.includes('mov')).map(r => r.id), ['admin', 'lead', 'mgr', 'pm', 'tm']);
  // a new capability: no per-user override is created from 'tog' / 'ren'
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM user_permissions WHERE permission='mov'`)).rows[0].n, 0);
  // the seed run at every start agrees with the migration
  const { seed } = await import('../src/db/seed.js');
  await seed({ log: () => {} });
  assert.deepEqual((await pool.query(`SELECT id FROM roles WHERE 'mov' = ANY(permissions) ORDER BY id`)).rows.map(r => r.id), ['admin', 'lead', 'mgr', 'pm', 'tm']);
  // re-runnable: one 'mov' each
  await pool.query(fs.readFileSync(new URL('../src/db/migrations/019_move_items.sql', import.meta.url), 'utf8'));
  for (const r of (await pool.query('SELECT id, permissions FROM roles')).rows) assert.ok(r.permissions.filter(p => p === 'mov').length <= 1, r.id);
});

test('019: existing requests are kept; a move request needs its destination', { skip }, async () => {
  const rq = (await pool.query('SELECT * FROM edit_requests WHERE id=$1', [ids.rq])).rows[0];
  assert.deepEqual([rq.kind, rq.status, rq.target_app_id, rq.meta], ['function', 'pending', null, null]);
  await assert.rejects(pool.query(`INSERT INTO edit_requests(department_id, app_id, kind, requested_by) VALUES ('hr','per','move_function',$1)`, [ids.lead1]),
    /edit_requests_move_target_check/);
  await assert.rejects(pool.query(`INSERT INTO edit_requests(department_id, app_id, kind, requested_by, target_app_id, target_department_id)
    VALUES ('hr','per','function',$1,'acc','fin')`, [ids.lead1]), /edit_requests_move_target_check/);
  const ok = await pool.query(`INSERT INTO edit_requests(department_id, app_id, kind, requested_by, target_app_id, target_department_id)
    VALUES ('hr','per','move_function',$1,'acc','fin') RETURNING id`, [ids.lead1]);
  assert.equal(ok.rowCount, 1);
  // function_moves: same application refused, reason required
  const f = (await pool.query(`SELECT id FROM functions WHERE app_id='per' AND code='D0'`)).rows[0].id;
  await assert.rejects(pool.query(`INSERT INTO function_moves(function_id, from_app_id, to_app_id, from_code, to_code, from_dept_id, to_dept_id, weight_mode, reason)
    VALUES ($1,'per','per','D0','C0','hr','hr','fixed','x')`, [f]));
  await assert.rejects(pool.query(`INSERT INTO function_moves(function_id, from_app_id, to_app_id, from_code, to_code, from_dept_id, to_dept_id, weight_mode, reason)
    VALUES ($1,'per','acc','D0','C0','hr','fin','fixed','')`, [f]));
  const v = await (await import('../src/services/logchain.js')).verifyAll();
  assert.ok(v.ok, JSON.stringify(v));
});

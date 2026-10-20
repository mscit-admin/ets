// Migration 018 (1.9.2): renaming an item gets its own permission 'ren'. On upgrade every role that has 'tog' gets
// 'ren', and every per-user override of 'tog' is copied to 'ren' with the same value (audited), so nothing changes
// for anyone. The fixture puts the database back in its 1.9.1 state (no 'ren' anywhere, 018 not applied) and
// migrates it again.
// Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
  // back to 1.9.1: no 'ren' in any role, 018 not applied
  await pool.query(`UPDATE roles SET permissions = array_remove(permissions, 'ren')`);
  await pool.query(`DELETE FROM schema_migrations WHERE version = '018_rename_permission.sql'`);
  // [username, role, overrides]
  const users = [
    ['lead_plain', 'lead', []],
    ['lead_no_tog', 'lead', [['tog', false]]],        // 'tog' revoked: must not gain rename
    ['ed_tog', 'ed', [['tog', true], ['wgt', true]]], // 'tog' granted outside the role: keeps renaming
    ['ed_plain', 'ed', []],
    ['member_both', 'member', [['tog', false], ['ren', true]]],   // already has a 'ren' override: left alone
  ];
  for (const [u, role, ov] of users) {
    ids[u] = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id) VALUES ($1,$2,'x',$3) RETURNING id`, [u, u, role])).rows[0].id;
    for (const [p, g] of ov) await pool.query('INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,$2,$3)', [ids[u], p, g]);
  }
});

after(async () => { if (!skip) await pool.end(); });

const perms = async u => {
  const { loadUserContext } = await import('../src/middleware/auth.js');
  return (await loadUserContext(ids[u])).permissions;
};
const override = async (u, p) => (await pool.query('SELECT granted FROM user_permissions WHERE user_id=$1 AND permission=$2', [ids[u], p])).rows[0]?.granted;

test('018: roles with "tog" get "ren", others do not', { skip }, async () => {
  const applied = await migrate({ log: () => {} });
  assert.deepEqual(applied, ['018_rename_permission.sql']);
  const roles = (await pool.query('SELECT id, permissions FROM roles ORDER BY id')).rows;
  for (const r of roles) assert.equal(r.permissions.includes('ren'), r.permissions.includes('tog'), r.id);
  const withRen = roles.filter(r => r.permissions.includes('ren')).map(r => r.id).sort();
  assert.deepEqual(withRen, ['admin', 'lead', 'member', 'mgr', 'pm', 'tm']);
  // one 'ren' each, even if 018 ran again by hand
  await pool.query(await (await import('node:fs')).promises.readFile(new URL('../src/db/migrations/018_rename_permission.sql', import.meta.url), 'utf8'));
  for (const r of (await pool.query('SELECT id, permissions FROM roles')).rows) {
    assert.ok(r.permissions.filter(p => p === 'ren').length <= 1, r.id);
  }
});

test('018: per-user "tog" overrides are copied to "ren" with the same value; effective rights unchanged', { skip }, async () => {
  assert.equal(await override('lead_no_tog', 'ren'), false);
  assert.equal(await override('ed_tog', 'ren'), true);
  assert.equal(await override('lead_plain', 'ren'), undefined);
  assert.equal(await override('ed_plain', 'ren'), undefined);
  assert.equal(await override('member_both', 'ren'), true);          // an existing 'ren' override is kept
  const has = async (u, p) => (await perms(u)).includes(p);
  assert.deepEqual([await has('lead_plain', 'tog'), await has('lead_plain', 'ren')], [true, true]);
  assert.deepEqual([await has('lead_no_tog', 'tog'), await has('lead_no_tog', 'ren')], [false, false]);
  assert.deepEqual([await has('ed_tog', 'tog'), await has('ed_tog', 'ren')], [true, true]);
  assert.deepEqual([await has('ed_plain', 'tog'), await has('ed_plain', 'ren')], [false, false]);
});

test('018: each user whose overrides changed has one audit row with the list before and after', { skip }, async () => {
  const rows = (await pool.query(`SELECT entity_id, username, old_value, new_value FROM audit_log
    WHERE entity='user' AND summary LIKE '%ren override copied from tog%' ORDER BY entity_id::int`)).rows;
  assert.deepEqual(rows.map(r => +r.entity_id).sort(), [ids.lead_no_tog, ids.ed_tog].sort());
  const ed = rows.find(r => +r.entity_id === ids.ed_tog);
  assert.equal(ed.username, 'system');
  assert.deepEqual(ed.old_value, { overrides: [{ permission: 'tog', granted: true }, { permission: 'wgt', granted: true }] });
  assert.deepEqual(ed.new_value, { overrides: [{ permission: 'ren', granted: true }, { permission: 'tog', granted: true }, { permission: 'wgt', granted: true }] });
  // the audit hash chain still verifies
  const v = await (await import('../src/services/logchain.js')).verifyAll();
  assert.ok(v.ok, JSON.stringify(v));
});

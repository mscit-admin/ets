// APP_SECRET rotation: scripts/rotate-app-secret.js re-encrypts stored 2FA secrets with the new key.
// Needs TEST_DATABASE_URL (like api.test.js); uses its own user rows and removes them afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const OLD = crypto.randomBytes(48).toString('base64'), NEW = crypto.randomBytes(48).toString('base64');
const logDir = new URL('../logs-test', import.meta.url).pathname;
let pool, cfg, cr;

before(async () => {
  if (skip) return;
  Object.assign(process.env, { DATABASE_URL: url, APP_SECRET: OLD, NODE_ENV: 'test', ETS_ENV_FILE: 'none',
    LOG_DIR: logDir, LOG_LEVEL: 'warn' });
  delete process.env.APP_SECRET_OLD;
  ({ pool } = await import('../src/db/pool.js'));
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  cfg = await import('../src/config.js');
  cr = await import('../src/services/crypto.js');
  await pool.query(`DELETE FROM users WHERE username LIKE 'rot\\_%'`);
});

after(async () => {
  if (skip) return;
  await pool.query(`DELETE FROM users WHERE username LIKE 'rot\\_%'`);
  await pool.end();
});

test('rotate-app-secret re-encrypts 2FA secrets under the new APP_SECRET', { skip }, async () => {
  const blob = cr.encrypt('JBSWY3DPEHPK3PXP');           // encrypted with the OLD secret
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,totp_secret)
    VALUES ('rot_a','Rotation',$1,'obs',$2)`, ['x', blob]);
  // other rows of the shared test database (api.test.js) use yet another secret: they are reported and
  // left unchanged, so the exit code may be 1 here — only this test's row is checked.
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/rotate-app-secret.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, APP_SECRET: NEW, APP_SECRET_OLD: OLD },
  }).catch(e => e);
  assert.match(stdout, /Re-encrypted [1-9]\d* 2FA secret\(s\)/);
  const stored = (await pool.query(`SELECT totp_secret FROM users WHERE username='rot_a'`)).rows[0].totp_secret;
  assert.notEqual(stored, blob);
  // readable with the new secret alone; no longer with the old one alone
  cfg.config.appSecret = NEW; cfg.config.appSecretOld = [];
  try {
    assert.equal(cr.decrypt(stored), 'JBSWY3DPEHPK3PXP');
    assert.equal(cr.needsReencrypt(stored), false);
    cfg.config.appSecret = OLD;
    assert.throws(() => cr.decrypt(stored));
  } finally { cfg.config.appSecret = OLD; }
});

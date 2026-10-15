#!/usr/bin/env node
// Re-encrypts every stored 2FA secret with the current APP_SECRET (after a rotation).
//   1. In /etc/ets/ets.env: move the current value to APP_SECRET_OLD, put a new random APP_SECRET
//      (openssl rand -base64 48), restart the service.
//   2. sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env node scripts/rotate-app-secret.js
//   3. When it reports 0 failures, remove APP_SECRET_OLD and restart again.
// Also upgrades old "v1" blobs to the current format. Safe to run more than once.
import { pool, tx } from '../src/db/pool.js';
import { assertConfig } from '../src/config.js';
import { needsReencrypt, reencrypt } from '../src/services/crypto.js';
import { logSystem } from '../src/services/logs.js';

assertConfig();
let done = 0, failed = 0;
await tx(async c => {
  const rows = (await c.query('SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL FOR UPDATE')).rows;
  for (const r of rows) {
    if (!needsReencrypt(r.totp_secret)) continue;
    try {
      await c.query('UPDATE users SET totp_secret=$2 WHERE id=$1', [r.id, reencrypt(r.totp_secret)]);
      done++;
    } catch (e) {
      failed++;
      console.error(`user id ${r.id}: cannot decrypt the 2FA secret (${e.message}) — left unchanged`);
    }
  }
});
await logSystem('app_secret_rotation', 'stored 2FA secrets re-encrypted', { reencrypted: done, failed });
console.log(`Re-encrypted ${done} 2FA secret(s); ${failed} failure(s).` +
  (failed ? ' Keep APP_SECRET_OLD until they are fixed (or reset those users\' 2FA).' : ''));
await pool.end();
process.exit(failed ? 1 : 0);

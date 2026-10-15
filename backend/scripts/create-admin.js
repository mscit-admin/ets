#!/usr/bin/env node
// Creates (or resets) a system administrator account from the command line.
//   npm run create-admin -- --username admin --name "System Admin" [--email a@b.ly] [--reset-2fa] [--must-change-password]
// The password is asked interactively (not echoed), or taken from the ETS_ADMIN_PASSWORD environment
// variable (used by the installer, so it never appears in the process list). --password '...' still works
// but is deprecated: the password would show in the process list and the shell history.
// --must-change-password: the administrator must choose a new password at the next sign-in.
// For an existing username: resets the password, unlocks the account and makes it an active admin;
// --reset-2fa also removes its authenticator (recovery when the phone is lost).
import readline from 'node:readline';
import { pool, query } from '../src/db/pool.js';
import { hashPassword, checkPolicy, ADMIN_MIN_LENGTH } from '../src/services/passwords.js';
import { getSetting } from '../src/services/settings.js';
import { logSystem } from '../src/services/logs.js';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };

function ask(q, hidden) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); });
  });
}

const username = arg('username') || await ask('Username: ');
const name = arg('name') || await ask('Full name: ');
if (arg('password')) console.error('Warning: --password is deprecated (visible in the process list and shell history); ' +
  'omit it to be asked, or set ETS_ADMIN_PASSWORD.');
let password = arg('password') || process.env.ETS_ADMIN_PASSWORD;
if (!password) {
  password = await ask('Password: ', true);
  if ((await ask('Repeat password: ', true)) !== password) { console.error('Passwords do not match'); process.exit(1); }
}
// Same policy as the application (Settings → minimum length), with the administrator minimum of 12.
const errs = checkPolicy(password, { minLength: await getSetting('security.password_min_length'), username, admin: true });
if (errs.length) {
  console.error('Weak password: ' + errs.join(', ') + ` (administrators: at least ${ADMIN_MIN_LENGTH} characters and at most 72 bytes, ` +
    'letters and digits, not a common password, not containing the username)');
  process.exit(1);
}

const email = arg('email') || null;
const mustChange = process.argv.includes('--must-change-password');
// A new account gets the default language from Settings; an existing account keeps its own.
const r = await query(`INSERT INTO users(username, full_name, email, password_hash, role_id, language, must_change_password)
  VALUES ($1,$2,$3,$4,'admin',$5,false)
  ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role_id='admin', is_active=true,
    full_name=COALESCE(NULLIF(EXCLUDED.full_name,''), users.full_name), email=COALESCE(EXCLUDED.email, users.email),
    failed_attempts=0, locked_until=NULL, last_failed_at=NULL, password_changed_at=now(), updated_at=now()
  RETURNING id, (xmax = 0) AS created`, [username, name, email, await hashPassword(password), await getSetting('app.default_language')]);
// --must-change-password (installer with a password from an answers file): temporary password
if (mustChange) await query('UPDATE users SET must_change_password=true WHERE id=$1', [r.rows[0].id]);
if (process.argv.includes('--reset-2fa')) {
  await query('UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL WHERE id=$1', [r.rows[0].id]);
  await query('DELETE FROM user_recovery_codes WHERE user_id=$1', [r.rows[0].id]);
  console.log('Two-factor authentication removed for this account.');
}
// Recovery after a compromise: whoever was signed in as this account is signed out (ETS-SEC-018).
const revoked = await query(`UPDATE sessions SET revoked_at=now(), revoke_reason='create_admin_cli'
  WHERE user_id=$1 AND revoked_at IS NULL`, [r.rows[0].id]);
if (revoked.rowCount) console.log(`${revoked.rowCount} active session(s) of this account signed out.`);
await logSystem('create_admin', `administrator ${r.rows[0].created ? 'created' : 'reset'} from CLI`, { username, reset2fa: process.argv.includes('--reset-2fa') });
console.log(`Administrator "${username}" ${r.rows[0].created ? 'created' : 'updated'} (id ${r.rows[0].id}).` +
  (mustChange ? ' A new password must be chosen at the next sign-in.' : ''));
await pool.end();
process.exit(0);

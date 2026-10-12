#!/usr/bin/env node
// Creates (or resets) a system administrator account from the command line.
//   npm run create-admin -- --username admin --name "System Admin" [--email a@b.ly] [--password '...'] [--reset-2fa]
// The password can also come from the ETS_ADMIN_PASSWORD environment variable (used by the installer,
// so it never appears in the process list).
// Without --password the password is asked interactively (not echoed to history).
// For an existing username: resets the password, unlocks the account and makes it an active admin;
// --reset-2fa also removes its authenticator (recovery when the phone is lost).
import readline from 'node:readline';
import { pool, query } from '../src/db/pool.js';
import { hashPassword, checkPolicy } from '../src/services/passwords.js';
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
let password = arg('password') || process.env.ETS_ADMIN_PASSWORD;
if (!password) {
  password = await ask('Password: ', true);
  if ((await ask('Repeat password: ', true)) !== password) { console.error('Passwords do not match'); process.exit(1); }
}
const errs = checkPolicy(password, { minLength: 10, username });
if (errs.length) { console.error('Weak password: ' + errs.join(', ') + ' (min 10 chars, letters and digits)'); process.exit(1); }

const email = arg('email') || null;
const r = await query(`INSERT INTO users(username, full_name, email, password_hash, role_id, must_change_password)
  VALUES ($1,$2,$3,$4,'admin',false)
  ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role_id='admin', is_active=true,
    full_name=COALESCE(NULLIF(EXCLUDED.full_name,''), users.full_name), email=COALESCE(EXCLUDED.email, users.email),
    failed_attempts=0, locked_until=NULL, password_changed_at=now(), updated_at=now()
  RETURNING id, (xmax = 0) AS created`, [username, name, email, await hashPassword(password)]);
if (process.argv.includes('--reset-2fa')) {
  await query('UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL WHERE id=$1', [r.rows[0].id]);
  await query('DELETE FROM user_recovery_codes WHERE user_id=$1', [r.rows[0].id]);
  console.log('Two-factor authentication removed for this account.');
}
await logSystem('create_admin', `administrator ${r.rows[0].created ? 'created' : 'reset'} from CLI`, { username, reset2fa: process.argv.includes('--reset-2fa') });
console.log(`Administrator "${username}" ${r.rows[0].created ? 'created' : 'updated'} (id ${r.rows[0].id}).`);
await pool.end();
process.exit(0);

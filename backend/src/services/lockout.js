// Per-account sign-in throttling (owner decision: progressive delay per account plus a per-IP limit).
//  - Every failed password, 2FA code or recovery-code check on an account counts (login, 2FA verify and the
//    re-authentication checks on the profile page).
//  - From MAX_FAILED_LOGINS failures on, the account is paused for 1, 2, 4 … minutes (at most LOCK_MINUTES).
//    The pause ends on its own; the counter restarts once the last failure is older than LOCKOUT_RESET_MINUTES,
//    and is cleared only by a complete sign-in (password and, when required, 2FA) or by an administrator.
//  - While paused, the login answers exactly like a wrong password (also for unknown usernames), so the
//    response does not tell whether an account exists or is paused.
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { HttpError } from '../utils/http.js';
import { logAuth } from './logs.js';

// One check at a time per account (the API runs as a single Node process): concurrent guesses for the same
// account wait for each other, so each one sees the counter left by the previous one (ETS-SEC-021).
const chains = new Map();
export function serialize(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(() => fn());
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}
// Keyed by the (case-insensitive) username — also for usernames that do not exist.
export const accountKey = username => 'acct:' + String(username || '').toLowerCase();

export const isDelayed = u => !!u.locked_until && new Date(u.locked_until) > new Date();
export const retryAfter = u => Math.max(1, Math.ceil((new Date(u.locked_until) - Date.now()) / 1000));
export const tooManyAttempts = u => new HttpError(429, 'too_many_attempts', { retry_after: retryAfter(u) });

// Counts one failure atomically and returns { attempts, locked_until, delayed }.
export async function registerFailure(req, u, event) {
  const max = config.security.maxFailedLogins;
  const q = await query(`WITH c AS (
      SELECT id, CASE WHEN last_failed_at IS NULL OR last_failed_at < now() - make_interval(mins => $3)
                      THEN 1 ELSE failed_attempts + 1 END AS n
      FROM users WHERE id=$1 FOR UPDATE)
    UPDATE users u SET failed_attempts = c.n, last_failed_at = now(),
      locked_until = CASE WHEN c.n >= $2
        THEN now() + least(make_interval(mins => $4), make_interval(secs => 60 * power(2, least(c.n - $2, 20))))
        ELSE u.locked_until END
    FROM c WHERE u.id = c.id RETURNING u.failed_attempts, u.locked_until`,
  [u.id, max, config.security.lockoutResetMinutes, config.security.lockMinutes]);
  const row = q.rows[0];
  await logAuth(req, { userId: u.id, username: u.username, event, success: false, detail: { attempts: row.failed_attempts } });
  const delayed = row.failed_attempts >= max;
  if (delayed) {
    await logAuth(req, { userId: u.id, username: u.username, event: 'account_locked', success: false,
      detail: { until: row.locked_until, attempts: row.failed_attempts } });
  }
  return { attempts: row.failed_attempts, locked_until: row.locked_until, delayed };
}

// After a complete sign-in, or when an administrator unlocks / resets the account.
export const clearFailures = (userId, db = { query }) =>
  db.query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE id=$1', [userId]);

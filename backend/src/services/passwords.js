import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';

export const hashPassword = pw => bcrypt.hash(String(pw), config.security.bcryptRounds);
// Many passwords at once (bulk user import): bcrypt at full cost takes ~0.3 s per password, so up to 500 of
// them are spread over a few short-lived worker threads instead of running one after another on the main thread.
// The passwords only travel in memory between threads; workers end as soon as the list is done.
export async function hashManyPasswords(list) {
  if (list.length <= 2) return Promise.all(list.map(hashPassword));
  const n = Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1, list.length));
  const out = new Array(list.length);
  let next = 0;
  const run = () => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./hash-worker.js', import.meta.url));
    const done = err => { w.terminate(); err ? reject(err) : resolve(); };
    const send = () => { if (next >= list.length) return done(); const i = next++; w.postMessage({ i, pw: list[i], rounds: config.security.bcryptRounds }); };
    w.on('message', m => { if (m.error) return done(new Error(m.error)); out[m.i] = m.hash; send(); });
    w.on('error', done);
    send();
  });
  await Promise.all(Array.from({ length: n }, run));
  return out;
}
export const verifyPassword = (pw, hash) => bcrypt.compare(String(pw), hash);
// True when a stored hash was made with another cost than BCRYPT_ROUNDS; it is re-hashed at the next
// successful sign-in so all hashes (and the dummy below) keep the same cost and timing (ETS-SEC-019/020).
export const needsRehash = hash => /^\$2[aby]\$\d\d\$/.test(String(hash)) && bcrypt.getRounds(hash) !== config.security.bcryptRounds;

// A constant hash used to keep login timing equal when the username does not exist.
// It uses the same cost as real hashes (bcrypt time follows the cost stored in the hash);
// made once on first use (server.js warms it at startup) so importing this module stays fast.
let dummyHash;
export const getDummyHash = () => (dummyHash ??= bcrypt.hash('not-a-real-password', config.security.bcryptRounds));

// Lowest minimum length whatever the setting says, and the minimum for administrator accounts.
export const MIN_LENGTH_FLOOR = 10;
export const ADMIN_MIN_LENGTH = 12;
// bcrypt only uses the first 72 bytes (UTF-8): longer passwords are refused instead of silently cut.
const MAX_BYTES = 72;

// Common passwords and the words they are usually built on (checked case-insensitively, ignoring digits and
// symbols at the end, so "Password2026!" and "Qwerty12345" are refused). Offline list, no outside service.
const COMMON = new Set(['password', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'pa$$w0rd', 'pass', 'qwerty', 'qwertyuiop',
  'asdfgh', 'asdfghjkl', 'zxcvbnm', 'abc', 'abcd', 'abcdef', 'abcdefg', 'abc123', 'admin', 'administrator', 'root',
  'welcome', 'letmein', 'iloveyou', 'monkey', 'dragon', 'master', 'secret', 'changeme', 'default', 'test', 'tester',
  'user', 'login', 'ets', 'erp', 'system', 'manager', 'football', 'sunshine', 'princess', 'shadow', 'superman',
  'q1w2e3r4', '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'aa', 'aaa', 'aaaa', 'libya', 'tripoli', 'benghazi', 'ليبيا',
  'كلمةالمرور', 'كلمةسر', 'مرحبا']);
const isCommon = p => {
  const base = p.toLowerCase().replace(/[\p{N}\p{P}\p{S}\s]+$/u, '').replace(/^[\p{N}\p{P}\p{S}\s]+/u, '');
  return !base || COMMON.has(base) || COMMON.has(p.toLowerCase()) || /^(.)\1+$/u.test(base);
};

// Returns a list of error codes (empty = valid).
// minLength comes from Settings (never below MIN_LENGTH_FLOOR); admin = the account is (or becomes) an administrator.
export function checkPolicy(pw, { minLength = MIN_LENGTH_FLOOR, username = '', admin = false } = {}) {
  const p = String(pw || '');
  const errors = [];
  const min = Math.max(+minLength || 0, MIN_LENGTH_FLOOR, admin ? ADMIN_MIN_LENGTH : 0);
  if ([...p].length < min) errors.push('password_too_short');
  if (Buffer.byteLength(p, 'utf8') > MAX_BYTES) errors.push('password_too_long');
  if (!/[a-zء-ي]/i.test(p) || !/\d/.test(p)) errors.push('password_needs_letters_digits');
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) errors.push('password_contains_username');
  if (isCommon(p)) errors.push('password_too_common');
  return errors;
}

// ---- temporary passwords (bulk user import) ----
// Letters and digits without the look-alikes 0 O o 1 l I (read aloud or copied by hand). At least 16 characters
// (≈ 92 bits), more when Settings asks for a longer minimum; picked without modulo bias. Re-drawn until it passes
// the same policy as a password typed by an administrator (letters + digits, no username, not common).
const TEMP_ABC = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TEMP_CUT = 256 - (256 % TEMP_ABC.length);
export function generateTemporaryPassword({ minLength = MIN_LENGTH_FLOOR, username = '', admin = false } = {}) {
  const len = Math.min(64, Math.max(16, +minLength || 0, admin ? ADMIN_MIN_LENGTH : 0));
  for (;;) {
    let s = '';
    while (s.length < len) {
      for (const x of crypto.randomBytes(len * 2)) if (x < TEMP_CUT && s.length < len) s += TEMP_ABC[x % TEMP_ABC.length];
    }
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !checkPolicy(s, { minLength, username, admin }).length) return s;
  }
}

// ---- 2FA recovery codes ----
// 10 codes like "4f9k-2m7q-x8bd": 12 characters from a 31-letter alphabet (≈ 59 bits), picked without
// modulo bias (ETS-SEC-030). Shown once; stored only as a keyed hash.
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    let s = '';
    while (s.length < 12) {
      for (const x of crypto.randomBytes(16)) {
        if (x < 248 && s.length < 12) s += ABC[x % ABC.length]; // 248 = 8 × 31: drop the uneven tail
      }
    }
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  });
}

export const normalizeRecoveryCode = c => String(c || '').trim().toLowerCase();
// HMAC-SHA-256 with a key derived (HKDF) from APP_SECRET, so a database copy alone cannot be searched for codes.
const recoveryKey = () => Buffer.from(crypto.hkdfSync('sha256', config.appSecret, 'ets-recovery-codes', 'ets recovery code hmac v1', 32));
export const hashRecoveryCode = c => 'h1:' + crypto.createHmac('sha256', recoveryKey()).update(normalizeRecoveryCode(c)).digest('hex');
// Hashes a typed code may be stored under: the current keyed hash, and the plain SHA-256 used before 1.0.0
// (those codes keep working until used or regenerated; the profile page suggests regenerating them).
export const recoveryCodeHashes = c => [hashRecoveryCode(c), crypto.createHash('sha256').update(normalizeRecoveryCode(c)).digest('hex')];

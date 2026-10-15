import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from '../config.js';

export const hashPassword = pw => bcrypt.hash(String(pw), config.security.bcryptRounds);
export const verifyPassword = (pw, hash) => bcrypt.compare(String(pw), hash);

// A constant hash used to keep login timing equal when the username does not exist.
// It uses the same cost as real hashes (bcrypt time follows the cost stored in the hash);
// made once on first use (server.js warms it at startup) so importing this module stays fast.
let dummyHash;
export const getDummyHash = () => (dummyHash ??= bcrypt.hash('not-a-real-password', config.security.bcryptRounds));

// Returns a list of error codes (empty = valid).
export function checkPolicy(pw, { minLength = 10, username = '' } = {}) {
  const p = String(pw || '');
  const errors = [];
  if (p.length < minLength) errors.push('password_too_short');
  if (!/[a-zء-ي]/i.test(p) || !/\d/.test(p)) errors.push('password_needs_letters_digits');
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) errors.push('password_contains_username');
  return errors;
}

// 10 recovery codes like "4f9k-2m7q" (shown once, stored hashed)
export function generateRecoveryCodes(n = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8);
    const s = Array.from(b, x => abc[x % abc.length]).join('');
    return s.slice(0, 4) + '-' + s.slice(4);
  });
}

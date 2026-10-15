import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, hotp, totp, verifyTotp, generateSecret } from '../src/services/totp.js';

// RFC 6238 Appendix B (SHA-1), truncated to 6 digits
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('base32 round trip', () => {
  assert.equal(SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(SECRET).toString(), '12345678901234567890');
});

test('RFC 6238 test vectors', () => {
  assert.equal(totp(SECRET, 59 * 1000), '287082');
  assert.equal(totp(SECRET, 1111111109 * 1000), '081804');
  assert.equal(totp(SECRET, 1234567890 * 1000), '005924');
  assert.equal(totp(SECRET, 2000000000 * 1000), '279037');
});

test('RFC 4226 HOTP vectors', () => {
  assert.deepEqual([0, 1, 2, 3].map(c => hotp(SECRET, c)), ['755224', '287082', '359152', '969429']);
});

test('verify accepts ±1 step and rejects others', () => {
  const s = generateSecret();
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30000);
  assert.equal(verifyTotp(s, totp(s, now), { time: now }), step);
  assert.equal(verifyTotp(s, totp(s, now - 30000), { time: now }), step - 1);
  assert.equal(verifyTotp(s, totp(s, now - 90000), { time: now }), null);
  assert.equal(verifyTotp(s, 'abc', { time: now }), null);
});

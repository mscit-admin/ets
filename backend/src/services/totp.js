// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) — compatible with Google Authenticator,
// Microsoft Authenticator, Authy, FreeOTP, etc.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}

export const totp = (secret, time = Date.now()) => hotp(secret, Math.floor(time / 30000));

// Accepts the current step and ±window steps (clock drift). Returns the matched
// step (so callers can reject replays) or null.
export function verifyTotp(secret, token, { window = 1, time = Date.now() } = {}) {
  const t = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const step = Math.floor(time / 30000);
  for (let w = -window; w <= window; w++) {
    const a = Buffer.from(hotp(secret, step + w)), b = Buffer.from(t);
    if (crypto.timingSafeEqual(a, b)) return step + w;
  }
  return null;
}

export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

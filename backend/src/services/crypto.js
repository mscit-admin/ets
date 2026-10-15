import crypto from 'node:crypto';
import { config } from '../config.js';

// Keys are derived from APP_SECRET. "v1" (old): key = SHA-256('ets-totp:'||secret).
// "v2" (current): key = HKDF-SHA256(secret, purpose), with a key id so that APP_SECRET can be rotated:
// the previous secret(s) in APP_SECRET_OLD still decrypt, and `npm run rotate-app-secret` re-encrypts.
const v1Key = secret => crypto.createHash('sha256').update('ets-totp:' + secret).digest();
const v2Key = secret => Buffer.from(crypto.hkdfSync('sha256', secret, 'ets-app-secret', 'ets-totp:v2', 32));
// Public key id: a short fingerprint of the secret (cannot be reversed into the secret or the key).
export const keyId = secret => crypto.createHash('sha256').update('ets-kid:' + secret).digest('hex').slice(0, 12);
const secrets = () => [config.appSecret, ...config.appSecretOld].filter(Boolean);

function open(key, iv, tag, enc, aad) {
  const t = Buffer.from(tag, 'base64url');
  if (t.length !== 16) throw new Error('Invalid authentication tag');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
  if (aad) d.setAAD(Buffer.from(String(aad), 'utf8'));
  d.setAuthTag(t);
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// AES-256-GCM; output "v2:kid:iv:tag:ciphertext" (base64url parts). `aad` (optional) binds the blob to
// a context such as the owning user id; the same value must be given to decrypt.
export function encrypt(plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', v2Key(config.appSecret), iv, { authTagLength: 16 });
  if (aad) c.setAAD(Buffer.from(String(aad), 'utf8'));
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v2', keyId(config.appSecret), iv.toString('base64url'), c.getAuthTag().toString('base64url'),
    enc.toString('base64url')].join(':');
}

export function decrypt(blob, aad) {
  const parts = String(blob).split(':');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, iv, tag, enc] = parts;
    const secret = secrets().find(s => keyId(s) === kid);
    if (!secret) throw new Error('Encrypted with an unknown APP_SECRET (key id ' + kid + ')');
    return open(v2Key(secret), iv, tag, enc, aad);
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    const [, iv, tag, enc] = parts;
    let err;
    for (const s of secrets()) {
      try { return open(v1Key(s), iv, tag, enc); } catch (e) { err = e; }
    }
    throw err || new Error('APP_SECRET is not set');
  }
  throw new Error('Unknown cipher version');
}

// True when a blob is not yet in the current format/key (re-encrypt it with reencrypt()).
export const needsReencrypt = blob => !String(blob).startsWith(`v2:${keyId(config.appSecret)}:`);
export const reencrypt = (blob, aad) => encrypt(decrypt(blob, aad), aad);

export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

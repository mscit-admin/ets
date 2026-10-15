import crypto from 'node:crypto';
import { config } from '../config.js';

const key = () => crypto.createHash('sha256').update('ets-totp:' + config.appSecret).digest();

// AES-256-GCM; output "v1:iv:tag:ciphertext" (base64url parts)
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join(':');
}

export function decrypt(blob) {
  const [v, iv, tag, enc] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unknown cipher version');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

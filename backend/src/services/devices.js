// Phones paired with an account (the Android app, 1.9.0). See docs/handover/06-Security.md §4b.
//
//  pairing code  10 characters (A–Z without I/L/O, 2–9: ~49 bits), one-time, valid 10 minutes, issued from a full
//                session after re-authentication (password and, when 2FA is on, a code); only its HMAC is stored.
//                A new code replaces the user's unused ones.
//  device token  32 random bytes, base64url (43 characters), returned once by POST /api/devices/pair; only its HMAC
//                (key derived from APP_SECRET; the previous secrets in APP_SECRET_OLD are accepted and the stored
//                hash is upgraded) is stored. Sent as "Authorization: Bearer <token>", accepted on /api/m/* only.
//  revocation    by the user (profile, or the phone itself: DELETE /api/m/device), an administrator (user page), and automatically — in the same transaction
//                as the account change — when the account is deactivated, deleted or its password is reset by an
//                administrator, and by the daily check after notify.device_idle_days without use. Every pairing and
//                revocation is written to auth_log (mobile_device_paired / mobile_device_revoked) and the change
//                history (pair:device / revoke:device).
import crypto from 'node:crypto';
import { config } from '../config.js';
import { onCommit } from '../db/pool.js';
import { logAudit, logAuth } from './logs.js';
import { publishDeviceCheck, closeDeviceStreams } from './live.js';

export const PAIR_TTL_MIN = 10;
export const MAX_DEVICES = 10;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;

const keyFor = (secret, purpose) => Buffer.from(crypto.hkdfSync('sha256', secret, 'ets-app-secret', purpose, 32));
const hmac = (secret, purpose, v) => 'h1:' + crypto.createHmac('sha256', keyFor(secret, purpose)).update(v).digest('hex');
const secrets = () => [config.appSecret, ...config.appSecretOld].filter(Boolean);

export const normCode = c => String(c ?? '').toUpperCase().replace(/[\s-]/g, '');
export const codeHashes = c => secrets().map(s => hmac(s, 'ets-device-pair-code v1', normCode(c)));
export const tokenHash = t => hmac(config.appSecret, 'ets-device-token v1', String(t));
export const tokenHashes = t => secrets().map(s => hmac(s, 'ets-device-token v1', String(t)));

export function newPairCode() {
  const b = crypto.randomBytes(10);
  return [...b].map(x => ALPHABET[x % ALPHABET.length]).join('');   // 256 % 31 bias is negligible for a 10-minute code
}
export const newToken = () => crypto.randomBytes(32).toString('base64url');

// Public address and certificate fingerprint written into the pairing QR.
// PUBLIC_BASE_URL (e.g. https://ets.example.ly) — else the address the browser used for this request.
// TLS_CERT_SHA256 — SHA-256 of the server certificate (DER), 64 hex digits; null when unset (e.g. a public CA).
export function qrPayload(req, code) {
  const url = config.mobile.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  return JSON.stringify({ v: 1, url: url.replace(/\/+$/, ''), code, cert_sha256: config.mobile.certSha256 || null });
}

const devRef = d => ({ id: d.id, name: d.name, platform: d.platform, app_version: d.app_version || null });

// Revokes devices inside the caller's transaction c, with one audit + auth row each.
// where: { userIds } or { ids }; reason: user | unpaired (from the phone) | admin | user_disabled | user_deleted | password_reset | inactive.
// by: the user who did it (null for the daily check). → the revoked rows. Their phone streams close after COMMIT.
export async function revokeDevices(c, req, { userIds = null, ids = null, reason, by = null }) {
  const rows = (await c.query(`UPDATE mobile_devices d SET revoked_at=now(), revoked_by=$2, revoke_reason=$3
    WHERE d.revoked_at IS NULL AND ${userIds ? 'd.user_id = ANY($1)' : 'd.id = ANY($1)'}
    RETURNING d.id, d.user_id, d.name, d.platform, d.app_version, d.last_seen_at,
      (SELECT username FROM users WHERE id=d.user_id) AS username, (SELECT full_name FROM users WHERE id=d.user_id) AS full_name`,
  [userIds || ids, by?.id ?? null, reason])).rows;
  for (const d of rows) {
    await logAudit(req, { db: c, ...(req ? {} : { actor: { id: null, username: 'system' } }), action: 'revoke', entity: 'device', entityId: d.id,
      summary: `${d.username}: ${d.name}`, oldValue: { revoked: false }, newValue: { revoked: true, reason },
      context: { device: devRef(d), owner: { id: d.user_id, username: d.username, full_name: d.full_name }, reason,
        by: by ? { id: by.id, username: by.username, full_name: by.full_name || null } : null, last_seen_at: d.last_seen_at } });
  }
  // audit rows first, then the auth rows: every transaction takes the two log chains in the same order
  for (const d of rows) {
    await logAuth(req, { db: c, userId: d.user_id, username: d.username, event: 'mobile_device_revoked', success: true,
      detail: { device_id: d.id, name: d.name, reason, by: by?.username ?? 'system' } });
  }
  if (rows.length) {
    onCommit(c, () => {
      closeDeviceStreams(rows.map(d => d.id));
      for (const uid of new Set(rows.map(d => d.user_id))) publishDeviceCheck(uid);
    });
  }
  return rows;
}

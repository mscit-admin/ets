// /api/devices — the user's own phones (profile page «أجهزتي»), with a signed-in session (1.9.0):
//   POST   /pair-code   one-time pairing code + the QR payload, after re-authentication (password, and a 2FA or
//                       recovery code when 2FA is on), like the other sensitive actions of the profile page
//   GET    /            own devices (active, and revoked in the last 30 days)
//   DELETE /:id         revoke one of them
// The pairing itself (the phone exchanging the code for its token) is POST /api/devices/pair: routes/mobile.js,
// without a session.
import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/ratelimit.js';
import { reauth } from './auth.js';
import { codeHashes, newPairCode, qrPayload, revokeDevices, PAIR_TTL_MIN } from '../services/devices.js';
import { logAuth } from '../services/logs.js';
import { notFound, idParam } from '../utils/http.js';

const r = Router();

r.post('/pair-code', authLimiter, requireAuth, async (req, res) => {
  await reauth(req, { password: req.body?.password, secondFactor: true, events: ['device_pair_bad_password', 'device_pair_bad_code'] });
  const code = newPairCode();
  const expires = await tx(async c => {
    // one code at a time: a new one replaces the user's unused codes
    await c.query('DELETE FROM device_pair_codes WHERE user_id=$1 AND used_at IS NULL', [req.user.id]);
    const row = (await c.query(`INSERT INTO device_pair_codes(code_hash, user_id, expires_at)
      VALUES ($1,$2, now() + make_interval(mins => $3)) RETURNING expires_at`, [codeHashes(code)[0], req.user.id, PAIR_TTL_MIN])).rows[0];
    await logAuth(req, { db: c, userId: req.user.id, username: req.user.username, event: 'mobile_pair_code_issued', success: true,
      detail: { expires_at: row.expires_at } });
    return row.expires_at;
  });
  res.json({ code, expires_at: expires, payload: qrPayload(req, code) });
});

r.use(requireAuth);

export async function devicesOf(userId) {
  return (await query(`SELECT id, name, platform, app_version, created_at, last_seen_at, revoked_at, revoke_reason
    FROM mobile_devices WHERE user_id=$1 AND (revoked_at IS NULL OR revoked_at > now() - interval '30 days')
    ORDER BY revoked_at IS NOT NULL, created_at DESC`, [userId])).rows;
}

r.get('/', async (req, res) => res.json({ devices: await devicesOf(req.user.id) }));

r.delete('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const n = await tx(async c => {
    const d = (await c.query('SELECT id, revoked_at FROM mobile_devices WHERE id=$1 AND user_id=$2', [id, req.user.id])).rows[0];
    if (!d) throw notFound();
    if (d.revoked_at) return 0;
    return (await revokeDevices(c, req, { ids: [id], reason: 'user', by: req.user })).length;
  });
  res.json({ ok: true, revoked: n });
});

export default r;

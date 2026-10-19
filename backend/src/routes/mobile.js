// The Android app's API (1.9.0). Two routers, mounted in app.js before the web API so neither ever reads a cookie:
//
//   POST /api/devices/pair        no session: { code, device_name, platform: 'android', app_version } →
//                                 { device_id, token, user: { full_name, lang } }. The token is shown once.
//                                 PAIR_RATE_LIMIT attempts per IP per 15 minutes (default 5), refused or not.
//   /api/m/*                      "Authorization: Bearer <device token>" only — never a cookie, and the token is
//                                 refused by every other /api route (they read only the session cookie):
//     GET  /api/m/me              { full_name, lang, server_version }
//     GET  /api/m/notifications   ?after_id=<id>&limit=1..100 → { items: [{ id, type, severity, title, body, link,
//                                 created_at, read }], unread } — with after_id: id > after_id, oldest first; without:
//                                 the newest ones, newest first; the phone's view (services/notify.js)
//     DELETE /api/m/device        the phone unpairs itself → 204 (revoked, reason «unpaired», audited)
//     POST /api/m/notifications/:id/read → 204
//     GET  /api/m/events          Server-Sent Events: "notification" { id }, "unread" { unread }, a comment every
//                                 LIVE_HEARTBEAT_SECONDS (25 s); ends when the device is revoked or the account may
//                                 no longer be used
// A token is refused (401 invalid_token) when unknown, revoked, or its account is deactivated, deleted, paused after
// failed sign-ins or must change its password. Refusals are written to auth_log (mobile_token_rejected, at most once
// per minute per address and reason) and limited per address (30 per 15 minutes, then 429).
import { Router } from 'express';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { jsonBody } from '../middleware/body.js';
import { accessLog } from '../middleware/common.js';
import { loadUserContext } from '../middleware/auth.js';
import { logAccess, logAudit, logAuth } from '../services/logs.js';
import { codeHashes, newToken, tokenHash, tokenHashes, revokeDevices, TOKEN_RE, MAX_DEVICES } from '../services/devices.js';
import { mobileList, mobileMarkRead, mobileUnread } from '../services/notify.js';
import { addMobileStream, listening } from '../services/live.js';
import { HttpError, bad, str, idParam } from '../utils/http.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const WINDOW = 15 * 60 * 1000;
const common = { standardHeaders: 'draft-7', legacyHeaders: false, windowMs: WINDOW };
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

// ---------------------------------------------------------------- pairing
export const pairLimiter = rateLimit({ ...common, limit: config.mobile.pairRateLimit,
  handler: (req, res) => {
    logAuth(req, { event: 'rate_limited', success: false, detail: { scope: 'device_pair', path: req.originalUrl.slice(0, 200) } });
    res.status(429).json({ error: 'too_many_attempts', retry_after: Math.max(1, Math.ceil(((req.rateLimit?.resetTime?.getTime() ?? Date.now() + WINDOW) - Date.now()) / 1000)) });
  } });

export const pairRouter = Router();
pairRouter.use(noStore, accessLog, pairLimiter, jsonBody);
pairRouter.post('/', async (req, res) => {
  const code = str(req.body?.code, 40);
  const name = str(req.body?.device_name, 80);
  const platform = req.body?.platform;
  const version = str(req.body?.app_version, 40) || null;
  if (!code || !name) throw bad('missing_fields');
  if (platform !== 'android') throw bad('invalid_value', { field: 'platform' });
  const token = newToken();
  const out = await tx(async c => {
    // one-time: only the first request with an unused, unexpired code gets it
    const pc = (await c.query(`UPDATE device_pair_codes SET used_at=now() WHERE code_hash = ANY($1) AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, code_hash`, [codeHashes(code)])).rows[0];
    if (!pc) {
      await logAuth(req, { db: c, event: 'mobile_pair_rejected', success: false, detail: { reason: 'invalid_or_expired_code', device_name: name } });
      return { error: 'invalid_code' };
    }
    const u = (await c.query(`SELECT id, username, full_name, language, is_active, deleted_at, must_change_password,
        (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM users WHERE id=$1 FOR UPDATE`, [pc.user_id])).rows[0];
    if (!u || !u.is_active || u.deleted_at || u.must_change_password || u.locked) {
      await logAuth(req, { db: c, userId: u?.id, username: u?.username, event: 'mobile_pair_rejected', success: false, detail: { reason: 'account_unavailable' } });
      return { error: 'invalid_code' };
    }
    const n = (await c.query('SELECT count(*)::int AS n FROM mobile_devices WHERE user_id=$1 AND revoked_at IS NULL', [u.id])).rows[0].n;
    if (n >= MAX_DEVICES) {
      await logAuth(req, { db: c, userId: u.id, username: u.username, event: 'mobile_pair_rejected', success: false, detail: { reason: 'too_many_devices' } });
      return { error: 'too_many_devices' };
    }
    const d = (await c.query(`INSERT INTO mobile_devices(user_id, name, platform, app_version, token_hash, created_ip, last_seen_at, last_ip)
      VALUES ($1,$2,$3,$4,$5,$6, now(), $6) RETURNING id, name, platform, app_version`, [u.id, name, platform, version, tokenHash(token), req.ip])).rows[0];
    await c.query('UPDATE device_pair_codes SET device_id=$2 WHERE code_hash=$1', [pc.code_hash, d.id]);
    const owner = { id: u.id, username: u.username, full_name: u.full_name };
    await logAudit(req, { db: c, actor: owner, actorIp: req.ip, action: 'pair', entity: 'device', entityId: d.id, summary: `${u.username}: ${d.name}`,
      newValue: { name: d.name, platform: d.platform, app_version: d.app_version },
      context: { device: d, owner, cert_sha256: config.mobile.certSha256 || null } });
    await logAuth(req, { db: c, userId: u.id, username: u.username, event: 'mobile_device_paired', success: true,
      detail: { device_id: d.id, name: d.name, platform: d.platform, app_version: d.app_version, cert_sha256: config.mobile.certSha256 || null } });
    return { device: d, user: u };
  });
  // a rejected code is answered after its auth_log row is committed (the transaction above did not roll back)
  if (out.error === 'too_many_devices') throw new HttpError(409, 'too_many_devices', { max: MAX_DEVICES });
  if (out.error) throw new HttpError(400, 'invalid_code');
  res.status(201).json({ device_id: out.device.id, token, user: { full_name: out.user.full_name, lang: out.user.language } });
});

// ---------------------------------------------------------------- Bearer device authentication
const failLimiter = rateLimit({ ...common, limit: 30, skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode !== 401,
  handler: (req, res) => res.status(429).json({ error: 'too_many_requests' }) });

const lastLogged = new Map();          // ip|reason → time: one auth_log row per minute and reason
function rejected(req, reason, extra = {}) {
  const k = `${req.ip}|${reason}`, t = Date.now();
  if (!(lastLogged.get(k) > t - 60_000)) {
    lastLogged.set(k, t);
    if (lastLogged.size > 5000) lastLogged.clear();
    logAuth(req, { userId: extra.userId ?? null, username: extra.username ?? null, event: 'mobile_token_rejected', success: false,
      detail: { reason, path: req.originalUrl.slice(0, 200), device_id: extra.deviceId ?? null } });
  }
  throw new HttpError(401, 'invalid_token');
}

export async function deviceAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(h);
  if (!m || !TOKEN_RE.test(m[1])) return rejected(req, h ? 'malformed' : 'missing');
  const hashes = tokenHashes(m[1]);
  const d = (await query(`SELECT d.id, d.user_id, d.name, d.token_hash, d.revoked_at, d.last_seen_at, u.username, u.is_active, u.deleted_at,
      u.must_change_password, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked
    FROM mobile_devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash = ANY($1)`, [hashes])).rows[0];
  if (!d) return rejected(req, 'unknown');
  const who = { userId: d.user_id, username: d.username, deviceId: d.id };
  if (d.revoked_at) return rejected(req, 'revoked', who);
  if (!d.is_active || d.deleted_at || d.must_change_password || d.locked) return rejected(req, 'account_unavailable', who);
  const user = await loadUserContext(d.user_id);
  if (!user || !user.is_active) return rejected(req, 'account_unavailable', who);
  // a token stored under a previous APP_SECRET is moved to the current one; last use is recorded every 5 minutes
  if (d.token_hash !== hashes[0]) await query('UPDATE mobile_devices SET token_hash=$2 WHERE id=$1', [d.id, hashes[0]]);
  if (!d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 5 * 60_000) {
    query('UPDATE mobile_devices SET last_seen_at=now(), last_ip=$2 WHERE id=$1', [d.id, req.ip]).catch(() => {});
  }
  req.user = user;
  req.device = { id: d.id, name: d.name };
  next();
}

export const mobileRouter = Router();
mobileRouter.use(noStore, accessLog, failLimiter, jsonBody, deviceAuth);

mobileRouter.get('/me', (req, res) => res.json({ full_name: req.user.full_name, lang: req.user.language, server_version: pkg.version }));

mobileRouter.get('/notifications', async (req, res) => {
  const raw = req.query.after_id;
  const after = raw === undefined || raw === '' ? null : String(raw) === '0' ? 0 : idParam(String(raw), 'after_id');
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('invalid_value', { field: 'limit' });
  res.json(await mobileList(req.user, { afterId: after, limit }));
});

mobileRouter.post('/notifications/:id/read', async (req, res) => {
  if (!(await mobileMarkRead(req.user, idParam(req.params.id)))) throw new HttpError(404, 'not_found');
  res.status(204).end();
});

mobileRouter.get('/events', async (req, res) => {
  try { await listening(); } catch { throw new HttpError(503, 'live_unavailable'); }
  if (req.socket.destroyed) return;
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.locals.accessLogged = true;
  logAccess(req, res, 0);
  const done = addMobileStream(res, { deviceId: req.device.id, user: req.user });
  req.on('close', done);
  res.write('retry: 10000\n\n');
  res.write(`event: unread\ndata: ${JSON.stringify({ unread: await mobileUnread(req.user) })}\n\n`);
});

// DELETE /api/m/device — the phone unpairs itself: its device is revoked (reason «unpaired»), audited like every
// revocation; the token stops working at once. → 204
mobileRouter.delete('/device', async (req, res) => {
  await tx(c => revokeDevices(c, req, { ids: [req.device.id], reason: 'unpaired', by: req.user }));
  res.status(204).end();
});

mobileRouter.use((req, res) => res.status(404).json({ error: 'not_found' }));


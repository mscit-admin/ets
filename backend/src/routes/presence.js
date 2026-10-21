// Online users (1.11.0, services/presence.js).
//   POST /api/presence        any signed-in user: { path, screen, ref? } about the caller's OWN session only (the
//                             session cookie decides which row; nothing in the body names a session or a user).
//                             200 { stored: true } | 202 { stored: false, coalesced: true }. Never activity for the
//                             idle timeout (middleware/auth.js). Header "X-ETS-Client: mobile" → client 'mobile'.
//   GET  /api/presence        system administrators only ('usr' + admin role, like the Users screen): who is online
//                             now. Viewing it is recorded in the change history at most once per 15 minutes per
//                             administrator (action 'view', entity 'presence').
//   GET  /api/presence/count  administrators only: { online, idle } (the Users page indicator; not recorded).
// Ending a listed session: POST /api/users/:id/revoke-sessions { session_ref } (routes/users.js).
import { Router } from 'express';
import { requireAuth, requirePerm, requireAdmin } from '../middleware/auth.js';
import { logAudit } from '../services/logs.js';
import { listPresence, presenceCounts, report } from '../services/presence.js';

const r = Router();
const adminOnly = [requireAuth, requirePerm('usr'), requireAdmin];

r.post('/', requireAuth, async (req, res) => {
  const out = await report(req);
  res.locals.accessFileOnly = true;          // one row per minute and tab would flood access_log (services/logs.js)
  res.status(out.stored ? 200 : 202).json(out);
});

// Looking at who is online is recorded once per administrator every 15 minutes (as the security logs, routes/logs.js).
const VIEW_EVERY = 15 * 60 * 1000;
const lastView = new Map();
async function recordView(req) {
  const k = req.user.id;
  if (Date.now() - (lastView.get(k) || 0) < VIEW_EVERY) return;
  lastView.set(k, Date.now());
  if (lastView.size > 10000) lastView.clear();
  await logAudit(req, { soft: true, action: 'view', entity: 'presence', entityId: 'online_users' });
}
export const resetViewThrottle = () => lastView.clear();

r.get('/', ...adminOnly, async (req, res) => {
  const data = await listPresence({ sessionId: req.session.id });
  await recordView(req);
  res.json(data);
});

r.get('/count', ...adminOnly, async (req, res) => res.json(await presenceCounts()));

export default r;

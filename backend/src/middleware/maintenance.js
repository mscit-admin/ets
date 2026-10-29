// Maintenance gate (1.12.38): while maintenance mode is on, non-admin API requests are short-circuited with a 503
// `maintenance_mode` so maintenance is real — an already-signed-in non-admin can no longer read or change anything.
// ADMIN-EXEMPT: an administrator is never blocked, so they can do the maintenance. A small allow-list stays open for
// everyone so the feature works: /auth (the login screen state, sign-out, 2FA, /me), /maintenance (the public state),
// and the mandatory-alert channel (/messages + the /events SSE stream) so the maintenance «تنبيه» can still reach and
// be answered by active users through AlertGate. Runs after sessionMiddleware, so req.user (if any) is known.
import { ADMIN_ROLE } from './auth.js';
import { maintenanceState } from '../services/maintenance.js';

// Request path prefixes that stay reachable for non-admins while maintenance is on (req.path is relative to /api).
const ALLOW_PREFIXES = ['/auth', '/maintenance', '/messages', '/events'];
const allowed = p => ALLOW_PREFIXES.some(a => p === a || p.startsWith(a + '/'));

export async function maintenanceGate(req, res, next) {
  try {
    if (req.user?.role === ADMIN_ROLE) return next();     // administrators are never blocked
    if (allowed(req.path)) return next();
    const m = await maintenanceState();
    if (!m.enabled) return next();
    return res.status(503).json({ error: 'maintenance_mode', message: m.message || null });
  } catch (e) { return next(e); }
}

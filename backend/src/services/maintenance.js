// Maintenance mode (1.12.31): an administrator can disable sign-in for everyone but administrators while the system
// is being updated / maintained. State is kept in the EXISTING settings mechanism (no schema change / migration):
//   maintenance.enabled  boolean   — on/off
//   maintenance.message  text      — the message shown on the login screen and sent as the maintenance alert; when
//                                     empty the clients fall back to their own localised default (AR/EN parity).
//   maintenance.since    timestamptz (ISO string) | null — when it was last turned on
//   maintenance.by       text | null — the username of the administrator who turned it on
//
// While on, ① the login endpoint refuses a would-be-successful NON-admin sign-in with a 503 `maintenance_mode`
// carrying the message (routes/auth.js), and ② the maintenance gate short-circuits non-admin API requests with the
// same 503 (middleware/maintenance.js), so an already-signed-in non-admin is signed out of active use. Both gates are
// ADMIN-EXEMPT: an administrator is never locked out, so they can perform the maintenance. The toggle is admin-only
// (routes/maintenance.js, requireAdmin) and, on enable, fires a mandatory ALERT to active non-admin users by reusing
// the existing alert broadcast (services/messages.js), which pops up through AlertGate like any other «تنبيه».
import { allSettings, getSetting } from './settings.js';

export const MAINTENANCE_KEYS = ['maintenance.enabled', 'maintenance.message', 'maintenance.since', 'maintenance.by'];
export const MAINTENANCE_MESSAGE_MAX = 1000;
// A sensible default used for the ALERT body when the administrator left the message empty (RTL-first, the app's
// default language). The login screen and the in-app banner fall back to their own localised strings instead.
export const DEFAULT_MAINTENANCE_MESSAGE = 'النظام تحت الصيانة حالياً. الدخول متوقّف مؤقتاً وسيعود قريباً.';

// The maintenance state, read from the shared settings cache. Leaks nothing beyond what the login screen needs.
export async function maintenanceState() {
  const s = await allSettings();
  return {
    enabled: !!s['maintenance.enabled'],
    message: typeof s['maintenance.message'] === 'string' ? s['maintenance.message'] : '',
    since: s['maintenance.since'] || null,
    by: s['maintenance.by'] || null,
  };
}

// Only { enabled, message } — what the (public) login screen may learn without authenticating.
export async function publicMaintenanceState() {
  const enabled = !!(await getSetting('maintenance.enabled'));
  const message = enabled ? (await getSetting('maintenance.message')) || '' : '';
  return { enabled, message };
}

// /api/maintenance — maintenance mode (1.12.38). See services/maintenance.js for the model.
//   GET  /public   PUBLIC (no session): { enabled, message } — the login screen's banner. Leaks nothing else.
//   GET  /         admin only: the full state { enabled, message, since, by } for the Settings screen.
//   PUT  /         admin only: enable/disable + set the message. On ENABLE (a real off→on transition) fires a
//                  mandatory alert to active non-admin users (reusing the alert broadcast) and audits 'maintenance_on';
//                  disabling audits 'maintenance_off'. Administrators are never locked out by maintenance mode.
import { Router } from 'express';
import { tx } from '../db/pool.js';
import { requireAuth, requireAdmin, ADMIN_ROLE } from '../middleware/auth.js';
import { invalidateSettings } from '../services/settings.js';
import { maintenanceState, publicMaintenanceState, MAINTENANCE_MESSAGE_MAX, DEFAULT_MAINTENANCE_MESSAGE } from '../services/maintenance.js';
import { activeUsers } from '../services/notify.js';
import { sendBroadcast } from '../services/messages.js';
import { logAudit } from '../services/logs.js';

const r = Router();

// Public — the login screen learns the maintenance state without a session. Only { enabled, message }.
r.get('/public', async (req, res) => res.json(await publicMaintenanceState()));

// Everything below is administrators only — the one role maintenance mode never blocks.
r.use(requireAuth, requireAdmin);

r.get('/', async (req, res) => res.json(await maintenanceState()));

r.put('/', async (req, res) => {
  const body = req.body || {};
  if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'invalid_value', field: 'enabled' });
  if (body.message !== undefined && typeof body.message !== 'string') return res.status(400).json({ error: 'invalid_value', field: 'message' });
  const enabled = body.enabled;
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAINTENANCE_MESSAGE_MAX) : '';

  const before = await maintenanceState();
  const turningOn = enabled && !before.enabled;
  const since = enabled ? (before.enabled ? before.since : new Date().toISOString()) : null;
  const by = enabled ? (before.enabled ? before.by : req.user.username) : null;

  await tx(async c => {
    const write = async (k, v) => c.query(
      `INSERT INTO settings(key,value,updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [k, JSON.stringify(v), req.user.id]);
    await write('maintenance.enabled', enabled);
    await write('maintenance.message', message);
    await write('maintenance.since', since);
    await write('maintenance.by', by);
    await logAudit(req, { db: c, action: enabled ? 'maintenance_on' : 'maintenance_off', entity: 'maintenance',
      entityId: 'maintenance', summary: enabled ? (message ? message.slice(0, 120) : null) : null,
      oldValue: { enabled: before.enabled, message: before.message },
      newValue: { enabled, message } });

    // On a real off→on transition, warn active NON-admin users with a mandatory alert (reusing the alert broadcast):
    // it pops up through AlertGate like any other «تنبيه». Administrators are excluded — they keep working.
    if (turningOn) {
      const recipients = (await activeUsers()).filter(u => u.role !== ADMIN_ROLE && u.id !== req.user.id);
      if (recipients.length) {
        await sendBroadcast(c, req.user, {
          subject: 'صيانة النظام', body: message || DEFAULT_MAINTENANCE_MESSAGE,
          recipients, audience: { all: true, maintenance: true }, kind: 'alert',
        });
      }
    }
  });
  invalidateSettings();
  // return the fresh full state; allSettings is now rebuilt on next read
  res.json(await maintenanceState());
});

export default r;

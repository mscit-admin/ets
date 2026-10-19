import { Router } from 'express';
import { tx } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { allSettings, invalidateSettings, SETTING_RULES } from '../services/settings.js';
import { logAudit, logAuth, logger } from '../services/logs.js';
import { publishChange, publishNotif } from '../services/live.js';
import { query } from '../db/pool.js';
import { effectivePolicy, crossProblem } from '../services/notify-catalog.js';
import { retentionReduced } from '../services/notify-events.js';
import { HttpError, bad, own } from '../utils/http.js';

const r = Router();
const LIVE_KEYS = new Set(['calc.weight_mode', 'calc.notif_share', 'calc.reports_share', 'approval.edits_need_lead']);
const RETENTION_KEYS = ['logs.retention_days', 'logs.audit_retention_days', 'logs.access_retention_days'];
r.use(requireAuth, requirePerm('cfg'));

r.get('/', async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');   // project-wide settings (ETS-SEC-058)
  const s = await allSettings();
  res.json({ settings: Object.fromEntries(Object.keys(SETTING_RULES).map(k => [k, k === 'notify.policy' ? effectivePolicy(s[k]) : s[k]])) });
});

r.put('/', async (req, res) => {
  const body = req.body || {};
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  for (const [k, v] of Object.entries(body)) {
    const rule = own(SETTING_RULES, k);        // own keys only: 'toString', '__proto__'… are unknown settings
    if (!rule) throw bad('unknown_setting', { key: k.slice(0, 100) });
    if (!rule(v)) throw bad('invalid_value', { key: k });
  }
  const current = await allSettings();
  // the notification policy is stored complete (the matrix in force), so its audit row shows every cell before / after
  if (body['notify.policy'] !== undefined) body['notify.policy'] = effectivePolicy(body['notify.policy']);
  const before = { ...current, 'notify.policy': effectivePolicy(current['notify.policy']) };
  const cross = crossProblem({ ...before, ...body });
  if (cross) throw bad('invalid_value', { key: cross.key, reason: cross.reason });
  await tx(async c => {
    for (const [k, v] of Object.entries(body)) {
      if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
      await c.query(`INSERT INTO settings(key,value,updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`, [k, JSON.stringify(v), req.user.id]);
      await logAudit(req, { db: c, action: 'update', entity: 'setting', entityId: k, oldValue: { value: before[k] }, newValue: { value: v } });
    }
    // in the same transaction, after the audit rows (one order of the two log chains for every transaction)
    if (body['mfa.mode'] !== undefined && body['mfa.mode'] !== current['mfa.mode']) {
      await logAuth(req, { db: c, userId: req.user.id, username: req.user.username, event: 'mfa_policy_changed', success: true,
        detail: { from: current['mfa.mode'], to: body['mfa.mode'] } });
    }
  });
  // a shorter retention removes history sooner: flagged for whoever watches the logs (ETS-SEC-048 / 075)
  for (const k of RETENTION_KEYS) {
    if (body[k] !== undefined && body[k] < current[k]) {
      logger.warn({ alert: true, kind: 'setting', key: k, from: current[k], to: body[k], by: req.user.username }, 'log retention reduced');
      await retentionReduced({ key: k, from: current[k], to: body[k], by: req.user.username });     // S7
    }
  }
  invalidateSettings();
  // a new notification policy shows / hides alerts already stored: open bells recount
  if (body['notify.policy'] !== undefined || body['notify.enabled'] !== undefined) {
    for (const { user_id: uid } of (await query('SELECT DISTINCT user_id FROM notifications WHERE read_at IS NULL')).rows) publishNotif(uid, []);
  }
  // settings that change the percentages or who needs approval: every screen reloads (after COMMIT)
  if (Object.keys(body).some(k => LIVE_KEYS.has(k) && JSON.stringify(current[k]) !== JSON.stringify(body[k]))) publishChange();
  res.json({ ok: true });
});

export default r;

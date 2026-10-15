import { Router } from 'express';
import { tx } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { allSettings, invalidateSettings, SETTING_RULES } from '../services/settings.js';
import { logAudit, logAuth } from '../services/logs.js';
import { HttpError, bad } from '../utils/http.js';

const r = Router();
r.use(requireAuth, requirePerm('cfg'));

r.get('/', async (req, res) => {
  const s = await allSettings();
  res.json({ settings: Object.fromEntries(Object.keys(SETTING_RULES).map(k => [k, s[k]])) });
});

r.put('/', async (req, res) => {
  const body = req.body || {};
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  for (const [k, v] of Object.entries(body)) {
    if (!SETTING_RULES[k]) throw bad('unknown_setting', { key: k });
    if (!SETTING_RULES[k](v)) throw bad('invalid_value', { key: k });
  }
  const current = await allSettings();
  await tx(async c => {
    for (const [k, v] of Object.entries(body)) {
      if (JSON.stringify(current[k]) === JSON.stringify(v)) continue;
      await c.query(`INSERT INTO settings(key,value,updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`, [k, JSON.stringify(v), req.user.id]);
      await logAudit(req, { db: c, action: 'update', entity: 'setting', entityId: k, oldValue: { value: current[k] }, newValue: { value: v } });
    }
  });
  if (body['mfa.mode'] !== undefined && body['mfa.mode'] !== current['mfa.mode']) {
    await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'mfa_policy_changed', success: true,
      detail: { from: current['mfa.mode'], to: body['mfa.mode'] } });
  }
  invalidateSettings();
  res.json({ ok: true });
});

export default r;

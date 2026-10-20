// /api/notifications — the bell, the history page and the user's preferences (1.9.0). Every row is checked again
// when read (services/notify.js): the list and the counts only ever show what the user may see now.
import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { listFor, unreadSummary, markRead, prefsFor, normPrefs } from '../services/notify.js';
import { publishNotif } from '../services/live.js';
import { allSettings } from '../services/settings.js';
import { TYPES, ROLES, CATEGORIES, SEVERITIES, effectivePolicy, isEligibleCell, isLockedCell, isMandatory } from '../services/notify-catalog.js';
import { HttpError, bad, idParam, isId } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

const lang = req => (req.query.lang === 'en' || req.query.lang === 'ar' ? req.query.lang : req.user.language);

// GET /api/notifications?unread=1&category=&type=&severity=&before=<id>&limit=1..100&lang=ar|en
r.get('/', async (req, res) => {
  const q = req.query;
  const f = { unread: q.unread === '1', limit: Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20)) };
  if (q.category) { if (!CATEGORIES.includes(q.category)) throw bad('invalid_value', { field: 'category' }); f.category = q.category; }
  if (q.type) { if (!Object.hasOwn(TYPES, q.type) && q.type !== 'rate_capped') throw bad('invalid_value', { field: 'type' }); f.type = q.type; }
  if (q.severity) { if (!SEVERITIES.includes(q.severity)) throw bad('invalid_value', { field: 'severity' }); f.severity = q.severity; }
  if (q.before !== undefined) f.before = idParam(String(q.before), 'before');
  res.json(await listFor(req.user, f, lang(req)));
});

// GET /api/notifications/count → { unread, critical, top_severity } (the bell)
r.get('/count', async (req, res) => res.json(await unreadSummary(req.user)));

// POST /api/notifications/read-all { ids?: [..] } — every visible unread alert, or these ones
r.post('/read-all', async (req, res) => {
  const ids = req.body?.ids;
  if (ids !== undefined && !(Array.isArray(ids) && ids.length <= 500 && ids.every(isId))) throw bad('invalid_value', { field: 'ids' });
  res.json({ marked: await markRead(req.user, ids ? { ids } : { all: true }) });
});
r.post('/:id/read', async (req, res) => res.json({ marked: await markRead(req.user, { ids: [idParam(req.params.id)] }) }));
r.post('/:id/unread', async (req, res) => res.json({ marked: await markRead(req.user, { ids: [idParam(req.params.id)], read: false }) }));

// GET / PUT /api/notifications/prefs — the types this user may receive, with mandatory ones locked.
// PUT { muted: [type], mobile_muted: [type], digest: bool }: a mandatory type cannot be muted (400 mandatory_type).
r.get('/prefs', async (req, res) => res.json(await prefsFor(req.user)));
r.put('/prefs', async (req, res) => {
  const b = req.body || {};
  for (const k of ['muted', 'mobile_muted']) {
    if (b[k] !== undefined && !(Array.isArray(b[k]) && b[k].length <= 100 && b[k].every(t => typeof t === 'string' && Object.hasOwn(TYPES, t)))) {
      throw bad('invalid_value', { field: k });
    }
  }
  if (b.digest !== undefined && typeof b.digest !== 'boolean') throw bad('invalid_value', { field: 'digest' });
  const pol = effectivePolicy((await allSettings())['notify.policy']);
  for (const t of [...(b.muted || []), ...(b.mobile_muted || [])]) {
    if (isMandatory(pol, t, req.user.role)) throw bad('mandatory_type', { type: t });
  }
  const cur = normPrefs((await query('SELECT prefs FROM notification_prefs WHERE user_id=$1', [req.user.id])).rows[0]?.prefs);
  const next = { muted: [...new Set(b.muted ?? cur.muted)].sort(), mobile_muted: [...new Set(b.mobile_muted ?? cur.mobile_muted)].sort(), digest: b.digest ?? cur.digest };
  // a personal choice: not audited (updated_at only)
  await query(`INSERT INTO notification_prefs(user_id, prefs) VALUES ($1,$2)
    ON CONFLICT (user_id) DO UPDATE SET prefs=EXCLUDED.prefs, updated_at=now()`, [req.user.id, JSON.stringify(next)]);
  publishNotif(req.user.id, []);
  res.json(await prefsFor(req.user));
});

// GET /api/notifications/policy-meta — the matrix for Settings → «الإشعارات» (cfg, full scope): every type with its
// eligible / mandatory roles and default, the roles, and the policy in force.
r.get('/policy-meta', requirePerm('cfg'), async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  const roles = (await query(`SELECT id, name_ar, name_en FROM roles ORDER BY array_position($1::text[], id)`, [ROLES])).rows;
  res.json({
    roles,
    types: Object.entries(TYPES).map(([k, t]) => ({ type: k, code: t.code, category: t.category, kind: t.kind, severity: t.severity,
      digest: !!t.digest, admin_only: !!t.admin,
      eligible: ROLES.filter(rl => isEligibleCell(k, rl)), locked: ROLES.filter(rl => isLockedCell(k, rl)),
      default_on: ROLES.filter(rl => t.matrix[rl] === '+' || t.matrix[rl] === '!'), default_push: t.push })),
    policy: effectivePolicy((await allSettings())['notify.policy']),
  });
});

export default r;


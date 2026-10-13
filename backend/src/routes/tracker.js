import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm, hasPerm, canSeeApp, canSeeDept } from '../middleware/auth.js';
import { summarize, sCurve } from '../services/calc.js';
import { allSettings, invalidateSettings } from '../services/settings.js';
import { logAudit, logSystem } from '../services/logs.js';
import { applyLegacy, buildLegacy, parseLegacy } from '../services/legacy.js';
import { HttpError, bad, notFound, str, intIn, numIn } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

const DATE = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Everything the user may see, plus the computed percentages.
async function loadVisible(user) {
  const [d, a, f, rep, settings] = await Promise.all([
    query('SELECT * FROM departments ORDER BY sort'),
    query('SELECT * FROM applications ORDER BY sort'),
    query(`SELECT id, app_id, code, source, weight, progress, enabled, test_status, notif_status, review_status,
             (note <> '') AS has_note FROM functions`),
    query('SELECT * FROM app_reports'),
    allSettings(),
  ]);
  const apps = a.rows.filter(x => canSeeApp(user, x));
  const appIds = new Set(apps.map(x => x.id));
  const departments = d.rows.filter(x => canSeeDept(user, x.id, apps));
  const functions = f.rows.filter(x => appIds.has(x.app_id));
  const reports = rep.rows.filter(x => appIds.has(x.app_id));
  const calc = summarize({ departments, applications: apps, functions, reports, settings });
  return { departments, apps, functions, reports, settings, calc };
}

async function getApp(user, id) {
  const a = (await query('SELECT * FROM applications WHERE id=$1', [id])).rows[0];
  if (!a) throw notFound();
  if (!canSeeApp(user, a)) throw new HttpError(403, 'out_of_scope', { application: id });
  return a;
}

const calcSettings = s => ({ weight_mode: s['calc.weight_mode'], notif_share: s['calc.notif_share'], reports_share: s['calc.reports_share'] });

r.get('/summary', async (req, res) => {
  const v = await loadVisible(req.user);
  const notes = v.functions.filter(f => f.enabled && f.has_note).length;
  res.json({
    total: v.calc.total,
    departments: v.departments.map(d => ({ ...d, ...v.calc.departments.find(x => x.id === d.id) })),
    applications: v.apps.map(a => ({ ...a, calc: v.calc.applications.find(x => x.id === a.id) })),
    counts: {
      functions: v.functions.filter(f => f.enabled).length,
      done: v.functions.filter(f => f.enabled && +f.progress >= 100).length,
      notes,
      experienceOff: v.functions.filter(f => !f.enabled && f.source === 'experience').length,
    },
    settings: calcSettings(v.settings),
  });
});

r.get('/departments/:id', async (req, res) => {
  const v = await loadVisible(req.user);
  const d = v.departments.find(x => x.id === req.params.id);
  if (!d) {
    const exists = (await query('SELECT 1 FROM departments WHERE id=$1', [req.params.id])).rowCount;
    throw exists ? new HttpError(403, 'out_of_scope', { department: req.params.id }) : notFound();
  }
  res.json({
    department: { ...d, ...v.calc.departments.find(x => x.id === d.id) },
    applications: v.apps.filter(a => a.department_id === d.id).map(a => ({ ...a, calc: v.calc.applications.find(x => x.id === a.id) })),
    settings: calcSettings(v.settings),
  });
});

r.get('/applications/:id', async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const v = await loadVisible(req.user);
  const [fns, rep, dept] = await Promise.all([
    query(`SELECT f.*, u.full_name AS updated_by_name FROM functions f LEFT JOIN users u ON u.id=f.updated_by
      WHERE f.app_id=$1 ORDER BY f.sort, f.id`, [a.id]),
    query('SELECT * FROM app_reports WHERE app_id=$1', [a.id]),
    query('SELECT * FROM departments WHERE id=$1', [a.department_id]),
  ]);
  const u = req.user;
  res.json({
    application: { ...a, calc: v.calc.applications.find(x => x.id === a.id) },
    department: dept.rows[0],
    functions: fns.rows,
    report: rep.rows[0] || null,
    settings: calcSettings(v.settings),
    can: { pct: hasPerm(u, 'pct'), wgt: hasPerm(u, 'wgt'), tst: hasPerm(u, 'tst'), tog: hasPerm(u, 'tog'), rep: hasPerm(u, 'rep') },
  });
});

// Field → permission needed to change it.
const FIELD_PERM = {
  progress: 'pct', notif_status: 'pct', weight: 'wgt', enabled: 'tog',
  test_status: 'tst', review_status: 'tst', note: 'tst', name_en: 'tog',
};
const FIELD_OK = {
  progress: v => numIn(v, 0, 100), weight: v => numIn(v, 0, 1000), enabled: v => typeof v === 'boolean',
  test_status: v => intIn(v, 0, 3), notif_status: v => intIn(v, 0, 3), review_status: v => intIn(v, 0, 3),
  note: v => typeof v === 'string' && v.length <= 2000, name_en: v => typeof v === 'string' && v.length <= 500,
};

// Statuses that mean "… with notes": choosing one makes the note mandatory.
export const NOTE_REQUIRED = { test_status: 1, notif_status: 2, review_status: 3 };
export const needsNote = f => Object.entries(NOTE_REQUIRED).some(([k, v]) => f[k] === v);

r.patch('/functions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cur = (await query('SELECT * FROM functions WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound();
  await getApp(req.user, cur.app_id);
  const body = req.body || {};
  // A user allowed to set a "with notes" status may write the note that goes with it in the same request.
  const settingNotedStatus = Object.entries(NOTE_REQUIRED).some(([k, v]) => body[k] === v && hasPerm(req.user, FIELD_PERM[k]));
  const changes = {};
  for (const [k, v] of Object.entries(body)) {
    if (!(k in FIELD_PERM)) throw bad('unknown_field', { field: k });
    const allowed = hasPerm(req.user, FIELD_PERM[k]) || (k === 'note' && settingNotedStatus);
    if (!allowed) throw new HttpError(403, 'forbidden', { permission: FIELD_PERM[k], field: k });
    if (!FIELD_OK[k](v)) throw bad('invalid_value', { field: k });
    if (cur[k] !== v) changes[k] = v;
  }
  if (!Object.keys(changes).length) return res.json({ function: cur });
  const after = { ...cur, ...changes };
  if (needsNote(after) && !String(after.note || '').trim()) {
    throw bad('note_required', { fields: Object.keys(NOTE_REQUIRED).filter(k => after[k] === NOTE_REQUIRED[k]) });
  }
  const keys = Object.keys(changes);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  const updated = await tx(async c => {
    const u = (await c.query(`UPDATE functions SET ${sets}, updated_at=now(), updated_by=$${keys.length + 2} WHERE id=$1 RETURNING *`,
      [id, ...keys.map(k => changes[k]), req.user.id])).rows[0];
    await logAudit(req, { db: c, action: 'update', entity: 'function', entityId: id,
      summary: `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}`,
      oldValue: Object.fromEntries(keys.map(k => [k, cur[k]])), newValue: changes });
    return u;
  });
  res.json({ function: updated });
});

// Set the same value on every enabled function of an application.
r.post('/applications/:id/bulk', async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const { field, value } = req.body || {};
  if (!['progress', 'test_status'].includes(field)) throw bad('unknown_field');
  if (!hasPerm(req.user, FIELD_PERM[field])) throw new HttpError(403, 'forbidden', { permission: FIELD_PERM[field] });
  if (!FIELD_OK[field](value)) throw bad('invalid_value');
  if (field === 'test_status' && value === NOTE_REQUIRED.test_status) {
    const missing = (await query(`SELECT count(*)::int AS n FROM functions WHERE app_id=$1 AND enabled AND btrim(note)=''`, [a.id])).rows[0].n;
    if (missing) throw bad('note_required', { fields: ['test_status'], missing });
  }
  const n = await tx(async c => {
    const q = await c.query(`UPDATE functions SET ${field}=$2, updated_at=now(), updated_by=$3 WHERE app_id=$1 AND enabled RETURNING id`,
      [a.id, value, req.user.id]);
    await logAudit(req, { db: c, action: 'bulk_update', entity: 'application', entityId: a.id,
      summary: `${field} = ${value} on ${q.rowCount} functions`, newValue: { field, value } });
    return q.rowCount;
  });
  res.json({ updated: n });
});

// Add a custom requirement ("from experience") to an application.
r.post('/applications/:id/functions', requirePerm('tog'), async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const name = str(req.body?.name_ar, 1000);
  if (!name) throw bad('name_required');
  const reason = str(req.body?.reference, 1000) || null;
  const f = await tx(async c => {
    const n = (await c.query(`SELECT count(*)::int AS n FROM functions WHERE app_id=$1 AND code LIKE 'C%'`, [a.id])).rows[0].n;
    const row = (await c.query(`INSERT INTO functions(app_id,code,source,name_ar,reference,enabled,sort,updated_by)
      VALUES ($1,$2,'custom',$3,$4,true,2000+$5,$6) RETURNING *`, [a.id, 'C' + n, name, reason, n, req.user.id])).rows[0];
    await logAudit(req, { db: c, action: 'create', entity: 'function', entityId: row.id, summary: `${a.id}/${row.code}`, newValue: { name_ar: name, reference: reason } });
    return row;
  });
  res.status(201).json({ function: f });
});

r.delete('/functions/:id', requirePerm('tog'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cur = (await query('SELECT * FROM functions WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound();
  await getApp(req.user, cur.app_id);
  if (cur.source !== 'custom') throw bad('only_custom_deletable');
  await tx(async c => {
    await c.query('DELETE FROM functions WHERE id=$1', [id]);
    await logAudit(req, { db: c, action: 'delete', entity: 'function', entityId: id, summary: `${cur.app_id}/${cur.code}`, oldValue: cur });
  });
  res.json({ ok: true });
});

// ---- weights & calculation parameters ----
r.get('/weights', async (req, res) => {
  const v = await loadVisible(req.user);
  res.json({
    departments: v.departments,
    applications: v.apps.map(a => ({ id: a.id, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en,
      weight: a.weight, default_weight: a.default_weight, fnWeight: v.calc.applications.find(x => x.id === a.id).fnWeight })),
    settings: calcSettings(v.settings),
  });
});

r.put('/weights', requirePerm('wgt'), async (req, res) => {
  const { weights = {}, weight_mode, notif_share, reports_share } = req.body || {};
  const apps = (await query('SELECT * FROM applications')).rows;
  const byId = new Map(apps.map(a => [a.id, a]));
  for (const [id, w] of Object.entries(weights)) {
    const a = byId.get(id);
    if (!a) throw bad('unknown_application', { id });
    if (!canSeeApp(req.user, a)) throw new HttpError(403, 'out_of_scope', { application: id });
    if (!numIn(w, 0, 1000)) throw bad('invalid_value', { id });
  }
  const global = { 'calc.weight_mode': weight_mode, 'calc.notif_share': notif_share, 'calc.reports_share': reports_share };
  const globalChanges = Object.entries(global).filter(([, v]) => v !== undefined);
  // project-wide parameters affect every department → full-scope users only
  if (globalChanges.length && !req.user.fullScope) throw new HttpError(403, 'out_of_scope', { setting: 'calc' });
  if (weight_mode !== undefined && !['fixed', 'auto'].includes(weight_mode)) throw bad('invalid_value', { field: 'weight_mode' });
  for (const k of ['notif_share', 'reports_share']) if (req.body[k] !== undefined && !numIn(req.body[k], 0, 0.5)) throw bad('invalid_value', { field: k });

  await tx(async c => {
    for (const [id, w] of Object.entries(weights)) {
      const old = byId.get(id).weight;
      if (old === w) continue;
      await c.query('UPDATE applications SET weight=$2, updated_at=now(), updated_by=$3 WHERE id=$1', [id, w, req.user.id]);
      await logAudit(req, { db: c, action: 'update', entity: 'application', entityId: id, summary: 'weight', oldValue: { weight: old }, newValue: { weight: w } });
    }
    for (const [k, v] of globalChanges) {
      const old = (await c.query('SELECT value FROM settings WHERE key=$1', [k])).rows[0]?.value;
      await c.query(`INSERT INTO settings(key,value,updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`, [k, JSON.stringify(v), req.user.id]);
      await logAudit(req, { db: c, action: 'update', entity: 'setting', entityId: k, oldValue: { value: old }, newValue: { value: v } });
    }
  });
  invalidateSettings();
  res.json({ ok: true });
});

r.post('/weights/reset', requirePerm('wgt'), async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  await tx(async c => {
    await c.query('UPDATE applications SET weight=default_weight, updated_at=now(), updated_by=$1', [req.user.id]);
    await logAudit(req, { db: c, action: 'reset', entity: 'application', summary: 'all weights reset to defaults' });
  });
  res.json({ ok: true });
});

// ---- reports track ----
r.get('/reports', async (req, res) => {
  const v = await loadVisible(req.user);
  const reports = await query(`SELECT r.*, u.full_name AS updated_by_name FROM app_reports r LEFT JOIN users u ON u.id=r.updated_by`);
  const byApp = new Map(reports.rows.map(x => [x.app_id, x]));
  const base = new Set(v.departments.filter(d => d.is_base).map(d => d.id));
  res.json({
    departments: v.departments.filter(d => !d.is_base),
    applications: v.apps.filter(a => !base.has(a.department_id)).map(a => ({
      id: a.id, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en, icon: a.icon,
      weight: v.calc.applications.find(x => x.id === a.id).weight, report: byApp.get(a.id) || null })),
    settings: calcSettings(v.settings),
    can: { rep: hasPerm(req.user, 'rep') },
  });
});

r.patch('/reports/:appId', requirePerm('rep'), async (req, res) => {
  const a = await getApp(req.user, req.params.appId);
  const cur = (await query('SELECT * FROM app_reports WHERE app_id=$1', [a.id])).rows[0];
  if (!cur) throw bad('no_reports_track');
  const ok = { progress: v => numIn(v, 0, 100), status: v => intIn(v, 0, 3), note: v => typeof v === 'string' && v.length <= 2000 };
  const changes = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!ok[k]) throw bad('unknown_field', { field: k });
    if (!ok[k](v)) throw bad('invalid_value', { field: k });
    if (cur[k] !== v) changes[k] = v;
  }
  const keys = Object.keys(changes);
  if (!keys.length) return res.json({ report: cur });
  const row = await tx(async c => {
    const u = (await c.query(`UPDATE app_reports SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now(),
      updated_by=$${keys.length + 2} WHERE app_id=$1 RETURNING *`, [a.id, ...keys.map(k => changes[k]), req.user.id])).rows[0];
    await logAudit(req, { db: c, action: 'update', entity: 'report', entityId: a.id,
      oldValue: Object.fromEntries(keys.map(k => [k, cur[k]])), newValue: changes });
    return u;
  });
  res.json({ report: row });
});

// ---- schedule (S-curve) ----
r.get('/schedule', async (req, res) => {
  const s = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const v = await loadVisible(req.user);
  const n = s.periods;
  res.json({
    start_date: DATE(s.start_date), periods: n, unit: s.unit,
    plan: Array.isArray(s.plan) && s.plan.length === n ? s.plan : sCurve(n),
    plan_is_default: !(Array.isArray(s.plan) && s.plan.length === n),
    actual: Array.from({ length: n }, (_, i) => (s.actual && s.actual[i] != null ? s.actual[i] : null)),
    current_pct: v.calc.total.pct,
    can: { sch: hasPerm(req.user, 'sch') },
  });
});

r.put('/schedule', requirePerm('sch'), async (req, res) => {
  const { start_date, periods, unit, plan, actual } = req.body || {};
  if (start_date !== null && start_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) throw bad('invalid_value', { field: 'start_date' });
  if (!intIn(periods, 1, 60)) throw bad('invalid_value', { field: 'periods' });
  if (!['month', 'fortnight'].includes(unit)) throw bad('invalid_value', { field: 'unit' });
  if (plan !== null && !(Array.isArray(plan) && plan.length === periods && plan.every(x => numIn(x, 0, 100)))) throw bad('invalid_value', { field: 'plan' });
  if (!(Array.isArray(actual) && actual.length <= periods && actual.every(x => x === null || numIn(x, 0, 100)))) throw bad('invalid_value', { field: 'actual' });
  const old = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  await tx(async c => {
    await c.query('UPDATE schedule SET start_date=$1, periods=$2, unit=$3, plan=$4, actual=$5, updated_at=now(), updated_by=$6 WHERE id=1',
      [start_date || null, periods, unit, plan, actual, req.user.id]);
    await logAudit(req, { db: c, action: 'update', entity: 'schedule', entityId: 1,
      oldValue: { start_date: DATE(old.start_date), periods: old.periods, unit: old.unit, plan: old.plan, actual: old.actual },
      newValue: { start_date: start_date || null, periods, unit, plan, actual } });
  });
  res.json({ ok: true });
});

// ---- search ----
r.get('/search', async (req, res) => {
  const q = str(req.query.q, 100);
  if (q.length < 2) return res.json({ results: [] });
  const rows = (await query(`SELECT f.id, f.app_id, f.code, f.name_ar, f.name_en, f.reference, f.progress, f.enabled, f.source,
        a.department_id, a.name_ar AS app_name_ar, a.name_en AS app_name_en
      FROM functions f JOIN applications a ON a.id=f.app_id
      WHERE f.name_ar ILIKE $1 OR f.name_en ILIKE $1 OR f.reference ILIKE $1 OR f.note ILIKE $1
         OR a.name_ar ILIKE $1 OR a.name_en ILIKE $1
      ORDER BY a.sort, f.sort LIMIT 200`, ['%' + q.replace(/[%_\\]/g, '\\$&') + '%'])).rows;
  res.json({ results: rows.filter(x => canSeeApp(req.user, { id: x.app_id, department_id: x.department_id })) });
});

// ---- export / import (original tracker format) ----
r.get('/export', requirePerm('exp'), async (req, res) => {
  const payload = await tx(c => buildLegacy(c));
  await logAudit(req, { action: 'export', entity: 'tracker', summary: 'JSON export' });
  res.setHeader('Content-Disposition', `attachment; filename="ets-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(payload);
});

r.post('/import', requirePerm('imp'), async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  let payload;
  try { payload = typeof req.body?.content === 'string' ? parseLegacy(req.body.content) : req.body?.payload; }
  catch { throw bad('invalid_import_file'); }
  if (!payload?.f) throw bad('invalid_import_file');
  const counts = await tx(async c => {
    const before = await buildLegacy(c);
    const n = await applyLegacy(c, payload, req.user.id);
    await logAudit(req, { db: c, action: 'import', entity: 'tracker', summary: JSON.stringify(n), oldValue: before });
    return n;
  });
  invalidateSettings();
  logSystem('import', 'legacy tracker data imported', { by: req.user.username, ...counts });
  res.json({ ok: true, counts });
});

export default r;

import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm, hasPerm, canSeeApp, canSeeDept } from '../middleware/auth.js';
import { summarize, sCurve } from '../services/calc.js';
import { allSettings, invalidateSettings } from '../services/settings.js';
import { logAudit, logSystem } from '../services/logs.js';
import { applyLegacy, buildLegacy, parseLegacy } from '../services/legacy.js';
import { needsLeadApproval, createRequest } from '../services/edits.js';
import { recentSnapshots } from '../services/snapshots.js';
import { createFunction, newFunctionData, removeFunction, restoreFunction } from '../services/functions.js';
import { largeJson } from '../middleware/body.js';
import { HttpError, bad, notFound, str, intIn, numIn, idParam, isId } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

const DATE = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Everything the user may see, plus the computed percentages.
async function loadVisible(user) {
  const [d, a, f, rep, settings] = await Promise.all([
    query('SELECT * FROM departments ORDER BY sort'),
    query('SELECT * FROM applications ORDER BY sort'),
    query(`SELECT id, app_id, code, source, weight, progress, enabled, test_status, notif_status, review_status,
             (note <> '') AS has_note FROM functions WHERE removed_at IS NULL`),
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

const allApps = async () => (await query('SELECT id, department_id FROM applications')).rows;

// Pending (not yet approved) edits of an application, for the "awaiting approval" badges.
async function pendingFor(appId) {
  return (await query(`SELECT i.kind, i.function_id, i.field, i.new_value, r.id AS request_id, r.requested_at,
      u.full_name AS requested_by_name
    FROM edit_request_items i JOIN edit_requests r ON r.id=i.request_id LEFT JOIN users u ON u.id=r.requested_by
    WHERE r.status='pending' AND i.app_id=$1 ORDER BY r.requested_at`, [appId])).rows;
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
    query(`SELECT f.*, u.full_name AS updated_by_name, rb.full_name AS removed_by_name FROM functions f
      LEFT JOIN users u ON u.id=f.updated_by LEFT JOIN users rb ON rb.id=f.removed_by
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
    pending: await pendingFor(a.id),
    needs_approval: await needsLeadApproval(u, a.department_id, await allApps()),
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
const NOTE_REQUIRED = { test_status: 1, notif_status: 2, review_status: 3 };
const needsNote = f => Object.entries(NOTE_REQUIRED).some(([k, v]) => f[k] === v);

r.patch('/functions/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const cur = (await query('SELECT * FROM functions WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound();
  await getApp(req.user, cur.app_id);
  if (cur.removed_at) throw bad('function_removed');
  const body = req.body || {};
  // A user allowed to set a "with notes" status may write the note that goes with it in the same request.
  const settingNotedStatus = Object.entries(NOTE_REQUIRED).some(([k, v]) => body[k] === v && hasPerm(req.user, FIELD_PERM[k]));
  const changes = {};
  for (const [k, v] of Object.entries(body)) {
    if (!Object.hasOwn(FIELD_PERM, k)) throw bad('unknown_field', { field: k });
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
  const app = (await query('SELECT department_id FROM applications WHERE id=$1', [cur.app_id])).rows[0];
  if (await needsLeadApproval(req.user, app.department_id, await allApps())) {
    const rq = await tx(c => createRequest(c, req, { deptId: app.department_id, appId: cur.app_id, kind: 'function',
      summary: `${cur.code} ${cur.name_ar.slice(0, 80)}`,
      items: keys.map(k => ({ kind: 'function', app_id: cur.app_id, function_id: id, field: k, old_value: cur[k], new_value: changes[k] })) }));
    return res.status(202).json({ pending: true, request_id: rq.id, function: cur });
  }
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
  if (await needsLeadApproval(req.user, a.department_id, await allApps())) {
    const rows = (await query(`SELECT id, ${field} AS v FROM functions WHERE app_id=$1 AND enabled ORDER BY sort, id`, [a.id])).rows
      .filter(x => Number(x.v) !== Number(value));
    if (!rows.length) return res.json({ updated: 0 });
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind: 'bulk',
      summary: `${field} = ${value} (${rows.length})`,
      items: rows.map(x => ({ kind: 'function', app_id: a.id, function_id: x.id, field, old_value: x.v, new_value: value })) }));
    return res.status(202).json({ pending: true, request_id: rq.id, updated: 0, requested: rows.length });
  }
  const n = await tx(async c => {
    const before = (await c.query(`SELECT id, code, name_ar, name_en, ${field} AS v FROM functions WHERE app_id=$1 AND enabled ORDER BY sort, id FOR UPDATE`, [a.id])).rows;
    const q = await c.query(`UPDATE functions SET ${field}=$2, updated_at=now(), updated_by=$3 WHERE app_id=$1 AND enabled RETURNING id`,
      [a.id, value, req.user.id]);
    const changed = before.filter(x => Number(x.v) !== Number(value));
    await logAudit(req, { db: c, action: 'bulk_update', entity: 'application', entityId: a.id,
      summary: `${field} = ${value} on ${q.rowCount} functions`, newValue: { field, value },
      context: { app_id: a.id, count: q.rowCount, changed: changed.length,
        items: changed.slice(0, 500).map(x => ({ kind: 'function', app_id: a.id, function_id: x.id, code: x.code, name_ar: x.name_ar, name_en: x.name_en,
          field, old: x.v, new: value })) } });
    return q.rowCount;
  });
  res.json({ updated: n });
});

// ---- add / remove / restore functions (migration 006) ----
// Before → after % of the application, its department and the project (user's scope) for a proposed change:
// { add: {weight, progress, enabled} } or { set: [{function_id, enabled}] }.
async function impactOf(user, appId, { add = null, set = [], drop = [] }) {
  const v = await loadVisible(user);
  const app = v.apps.find(x => x.id === appId);
  const byId = new Map(set.map(x => [x.function_id, x]));
  const functions = v.functions.filter(f => !drop.includes(f.id)).map(f => (byId.has(f.id) ? { ...f, enabled: byId.get(f.id).enabled } : f));
  for (const x of set) if (!v.functions.some(f => f.id === x.function_id) && x.enabled) {
    const f = (await query('SELECT * FROM functions WHERE id=$1', [x.function_id])).rows[0];      // restoring a removed one
    if (f) functions.push({ ...f, enabled: true, has_note: !!f.note });
  }
  if (add) functions.push({ id: -1, app_id: appId, source: 'custom', weight: add.weight, progress: add.progress, enabled: add.enabled,
    test_status: 0, notif_status: 0, review_status: 0 });
  const after = summarize({ departments: v.departments, applications: v.apps, functions, reports: v.reports, settings: v.settings });
  const pick = (c) => ({ app: c.applications.find(x => x.id === appId), dept: c.departments.find(x => x.id === app.department_id), total: c.total });
  const b = pick(v.calc), a = pick(after);
  const row = (x, y, k = 'pct') => ({ before: x?.[k] ?? 0, after: y?.[k] ?? 0 });
  const included = list => list.filter(f => f.app_id === appId && f.enabled).length;
  return { app: row(b.app, a.app), dept: row(b.dept, a.dept), total: row(b.total, a.total),
    count: row(b.app, a.app, 'count'), included: { before: included(v.functions), after: included(functions) },
    app_weight: row(b.app, a.app, 'fnWeight') };
}

// Data-entry users (not approvers of the department) send additions / removals / restores to the team lead.
async function lifecycle(req, res, { a, kind, summary, item, direct, impact }) {
  if (await needsLeadApproval(req.user, a.department_id, await allApps())) {
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind, summary, items: [{ kind: 'function', app_id: a.id, ...item }] }));
    return res.status(202).json({ pending: true, request_id: rq.id, impact });
  }
  const f = await tx(direct);
  res.status(kind === 'add_function' ? 201 : 200).json({ function: f, impact });
}

r.post('/applications/:id/impact', requirePerm('tog'), async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const b = req.body || {};
  const add = b.add ? newFunctionDataOr400(b.add, true) : null;
  const set = Array.isArray(b.set) ? b.set.filter(x => isId(x?.function_id) && typeof x.enabled === 'boolean').slice(0, 500) : [];
  const drop = Array.isArray(b.drop) ? b.drop.filter(isId).slice(0, 500) : [];
  res.json(await impactOf(req.user, a.id, { add, set, drop }));
});

function newFunctionDataOr400(body, preview = false) {
  try { return newFunctionData(preview ? { name_ar: 'x', ...body } : body); }
  catch (e) { throw bad(e.code || 'invalid_value'); }
}

r.post('/applications/:id/functions', requirePerm('tog'), async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const d = newFunctionDataOr400(req.body);
  const impact = await impactOf(req.user, a.id, { add: d });
  await lifecycle(req, res, { a, kind: 'add_function', impact, summary: `+ ${d.name_ar.slice(0, 80)}`,
    item: { field: 'create', old_value: null, new_value: d },
    direct: async c => {
      const f = await createFunction(c, a.id, d, req.user.id);
      await logAudit(req, { db: c, action: 'create', entity: 'function', entityId: f.id, summary: `${a.id}/${f.code} ${d.name_ar.slice(0, 80)}`, newValue: d });
      return f;
    } });
});

async function loadFn(req, { removed }) {
  const id = idParam(req.params.id);
  const cur = (await query('SELECT * FROM functions WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound();
  const a = await getApp(req.user, cur.app_id);
  if (removed === true && !cur.removed_at) throw bad('function_not_removed');
  if (removed === false && cur.removed_at) throw bad('function_removed');
  return { cur, a };
}

r.post('/functions/:id/remove', requirePerm('tog'), async (req, res) => {
  const { cur, a } = await loadFn(req, { removed: false });
  const reason = str(req.body?.reason, 1000);
  if (!reason) throw bad('reason_required');
  const impact = await impactOf(req.user, a.id, { drop: [cur.id] });
  await lifecycle(req, res, { a, kind: 'remove_function', impact, summary: `− ${cur.code} ${cur.name_ar.slice(0, 80)}`,
    item: { function_id: cur.id, field: 'removed', old_value: { removed: false }, new_value: { removed: true, reason } },
    direct: async c => {
      const f = await removeFunction(c, cur.id, reason, req.user.id);
      await logAudit(req, { db: c, action: 'remove', entity: 'function', entityId: cur.id, summary: `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}`,
        oldValue: { enabled: cur.enabled, weight: cur.weight, progress: cur.progress }, newValue: { reason } });
      return f;
    } });
});

r.post('/functions/:id/restore', requirePerm('tog'), async (req, res) => {
  const { cur, a } = await loadFn(req, { removed: true });
  const impact = await impactOf(req.user, a.id, { set: [{ function_id: cur.id, enabled: true }] });
  await lifecycle(req, res, { a, kind: 'restore_function', impact, summary: `↺ ${cur.code} ${cur.name_ar.slice(0, 80)}`,
    item: { function_id: cur.id, field: 'removed', old_value: { removed: true }, new_value: { removed: false } },
    direct: async c => {
      const f = await restoreFunction(c, cur.id, req.user.id);
      await logAudit(req, { db: c, action: 'restore', entity: 'function', entityId: cur.id, summary: `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}` });
      return f;
    } });
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
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw bad('invalid_value', { field: 'weights' });
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
      if (Number(old) === Number(w)) continue;
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
  const pend = (await query(`SELECT i.app_id, i.field, i.new_value, u.full_name AS requested_by_name
    FROM edit_request_items i JOIN edit_requests r ON r.id=i.request_id LEFT JOIN users u ON u.id=r.requested_by
    WHERE r.status='pending' AND i.kind='report'`)).rows;
  res.json({
    departments: v.departments.filter(d => !d.is_base),
    applications: v.apps.filter(a => !base.has(a.department_id)).map(a => ({
      id: a.id, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en, icon: a.icon,
      weight: v.calc.applications.find(x => x.id === a.id).weight, report: byApp.get(a.id) || null,
      pending: pend.filter(p => p.app_id === a.id) })),
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
    if (!Object.hasOwn(ok, k)) throw bad('unknown_field', { field: k });
    if (!ok[k](v)) throw bad('invalid_value', { field: k });
    if (cur[k] !== v) changes[k] = v;
  }
  const keys = Object.keys(changes);
  if (!keys.length) return res.json({ report: cur });
  if (await needsLeadApproval(req.user, a.department_id, await allApps())) {
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind: 'report', summary: keys.join(', '),
      items: keys.map(k => ({ kind: 'report', app_id: a.id, field: k, old_value: cur[k], new_value: changes[k] })) }));
    return res.status(202).json({ pending: true, request_id: rq.id, report: cur });
  }
  const row = await tx(async c => {
    const u = (await c.query(`UPDATE app_reports SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now(),
      updated_by=$${keys.length + 2} WHERE app_id=$1 RETURNING *`, [a.id, ...keys.map(k => changes[k]), req.user.id])).rows[0];
    await logAudit(req, { db: c, action: 'update', entity: 'report', entityId: a.id,
      oldValue: Object.fromEntries(keys.map(k => [k, cur[k]])), newValue: changes });
    return u;
  });
  res.json({ report: row });
});

// ---- schedule (S-curve) and project timeline ----
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = v => ISO.test(v) && !Number.isNaN(new Date(v + 'T00:00:00Z').getTime()) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v);

// Start + k periods (months keep the day of month, clamped to the month's length), as 'YYYY-MM-DD'.
function addPeriods(start, unit, k) {
  const d = new Date(start + 'T00:00:00Z');
  if (unit === 'month') {
    const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + k);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  } else d.setUTCDate(d.getUTCDate() + 14 * k);
  return d.toISOString().slice(0, 10);
}
// Number of periods from start to close: the smallest k whose period end reaches the close date.
function periodsBetween(start, end, unit) {
  let k = 1;
  while (addPeriods(start, unit, k) < end && k <= 61) k++;
  return k;
}

function scheduleJson(s) {
  const n = s.periods;
  return {
    start_date: DATE(s.start_date), end_date: DATE(s.end_date), periods: n, unit: s.unit,
    plan: Array.isArray(s.plan) && s.plan.length === n ? s.plan : sCurve(n),
    plan_is_default: !(Array.isArray(s.plan) && s.plan.length === n),
    actual: Array.from({ length: n }, (_, i) => (s.actual && s.actual[i] != null ? s.actual[i] : null)),
  };
}

r.get('/schedule', async (req, res) => {
  const s = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const v = await loadVisible(req.user);
  res.json({ ...scheduleJson(s), current_pct: v.calc.total.pct,
    can: { sch: hasPerm(req.user, 'sch'), timeline: hasPerm(req.user, 'cfg') && !!req.user.fullScope } });
});

// Periods follow the close date when one is set; arrays are cut to fit, the plan returns to the S-curve
// when the number of periods changes.
function fitTimeline({ start_date, end_date, unit, periods, plan, actual }) {
  if (start_date && end_date) {
    if (end_date <= start_date) throw bad('end_before_start');
    periods = periodsBetween(start_date, end_date, unit);
    if (periods > 60) throw bad('timeline_too_long', { max: 60 });
  }
  if (!(Array.isArray(plan) && plan.length === periods)) plan = null;
  actual = Array.isArray(actual) ? actual.slice(0, periods) : [];
  return { start_date: start_date || null, end_date: (start_date && end_date) || null, unit, periods, plan, actual };
}

async function saveSchedule(req, next) {
  const old = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  await tx(async c => {
    await c.query(`UPDATE schedule SET start_date=$1, end_date=$2, periods=$3, unit=$4, plan=$5, actual=$6, updated_at=now(), updated_by=$7 WHERE id=1`,
      [next.start_date, next.end_date, next.periods, next.unit, next.plan, next.actual, req.user.id]);
    await logAudit(req, { db: c, action: 'update', entity: 'schedule', entityId: 1,
      oldValue: { start_date: DATE(old.start_date), end_date: DATE(old.end_date), periods: old.periods, unit: old.unit, plan: old.plan, actual: old.actual },
      newValue: next });
  });
}

r.put('/schedule', requirePerm('sch'), async (req, res) => {
  const { periods, unit, plan, actual } = req.body || {};
  const old = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  // The start and close dates belong to Settings; the schedule screen only keeps the start date when no close date is set.
  let start_date = DATE(old.start_date);
  if (!old.end_date && 'start_date' in (req.body || {})) {
    start_date = req.body.start_date;
    if (start_date !== null && !validDate(start_date)) throw bad('invalid_value', { field: 'start_date' });
  }
  if (!intIn(periods, 1, 60)) throw bad('invalid_value', { field: 'periods' });
  if (!['month', 'fortnight'].includes(unit)) throw bad('invalid_value', { field: 'unit' });
  if (plan !== null && !(Array.isArray(plan) && plan.length === periods && plan.every(x => numIn(x, 0, 100)))) throw bad('invalid_value', { field: 'plan' });
  if (!(Array.isArray(actual) && actual.length <= periods && actual.every(x => x === null || numIn(x, 0, 100)))) throw bad('invalid_value', { field: 'actual' });
  const next = fitTimeline({ start_date, end_date: DATE(old.end_date), unit, periods, plan, actual });
  await saveSchedule(req, next);
  res.json({ ok: true, periods: next.periods });
});

// Settings → project timeline: start and planned close date.
r.put('/timeline', requirePerm('cfg'), async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  const { start_date = null, end_date = null } = req.body || {};
  for (const [k, v] of Object.entries({ start_date, end_date })) if (v !== null && !validDate(v)) throw bad('invalid_value', { field: k });
  if (end_date && !start_date) throw bad('start_required');
  const old = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const next = fitTimeline({ start_date, end_date, unit: old.unit, periods: old.periods, plan: old.plan, actual: old.actual || [] });
  await saveSchedule(req, next);
  res.json({ ok: true, ...next });
});

// Everything the project status page needs, for the user's scope.
r.get('/project-status', async (req, res) => {
  const s = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const v = await loadVisible(req.user);
  const on = v.functions.filter(f => f.enabled);
  const deptIds = new Set(v.departments.map(d => d.id));
  const [snaps, edits, imports] = await Promise.all([
    recentSnapshots(),
    query(`SELECT department_id, count(*)::int AS n FROM edit_requests WHERE status='pending' GROUP BY 1`),
    query(`SELECT department_id, count(*)::int AS n FROM import_batches WHERE status='pending' GROUP BY 1`),
  ]);
  // Scoped users: the project line of a snapshot is the weighted average of the departments they can see.
  const depts = v.departments.map(d => ({ ...d, ...v.calc.departments.find(x => x.id === d.id) }));
  const tw = depts.reduce((a, d) => a + d.weight, 0);
  const trend = snaps.map(x => {
    if (req.user.fullScope) return { day: x.day, pct: x.pct };
    const p = tw ? depts.reduce((a, d) => a + d.weight * (+x.departments?.[d.id] || 0), 0) / tw : 0;
    return { day: x.day, pct: Math.round(p * 100) / 100 };
  });
  const deptTrend = Object.fromEntries(depts.map(d => [d.id, snaps.map(x => ({ day: x.day, pct: +x.departments?.[d.id] || 0 }))]));
  const pend = rows => rows.filter(x => deptIds.has(x.department_id) || (x.department_id === null && req.user.fullScope)).reduce((a, x) => a + x.n, 0);
  const reps = v.reports.filter(x => !v.departments.find(d => d.id === v.apps.find(a => a.id === x.app_id)?.department_id)?.is_base);
  res.json({
    schedule: scheduleJson(s),
    today: new Date().toISOString().slice(0, 10),
    total: v.calc.total,
    departments: depts.map(d => ({ id: d.id, name_ar: d.name_ar, name_en: d.name_en, color: d.color, emblem: d.emblem,
      pct: d.pct, weight: d.weight, apps: d.apps })),
    counts: {
      functions: on.length,
      done: on.filter(f => +f.progress >= 100).length,
      in_progress: on.filter(f => +f.progress > 0 && +f.progress < 100).length,
      not_started: on.filter(f => !(+f.progress > 0)).length,
      notes: on.filter(f => f.has_note).length,
      tests: v.calc.total.tests,
      notif_bad: on.filter(f => (f.notif_status | 0) === 3).length,
      review_missing: on.filter(f => (f.review_status | 0) === 2).length,
      reports: reps.length,
      reports_done: reps.filter(x => +x.progress >= 100).length,
      reports_pct: reps.length ? reps.reduce((a, x) => a + +x.progress, 0) / reps.length : null,
    },
    pending: { edits: pend(edits.rows), imports: pend(imports.rows) },
    trend, dept_trend: deptTrend,
    can: { timeline: hasPerm(req.user, 'cfg') && !!req.user.fullScope, sch: hasPerm(req.user, 'sch') },
  });
});

// ---- search ----
r.get('/search', async (req, res) => {
  const q = str(req.query.q, 100);
  if (q.length < 2) return res.json({ results: [] });
  const rows = (await query(`SELECT f.id, f.app_id, f.code, f.name_ar, f.name_en, f.reference, f.progress, f.enabled, f.source,
        a.department_id, a.name_ar AS app_name_ar, a.name_en AS app_name_en
      FROM functions f JOIN applications a ON a.id=f.app_id
      WHERE f.removed_at IS NULL AND (f.name_ar ILIKE $1 OR f.name_en ILIKE $1 OR f.reference ILIKE $1 OR f.note ILIKE $1
         OR a.name_ar ILIKE $1 OR a.name_en ILIKE $1)
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

// Full import of everything (all departments, settings, schedule) WITHOUT approval: initial migration only,
// so it needs 'cfg' as well. Team results go through /api/imports (per department, approved).
r.post('/import', requirePerm('imp'), requirePerm('cfg'), largeJson, async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  let payload;
  try { payload = typeof req.body?.content === 'string' ? parseLegacy(req.body.content) : req.body?.payload; }
  catch { throw bad('invalid_import_file'); }
  if (!payload || typeof payload !== 'object' || !payload.f || typeof payload.f !== 'object') throw bad('invalid_import_file');
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

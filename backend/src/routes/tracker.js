import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm, hasPerm, canSeeApp, canSeeDept, coversDept } from '../middleware/auth.js';
import { summarize, sCurve, CALC_FUNCTIONS_SQL, ITEM_TYPES, itemCounts, reportsOverview } from '../services/calc.js';
import { allSettings, invalidateSettings } from '../services/settings.js';
import { logAudit, logSystem } from '../services/logs.js';
import { applyLegacy, buildLegacy, parseLegacy } from '../services/legacy.js';
import { needsLeadApproval, createRequest } from '../services/edits.js';
import { recentSnapshots } from '../services/snapshots.js';
import { createFunction, newFunctionData, removeFunction, restoreFunction } from '../services/functions.js';
import { PASS, passConflict, passRuleError, withPassProgress, itemList } from '../services/passRule.js';
import { largeJson } from '../middleware/body.js';
import { publishChange, publishApps } from '../services/live.js';
import { functionsExcluded, itemsMovedIn, applicationMovedIn } from '../services/notify-events.js';
import { MOVE_MAX, parseMoveReason, moveNeedsApproval, weightTransfer, destinationWeight, checkMovable, applyMove, movesOf }
  from '../services/move.js';
import { moveApplication, moveAppNeedsApproval, checkAppMovable, appMovesOf } from '../services/app-move.js';
import { HttpError, bad, notFound, str, intIn, numIn, idParam, isId } from '../utils/http.js';
import { RENAME_KEYS, parseRename, parseRenameReason, duplicateName } from '../services/rename.js';
import { REASON_KEYS, parseDisableReason, checkDuplicates, setDisabled, clearDisabled, currentReasons, reasonValues, hadReason, refs,
  duplicatesOf } from '../services/disable.js';
import { parseReopenReason, parseReopenDoc } from '../services/reopen.js';

const r = Router();
r.use(requireAuth);

const DATE = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Everything the user may see, plus the computed percentages.
async function loadVisible(user) {
  const [d, a, f, rep, settings] = await Promise.all([
    query('SELECT * FROM departments ORDER BY sort'),
    query('SELECT * FROM applications ORDER BY sort'),
    query(CALC_FUNCTIONS_SQL),
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

// Pending (not yet approved) edits of an application, for the "awaiting approval" badges.
async function pendingFor(appId) {
  return (await query(`SELECT i.kind, i.function_id, i.field, i.new_value, i.meta, r.id AS request_id, r.requested_at,
      u.full_name AS requested_by_name
    FROM edit_request_items i JOIN edit_requests r ON r.id=i.request_id LEFT JOIN users u ON u.id=r.requested_by
    WHERE r.status='pending' AND i.app_id=$1 ORDER BY r.requested_at`, [appId])).rows;
}

const calcSettings = s => ({ weight_mode: s['calc.weight_mode'], notif_share: s['calc.notif_share'], reports_share: s['calc.reports_share'] });

// The data behind each screen, as functions of the reader: the screen's route and its Excel export
// (routes/export.js) use the same ones, so an export never shows more than the screen (export policy).
export async function summaryData(user) {
  const v = await loadVisible(user);
  const n = itemCounts(v.functions);
  return {
    total: v.calc.total,
    departments: v.departments.map(d => ({ ...d, ...v.calc.departments.find(x => x.id === d.id) })),
    applications: v.apps.map(a => ({ ...a, calc: v.calc.applications.find(x => x.id === a.id) })),
    // functions / done: function items only; report_items: the items marked as reports (1.8.0); notes: every item
    counts: {
      functions: n.functions,
      done: n.done,
      report_items: n.report_items,
      notes: n.notes,
      experienceOff: v.functions.filter(f => !f.enabled && f.source === 'experience').length,
    },
    settings: calcSettings(v.settings),
  };
}
r.get('/summary', async (req, res) => res.json(await summaryData(req.user)));

export async function departmentData(user, id) {
  const v = await loadVisible(user);
  const d = v.departments.find(x => x.id === id);
  if (!d) {
    const exists = typeof id === 'string' && (await query('SELECT 1 FROM departments WHERE id=$1', [id])).rowCount;
    throw exists ? new HttpError(403, 'out_of_scope', { department: id }) : notFound();
  }
  return {
    department: { ...d, ...v.calc.departments.find(x => x.id === d.id) },
    applications: v.apps.filter(a => a.department_id === d.id).map(a => ({ ...a, calc: v.calc.applications.find(x => x.id === a.id) })),
    settings: calcSettings(v.settings),
  };
}
r.get('/departments/:id', async (req, res) => res.json(await departmentData(req.user, req.params.id)));

export async function applicationData(user, id) {
  if (typeof id !== 'string') throw notFound();
  const a = await getApp(user, id);
  const v = await loadVisible(user);
  const [fns, rep, dept] = await Promise.all([
    query(`SELECT f.*, u.full_name AS updated_by_name, rb.full_name AS removed_by_name, db.full_name AS disabled_by_name,
        cb.full_name AS closed_by_name FROM functions f
      LEFT JOIN users u ON u.id=f.updated_by LEFT JOIN users rb ON rb.id=f.removed_by LEFT JOIN users db ON db.id=f.disabled_by
      LEFT JOIN users cb ON cb.id=f.closed_by
      WHERE f.app_id=$1 ORDER BY f.sort, f.id`, [a.id]),
    query('SELECT * FROM app_reports WHERE app_id=$1', [a.id]),
    query('SELECT * FROM departments WHERE id=$1', [a.department_id]),
  ]);
  // the most recent reopening of each function (its attached document + reason), shown under a reopened item
  const reopenings = new Map((await query(`SELECT DISTINCT ON (function_id) function_id, id, reason, reopened_at, doc_name,
      (SELECT full_name FROM users WHERE id=reopened_by) AS reopened_by_name
    FROM function_reopenings WHERE function_id = ANY($1) ORDER BY function_id, reopened_at DESC`,
  [fns.rows.map(f => f.id)])).rows.map(x => [x.function_id, x]));
  const u = user;
  // the functions each excluded duplicate points at (names only within the reader's scope)
  const dups = await duplicatesOf(query, user, fns.rows.filter(f => !f.enabled).map(f => f.id));
  // items moved here from another application (1.10.0): their moves, oldest first; moved_from = the move that brought
  // the item here (the badge «منقول من …»)
  const moves = await movesOf({ query }, user, fns.rows.map(f => f.id));
  const movedFrom = f => [...(moves.get(f.id) || [])].reverse().find(m => m.to_app_id === a.id) || null;
  // the application itself moved here from another department (1.12.16): its moves, oldest first; app_moved_from = the
  // most recent one that brought it into its current department (the header badge «منقول من …»)
  const appMoves = (await appMovesOf({ query }, user, [a.id])).get(a.id) || [];
  const appMovedFrom = [...appMoves].reverse().find(m => m.to_department_id === a.department_id) || null;
  return {
    application: { ...a, calc: v.calc.applications.find(x => x.id === a.id),
      ...(appMoves.length ? { moves: appMoves, moved_from: appMovedFrom } : {}) },
    department: dept.rows[0],
    functions: fns.rows.map(f => ({ ...f, duplicate_of: dups.get(f.id) || [],
      ...(moves.has(f.id) ? { moves: moves.get(f.id), moved_from: movedFrom(f) } : {}),
      ...(reopenings.has(f.id) ? { last_reopening: reopenings.get(f.id) } : {}) })),
    report: rep.rows[0] || null,
    pending: await pendingFor(a.id),
    needs_approval: await needsLeadApproval(u, a),
    settings: calcSettings(v.settings),
    can: { pct: hasPerm(u, 'pct'), wgt: hasPerm(u, 'wgt'), tst: hasPerm(u, 'tst'), tog: hasPerm(u, 'tog'), ren: hasPerm(u, 'ren'), mov: hasPerm(u, 'mov'), rep: hasPerm(u, 'rep'),
      cls: hasPerm(u, 'apv_final') },
  };
}
r.get('/applications/:id', async (req, res) => res.json(await applicationData(req.user, req.params.id)));

// Field → permission needed to change it.
const FIELD_PERM = {
  progress: 'pct', notif_status: 'pct', weight: 'wgt', enabled: 'tog',
  test_status: 'tst', review_status: 'tst', note: 'tst',
  item_type: 'tog',          // function / report (1.8.0): whoever adds and removes items sets their type
};
const FIELD_OK = {
  progress: v => numIn(v, 0, 100), weight: v => numIn(v, 0, 1000), enabled: v => typeof v === 'boolean',
  test_status: v => intIn(v, 0, 7), notif_status: v => intIn(v, 0, 3), review_status: v => intIn(v, 0, 5),
  note: v => typeof v === 'string' && v.length <= 2000,
  item_type: v => ITEM_TYPES.includes(v),
};

// Statuses that mean "… with notes": choosing one makes the note mandatory. A field may have more than one such
// value — test_status needs a note for «نجح مع ملاحظة» (1), «إعادة الاختبار» (4, 1.12.25), «غير متاح للاختبار» (5),
// «لم يتم عرضها» (6) and «لم يتم التدريب» (7, migration 030).
const NOTE_REQUIRED = { test_status: [1, 4, 5, 6, 7], notif_status: [2], review_status: [3] };
const notedValue = (k, v) => (NOTE_REQUIRED[k] || []).includes(v);
const needsNote = f => Object.entries(NOTE_REQUIRED).some(([k]) => notedValue(k, f[k]));

r.patch('/functions/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const cur = (await query('SELECT * FROM functions WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound();
  await getApp(req.user, cur.app_id);
  const body = { ...(req.body || {}) };
  // A closed function is locked (migration 033): no field edit and no rename until it is reopened. Only closing /
  // reopening change its state. This guard mirrors the function_removed one and sits ahead of the rename dispatch so
  // both a field edit and a rename are refused.
  if (cur.closed_at) throw bad('closed_locked');
  // the names (Arabic / English) change only with a reason, in a request of their own (1.9.1)
  if (RENAME_KEYS.some(k => Object.hasOwn(body, k))) return renameFunction(req, res, cur, body);
  if (cur.removed_at) throw bad('function_removed');
  // the reason that goes with an exclusion (enabled: false) is not a column edited directly (migration 013)
  const reasonBody = {};
  for (const k of REASON_KEYS) if (Object.hasOwn(body, k)) { reasonBody[k] = body[k]; delete body[k]; }
  if (Object.keys(reasonBody).length && body.enabled !== false) throw bad('invalid_value', { field: 'disabled_reason' });
  // A user allowed to set a "with notes" status may write the note that goes with it in the same request — only
  // while the function has no note yet. Changing or replacing an existing note needs 'tst' (ETS-SEC-056: moving
  // the status away and back must not open a way to overwrite a note).
  const settingNotedStatus = !String(cur.note || '').trim() &&
    Object.keys(NOTE_REQUIRED).some(k => notedValue(k, body[k]) && hasPerm(req.user, FIELD_PERM[k]));
  const changes = {};
  for (const [k, v] of Object.entries(body)) {
    if (!Object.hasOwn(FIELD_PERM, k)) throw bad('unknown_field', { field: k });
    const allowed = hasPerm(req.user, FIELD_PERM[k]) || (k === 'note' && settingNotedStatus);
    if (!allowed) throw new HttpError(403, 'forbidden', { permission: FIELD_PERM[k], field: k });
    if (!FIELD_OK[k](v)) throw bad('invalid_value', { field: k });
    if (cur[k] !== v) changes[k] = v;
  }
  if (!Object.keys(changes).length) return res.json({ function: cur });
  // Choosing «نجح» brings the item to 100 % in the same write (1.12.21): the progress bump is added here, after the
  // per-field permission check, so it is covered by the test-status permission and travels with the change (direct
  // edit, approval request, audit). It never lowers a progress; an item already «نجح» below 100 % is left untouched.
  Object.assign(changes, withPassProgress(cur, changes));
  const after = { ...cur, ...changes };
  if (needsNote(after) && !String(after.note || '').trim()) {
    throw bad('note_required', { fields: Object.keys(NOTE_REQUIRED).filter(k => notedValue(k, after[k])) });
  }
  // «نجح» = 100 % (1.8.1 / auto-filled 1.12.21): after the bump above, only a progress lowered below 100 on a passed
  // item is still refused (progress_below_100_while_passed). Checked for a direct edit and one sent for approval.
  const passErr = passRuleError(cur, changes);
  if (passErr) throw bad(passErr, { progress: Number(after.progress), test_status: Number(after.test_status), code: cur.code });
  // excluding a function needs a reason; a duplicate names the function(s) it duplicates
  let disable = null;
  if (changes.enabled === false) {
    disable = parseDisableReason(reasonBody);
    disable.duplicates = await checkDuplicates({ query }, req.user, disable.duplicate_of, [id]);
  }
  const keys = Object.keys(changes);
  const app = (await query('SELECT id, department_id FROM applications WHERE id=$1', [cur.app_id])).rows[0];
  if (await needsLeadApproval(req.user, app)) {
    const rq = await tx(c => createRequest(c, req, { deptId: app.department_id, appId: cur.app_id, kind: 'function',
      summary: `${cur.code} ${cur.name_ar.slice(0, 80)}`,
      items: keys.map(k => ({ kind: 'function', app_id: cur.app_id, function_id: id, field: k, old_value: cur[k], new_value: changes[k],
        ...(k === 'enabled' && disable ? { meta: reasonMeta(disable) } : {}) })) }));
    publishChange({ dept_id: app.department_id, app_id: cur.app_id });     // "awaiting approval" badges
    return res.status(202).json({ pending: true, request_id: rq.id, function: cur });
  }
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  // A note written through the exception above is only stored if the function still has no note when the row is
  // updated, so a note saved at the same moment by a tester cannot be overwritten (V6-N1).
  const firstNoteOnly = 'note' in changes && !hasPerm(req.user, FIELD_PERM.note);
  const updated = await tx(async c => {
    const u = (await c.query(`UPDATE functions SET ${sets}, updated_at=now(), updated_by=$${keys.length + 2} WHERE id=$1
      ${firstNoteOnly ? "AND btrim(coalesce(note, ''))=''" : ''} RETURNING *`,
    [id, ...keys.map(k => changes[k]), req.user.id])).rows[0];
    if (!u) throw new HttpError(409, 'note_changed');
    // the row as saved: another edit at the same moment must not leave it «نجح» below 100 % (rolled back)
    if (('test_status' in changes || 'progress' in changes) && passConflict(u)) {
      throw new HttpError(409, 'test_status' in changes ? 'pass_requires_100' : 'progress_below_100_while_passed',
        { progress: Number(u.progress), test_status: u.test_status, code: cur.code });
    }
    const oldValue = Object.fromEntries(keys.map(k => [k, cur[k]])), newValue = { ...changes };
    if (disable) {
      await setDisabled(c, [id], disable, req.user.id);
      Object.assign(newValue, reasonValues(disable));
    } else if (changes.enabled === true) {
      const was = (await currentReasons(c, [id])).get(id);          // kept in the audit row: the history of the reason
      if (hadReason(was)) Object.assign(oldValue, was);
      await clearDisabled(c, [id]);
    }
    await logAudit(req, { db: c, action: 'update', entity: 'function', entityId: id,
      summary: `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}`, oldValue, newValue });
    return 'enabled' in changes ? (await c.query('SELECT * FROM functions WHERE id=$1', [id])).rows[0] : u;
  });
  // live updates: after COMMIT (tx resolved), ids only (services/live.js)
  publishChange({ dept_id: app.department_id, app_id: cur.app_id });
  if (changes.enabled === false) await functionsExcluded(cur.app_id, 1, [req.user.id]);     // T7
  res.json({ function: updated });
});

// Rename of an item (1.9.1): name_ar and / or name_en with rename_reason, nothing else in the request, so the reason
// clearly belongs to the rename. The code stays. A member's rename waits for the team lead like any other edit; the
// reason goes with the request (edit_request_items.meta) and into the audit row (new_value.rename_reason).
async function renameFunction(req, res, cur, body) {
  // its own permission since 1.9.2 ('ren'), apart from adding / removing / including items ('tog')
  if (!hasPerm(req.user, 'ren')) throw new HttpError(403, 'forbidden', { permission: 'ren', field: 'name_ar' });
  const others = Object.keys(body).filter(k => !RENAME_KEYS.includes(k));
  if (others.length) throw bad('rename_must_be_separate', { fields: others });
  if (cur.removed_at) throw new HttpError(409, 'function_removed');
  const reason = parseRenameReason(body.rename_reason);
  const changes = parseRename(body, cur);
  const id = cur.id, keys = Object.keys(changes);
  const warning = 'name_ar' in changes && await duplicateName({ query }, cur.app_id, id, changes.name_ar) ? { warning: 'duplicate_name' } : {};
  const app = (await query('SELECT id, department_id FROM applications WHERE id=$1', [cur.app_id])).rows[0];
  if (await needsLeadApproval(req.user, app)) {
    const rq = await tx(c => createRequest(c, req, { deptId: app.department_id, appId: cur.app_id, kind: 'function',
      summary: `${cur.code} ${cur.name_ar.slice(0, 80)}`,
      items: keys.map(k => ({ kind: 'function', app_id: cur.app_id, function_id: id, field: k, old_value: cur[k], new_value: changes[k],
        meta: { rename_reason: reason } })) }));
    publishChange({ dept_id: app.department_id, app_id: cur.app_id });     // "awaiting approval" badges
    return res.status(202).json({ pending: true, request_id: rq.id, function: cur, ...warning });
  }
  const updated = await tx(async c => {
    // the names as they are now: a rename made by someone else at the same moment is not overwritten
    const now = (await c.query('SELECT name_ar, name_en, removed_at FROM functions WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (now.removed_at) throw new HttpError(409, 'function_removed');
    if (keys.some(k => now[k] !== cur[k])) throw new HttpError(409, 'name_changed');
    const u = (await c.query(`UPDATE functions SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now(),
      updated_by=$${keys.length + 2} WHERE id=$1 RETURNING *`, [id, ...keys.map(k => changes[k]), req.user.id])).rows[0];
    await logAudit(req, { db: c, action: 'update', entity: 'function', entityId: id,
      summary: `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}`,
      oldValue: Object.fromEntries(keys.map(k => [k, cur[k]])), newValue: { ...changes, rename_reason: reason } });
    return u;
  });
  publishChange({ dept_id: app.department_id, app_id: cur.app_id });      // after COMMIT
  res.json({ function: updated, ...warning });
}

// Set the same value on every enabled function of an application.
r.post('/applications/:id/bulk', async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const { field, value } = req.body || {};
  if (field === 'enabled') return bulkEnabled(req, res, a);
  if (field === 'item_type') return bulkItemType(req, res, a);
  if (!['progress', 'test_status'].includes(field)) throw bad('unknown_field');
  if (!hasPerm(req.user, FIELD_PERM[field])) throw new HttpError(403, 'forbidden', { permission: FIELD_PERM[field] });
  if (!FIELD_OK[field](value)) throw bad('invalid_value');
  if (field === 'test_status' && notedValue('test_status', Number(value))) {
    const missing = (await query(`SELECT count(*)::int AS n FROM functions WHERE app_id=$1 AND enabled AND btrim(note)=''`, [a.id])).rows[0].n;
    if (missing) throw bad('note_required', { fields: ['test_status'], missing });
  }
  await bulkPassCheck({ query }, a.id, field, value);         // lowering progress on a passed item: still all-or-nothing
  // A bulk «نجح» also brings every newly-passed item (not yet «نجح») up to 100 % in the same operation (1.12.21).
  const setPass = field === 'test_status' && Number(value) === PASS;
  if (await needsLeadApproval(req.user, a)) {
    // closed (locked) items are left untouched by a bulk set (migration 033): closed_at IS NULL everywhere
    const rows = (await query(`SELECT id, ${field} AS v FROM functions WHERE app_id=$1 AND enabled AND closed_at IS NULL ORDER BY sort, id`, [a.id])).rows
      .filter(x => Number(x.v) !== Number(value));
    // progress bumps travel with the request so the approved result is «نجح» @ 100 %: only items becoming «نجح»
    // (test_status <> PASS) and below 100 — an item already «نجح» is left untouched.
    const bumps = setPass
      ? (await query(`SELECT id, progress FROM functions WHERE app_id=$1 AND enabled AND closed_at IS NULL AND test_status <> $2 AND progress < 100 ORDER BY sort, id`, [a.id, PASS])).rows
      : [];
    const items = [
      ...rows.map(x => ({ kind: 'function', app_id: a.id, function_id: x.id, field, old_value: x.v, new_value: value })),
      ...bumps.map(x => ({ kind: 'function', app_id: a.id, function_id: x.id, field: 'progress', old_value: Number(x.progress), new_value: 100 })),
    ];
    if (!items.length) return res.json({ updated: 0 });
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind: 'bulk',
      summary: `${field} = ${value} (${rows.length})`, items }));
    publishChange({ dept_id: a.department_id, app_id: a.id });
    return res.status(202).json({ pending: true, request_id: rq.id, updated: 0, requested: rows.length });
  }
  const n = await tx(async c => {
    const before = (await c.query(`SELECT id, code, name_ar, name_en, progress, ${field} AS v FROM functions WHERE app_id=$1 AND enabled AND closed_at IS NULL ORDER BY sort, id FOR UPDATE`, [a.id])).rows;
    await bulkPassCheck(c, a.id, field, value);              // again on the locked rows
    // For «نجح», also set progress = 100 — but only on rows that were not already «نجح» (test_status <> value), so an
    // item already passed below 100 % keeps its progress. The CASE reads the pre-update test_status (same statement).
    // closed (locked) items are never written by a bulk set (migration 033).
    const sql = setPass
      ? `UPDATE functions SET test_status=$2, progress = CASE WHEN test_status <> $2 THEN 100 ELSE progress END,
         updated_at=now(), updated_by=$3 WHERE app_id=$1 AND enabled AND closed_at IS NULL RETURNING id`
      : `UPDATE functions SET ${field}=$2, updated_at=now(), updated_by=$3 WHERE app_id=$1 AND enabled AND closed_at IS NULL RETURNING id`;
    const q = await c.query(sql, [a.id, value, req.user.id]);
    const changed = before.filter(x => Number(x.v) !== Number(value));
    const items = changed.slice(0, 500).map(x => ({ kind: 'function', app_id: a.id, function_id: x.id, code: x.code, name_ar: x.name_ar, name_en: x.name_en,
      field, old: x.v, new: value }));
    // the progress brought to 100 on the newly-passed items (audit reflects both fields)
    if (setPass) for (const x of before) if (Number(x.v) !== PASS && Number(x.progress) < 100 && items.length < 1000) {
      items.push({ kind: 'function', app_id: a.id, function_id: x.id, code: x.code, name_ar: x.name_ar, name_en: x.name_en, field: 'progress', old: Number(x.progress), new: 100 });
    }
    await logAudit(req, { db: c, action: 'bulk_update', entity: 'application', entityId: a.id,
      summary: `${field} = ${value} on ${q.rowCount} functions`, newValue: { field, value },
      context: { app_id: a.id, count: q.rowCount, changed: changed.length, items } });
    return q.rowCount;
  });
  publishChange({ dept_id: a.department_id, app_id: a.id });
  res.json({ updated: n });
});

// «نجح» = 100 % for a bulk set (1.8.1 / auto-filled 1.12.21): a bulk «نجح» now succeeds and brings every newly-passed
// item up to 100 % (handled in the UPDATE below), so it is no longer refused. Only a bulk progress below 100 is still
// refused (400) when it would lower the progress of a passed item, with the list of those items.
async function bulkPassCheck(c, appId, field, value) {
  if (!(field === 'progress' && value < 100)) return;
  const rows = (await c.query(`SELECT id, code, name_ar, name_en, item_type, progress, test_status FROM functions
    WHERE app_id=$1 AND enabled AND closed_at IS NULL AND test_status = $2 AND progress <> $3 ORDER BY sort, id`, [appId, PASS, value])).rows;
  if (!rows.length) return;
  const items = rows.map(x => ({ function_id: x.id, app_id: appId, code: x.code, name_ar: x.name_ar, name_en: x.name_en, item_type: x.item_type,
    progress: Number(value), current_progress: Number(x.progress), test_status: x.test_status, error: 'progress_below_100_while_passed' }));
  throw bad('progress_below_100_while_passed', { bulk: true, count: items.length, items: items.slice(0, 200), list: itemList(items.map(x => ({ code: x.code }))) });
}

// Reason of an exclusion as carried by a pending request item (edit_request_items.meta), applied on approval.
const reasonMeta = d => ({ disabled_reason: d.reason, disabled_note: d.note, duplicate_of: refs(d.duplicates || []) });

// Exclude (or include) the chosen functions of an application in one go: { field: 'enabled', value, function_ids,
// and for an exclusion disabled_reason / disabled_note / duplicate_of } — the same reason for every function.
// One audit row per function, so each one's history shows its reason.
async function bulkEnabled(req, res, a) {
  if (!hasPerm(req.user, 'tog')) throw new HttpError(403, 'forbidden', { permission: 'tog' });
  const { value, function_ids: raw } = req.body;
  if (typeof value !== 'boolean') throw bad('invalid_value', { field: 'value' });
  if (!Array.isArray(raw) || !raw.length || raw.length > 500 || !raw.every(isId)) throw bad('invalid_value', { field: 'function_ids' });
  const ids = [...new Set(raw)];
  const rows = (await query('SELECT id, code, name_ar, enabled, removed_at, closed_at FROM functions WHERE app_id=$1 AND id = ANY($2) ORDER BY sort, id', [a.id, ids])).rows;
  // only functions of this application that are not removed (ETS-SEC-058)
  if (rows.length !== ids.length || rows.some(x => x.removed_at)) throw bad('invalid_value', { field: 'function_ids' });
  // a closed (locked) item keeps its include / exclude state until it is reopened (migration 033)
  if (rows.some(x => x.closed_at)) throw bad('closed_locked');
  let disable = null;
  if (!value) {
    disable = parseDisableReason(req.body);
    disable.duplicates = await checkDuplicates({ query }, req.user, disable.duplicate_of, ids);
  }
  const targets = rows.filter(x => x.enabled !== value);
  if (!targets.length) return res.json({ updated: 0 });
  if (await needsLeadApproval(req.user, a)) {
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind: 'bulk',
      summary: `enabled = ${value} (${targets.length})`,
      items: targets.map(x => ({ kind: 'function', app_id: a.id, function_id: x.id, field: 'enabled', old_value: !value, new_value: value,
        ...(disable ? { meta: reasonMeta(disable) } : {}) })) }));
    publishChange({ dept_id: a.department_id, app_id: a.id });
    return res.status(202).json({ pending: true, request_id: rq.id, updated: 0, requested: targets.length });
  }
  const n = await tx(async c => {
    const changed = (await c.query(`UPDATE functions SET enabled=$2, updated_at=now(), updated_by=$3
      WHERE id = ANY($1) AND removed_at IS NULL AND enabled <> $2 RETURNING id`, [targets.map(x => x.id), value, req.user.id])).rows.map(x => x.id);
    const was = value ? await currentReasons(c, changed) : new Map();
    if (disable) await setDisabled(c, changed, disable, req.user.id);
    else await clearDisabled(c, changed);
    for (const x of targets.filter(t => changed.includes(t.id))) {
      const prev = was.get(x.id);
      await logAudit(req, { db: c, action: 'update', entity: 'function', entityId: x.id, summary: `${a.id}/${x.code} ${x.name_ar.slice(0, 80)}`,
        oldValue: { enabled: !value, ...(hadReason(prev) ? prev : {}) },
        newValue: { enabled: value, ...(disable ? reasonValues(disable) : {}) },
        context: { bulk: true, app_id: a.id, count: changed.length } });
    }
    return changed.length;
  });
  publishChange({ dept_id: a.department_id, app_id: a.id });
  if (!value) await functionsExcluded(a.id, n, [req.user.id]);                             // T7
  res.json({ updated: n });
}

// Set the type (function / report, 1.8.0) of the chosen items of an application: { field: 'item_type', value, function_ids }.
// Excluded items may be chosen too (their type matters once they count again); removed ones may not. One audit row per
// item, like the other changes of a single item, so each one's history reads «… changed the type of D7 from … to …».
async function bulkItemType(req, res, a) {
  if (!hasPerm(req.user, FIELD_PERM.item_type)) throw new HttpError(403, 'forbidden', { permission: FIELD_PERM.item_type });
  const { value, function_ids: raw } = req.body;
  if (!FIELD_OK.item_type(value)) throw bad('invalid_value', { field: 'value' });
  if (!Array.isArray(raw) || !raw.length || raw.length > 500 || !raw.every(isId)) throw bad('invalid_value', { field: 'function_ids' });
  const ids = [...new Set(raw)];
  const rows = (await query('SELECT id, code, name_ar, item_type, removed_at, closed_at FROM functions WHERE app_id=$1 AND id = ANY($2) ORDER BY sort, id', [a.id, ids])).rows;
  // only items of this application that are not removed (ETS-SEC-058)
  if (rows.length !== ids.length || rows.some(x => x.removed_at)) throw bad('invalid_value', { field: 'function_ids' });
  // a closed (locked) item keeps its type until it is reopened (migration 033)
  if (rows.some(x => x.closed_at)) throw bad('closed_locked');
  const targets = rows.filter(x => x.item_type !== value);
  if (!targets.length) return res.json({ updated: 0 });
  if (await needsLeadApproval(req.user, a)) {
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind: 'bulk',
      summary: `item_type = ${value} (${targets.length})`,
      items: targets.map(x => ({ kind: 'function', app_id: a.id, function_id: x.id, field: 'item_type', old_value: x.item_type, new_value: value })) }));
    publishChange({ dept_id: a.department_id, app_id: a.id });
    return res.status(202).json({ pending: true, request_id: rq.id, updated: 0, requested: targets.length });
  }
  const n = await tx(async c => {
    const changed = (await c.query(`UPDATE functions SET item_type=$2, updated_at=now(), updated_by=$3
      WHERE id = ANY($1) AND removed_at IS NULL AND item_type <> $2 RETURNING id`, [targets.map(x => x.id), value, req.user.id])).rows.map(x => x.id);
    for (const x of targets.filter(t => changed.includes(t.id))) {
      await logAudit(req, { db: c, action: 'update', entity: 'function', entityId: x.id, summary: `${a.id}/${x.code} ${x.name_ar.slice(0, 80)}`,
        oldValue: { item_type: x.item_type }, newValue: { item_type: value }, context: { bulk: true, app_id: a.id, count: changed.length } });
    }
    return changed.length;
  });
  // live updates: after COMMIT (services/live.js)
  publishChange({ dept_id: a.department_id, app_id: a.id });
  res.json({ updated: n });
}

// Functions a duplicate can point at: in the user's scope, counted (not excluded, not removed), other than the
// ones being excluded. Default: the given application; all=1 searches every application in scope.
r.get('/function-options', async (req, res) => {
  const appId = str(req.query.app_id, 40);
  const all = req.query.all === '1';
  const q = str(req.query.q, 100);
  const exclude = String(req.query.exclude || '').split(',').filter(Boolean).slice(0, 500).map(Number).filter(isId);
  if (!all && !appId) throw bad('invalid_value', { field: 'app_id' });
  if (!all) await getApp(req.user, appId);
  const apps = all ? (await query('SELECT id, department_id FROM applications')).rows.filter(x => canSeeApp(req.user, x)).map(x => x.id) : [appId];
  const params = [exclude, apps];
  // with_off=1: excluded items too (choosing the items of a bulk move, 1.10.0); never removed ones
  let where = `f.removed_at IS NULL ${req.query.with_off === '1' ? '' : 'AND f.enabled'} AND NOT (f.id = ANY($1)) AND f.app_id = ANY($2)`;
  if (q) {
    params.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    where += ` AND (f.code ILIKE $${params.length} OR f.name_ar ILIKE $${params.length} OR f.name_en ILIKE $${params.length}
      OR a.name_ar ILIKE $${params.length} OR a.name_en ILIKE $${params.length} OR a.id ILIKE $${params.length})`;
  }
  const limit = 200;
  const rows = (await query(`SELECT f.id, f.app_id, f.code, f.name_ar, f.name_en, f.enabled, a.name_ar AS app_name_ar, a.name_en AS app_name_en
    FROM functions f JOIN applications a ON a.id=f.app_id WHERE ${where} ORDER BY a.sort, f.sort, f.id LIMIT ${limit + 1}`, params)).rows;
  res.json({ options: rows.slice(0, limit), more: rows.length > limit });
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
    if (f) functions.push({ ...f, enabled: true, has_note: !!f.note });   // SELECT * carries item_type
  }
  if (add) functions.push({ id: -1, app_id: appId, source: 'custom', item_type: add.item_type || 'function', weight: add.weight,
    progress: add.progress, enabled: add.enabled, test_status: 0, notif_status: 0, review_status: 0 });
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
  if (await needsLeadApproval(req.user, a)) {
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind, summary, items: [{ kind: 'function', app_id: a.id, ...item }] }));
    publishChange({ dept_id: a.department_id, app_id: a.id });
    return res.status(202).json({ pending: true, request_id: rq.id, impact });
  }
  const f = await tx(direct);
  publishChange({ dept_id: a.department_id, app_id: a.id });
  if (kind === 'remove_function' && f) await functionsExcluded(a.id, 1, [req.user.id]);    // T7
  res.status(kind === 'add_function' ? 201 : 200).json({ function: f, impact });
}

r.post('/applications/:id/impact', requirePerm('tog'), async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const b = req.body || {};
  const add = b.add ? newFunctionDataOr400(b.add, true) : null;
  let set = Array.isArray(b.set) ? b.set.filter(x => isId(x?.function_id) && typeof x.enabled === 'boolean').slice(0, 500) : [];
  // only functions of this application (ETS-SEC-058)
  if (set.length) {
    const own = new Set((await query('SELECT id FROM functions WHERE app_id=$1 AND id = ANY($2)', [a.id, set.map(x => x.function_id)])).rows.map(x => x.id));
    set = set.filter(x => own.has(x.function_id));
  }
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
  if (cur.closed_at) throw bad('closed_locked');          // a closed (locked) item is reopened before it can be removed
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

// ---- close / lock & reopen a function (migration 033) ----
// Closing is the final-endorsement action: a holder of 'apv_final' («الاعتماد النهائي») marks a finished function as
// done. It becomes locked (no edit until reopened) and counts as 100 % in the calculation while staying counted
// (services/calc.js). Reopening needs an attached official document AND a written reason. Both routes enforce scope
// (getApp in loadFn) and the 'apv_final' permission.
r.post('/functions/:id/close', requirePerm('apv_final'), async (req, res) => {
  const { cur, a } = await loadFn(req, { removed: false });
  if (cur.closed_at) throw bad('already_closed');
  const updated = await tx(async c => {
    const u = (await c.query(`UPDATE functions SET closed_at=now(), closed_by=$2, updated_at=now(), updated_by=$2
      WHERE id=$1 AND closed_at IS NULL AND removed_at IS NULL RETURNING *`, [cur.id, req.user.id])).rows[0];
    if (!u) throw new HttpError(409, 'already_closed');
    await logAudit(req, { db: c, action: 'close', entity: 'function', entityId: cur.id,
      summary: `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}`, oldValue: { closed: false }, newValue: { closed: true } });
    return u;
  });
  publishChange({ dept_id: a.department_id, app_id: cur.app_id });     // the item now reads as 100 %
  res.json({ function: updated });
});

// Reopen: MULTIPART-style upload is not used in this codebase; like a branding image the document travels as a data:
// URL in the JSON body (body: { document: "data:application/pdf;base64,…", reason }). largeJson parses it after the
// permission check. Both the document and the reason are mandatory.
r.post('/functions/:id/reopen', requirePerm('apv_final'), largeJson, async (req, res) => {
  const { cur, a } = await loadFn(req, { removed: false });
  if (!cur.closed_at) throw bad('not_closed');
  const reason = parseReopenReason(req.body?.reason);
  const doc = parseReopenDoc(req.body?.document);
  const updated = await tx(async c => {
    const u = (await c.query(`UPDATE functions SET closed_at=NULL, closed_by=NULL, updated_at=now(), updated_by=$2
      WHERE id=$1 AND closed_at IS NOT NULL RETURNING *`, [cur.id, req.user.id])).rows[0];
    if (!u) throw new HttpError(409, 'not_closed');
    const ro = (await c.query(`INSERT INTO function_reopenings(function_id, reopened_by, reason, doc_name, doc_mime, doc_size, doc_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [cur.id, req.user.id, reason, doc.name, doc.mime, doc.size, doc.data])).rows[0];
    await logAudit(req, { db: c, action: 'reopen', entity: 'function', entityId: cur.id,
      summary: `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}`, oldValue: { closed: true },
      newValue: { closed: false, reason, reopening_id: ro.id, doc_name: doc.name, doc_mime: doc.mime, doc_size: doc.size } });
    return u;
  });
  publishChange({ dept_id: a.department_id, app_id: cur.app_id });
  res.json({ function: updated });
});

// Serve a stored reopen document (scope-enforced, like branding serves its image). Shown inline; never sniffed by the
// browser (nosniff) and framed by a strict CSP so a stored file can do nothing but be viewed / downloaded.
r.get('/functions/:id/reopenings/:roId/document', async (req, res) => {
  const id = idParam(req.params.id);
  const f = (await query('SELECT app_id FROM functions WHERE id=$1', [id])).rows[0];
  if (!f) throw notFound();
  await getApp(req.user, f.app_id);                        // scope
  const roId = idParam(req.params.roId, 'reopening_id');
  const ro = (await query('SELECT doc_name, doc_mime, doc_size, doc_data FROM function_reopenings WHERE id=$1 AND function_id=$2', [roId, id])).rows[0];
  if (!ro) throw notFound();
  res.set({ 'Content-Type': ro.doc_mime, 'Content-Disposition': `inline; filename="${ro.doc_name}"`,
    'Content-Length': String(ro.doc_size), 'Cache-Control': 'private, max-age=0, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  res.send(ro.doc_data);
});

// ---- moving items to another application (1.10.0, services/move.js) ----
// Applications and departments a user may move items to: every application in scope but the current one, grouped by
// department (the dialog picks the department — "module" — first, then the application).
r.get('/move-targets', requirePerm('mov'), async (req, res) => {
  let appId = str(req.query.app_id, 40);
  if (req.query.function_id !== undefined) {
    const f = (await query('SELECT app_id FROM functions WHERE id=$1', [idParam(String(req.query.function_id), 'function_id')])).rows[0];
    if (!f) throw notFound();
    appId = f.app_id;
  }
  if (!appId) throw bad('invalid_value', { field: 'app_id' });
  const cur = await getApp(req.user, appId);
  const [d, a] = await Promise.all([query('SELECT id, name_ar, name_en, short_ar, short_en, emblem, is_base, sort FROM departments ORDER BY sort'),
    query('SELECT id, department_id, name_ar, name_en, icon, sort FROM applications ORDER BY sort')]);
  const apps = a.rows.filter(x => x.id !== cur.id && canSeeApp(req.user, x));
  res.json({ current: { app_id: cur.id, department_id: cur.department_id },
    departments: d.rows.map(x => ({ ...x, applications: apps.filter(y => y.department_id === x.id).map(({ sort: _s, ...y }) => y) }))
      .filter(x => x.applications.length) });
});

// Before → after of the source and destination applications, their department(s) and the project (reader's scope),
// with the application weight that goes with the items (same calculation as the move itself, services/move.js).
async function moveImpact(user, src, dst, ids) {
  const v = await loadVisible(user);
  const mode = v.settings['calc.weight_mode'] === 'auto' ? 'auto' : 'fixed';
  const srcApp = v.apps.find(x => x.id === src.id), dstApp = v.apps.find(x => x.id === dst.id);
  const tr = weightTransfer({ mode, srcWeight: srcApp.weight, srcFunctions: v.functions.filter(f => f.app_id === src.id), ids });
  let dstAfter = +dstApp.weight, overflow = false;
  try { if (tr.share > 0) dstAfter = destinationWeight(dstApp.weight, tr.share); } catch { overflow = true; }
  const set = new Set(ids);
  const functions = v.functions.map(f => (set.has(f.id) ? { ...f, app_id: dst.id } : f));
  const applications = v.apps.map(a => (a.id === src.id ? { ...a, weight: tr.src_after } : a.id === dst.id ? { ...a, weight: dstAfter } : a));
  const after = summarize({ departments: v.departments, applications, functions, reports: v.reports, settings: v.settings });
  const pair = (b, x, k) => ({ before: b?.[k] ?? 0, after: x?.[k] ?? 0 });
  const appRow = (a, role) => {
    const b = v.calc.applications.find(x => x.id === a.id), x = after.applications.find(y => y.id === a.id);
    return { id: a.id, role, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en,
      pct: pair(b, x, 'pct'), weight: pair(b, x, 'weight'), count: pair(b, x, 'count') };
  };
  const deptRow = id => {
    const d = v.departments.find(x => x.id === id);
    const b = v.calc.departments.find(x => x.id === id), x = after.departments.find(y => y.id === id);
    return { id, name_ar: d.name_ar, name_en: d.name_en, is_base: d.is_base, pct: pair(b, x, 'pct'), weight: pair(b, x, 'weight') };
  };
  const moved = v.functions.filter(f => set.has(f.id));
  return { mode, items: ids.length, counted: moved.filter(f => f.enabled).length,
    weight: { share: tr.share, moved_weight: tr.moved_weight, src_items_weight: tr.denominator, overflow,
      src: { before: +srcApp.weight, after: tr.src_after }, dst: { before: +dstApp.weight, after: dstAfter } },
    apps: [appRow(srcApp, 'source'), appRow(dstApp, 'destination')],
    departments: [...new Set([src.department_id, dst.department_id])].map(deptRow),
    total: pair(v.calc.total, after.total, 'pct') };
}

// The common checks of a move (single or bulk) → { src, dst, rows }: 'mov' (route), both applications in scope,
// a different destination, items of the source application, not removed, no pending request / import about them.
async function movePlan(req, src, ids, { needReason }) {
  const toId = str(req.body?.to_app_id, 40);
  if (!toId) throw bad('invalid_value', { field: 'to_app_id' });
  const dst = (await query('SELECT * FROM applications WHERE id=$1', [toId])).rows[0];
  if (!dst) throw bad('unknown_application', { id: toId });
  if (!canSeeApp(req.user, dst)) throw new HttpError(403, 'out_of_scope', { application: toId });
  if (dst.id === src.id) throw bad('move_same_app');
  const reason = needReason ? parseMoveReason(req.body?.reason) : null;
  const rows = (await query('SELECT id, app_id, code, name_ar, name_en, enabled, weight, removed_at, closed_at FROM functions WHERE app_id=$1 AND id = ANY($2) ORDER BY sort, id',
    [src.id, ids])).rows;
  if (rows.length !== ids.length) throw bad('invalid_value', { field: 'function_ids' });      // only items of this application
  // a closed (locked) item stays put until it is reopened (migration 033)
  if (rows.some(x => x.closed_at)) throw new HttpError(409, 'closed_locked', { items: rows.filter(x => x.closed_at).map(x => ({ function_id: x.id, code: x.code })) });
  await checkMovable({ query }, rows);
  return { dst, rows, reason };
}

const moveIds = raw => {
  if (!Array.isArray(raw) || !raw.length || raw.length > MOVE_MAX || !raw.every(isId)) throw bad('invalid_value', { field: 'function_ids', max: MOVE_MAX });
  return [...new Set(raw)];
};

// Direct move, or a 'move_function' request for the team leads (202). Live changes and the T8 alert after COMMIT.
async function doMove(req, res, src, ids) {
  const { dst, rows, reason } = await movePlan(req, src, ids, { needReason: true });
  const impact = await moveImpact(req.user, src, dst, ids);
  if (impact.weight.overflow) throw new HttpError(409, 'move_weight_out_of_range', { max: 1000, after: impact.weight.dst.before + impact.weight.share });
  if (await moveNeedsApproval(req.user, src, dst)) {
    const tr = weightTransfer({ mode: impact.mode, srcWeight: src.weight,
      srcFunctions: (await query(CALC_FUNCTIONS_SQL + ' AND app_id=$1', [src.id])).rows, ids: rows.map(f => f.id) });
    const rq = await tx(c => createRequest(c, req, { deptId: src.department_id, appId: src.id, kind: 'move_function',
      summary: `${rows.map(f => f.code).join(', ').slice(0, 120)} → ${dst.id}`,
      target: { appId: dst.id, deptId: dst.department_id },
      meta: { reason, weight_mode: impact.mode, weight_share: impact.weight.share, impact },
      items: rows.map(f => ({ kind: 'function', app_id: src.id, function_id: f.id, field: 'move',
        old_value: { app_id: src.id, department_id: src.department_id, code: f.code },
        new_value: { app_id: dst.id, department_id: dst.department_id, name_ar: dst.name_ar, name_en: dst.name_en },
        meta: { reason, weight_share: tr.per.get(f.id) || 0 } })) }));
    publishApps([src, dst]);                               // "awaiting approval" badges
    return res.status(202).json({ pending: true, request_id: rq.id, impact });
  }
  const out = await tx(c => applyMove(c, req, { srcId: src.id, dstId: dst.id, ids: rows.map(f => f.id), reason }));
  await publishApps([src, dst]);                           // after COMMIT: both applications / departments
  await itemsMovedIn(src.id, dst.id, out.items.length, [req.user.id]);      // T8
  res.json({ moved: out.items, weight: out.weight, impact });
}

r.post('/functions/:id/move/preview', requirePerm('mov'), async (req, res) => {
  const { cur, a } = await loadFn(req, { removed: undefined });
  if (cur.removed_at) throw new HttpError(409, 'move_function_removed', { items: [{ function_id: cur.id, code: cur.code }] });
  const { dst } = await movePlan(req, a, [cur.id], { needReason: false });
  res.json({ ...await moveImpact(req.user, a, dst, [cur.id]), needs_approval: await moveNeedsApproval(req.user, a, dst) });
});

r.post('/functions/:id/move', requirePerm('mov'), async (req, res) => {
  const { cur, a } = await loadFn(req, { removed: undefined });
  if (cur.removed_at) throw new HttpError(409, 'move_function_removed', { items: [{ function_id: cur.id, code: cur.code }] });
  await doMove(req, res, a, [cur.id]);
});

r.post('/applications/:id/bulk-move/preview', requirePerm('mov'), async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const ids = moveIds(req.body?.function_ids);
  const { dst } = await movePlan(req, a, ids, { needReason: false });
  res.json({ ...await moveImpact(req.user, a, dst, ids), needs_approval: await moveNeedsApproval(req.user, a, dst) });
});

// All or nothing: every chosen item moves in one transaction, or none does.
r.post('/applications/:id/bulk-move', requirePerm('mov'), async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  await doMove(req, res, a, moveIds(req.body?.function_ids));
});

// ---- moving a whole application to another department ("module") (1.12.16, services/app-move.js) ----
// Departments a user may move an application INTO: every department whose WHOLE scope they cover, but the current one.
r.get('/app-move-targets', requirePerm('mov'), async (req, res) => {
  const appId = str(req.query.app_id, 40);
  if (!appId) throw bad('invalid_value', { field: 'app_id' });
  const cur = await getApp(req.user, appId);
  const d = (await query('SELECT id, name_ar, name_en, short_ar, short_en, emblem, is_base, sort FROM departments ORDER BY sort')).rows;
  res.json({ current: { app_id: cur.id, department_id: cur.department_id },
    departments: d.filter(x => x.id !== cur.department_id && coversDept(req.user, x.id)).map(({ sort: _s, ...x }) => x) });
});

// The common checks of an application move → { dst, reason }: a different destination department the user covers, a
// required reason (same rule as an item move), no pending request / import on the application or its items.
async function appMovePlan(req, app, { needReason }) {
  const toDept = str(req.body?.to_department_id, 50);
  if (!toDept) throw bad('invalid_value', { field: 'to_department_id' });
  const dst = (await query('SELECT * FROM departments WHERE id=$1', [toDept])).rows[0];
  if (!dst) throw bad('unknown_department', { id: toDept });
  if (!coversDept(req.user, dst.id)) throw new HttpError(403, 'out_of_scope', { department: toDept });
  if (dst.id === app.department_id) throw bad('move_same_dept');
  const reason = needReason ? parseMoveReason(req.body?.reason) : null;
  await checkAppMovable({ query }, app.id);
  return { dst, reason };
}

// Before → after of the two departments and the project (reader's scope) of moving the application to dstDept.
async function appMoveImpact(user, app, dst) {
  const v = await loadVisible(user);
  const mode = v.settings['calc.weight_mode'] === 'auto' ? 'auto' : 'fixed';
  const applications = v.apps.map(a => (a.id === app.id ? { ...a, department_id: dst.id } : a));
  const after = summarize({ departments: v.departments, applications, functions: v.functions, reports: v.reports, settings: v.settings });
  const pair = (b, x, k) => ({ before: b?.[k] ?? 0, after: x?.[k] ?? 0 });
  const deptRow = (id, role) => {
    const d = v.departments.find(x => x.id === id) || (id === dst.id ? dst : null);
    const b = v.calc.departments.find(x => x.id === id), x = after.departments.find(y => y.id === id);
    return { id, role, name_ar: d?.name_ar, name_en: d?.name_en, is_base: d?.is_base, pct: pair(b, x, 'pct'), weight: pair(b, x, 'weight') };
  };
  const appCalcRow = v.calc.applications.find(x => x.id === app.id);
  return { mode, app_weight: mode === 'auto' ? (appCalcRow?.weight ?? 0) : +app.weight,
    departments: [deptRow(app.department_id, 'source'), deptRow(dst.id, 'destination')],
    total: pair(v.calc.total, after.total, 'pct') };
}

r.post('/applications/:id/move-dept/preview', requirePerm('mov'), async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const { dst } = await appMovePlan(req, a, { needReason: false });
  res.json({ ...await appMoveImpact(req.user, a, dst), needs_approval: await moveAppNeedsApproval(req.user, a.department_id, dst.id) });
});

// Direct move, or a 'move_application' request for the two department leads (202). Live changes and the T9 alert after COMMIT.
r.post('/applications/:id/move-dept', requirePerm('mov'), async (req, res) => {
  const a = await getApp(req.user, req.params.id);
  const { dst, reason } = await appMovePlan(req, a, { needReason: true });
  const impact = await appMoveImpact(req.user, a, dst);
  if (await moveAppNeedsApproval(req.user, a.department_id, dst.id)) {
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind: 'move_application',
      summary: `${a.id} → ${dst.id}`,
      target: { appId: null, deptId: dst.id },
      meta: { reason, weight_mode: impact.mode, weight: impact.app_weight, impact },
      items: [{ kind: 'application', app_id: a.id, field: 'move',
        old_value: { department_id: a.department_id }, new_value: { department_id: dst.id, name_ar: dst.name_ar, name_en: dst.name_en },
        meta: { reason } }] }));
    await publishChange({ dept_id: a.department_id, app_id: a.id });    // "awaiting approval" badge
    return res.status(202).json({ pending: true, request_id: rq.id, impact });
  }
  const out = await tx(c => moveApplication(c, req, { appId: a.id, dstDeptId: dst.id, reason }));
  await publishChange({ dept_id: a.department_id });                   // after COMMIT: the source department's total
  await publishChange({ dept_id: dst.id, app_id: a.id });              // the destination, with the moved application
  await applicationMovedIn(a.id, a.department_id, dst.id, [req.user.id]);   // T9
  res.json({ moved: true, weight: out.weight, impact });
});

// ---- weights & calculation parameters ----
export async function weightsData(user) {
  const v = await loadVisible(user);
  return {
    departments: v.departments,
    applications: v.apps.map(a => ({ id: a.id, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en,
      weight: a.weight, default_weight: a.default_weight, fnWeight: v.calc.applications.find(x => x.id === a.id).fnWeight })),
    settings: calcSettings(v.settings),
  };
}
r.get('/weights', async (req, res) => res.json(await weightsData(req.user)));

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
  // project-wide parameters concern every screen; application weights only their departments
  if (globalChanges.length) publishChange();
  else publishApps(Object.keys(weights).filter(id => Number(byId.get(id).weight) !== Number(weights[id])).map(id => byId.get(id)));
  res.json({ ok: true });
});

r.post('/weights/reset', requirePerm('wgt'), async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  await tx(async c => {
    await c.query('UPDATE applications SET weight=default_weight, updated_at=now(), updated_by=$1', [req.user.id]);
    await logAudit(req, { db: c, action: 'reset', entity: 'application', summary: 'all weights reset to defaults' });
  });
  publishChange();
  res.json({ ok: true });
});

// ---- reports track ----
export async function reportsData(user) {
  const v = await loadVisible(user);
  const reports = await query(`SELECT r.*, u.full_name AS updated_by_name FROM app_reports r LEFT JOIN users u ON u.id=r.updated_by`);
  const byApp = new Map(reports.rows.map(x => [x.app_id, x]));
  const base = new Set(v.departments.filter(d => d.is_base).map(d => d.id));
  const pend = (await query(`SELECT i.app_id, i.field, i.new_value, u.full_name AS requested_by_name
    FROM edit_request_items i JOIN edit_requests r ON r.id=i.request_id LEFT JOIN users u ON u.id=r.requested_by
    WHERE r.status='pending' AND i.kind='report'`)).rows;
  return {
    departments: v.departments.filter(d => !d.is_base),
    applications: v.apps.filter(a => !base.has(a.department_id)).map(a => {
      const c = v.calc.applications.find(x => x.id === a.id);
      // reportPct: the application's reports % — its report items (1.8.0) with this track — as used in its progress
      return { id: a.id, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en, icon: a.icon,
        weight: c.weight, report: byApp.get(a.id) || null, report_pct: c.reportPct, report_items: c.reportItems,
        pending: pend.filter(p => p.app_id === a.id) };
    }),
    settings: calcSettings(v.settings),
    can: { rep: hasPerm(user, 'rep') },
  };
}
r.get('/reports', async (req, res) => res.json(await reportsData(req.user)));

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
  if (await needsLeadApproval(req.user, a)) {
    const rq = await tx(c => createRequest(c, req, { deptId: a.department_id, appId: a.id, kind: 'report', summary: keys.join(', '),
      items: keys.map(k => ({ kind: 'report', app_id: a.id, field: k, old_value: cur[k], new_value: changes[k] })) }));
    publishChange({ dept_id: a.department_id, app_id: a.id });
    return res.status(202).json({ pending: true, request_id: rq.id, report: cur });
  }
  const row = await tx(async c => {
    const u = (await c.query(`UPDATE app_reports SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now(),
      updated_by=$${keys.length + 2} WHERE app_id=$1 RETURNING *`, [a.id, ...keys.map(k => changes[k]), req.user.id])).rows[0];
    await logAudit(req, { db: c, action: 'update', entity: 'report', entityId: a.id,
      oldValue: Object.fromEntries(keys.map(k => [k, cur[k]])), newValue: changes });
    return u;
  });
  publishChange({ dept_id: a.department_id, app_id: a.id });
  res.json({ report: row });
});

// ---- schedule (S-curve) and project timeline ----
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = v => ISO.test(v) && !Number.isNaN(new Date(v + 'T00:00:00Z').getTime()) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v);

// Start + k periods (months keep the day of month, clamped to the month's length), as 'YYYY-MM-DD'.
export function addPeriods(start, unit, k) {
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

export async function scheduleData(user) {
  const s = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const v = await loadVisible(user);
  return { ...scheduleJson(s), current_pct: v.calc.total.pct,
    can: { sch: hasPerm(user, 'sch') && !!user.fullScope, timeline: hasPerm(user, 'cfg') && !!user.fullScope } };
}
r.get('/schedule', async (req, res) => res.json(await scheduleData(req.user)));

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
  publishChange();          // schedule / timeline: dashboard curve, project status
}

r.put('/schedule', requirePerm('sch'), async (req, res) => {
  // a single project-wide schedule → full-scope users only, like the other project-wide parameters (ETS-SEC-024)
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope', { setting: 'schedule' });
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
export async function projectStatusData(user) {
  const s = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const v = await loadVisible(user);
  const on = v.functions.filter(f => f.enabled);
  const n = itemCounts(v.functions);
  const [snaps, edits, imports] = await Promise.all([
    recentSnapshots(),
    query(`SELECT app_id, count(*)::int AS n FROM edit_requests WHERE status='pending' GROUP BY 1`),
    // per batch: the applications it changes (a scoped reader counts a batch when one of them is theirs)
    query(`SELECT coalesce(array_agg(DISTINCT ch.app_id) FILTER (WHERE ch.app_id IS NOT NULL), '{}') AS apps, 1 AS n
      FROM import_batches b LEFT JOIN import_changes ch ON ch.batch_id=b.id WHERE b.status='pending' GROUP BY b.id`),
  ]);
  // Scoped users: the project line of a snapshot is the weighted average of the departments they can see.
  const depts = v.departments.map(d => ({ ...d, ...v.calc.departments.find(x => x.id === d.id) }));
  const tw = depts.reduce((a, d) => a + d.weight, 0);
  const trend = snaps.map(x => {
    if (user.fullScope) return { day: x.day, pct: x.pct };
    const p = tw ? depts.reduce((a, d) => a + d.weight * (+x.departments?.[d.id] || 0), 0) / tw : 0;
    return { day: x.day, pct: Math.round(p * 100) / 100 };
  });
  const deptTrend = Object.fromEntries(depts.map(d => [d.id, snaps.map(x => ({ day: x.day, pct: +x.departments?.[d.id] || 0 }))]));
  // pending work: full scope counts everything; a scoped reader only requests / batches of applications in scope (V2-N3)
  const visibleApps = new Set(v.apps.map(a => a.id));
  const mine = id => visibleApps.has(id);
  const pend = (rows, ok) => rows.filter(x => user.fullScope || ok(x)).reduce((a, x) => a + x.n, 0);
  const tracks = v.reports.filter(x => !v.departments.find(d => d.id === v.apps.find(a => a.id === x.app_id)?.department_id)?.is_base);
  return {
    schedule: scheduleJson(s),
    today: new Date().toISOString().slice(0, 10),
    total: v.calc.total,
    departments: depts.map(d => ({ id: d.id, name_ar: d.name_ar, name_en: d.name_en, color: d.color, emblem: d.emblem,
      pct: d.pct, weight: d.weight, apps: d.apps })),
    // functions / done / in_progress / not_started: function items; notes, tests and the flags: every counted item;
    // reports*: the report items and the reports tracks pooled as in an application's reports % (1.8.0)
    counts: {
      functions: n.functions,
      done: n.done,
      in_progress: n.in_progress,
      not_started: n.not_started,
      notes: n.notes,
      tests: v.calc.total.tests,
      notif_bad: on.filter(f => (f.notif_status | 0) === 3).length,
      review_missing: on.filter(f => (f.review_status | 0) === 2).length,
      ...reportsOverview(v.functions, tracks, +v.settings['calc.notif_share'] || 0),
    },
    pending: { edits: pend(edits.rows, x => mine(x.app_id)), imports: pend(imports.rows, x => x.apps.some(mine)) },
    trend, dept_trend: deptTrend,
    // department status thresholds (Settings → Notifications), used by the status page and the plan alerts alike
    health_gaps: { riskGap: +v.settings['notify.dept_risk_gap'] || 5, delayGap: +v.settings['notify.dept_delay_gap'] || 15 },
    can: { timeline: hasPerm(user, 'cfg') && !!user.fullScope, sch: hasPerm(user, 'sch') && !!user.fullScope },
  };
}
r.get('/project-status', async (req, res) => res.json(await projectStatusData(req.user)));

// ---- search ----
r.get('/search', async (req, res) => {
  const q = str(req.query.q, 100);
  if (q.length < 2) return res.json({ results: [] });
  const rows = (await query(`SELECT f.id, f.app_id, f.code, f.name_ar, f.name_en, f.reference, f.progress, f.enabled, f.source, f.item_type,
        a.department_id, a.name_ar AS app_name_ar, a.name_en AS app_name_en
      FROM functions f JOIN applications a ON a.id=f.app_id
      WHERE f.removed_at IS NULL AND (f.name_ar ILIKE $1 OR f.name_en ILIKE $1 OR f.reference ILIKE $1 OR f.note ILIKE $1
         OR a.name_ar ILIKE $1 OR a.name_en ILIKE $1)
      ORDER BY a.sort, f.sort LIMIT 200`, ['%' + q.replace(/[%_\\]/g, '\\$&') + '%'])).rows;
  res.json({ results: rows.filter(x => canSeeApp(req.user, { id: x.app_id, department_id: x.department_id })) });
});

// ---- export / import (original tracker format) ----
// Only the applications in the user's scope; the project schedule only for full-scope users (ETS-SEC-006).
r.get('/export', requirePerm('exp'), async (req, res) => {
  const payload = await tx(c => buildLegacy(c, { user: req.user }));
  // strict: no data leaves without its audit row (ETS-SEC-049)
  await logAudit(req, { action: 'export', entity: 'tracker', summary: req.user.fullScope ? 'JSON export' : 'JSON export (own scope)',
    newValue: { applications: Object.keys(payload.appW).length } });
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
    const before = await buildLegacy(c, { user: req.user });   // full scope (checked above)
    const n = await applyLegacy(c, payload, req.user.id);
    await logAudit(req, { db: c, action: 'import', entity: 'tracker', summary: JSON.stringify(n), oldValue: before });
    return n;
  });
  invalidateSettings();
  publishChange();
  logSystem('import', 'legacy tracker data imported', { by: req.user.username, ...counts });
  res.json({ ok: true, counts });
});

export default r;

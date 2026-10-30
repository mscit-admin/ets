import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm, hasPerm, canSeeApp, coversDept } from '../middleware/auth.js';
import { CALC_FUNCTIONS_SQL } from '../services/calc.js';
import { invalidateSettings } from '../services/settings.js';
import { logAudit, logSystem } from '../services/logs.js';
import { applyLegacy, buildLegacy, parseLegacy } from '../services/legacy.js';
import { needsLeadApproval, createRequest } from '../services/edits.js';
import { addNote, recordNoteHistory, syncFunctionNote, noteHistory, canDecideNote } from '../services/notes.js';
import { createFunction, newFunctionData, removeFunction, restoreFunction } from '../services/functions.js';
import { PASS, passConflict, passRuleError, withPassProgress } from '../services/passRule.js';
import { largeJson } from '../middleware/body.js';
import { publishChange, publishApps } from '../services/live.js';
import { functionsExcluded, itemsMovedIn, applicationMovedIn } from '../services/notify-events.js';
import { MOVE_MAX, parseMoveReason, moveNeedsApproval, weightTransfer, checkMovable, applyMove }
  from '../services/move.js';
import { moveApplication, moveAppNeedsApproval, checkAppMovable } from '../services/app-move.js';
import { HttpError, bad, notFound, str, intIn, numIn, idParam, isId, isDate } from '../utils/http.js';
import { RENAME_KEYS, parseRename, parseRenameReason, duplicateName } from '../services/rename.js';
import { REASON_KEYS, parseDisableReason, checkDuplicates, setDisabled, clearDisabled, currentReasons, reasonValues, hadReason }
  from '../services/disable.js';
import { parseReopenReason, parseReopenDoc } from '../services/reopen.js';
import { FIELD_PERM, FIELD_OK, NOTE_REQUIRED, notedValue, needsNote } from '../services/field-rules.js';
import { bulkEnabled, bulkItemType, bulkPassCheck, reasonMeta } from '../services/bulk.js';
import { impactOf, moveImpact, appMoveImpact } from '../services/impact.js';
import { DATE, fitTimeline, saveSchedule } from '../services/schedule.js';
import { getApp, summaryData, departmentData, applicationData, weightsData, reportsData, scheduleData, projectStatusData }
  from '../services/tracker-data.js';

// The data-assembly functions and the schedule maths moved to services/ (BE-1) but are still read through this route
// module by the Excel exports (routes/export.js); re-export them here under the same names and path.
export { summaryData, departmentData, applicationData, weightsData, reportsData, scheduleData, projectStatusData }
  from '../services/tracker-data.js';
export { addPeriods } from '../services/schedule.js';

const r = Router();
r.use(requireAuth);

r.get('/summary', async (req, res) => res.json(await summaryData(req.user)));

r.get('/departments/:id', async (req, res) => res.json(await departmentData(req.user, req.params.id)));

r.get('/applications/:id', async (req, res) => res.json(await applicationData(req.user, req.params.id)));

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
    // a note written in this edit is also appended to the item's history (migration 031); functions.note has just
    // been set to the same text, so it stays the current active note (services/notes.js)
    if ('note' in changes) await recordNoteHistory(c, id, changes.note, req.user.id);
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

// ============================================================
// Notes history of an item (migration 031)
// ============================================================
// Loads the function and its application, enforcing scope (getApp). Returns { cur, app }.
async function getFunctionForNotes(user, functionId) {
  const cur = (await query('SELECT * FROM functions WHERE id=$1', [functionId])).rows[0];
  if (!cur) throw notFound();
  const app = await getApp(user, cur.app_id);          // 403 when the item is outside the reader's scope
  return { cur, app };
}

// GET /tracker/functions/:id/notes — the full chronological note history of the item. Visible to anyone who can see
// the function (scope enforced); the management actions (done / decision / deletion) are gated in PATCH below.
r.get('/functions/:id/notes', async (req, res) => {
  const id = idParam(req.params.id);
  const { app } = await getFunctionForNotes(req.user, id);
  res.json({ notes: await noteHistory({ query }, id), can: { lead: canDecideNote(req.user, app) } });
});

// POST /tracker/functions/:id/notes — add a note. Same permission as writing a note today: 'tst' (FIELD_PERM.note).
// The note is appended to the history and becomes the current active note (functions.note is kept in sync). An
// optional `replaces` is the id of a REJECTED note of the same item this one follows up (the chain, migration 031).
r.post('/functions/:id/notes', async (req, res) => {
  const id = idParam(req.params.id);
  const { cur, app } = await getFunctionForNotes(req.user, id);
  if (cur.removed_at) throw bad('function_removed');
  if (!hasPerm(req.user, FIELD_PERM.note)) throw new HttpError(403, 'forbidden', { permission: FIELD_PERM.note, field: 'note' });
  const body = str(req.body?.body, 2000);
  if (!body) throw bad('note_required');
  let replaces = null;
  if (req.body?.replaces != null) {
    replaces = idParam(req.body.replaces, 'replaces');
    const prev = (await query('SELECT id, function_id, decision FROM function_notes WHERE id=$1', [replaces])).rows[0];
    // the replaced note must belong to this item and be a rejected one (the follow-up only applies to «مرفوضة»)
    if (!prev || prev.function_id !== id || prev.decision !== 'rejected') throw bad('invalid_value', { field: 'replaces' });
  }
  const note = await tx(async c => {
    const n = await addNote(c, { functionId: id, body, authorId: req.user.id, replaces });
    await logAudit(req, { db: c, action: 'update', entity: 'function', entityId: id,
      summary: `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}`,
      oldValue: { note: cur.note || '' }, newValue: { note: body },
      context: { via: 'note_add', note_id: n.id, ...(replaces ? { replaces } : {}) } });
    return n;
  });
  publishChange({ dept_id: app.department_id, app_id: cur.app_id });
  res.status(201).json({ note });
});

// PATCH /tracker/notes/:noteId — one sub-action on a note, each permission-checked:
//   { done: bool }             the AUTHOR marks their own note «منتهية / غير منتهية»
//   { decision: 'approved'|'rejected' }  the TEAM LEAD decides (approved = «معتمدة للعمل», rejected = «مرفوضة»)
//   { request_delete: true }   anyone who can see the item REQUESTS its deletion (not hidden yet)
//   { approve_delete: true }   the TEAM LEAD approves the deletion (the note is then hidden, never removed)
// Every change writes an audit row. A note ADDITION (POST above) is a genuine note change and is logged as
// entity 'function' so it flows into the function-changes export like any note edit; the lifecycle sub-actions
// here (done / decision / deletion) are logged as entity 'function_note' — part of the audit trail, but not a
// function-column change, so they stay out of that export. functions.note is re-synced whenever the active note
// may have moved (a rejection or an approved deletion).
r.patch('/notes/:noteId', async (req, res) => {
  const noteId = idParam(req.params.noteId, 'noteId');
  const n = (await query('SELECT * FROM function_notes WHERE id=$1', [noteId])).rows[0];
  if (!n) throw notFound();
  const { cur, app } = await getFunctionForNotes(req.user, n.function_id);        // scope enforced on every action
  const body = req.body || {};
  const lead = canDecideNote(req.user, app);
  const isAuthor = n.author_id === req.user.id;
  const summary = `${cur.app_id}/${cur.code} ${cur.name_ar.slice(0, 80)}`;
  const audit = (entity, action, oldValue, newValue, context) =>
    logAudit(req, { db: context.db, action, entity, entityId: entity === 'function_note' ? noteId : n.function_id, summary, oldValue, newValue,
      context: { note_id: noteId, function_id: n.function_id, ...context, db: undefined } });

  // ---- author toggles done
  if ('done' in body) {
    if (typeof body.done !== 'boolean') throw bad('invalid_value', { field: 'done' });
    if (!isAuthor) throw new HttpError(403, 'forbidden', { field: 'done' });   // only the author of the note
    const row = await tx(async c => {
      const u = (await c.query('UPDATE function_notes SET done=$2 WHERE id=$1 RETURNING *', [noteId, body.done])).rows[0];
      await audit('function_note', 'update', { done: n.done }, { done: body.done }, { db: c });
      return u;
    });
    publishChange({ app_id: cur.app_id });
    return res.json({ note: row });
  }

  // ---- team lead sets the decision (approved / rejected)
  if ('decision' in body) {
    if (!['approved', 'rejected'].includes(body.decision)) throw bad('invalid_value', { field: 'decision' });
    if (!lead) throw new HttpError(403, 'forbidden', { permission: 'apv_dept', field: 'decision' });
    const row = await tx(async c => {
      const u = (await c.query('UPDATE function_notes SET decision=$2, decided_by=$3, decided_at=now() WHERE id=$1 RETURNING *',
        [noteId, body.decision, req.user.id])).rows[0];
      // a rejected note is no longer active (an approved one may be) — keep functions.note the current active note
      await syncFunctionNote(c, n.function_id, req.user.id);
      await audit('function_note', 'update', { decision: n.decision }, { decision: body.decision }, { db: c, via: 'note_decision' });
      return u;
    });
    publishChange({ dept_id: app.department_id, app_id: cur.app_id });
    return res.json({ note: row });
  }

  // ---- request deletion (anyone who can see the item)
  if (body.request_delete === true) {
    if (n.deleted_at) throw bad('note_deleted');
    const row = await tx(async c => {
      const u = (await c.query(
        `UPDATE function_notes SET delete_requested_by=$2, delete_requested_at=now() WHERE id=$1 RETURNING *`,
        [noteId, req.user.id])).rows[0];
      await audit('function_note', 'update', { delete_requested: false }, { delete_requested: true }, { db: c });
      return u;
    });
    publishChange({ app_id: cur.app_id });
    return res.json({ note: row });
  }

  // ---- approve deletion (team lead): the note is hidden, never removed
  if (body.approve_delete === true) {
    if (!lead) throw new HttpError(403, 'forbidden', { permission: 'apv_dept', field: 'approve_delete' });
    if (n.deleted_at) throw bad('note_deleted');
    const row = await tx(async c => {
      const u = (await c.query('UPDATE function_notes SET deleted_by=$2, deleted_at=now() WHERE id=$1 RETURNING *',
        [noteId, req.user.id])).rows[0];
      await syncFunctionNote(c, n.function_id, req.user.id);        // a hidden note is no longer the active note
      await audit('function_note', 'delete', { note: n.body }, { deleted: true }, { db: c, via: 'note_delete' });
      return u;
    });
    publishChange({ dept_id: app.department_id, app_id: cur.app_id });
    return res.json({ note: row });
  }

  throw bad('unknown_field');
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
  publishApps([src, dst]);                                 // after COMMIT: both applications / departments
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
    publishChange({ dept_id: a.department_id, app_id: a.id });          // "awaiting approval" badge
    return res.status(202).json({ pending: true, request_id: rq.id, impact });
  }
  const out = await tx(c => moveApplication(c, req, { appId: a.id, dstDeptId: dst.id, reason }));
  publishChange({ dept_id: a.department_id });                         // after COMMIT: the source department's total
  publishChange({ dept_id: dst.id, app_id: a.id });                   // the destination, with the moved application
  await applicationMovedIn(a.id, a.department_id, dst.id, [req.user.id]);   // T9
  res.json({ moved: true, weight: out.weight, impact });
});

// ---- weights & calculation parameters ----
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
r.get('/schedule', async (req, res) => res.json(await scheduleData(req.user)));

r.put('/schedule', requirePerm('sch'), async (req, res) => {
  // a single project-wide schedule → full-scope users only, like the other project-wide parameters (ETS-SEC-024)
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope', { setting: 'schedule' });
  const { periods, unit, plan, actual } = req.body || {};
  const old = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  // The start and close dates belong to Settings; the schedule screen only keeps the start date when no close date is set.
  let start_date = DATE(old.start_date);
  if (!old.end_date && 'start_date' in (req.body || {})) {
    start_date = req.body.start_date;
    if (start_date !== null && !isDate(start_date)) throw bad('invalid_value', { field: 'start_date' });
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
  for (const [k, v] of Object.entries({ start_date, end_date })) if (v !== null && !isDate(v)) throw bad('invalid_value', { field: k });
  if (end_date && !start_date) throw bad('start_required');
  const old = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const next = fitTimeline({ start_date, end_date, unit: old.unit, periods: old.periods, plan: old.plan, actual: old.actual || [] });
  await saveSchedule(req, next);
  res.json({ ok: true, ...next });
});

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

// Bulk-operation logic for an application's items (extracted from routes/tracker.js, BE-1): set one field on every
// enabled function, exclude/include chosen functions, or set their type. The /applications/:id/bulk route stays thin
// and dispatches here; it keeps the inline progress / test_status bulk and calls bulkPassCheck from this module.
import { query, tx } from '../db/pool.js';
import { hasPerm } from '../middleware/auth.js';
import { HttpError, bad, isId } from '../utils/http.js';
import { logAudit } from './logs.js';
import { publishChange } from './live.js';
import { needsLeadApproval, createRequest } from './edits.js';
import { functionsExcluded } from './notify-events.js';
import { PASS, itemList } from './passRule.js';
import { parseDisableReason, checkDuplicates, setDisabled, clearDisabled, currentReasons, reasonValues, hadReason, refs } from './disable.js';
import { FIELD_PERM, FIELD_OK } from './field-rules.js';

// «نجح» = 100 % for a bulk set (1.8.1 / auto-filled 1.12.21): a bulk «نجح» now succeeds and brings every newly-passed
// item up to 100 % (handled in the UPDATE below), so it is no longer refused. Only a bulk progress below 100 is still
// refused (400) when it would lower the progress of a passed item, with the list of those items.
export async function bulkPassCheck(c, appId, field, value) {
  if (!(field === 'progress' && value < 100)) return;
  const rows = (await c.query(`SELECT id, code, name_ar, name_en, item_type, progress, test_status FROM functions
    WHERE app_id=$1 AND enabled AND closed_at IS NULL AND test_status = $2 AND progress <> $3 ORDER BY sort, id`, [appId, PASS, value])).rows;
  if (!rows.length) return;
  const items = rows.map(x => ({ function_id: x.id, app_id: appId, code: x.code, name_ar: x.name_ar, name_en: x.name_en, item_type: x.item_type,
    progress: Number(value), current_progress: Number(x.progress), test_status: x.test_status, error: 'progress_below_100_while_passed' }));
  throw bad('progress_below_100_while_passed', { bulk: true, count: items.length, items: items.slice(0, 200), list: itemList(items.map(x => ({ code: x.code }))) });
}

// Reason of an exclusion as carried by a pending request item (edit_request_items.meta), applied on approval.
export const reasonMeta = d => ({ disabled_reason: d.reason, disabled_note: d.note, duplicate_of: refs(d.duplicates || []) });

// Exclude (or include) the chosen functions of an application in one go: { field: 'enabled', value, function_ids,
// and for an exclusion disabled_reason / disabled_note / duplicate_of } — the same reason for every function.
// One audit row per function, so each one's history shows its reason.
export async function bulkEnabled(req, res, a) {
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
export async function bulkItemType(req, res, a) {
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

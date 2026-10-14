// Edits made in the screens that must wait for the department team lead (see migration 004).
import { hasPerm, canSeeDept } from '../middleware/auth.js';
import { getSetting } from './settings.js';
import { logAudit } from './logs.js';
import { createFunction, removeFunction, restoreFunction } from './functions.js';

const FN_COLS = new Set(['progress', 'weight', 'enabled', 'test_status', 'notif_status', 'review_status', 'note', 'name_en']);
const REP_COLS = new Set(['progress', 'status', 'note']);
const same = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : a === b);

// Approver of a department's edits: team lead permission + scope covering the department.
export const isDeptApprover = (user, deptId, apps) => hasPerm(user, 'apv_dept') && canSeeDept(user, deptId, apps);

// Does this user's edit in this department have to wait for the team lead?
export async function needsLeadApproval(user, deptId, apps) {
  if (!(await getSetting('approval.edits_need_lead'))) return false;
  if (hasPerm(user, 'cfg') || hasPerm(user, 'apv_final')) return false;   // administrators, project / technical managers
  return !isDeptApprover(user, deptId, apps);                              // team leads of the department
}

// Stores a request. items: [{kind, app_id, function_id?, field, old_value, new_value}]
export async function createRequest(c, req, { deptId, appId, kind, summary, items }) {
  // The same user editing the same value again replaces the earlier pending value.
  for (const it of items) {
    if (it.field === 'create' || it.field === 'removed') continue;      // each addition / removal is its own request
    await c.query(`DELETE FROM edit_request_items i USING edit_requests r
      WHERE i.request_id=r.id AND r.status='pending' AND r.requested_by=$1 AND i.kind=$2 AND i.app_id=$3
        AND i.field=$4 AND i.function_id IS NOT DISTINCT FROM $5`,
    [req.user.id, it.kind, it.app_id, it.field, it.function_id ?? null]);
  }
  await c.query(`UPDATE edit_requests r SET status='superseded', decided_at=now()
    WHERE r.status='pending' AND r.requested_by=$1 AND NOT EXISTS (SELECT 1 FROM edit_request_items i WHERE i.request_id=r.id)`, [req.user.id]);
  const r = (await c.query(`INSERT INTO edit_requests(department_id, app_id, kind, summary, requested_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`, [deptId, appId, kind, summary, req.user.id])).rows[0];
  for (const it of items) {
    await c.query(`INSERT INTO edit_request_items(request_id, kind, app_id, function_id, field, old_value, new_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [r.id, it.kind, it.app_id, it.function_id ?? null, it.field, JSON.stringify(it.old_value), JSON.stringify(it.new_value)]);
  }
  await logAudit(req, { db: c, action: 'edit_request', entity: 'edit_request', entityId: r.id,
    summary: `${appId}: ${summary}`, newValue: { items: items.length } });
  return r;
}

// Applies an approved request; a value changed by someone else since the request is skipped.
export async function applyRequest(c, requestId, userId) {
  const items = (await c.query('SELECT * FROM edit_request_items WHERE request_id=$1 ORDER BY id', [requestId])).rows;
  let applied = 0, skipped = 0;
  for (const it of items) {
    if (it.field === 'create' || it.field === 'removed') {
      const r = await applyLifecycle(c, it, userId);
      r.ok ? applied++ : skipped++;
      await c.query('UPDATE edit_request_items SET applied=$2, note=$3, function_id=COALESCE(function_id, $4) WHERE id=$1',
        [it.id, r.ok, r.ok ? null : r.note, r.functionId ?? null]);
      continue;
    }
    const cols = it.kind === 'function' ? FN_COLS : REP_COLS;
    if (!cols.has(it.field)) { skipped++; continue; }                     // never interpolate an unknown column
    const cur = it.kind === 'function'
      ? (await c.query(`SELECT ${it.field} AS v FROM functions WHERE id=$1 AND removed_at IS NULL FOR UPDATE`, [it.function_id])).rows[0]
      : (await c.query(`SELECT ${it.field} AS v FROM app_reports WHERE app_id=$1 FOR UPDATE`, [it.app_id])).rows[0];
    const ok = !!cur && same(cur.v, it.old_value);
    if (ok) {
      if (it.kind === 'function') await c.query(`UPDATE functions SET ${it.field}=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [it.function_id, it.new_value, userId]);
      else await c.query(`UPDATE app_reports SET ${it.field}=$2, updated_at=now(), updated_by=$3 WHERE app_id=$1`, [it.app_id, it.new_value, userId]);
      applied++;
    } else skipped++;
    await c.query('UPDATE edit_request_items SET applied=$2, note=$3 WHERE id=$1', [it.id, ok, ok ? null : 'value changed after the request']);
  }
  return { applied, skipped };
}

// Approved addition / removal / restore. new_value of 'removed': { removed: true, reason } or { removed: false }.
async function applyLifecycle(c, it, userId) {
  if (it.field === 'create') {
    const f = await createFunction(c, it.app_id, it.new_value, userId);
    await logAudit({ user: { id: userId } }, { db: c, action: 'create', entity: 'function', entityId: f.id, summary: `${f.app_id}/${f.code} (approved request)`, newValue: it.new_value });
    return { ok: true, functionId: f.id };
  }
  const f = it.new_value?.removed ? await removeFunction(c, it.function_id, it.new_value.reason, userId) : await restoreFunction(c, it.function_id, userId);
  if (!f) return { ok: false, note: 'already ' + (it.new_value?.removed ? 'removed' : 'restored') };
  await logAudit({ user: { id: userId } }, { db: c, action: it.new_value?.removed ? 'remove' : 'restore', entity: 'function', entityId: f.id,
    summary: `${f.app_id}/${f.code} (approved request)`, newValue: it.new_value });
  return { ok: true };
}

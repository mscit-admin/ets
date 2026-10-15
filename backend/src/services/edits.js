// Edits made in the screens that must wait for the department team lead (see migration 004).
import { hasPerm, canSeeApp, loadUserContext } from '../middleware/auth.js';
import { getSetting } from './settings.js';
import { logAudit } from './logs.js';
import { namedItems, logAppliedChanges, loadUser, userRef } from './audit.js';
import { createFunction, removeFunction, restoreFunction } from './functions.js';

const FN_COLS = new Set(['progress', 'weight', 'enabled', 'test_status', 'notif_status', 'review_status', 'note', 'name_en']);
const REP_COLS = new Set(['progress', 'status', 'note']);
const same = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : a === b);

// Approver of an application's edits: team lead permission + scope covering that application (a lead scoped to
// one application of a department is not an approver for the department's other applications — ETS-SEC-007).
// app: { id, department_id }
export const isAppApprover = (user, app) => !!app && hasPerm(user, 'apv_dept') && canSeeApp(user, app);

// Does this user's edit of this application have to wait for the team lead?
export async function needsLeadApproval(user, app) {
  if (!(await getSetting('approval.edits_need_lead'))) return false;
  if (hasPerm(user, 'cfg') || hasPerm(user, 'apv_final')) return false;   // administrators, project / technical managers
  return !isAppApprover(user, app);                                        // team leads of the application's department
}

// Permission an edit-request item needs (same rules as the direct edit in routes/tracker.js).
const ITEM_PERM = {
  function: { progress: 'pct', notif_status: 'pct', weight: 'wgt', enabled: 'tog', name_en: 'tog', create: 'tog', removed: 'tog',
    test_status: 'tst', review_status: 'tst', note: 'tst' },
  report: { progress: 'rep', status: 'rep', note: 'rep' },
};

const NOTED = { test_status: 1, notif_status: 2, review_status: 3 };   // statuses "… with notes" (routes/tracker.js)

// Re-checks, when a request is approved, that its author may still make every change in it: account active,
// application in scope, field permissions held (ETS-SEC-027). Returns null when allowed, else the reason.
export async function requesterBlocked(c, rq) {
  const u = await loadUserContext(rq.requested_by);
  if (!u || !u.is_active) return 'requester_inactive';
  const app = (await c.query('SELECT id, department_id FROM applications WHERE id=$1', [rq.app_id])).rows[0];
  if (!app || !canSeeApp(u, app)) return 'requester_out_of_scope';
  const items = (await c.query('SELECT kind, function_id, field, new_value FROM edit_request_items WHERE request_id=$1', [rq.id])).rows;
  // the note that goes with a "with notes" status the author may set (see routes/tracker.js)
  const notedStatus = it => items.some(x => x.kind === 'function' && x.function_id === it.function_id && NOTED[x.field] !== undefined &&
    Number(x.new_value) === NOTED[x.field] && hasPerm(u, ITEM_PERM.function[x.field]));
  const allowed = it => hasPerm(u, ITEM_PERM[it.kind]?.[it.field]) || (it.kind === 'function' && it.field === 'note' && notedStatus(it));
  if (!items.every(allowed)) return 'requester_lacks_permission';
  return null;
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
    summary: `${appId}: ${summary}`, newValue: { items: items.length },
    context: { app_id: appId, department_id: deptId, kind, items: await namedItems(c, items) } });
  return r;
}

// Context of an audit row about a request: who asked, who decided, and the items with their before → after values.
export async function requestContext(c, rq, req, extra = {}) {
  const items = (await c.query('SELECT * FROM edit_request_items WHERE request_id=$1 ORDER BY id', [rq.id])).rows;
  return { via: 'edit_request', request_id: rq.id, app_id: rq.app_id, department_id: rq.department_id,
    requested_by: userRef(await loadUser(c, rq.requested_by)), decided_by: userRef(req.user), ...extra, items: await namedItems(c, items) };
}

// Applies an approved request (rq: the edit_requests row; req: the approver's request); a value changed by
// someone else since the request is skipped. Each applied change is audited in the name of the employee who
// made it, with the approving team lead in its context.
export async function applyRequest(c, rq, req) {
  const userId = rq.requested_by;
  const actor = userRef(await loadUser(c, userId));
  const via = { via: 'edit_request', request_id: rq.id, requested_by: actor, approved_by: userRef(req.user) };
  const items = (await c.query('SELECT * FROM edit_request_items WHERE request_id=$1 ORDER BY id', [rq.id])).rows;
  const done = [];
  let applied = 0, skipped = 0;
  for (const it of items) {
    if (it.field === 'create' || it.field === 'removed') {
      const r = await applyLifecycle(c, it, userId, req, actor, via);
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
      done.push(it);
    } else skipped++;
    await c.query('UPDATE edit_request_items SET applied=$2, note=$3 WHERE id=$1', [it.id, ok, ok ? null : 'value changed after the request']);
  }
  await logAppliedChanges(req, c, done, { actor, context: via });
  return { applied, skipped };
}

// Approved addition / removal / restore. new_value of 'removed': { removed: true, reason } or { removed: false }.
async function applyLifecycle(c, it, userId, req, actor, via) {
  if (it.field === 'create') {
    const f = await createFunction(c, it.app_id, it.new_value, userId);
    await logAudit(req, { db: c, actor, context: via, action: 'create', entity: 'function', entityId: f.id, summary: `${f.app_id}/${f.code} (approved request)`, newValue: it.new_value });
    return { ok: true, functionId: f.id };
  }
  const f = it.new_value?.removed ? await removeFunction(c, it.function_id, it.new_value.reason, userId) : await restoreFunction(c, it.function_id, userId);
  if (!f) return { ok: false, note: 'already ' + (it.new_value?.removed ? 'removed' : 'restored') };
  await logAudit(req, { db: c, actor, context: via, action: it.new_value?.removed ? 'remove' : 'restore', entity: 'function', entityId: f.id,
    summary: `${f.app_id}/${f.code} (approved request)`, newValue: it.new_value });
  return { ok: true };
}

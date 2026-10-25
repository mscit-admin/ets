// Edits made in the screens that must wait for the department team lead (see migration 004).
import { hasPerm, canSeeApp, coversDept, loadUserContext } from '../middleware/auth.js';
import { getSetting } from './settings.js';
import { logAudit } from './logs.js';
import { namedItems, logAppliedChanges, loadUser, userRef, originIp } from './audit.js';
import { createFunction, removeFunction, restoreFunction } from './functions.js';
import { setDisabled, clearDisabled, currentReasons, hadReason } from './disable.js';
import { passConflict } from './passRule.js';
import { HttpError } from '../utils/http.js';
import { onCommit } from '../db/pool.js';
import { requestCreated, functionsExcluded } from './notify-events.js';

const FN_COLS = new Set(['progress', 'weight', 'enabled', 'test_status', 'notif_status', 'review_status', 'note', 'name_ar', 'name_en', 'item_type']);
const NAME_COLS = new Set(['name_ar', 'name_en']);       // a rename (1.9.1): carries its reason in meta.rename_reason
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
  function: { progress: 'pct', notif_status: 'pct', weight: 'wgt', enabled: 'tog', name_ar: 'ren', name_en: 'ren', create: 'tog', removed: 'tog',
    test_status: 'tst', review_status: 'tst', note: 'tst', item_type: 'tog', move: 'mov' },
  report: { progress: 'rep', status: 'rep', note: 'rep' },
  application: { move: 'mov' },      // a whole-application move (1.12.16): its single item carries the 'mov' permission
};

const NOTED = { test_status: 1, notif_status: 2, review_status: 3 };   // statuses "… with notes" (routes/tracker.js)

// Re-checks, when a request is approved, that its author may still make every change in it: account active,
// application in scope, field permissions held (ETS-SEC-027). Returns null when allowed, else the reason.
export async function requesterBlocked(c, rq) {
  const u = await loadUserContext(rq.requested_by);
  if (!u || !u.is_active) return 'requester_inactive';
  const app = (await c.query('SELECT id, department_id FROM applications WHERE id=$1', [rq.app_id])).rows[0];
  if (!app || !canSeeApp(u, app)) return 'requester_out_of_scope';
  // a move (1.10.0): the destination application must be in the author's scope too
  if (rq.target_app_id) {
    const dst = (await c.query('SELECT id, department_id FROM applications WHERE id=$1', [rq.target_app_id])).rows[0];
    if (!dst || !canSeeApp(u, dst)) return 'requester_out_of_scope';
  }
  // an application move (1.12.16): the author must still hold 'mov' and cover the WHOLE destination department
  if (rq.kind === 'move_application') {
    if (!hasPerm(u, 'mov')) return 'requester_lacks_permission';
    if (!rq.target_department_id || !coversDept(u, rq.target_department_id)) return 'requester_out_of_scope';
  }
  const items = (await c.query('SELECT kind, function_id, field, new_value, meta FROM edit_request_items WHERE request_id=$1', [rq.id])).rows;
  // the note that goes with a "with notes" status the author may set, and only while the function still has no
  // note — checked again now, as a note may have been written since the request (see routes/tracker.js, ETS-SEC-056)
  const fids = [...new Set(items.filter(it => it.kind === 'function' && it.field === 'note' && it.function_id).map(it => it.function_id))];
  const noted = new Set(fids.length ? (await c.query('SELECT id, note FROM functions WHERE id = ANY($1)', [fids])).rows
    .filter(x => String(x.note || '').trim()).map(x => x.id) : []);
  const notedStatus = it => !noted.has(it.function_id) && items.some(x => x.kind === 'function' && x.function_id === it.function_id &&
    NOTED[x.field] !== undefined && Number(x.new_value) === NOTED[x.field] && hasPerm(u, ITEM_PERM.function[x.field]));
  const allowed = it => hasPerm(u, ITEM_PERM[it.kind]?.[it.field]) || (it.kind === 'function' && it.field === 'note' && notedStatus(it));
  if (!items.every(allowed)) return 'requester_lacks_permission';
  // the functions an exclusion names as duplicated must still be in the author's scope
  const dupIds = [...new Set(items.flatMap(it => (it.meta?.duplicate_of || []).map(d => d.id)))];
  if (dupIds.length) {
    const apps = (await c.query('SELECT a.id, a.department_id FROM functions f JOIN applications a ON a.id=f.app_id WHERE f.id = ANY($1)', [dupIds])).rows;
    if (apps.some(a => !canSeeApp(u, a))) return 'requester_out_of_scope';
  }
  return null;
}

// Stores a request. items: [{kind, app_id, function_id?, field, old_value, new_value, meta?}] — meta: the reason of an
// exclusion ({disabled_reason, disabled_note, duplicate_of: [{id, app_id, code}]}), applied with it on approval, or
// of a rename ({rename_reason}, 1.9.1), written into the audit row on approval.
// target: the destination { appId, deptId } of a move (1.10.0); meta: the request's own data (a move's reason and impact).
export async function createRequest(c, req, { deptId, appId, kind, summary, items, target = null, meta = null }) {
  // The same user editing the same value again replaces the earlier pending value.
  for (const it of items) {
    if (it.field === 'create' || it.field === 'removed' || it.field === 'move') continue;      // each addition / removal / move is its own request
    await c.query(`DELETE FROM edit_request_items i USING edit_requests r
      WHERE i.request_id=r.id AND r.status='pending' AND r.requested_by=$1 AND i.kind=$2 AND i.app_id=$3
        AND i.field=$4 AND i.function_id IS NOT DISTINCT FROM $5`,
    [req.user.id, it.kind, it.app_id, it.field, it.function_id ?? null]);
  }
  await c.query(`UPDATE edit_requests r SET status='superseded', decided_at=now()
    WHERE r.status='pending' AND r.requested_by=$1 AND NOT EXISTS (SELECT 1 FROM edit_request_items i WHERE i.request_id=r.id)`, [req.user.id]);
  const r = (await c.query(`INSERT INTO edit_requests(department_id, app_id, kind, summary, requested_by, target_app_id, target_department_id, meta)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [deptId, appId, kind, summary, req.user.id, target?.appId ?? null, target?.deptId ?? null, meta ? JSON.stringify(meta) : null])).rows[0];
  for (const it of items) {
    await c.query(`INSERT INTO edit_request_items(request_id, kind, app_id, function_id, field, old_value, new_value, meta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [r.id, it.kind, it.app_id, it.function_id ?? null, it.field, JSON.stringify(it.old_value), JSON.stringify(it.new_value),
      it.meta ? JSON.stringify(it.meta) : null]);
  }
  await logAudit(req, { db: c, action: 'edit_request', entity: 'edit_request', entityId: r.id,
    summary: `${appId}: ${summary}`, newValue: { items: items.length },
    context: { app_id: appId, department_id: deptId, kind, ...(target ? { to_app_id: target.appId, to_department_id: target.deptId } : {}),
      ...(meta?.reason ? { reason: meta.reason } : {}), items: await namedItems(c, items) } });
  onCommit(c, () => requestCreated(r));          // A1: the application's approvers (after COMMIT); a move: of both applications
  return r;
}

// Where a rejected (returned) request goes (1.12.28): back to its author, UNLESS the author is currently on leave
// (on_leave true and, when a window is set, today within [leave_from, leave_to]) and has a substitute — then to the
// substitute. If the author is on leave with no substitute (or the substitute is inactive / deleted), it falls back
// to the author. → { to, substitute: bool, requester }.
export async function computeReturnTo(c, rq) {
  const requester = rq.requested_by;
  const u = (await c.query(`SELECT substitute_user_id,
      (on_leave AND (leave_from IS NULL OR leave_from <= current_date) AND (leave_to IS NULL OR leave_to >= current_date)) AS on_leave_now
    FROM users WHERE id=$1`, [requester])).rows[0];
  if (!u || !u.on_leave_now || !u.substitute_user_id) return { to: requester, substitute: false, requester };
  // the substitute must be a usable account (active, not deleted); otherwise fall back to the author
  const sub = (await c.query(`SELECT id FROM users WHERE id=$1 AND is_active AND deleted_at IS NULL`, [u.substitute_user_id])).rows[0];
  return sub ? { to: sub.id, substitute: true, requester } : { to: requester, substitute: false, requester };
}

// Context of an audit row about a request: who asked, who decided, and the items with their before → after values.
export async function requestContext(c, rq, req, extra = {}) {
  const items = (await c.query('SELECT * FROM edit_request_items WHERE request_id=$1 ORDER BY id', [rq.id])).rows;
  return { via: 'edit_request', request_id: rq.id, app_id: rq.app_id, department_id: rq.department_id,
    ...(rq.target_app_id || rq.kind === 'move_application'
      ? { kind: rq.kind, ...(rq.target_app_id ? { to_app_id: rq.target_app_id } : {}), to_department_id: rq.target_department_id, move_reason: rq.meta?.reason ?? null }
      : {}),
    requested_by: userRef(await loadUser(c, rq.requested_by)), decided_by: userRef(req.user), ...extra, items: await namedItems(c, items) };
}

// Applies an approved request (rq: the edit_requests row; req: the approver's request); a value changed by
// someone else since the request is skipped. Each applied change is audited in the name of the employee who
// made it, with the approving team lead in its context.
export async function applyRequest(c, rq, req) {
  const userId = rq.requested_by;
  const actor = userRef(await loadUser(c, userId));
  // rows in the requester's name carry the requester's IP; the approver's IP stays in the context (ETS-SEC-052)
  const actorIp = await originIp(c, 'edit_request', 'edit_request', rq.id);
  const via = { via: 'edit_request', request_id: rq.id, requested_by: actor, approved_by: userRef(req.user), approver_ip: req.ip || null };
  const items = (await c.query('SELECT * FROM edit_request_items WHERE request_id=$1 ORDER BY id', [rq.id])).rows;
  const done = [];
  let applied = 0, skipped = 0, removed = 0;
  for (const it of items) {
    if (it.field === 'create' || it.field === 'removed') {
      const r = await applyLifecycle(c, it, userId, req, actor, actorIp, via);
      r.ok ? applied++ : skipped++;
      if (r.ok && it.field === 'removed' && it.new_value?.removed) removed++;
      await c.query('UPDATE edit_request_items SET applied=$2, note=$3, function_id=COALESCE(function_id, $4) WHERE id=$1',
        [it.id, r.ok, r.ok ? null : r.note, r.functionId ?? null]);
      continue;
    }
    const cols = it.kind === 'function' ? FN_COLS : REP_COLS;
    if (!cols.has(it.field)) { skipped++; continue; }                     // never interpolate an unknown column
    const cur = it.kind === 'function'
      ? (await c.query(`SELECT ${it.field} AS v FROM functions WHERE id=$1 AND removed_at IS NULL FOR UPDATE`, [it.function_id])).rows[0]
      : (await c.query(`SELECT ${it.field} AS v FROM app_reports WHERE app_id=$1 FOR UPDATE`, [it.app_id])).rows[0];
    let ok = !!cur && same(cur.v, it.old_value);
    let why = ok ? null : 'value changed after the request';
    const rename = it.kind === 'function' && NAME_COLS.has(it.field);
    // a name renamed by someone else since the request: refused (409), the request stays pending (rolled back)
    if (rename && cur && !ok) {
      throw new HttpError(409, 'name_changed', { function_id: it.function_id, field: it.field, expected: it.old_value, current: cur.v });
    }
    const toggle = it.kind === 'function' && it.field === 'enabled';
    // an exclusion carries its reason; the functions it names as duplicated must still be there
    const reason = toggle && it.new_value === false ? await requestReason(c, it) : null;
    if (ok && reason?.invalid) { ok = false; why = reason.invalid; }
    if (ok) {
      const before = toggle && it.new_value === true ? (await currentReasons(c, [it.function_id])).get(it.function_id) : null;
      if (it.kind === 'function') await c.query(`UPDATE functions SET ${it.field}=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [it.function_id, it.new_value, userId]);
      else await c.query(`UPDATE app_reports SET ${it.field}=$2, updated_at=now(), updated_by=$3 WHERE app_id=$1`, [it.app_id, it.new_value, userId]);
      applied++;
      done.push(it);
      if (rename && it.meta?.rename_reason && !done.some(x => x.function_id === it.function_id && x.field === 'rename_reason')) {
        done.push({ kind: 'function', app_id: it.app_id, function_id: it.function_id, field: 'rename_reason', old_value: null, new_value: it.meta.rename_reason });
      }
      if (reason) {
        await setDisabled(c, [it.function_id], reason, userId);
        done.push(...reasonItems(it, null, reason));
      } else if (before) {
        await clearDisabled(c, [it.function_id]);
        if (hadReason(before)) done.push(...reasonItems(it, before, null));
      }
    } else skipped++;
    await c.query('UPDATE edit_request_items SET applied=$2, note=$3 WHERE id=$1', [it.id, ok, why]);
  }
  await recheckPass(c, done);
  await logAppliedChanges(req, c, done, { actor, actorIp, context: via });
  // T7: functions excluded / removed by this request — told to the application's users (not its author or approver)
  const excluded = removed + done.filter(it => it.kind === 'function' && it.field === 'enabled' && it.new_value === false).length;
  if (excluded) onCommit(c, () => functionsExcluded(rq.app_id, excluded, [rq.requested_by, req.user.id]));
  return { applied, skipped };
}

// «نجح» needs 100 % (1.8.1), checked again on approval against the values as they are now: a request that would
// leave an item «نجح» below 100 % (e.g. its progress was lowered, or the status set to «نجح», since the request) is
// refused with 409 and the code of the rule; the transaction is rolled back, the request stays pending.
async function recheckPass(c, done) {
  const touched = new Map();      // function id → did the request set its test status?
  for (const it of done) {
    if (it.kind !== 'function' || !['test_status', 'progress'].includes(it.field)) continue;
    touched.set(it.function_id, touched.get(it.function_id) || it.field === 'test_status');
  }
  if (!touched.size) return;
  const rows = (await c.query('SELECT id, code, progress, test_status FROM functions WHERE id = ANY($1)', [[...touched.keys()]])).rows;
  const bad = rows.find(passConflict);
  if (bad) {
    throw new HttpError(409, touched.get(bad.id) ? 'pass_requires_100' : 'progress_below_100_while_passed',
      { function_id: bad.id, code: bad.code, progress: Number(bad.progress), test_status: bad.test_status });
  }
}

// Reason of an approved exclusion (item meta); invalid when a function it names as duplicated is gone or removed
// since the request. A request made before 1.5.0 has no meta: the exclusion is applied without a reason.
async function requestReason(c, it) {
  const m = it.meta || {};
  const ids = (m.duplicate_of || []).map(d => d.id).filter(Number.isInteger);
  const d = { reason: m.disabled_reason ?? null, note: m.disabled_note ?? null, duplicate_of: ids };
  if (d.reason === 'duplicate') {
    const ok = new Set((await c.query('SELECT id FROM functions WHERE id = ANY($1) AND removed_at IS NULL AND id <> $2', [ids, it.function_id])).rows.map(x => x.id));
    if (!ids.length || ids.some(id => !ok.has(id))) return { invalid: 'duplicated function no longer available' };
  }
  return d;
}

// Extra before → after values of an applied exclusion / inclusion for its audit row (see logAppliedChanges).
function reasonItems(it, before, after) {
  const meta = it.meta || {};
  const v = (src, k) => (src ? src[k] ?? null : null);
  const nv = after ? { disabled_reason: after.reason, disabled_note: after.note, duplicate_of: meta.duplicate_of || [] } : null;
  return ['disabled_reason', 'disabled_note', 'duplicate_of'].map(field => ({ kind: 'function', app_id: it.app_id, function_id: it.function_id,
    field, old_value: v(before, field) ?? (field === 'duplicate_of' ? [] : null), new_value: v(nv, field) ?? (field === 'duplicate_of' ? [] : null) }));
}

// Approved addition / removal / restore. new_value of 'removed': { removed: true, reason } or { removed: false }.
async function applyLifecycle(c, it, userId, req, actor, actorIp, via) {
  if (it.field === 'create') {
    const f = await createFunction(c, it.app_id, it.new_value, userId);
    await logAudit(req, { db: c, actor, actorIp, context: via, action: 'create', entity: 'function', entityId: f.id, summary: `${f.app_id}/${f.code} (approved request)`, newValue: it.new_value });
    return { ok: true, functionId: f.id };
  }
  const f = it.new_value?.removed ? await removeFunction(c, it.function_id, it.new_value.reason, userId) : await restoreFunction(c, it.function_id, userId);
  if (!f) return { ok: false, note: 'already ' + (it.new_value?.removed ? 'removed' : 'restored') };
  await logAudit(req, { db: c, actor, actorIp, context: via, action: it.new_value?.removed ? 'remove' : 'restore', entity: 'function', entityId: f.id,
    summary: `${f.app_id}/${f.code} (approved request)`, newValue: it.new_value });
  return { ok: true };
}

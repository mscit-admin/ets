// Moving an ENTIRE application (with all its functions / report items) from one department ("module", الإدارة) to
// another (1.12.16, migration 022). It mirrors the item move (services/move.js) but one level up — at the department.
//
//   - the application keeps its id, its weight, its functions (ids, codes, values, statuses, provenance) and
//     everything else; only its department_id changes. Its functions travel with it automatically (they belong to
//     the application through application_id, which is untouched);
//   - where it came from is kept in application_moves (the badge «منقول من …», the logs, the audit);
//   - WEIGHT (fixed mode): a department's weight is DERIVED — the sum of its applications' weights (services/calc.js),
//     there is no stored department weight and no department weight cap. So the application's weight follows it with
//     NO mutation: the source department total loses exactly the application's weight and the destination gains it,
//     and the total system weight (the sum of every application's weight, independent of how they are grouped into
//     departments) is unchanged by construction. Nothing can overflow or need clamping. Auto mode: a department's
//     weight is the sum of its applications' counted item weights, which likewise follow the application — nothing to
//     transfer either way; the move is purely a change of department_id;
//   - one strict audit row for the application move ('move' on the application), plus — in fixed mode — the two
//     departments' derived weight changes recorded for the Weights history ('update' on each department).
// Who may move: permission 'mov' and both departments in scope (routes/tracker.js). Directly when the user is a lead
// (apv_dept) of BOTH departments, holds 'cfg' or 'apv_final', or approvals are off; otherwise a 'move_application'
// request approved by the source department's team lead, then the destination's (routes/approvals.js).
import { getSetting } from './settings.js';
import { hasPerm, coversDept } from '../middleware/auth.js';
import { requestContext } from './edits.js';
import { checkMovable } from './move.js';
import { loadUser, userRef, originIp } from './audit.js';
import { logAudit } from './logs.js';
import { NOTE_MIN, NOTE_MAX } from './disable.js';
import { HttpError } from '../utils/http.js';

export const APP_MOVE_REASON_MIN = NOTE_MIN, APP_MOVE_REASON_MAX = NOTE_MAX;   // same rule as an item move's reason

// Lead (first-stage / second-stage approver) of a department: the team-lead permission and the WHOLE department in
// scope (not merely one of its applications) — the move concerns every application of the department (ETS-SEC-007).
export const isDeptApprover = (user, deptId) => !!deptId && hasPerm(user, 'apv_dept') && coversDept(user, deptId);

// Does this user's move of an application from srcDept to dstDept wait for the two team leads?
export async function moveAppNeedsApproval(user, srcDeptId, dstDeptId) {
  if (!(await getSetting('approval.edits_need_lead'))) return false;
  if (hasPerm(user, 'cfg') || hasPerm(user, 'apv_final')) return false;      // administrators, project / technical managers
  return !(isDeptApprover(user, srcDeptId) && isDeptApprover(user, dstDeptId));
}

const weightMode = async c => (await c.query(`SELECT value FROM settings WHERE key='calc.weight_mode'`)).rows[0]?.value === 'auto' ? 'auto' : 'fixed';
const userName = async (c, id) => (id ? (await c.query('SELECT full_name, username FROM users WHERE id=$1', [id])).rows[0] : null);
const cents = v => Math.round((+v || 0) * 100);

/**
 * The application cannot be moved now (409): a pending edit / move / import request on the application itself (as a
 * source or a destination), or on any of its items. exceptRequest: the move_application request being approved does
 * not block itself. Removed items travel with the application and never block it.
 */
export async function checkAppMovable(c, appId, { exceptRequest = null } = {}) {
  const reqs = (await c.query(`SELECT id, kind FROM edit_requests WHERE status='pending'
    AND (app_id=$1 OR target_app_id=$1) AND id IS DISTINCT FROM $2::int ORDER BY id`, [appId, exceptRequest])).rows;
  if (reqs.length) throw new HttpError(409, 'move_app_pending_request', { requests: reqs.map(x => ({ request_id: x.id, kind: x.kind })) });
  const fns = (await c.query(`SELECT id, code, removed_at FROM functions WHERE app_id=$1`, [appId])).rows.filter(f => !f.removed_at);
  await checkMovable(c, fns, { exceptRequest });     // pending item request / import on any of the application's items
}

const deptTotal = async (c, deptId) => +(await c.query('SELECT COALESCE(sum(weight), 0) AS w FROM applications WHERE department_id=$1', [deptId])).rows[0].w;
const nm = (x, p) => ({ [p + '_name_ar']: x.name_ar, [p + '_name_en']: x.name_en });

/**
 * Moves the application appId to department dstDeptId inside the caller's transaction c. The two departments are
 * locked FOR UPDATE in id order (no deadlock between two moves in opposite directions), then the application; every
 * check is made again on the locked rows. actor / actorIp / context: an approved request — the move is recorded in
 * the requester's name (services/edits.js style). Returns { app, src, dst, weight, by } for the caller to publish the
 * live change and the notification after COMMIT.
 */
export async function moveApplication(c, req, { appId, dstDeptId, reason, userId = req.user.id, actor = null, actorIp = null, context = null, requestId = null }) {
  // the application's current department (unlocked read) decides which two department rows to lock
  const pre = (await c.query('SELECT department_id FROM applications WHERE id=$1', [appId])).rows[0];
  if (!pre) throw new HttpError(409, 'move_source_changed', { application: appId });
  const srcDeptId = pre.department_id;
  if (srcDeptId === dstDeptId) throw new HttpError(409, 'move_same_dept', { department: dstDeptId });
  // lock BOTH departments in id order (one query, so two opposite-direction moves take them in the same order and
  // never deadlock), then the application
  const depts = (await c.query('SELECT id, name_ar, name_en FROM departments WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[srcDeptId, dstDeptId]])).rows;
  const src = depts.find(d => d.id === srcDeptId), dst = depts.find(d => d.id === dstDeptId);
  if (!dst) throw new HttpError(409, 'move_target_missing', { department: dstDeptId });
  if (!src) throw new HttpError(409, 'move_source_changed', { department: srcDeptId });
  const app = (await c.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [appId])).rows[0];
  if (!app || app.department_id !== srcDeptId) throw new HttpError(409, 'move_source_changed', { application: appId });
  // a name already used by another application of the destination department (there is no DB uniqueness; refuse so the
  // destination never ends up with two applications of the same name)
  const clash = (await c.query(`SELECT id, name_ar, name_en FROM applications WHERE department_id=$1 AND id<>$2
    AND (name_ar=$3 OR name_en=$4) LIMIT 1`, [dstDeptId, appId, app.name_ar, app.name_en])).rows[0];
  if (clash) throw new HttpError(409, 'move_app_name_conflict', { application: clash.id });
  await checkAppMovable(c, appId, { exceptRequest: requestId });

  const mode = await weightMode(c);
  // department weights are derived; in fixed mode record the two totals' before → after for the Weights history
  const srcBefore = await deptTotal(c, srcDeptId), dstBefore = await deptTotal(c, dstDeptId);
  const appW = +app.weight;
  const weight = { mode, app_weight: appW,
    src: { before: srcBefore, after: (cents(srcBefore) - cents(appW)) / 100 },
    dst: { before: dstBefore, after: (cents(dstBefore) + cents(appW)) / 100 } };

  await c.query('UPDATE applications SET department_id=$2, updated_at=now(), updated_by=$3 WHERE id=$1', [appId, dstDeptId, userId]);
  await c.query(`INSERT INTO application_moves(app_id, from_department_id, to_department_id, weight_mode, weight, reason, moved_by, request_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [appId, srcDeptId, dstDeptId, mode, appW, reason, userId, requestId]);

  const ctxBase = { ...(context || {}), app_id: appId, ...nm(app, 'app'), from_dept_id: srcDeptId, to_dept_id: dstDeptId,
    ...nm(src, 'from_dept'), ...nm(dst, 'to_dept'), weight_mode: mode, app_weight: appW, ...(requestId ? { request_id: requestId } : {}) };
  await logAudit(req, { db: c, actor, actorIp, action: 'move', entity: 'application', entityId: appId,
    summary: `${appId} ${app.name_ar.slice(0, 80)}: ${srcDeptId} → ${dstDeptId}`,
    oldValue: { department_id: srcDeptId, weight: appW }, newValue: { department_id: dstDeptId, weight: appW, reason },
    context: { ...ctxBase, src_dept_weight: weight.src, dst_dept_weight: weight.dst } });

  if (mode === 'fixed' && appW > 0) {
    const why = `نقل التطبيق ${app.name_ar} من ${src.name_ar} إلى ${dst.name_ar}`;
    for (const [d, w] of [[src, weight.src], [dst, weight.dst]]) {
      await logAudit(req, { db: c, actor, actorIp, action: 'update', entity: 'department', entityId: d.id, summary: 'weight',
        oldValue: { weight: w.before }, newValue: { weight: w.after },
        context: { ...ctxBase, via: context?.via || 'move', move: true, reason: why, move_reason: reason,
          weight_share: appW, side: d.id === src.id ? 'source' : 'destination' } });
    }
  }
  return { app: { id: appId, name_ar: app.name_ar, name_en: app.name_en }, src: { id: srcDeptId }, dst: { id: dstDeptId },
    weight, by: await userName(c, userId) };
}

/**
 * The history of moves of these applications (application page: badge and details). A department name outside the
 * reader's scope is left out (as the item-move badge, services/move.js). appIds: application ids.
 */
export async function appMovesOf(c, user, appIds) {
  if (!appIds.length) return new Map();
  const rows = (await c.query(`SELECT m.id, m.app_id, m.from_department_id, m.to_department_id, m.weight_mode, m.weight, m.reason,
      m.moved_at, m.request_id, u.full_name AS moved_by_name,
      fd.name_ar AS from_dept_name_ar, fd.name_en AS from_dept_name_en, td.name_ar AS to_dept_name_ar, td.name_en AS to_dept_name_en
    FROM application_moves m LEFT JOIN users u ON u.id=m.moved_by
      JOIN departments fd ON fd.id=m.from_department_id JOIN departments td ON td.id=m.to_department_id
    WHERE m.app_id = ANY($1) ORDER BY m.moved_at, m.id`, [appIds])).rows;
  const out = new Map();
  for (const m of rows) {
    for (const [side, dep] of [['from', m.from_department_id], ['to', m.to_department_id]]) {
      if (!coversDept(user, dep)) { m[side + '_dept_name_ar'] = null; m[side + '_dept_name_en'] = null; }
    }
    (out.get(m.app_id) || out.set(m.app_id, []).get(m.app_id)).push(m);
  }
  return out;
}

/**
 * Approval of a 'move_application' request (routes/approvals.js; the caller checked that req.user may approve the
 * stage that is due and that the requester is still allowed — requesterBlocked). Two stages: the source department's
 * team lead, then the destination's; a lead of both completes the two at once. The application is checked again at
 * each stage; at the last one the move is applied in the requester's name. Returns { applied, stage, result?, out? }.
 */
export async function approveAppMove(c, rq, req, { reason = null } = {}) {
  await checkAppMovable(c, rq.app_id, { exceptRequest: rq.id });
  const stage = rq.source_approved_by ? 'target' : 'source';
  let sourceBy = rq.source_approved_by;
  if (stage === 'source') {
    sourceBy = req.user.id;
    await c.query('UPDATE edit_requests SET source_approved_by=$2, source_approved_at=now() WHERE id=$1', [rq.id, req.user.id]);
    if (!isDeptApprover(req.user, rq.target_department_id)) {
      await logAudit(req, { db: c, action: 'edit_approve_source', entity: 'edit_request', entityId: rq.id,
        summary: `${rq.app_id}: ${rq.department_id} → ${rq.target_department_id}: source approved`, newValue: { stage: 'source' },
        context: await requestContext(c, rq, req, { reason, stage: 'source' }) });
      return { applied: false, stage: 'source' };
    }
  }
  await c.query('UPDATE edit_requests SET target_approved_by=$2, target_approved_at=now() WHERE id=$1', [rq.id, req.user.id]);
  const actor = userRef(await loadUser(c, rq.requested_by));
  const actorIp = await originIp(c, 'edit_request', 'edit_request', rq.id);
  const via = { via: 'edit_request', request_id: rq.id, requested_by: actor, approved_by: userRef(req.user), approver_ip: req.ip || null,
    source_approved_by: userRef(await loadUser(c, sourceBy)), target_approved_by: userRef(req.user) };
  const out = await moveApplication(c, req, { appId: rq.app_id, dstDeptId: rq.target_department_id, reason: rq.meta?.reason || '—',
    userId: rq.requested_by, actor, actorIp, context: via, requestId: rq.id });
  await c.query('UPDATE edit_request_items SET applied=true, note=NULL WHERE request_id=$1', [rq.id]);
  const result = { applied: 1, skipped: 0, app_id: rq.app_id, weight: out.weight };
  await c.query(`UPDATE edit_requests SET status='applied', decided_by=$2, decided_at=now(), reason=$3, apply_result=$4 WHERE id=$1`,
    [rq.id, req.user.id, reason, JSON.stringify(result)]);
  const done = stage === 'source' ? 'both' : 'target';
  await logAudit(req, { db: c, action: 'edit_approve', entity: 'edit_request', entityId: rq.id,
    summary: `${rq.app_id}: ${rq.department_id} → ${rq.target_department_id} moved`, newValue: { applied: 1, skipped: 0 },
    context: await requestContext(c, rq, req, { reason, stage: done }) });
  return { applied: true, stage: done, result, out };
}

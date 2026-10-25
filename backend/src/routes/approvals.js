// Edit requests made in the screens by data-entry users, approved by the department team lead only.
import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, hasPerm, canSeeApp, coversDept } from '../middleware/auth.js';
import { isAppApprover, applyRequest, requestContext, requesterBlocked, computeReturnTo } from '../services/edits.js';
import { logAudit } from '../services/logs.js';
import { publishChange, publishApps } from '../services/live.js';
import { requestDecided, requestsSettled, itemsMovedIn, applicationMovedIn, requestReturned, requestCreated } from '../services/notify-events.js';
import { approveMove, currentShare } from '../services/move.js';
import { approveAppMove, isDeptApprover } from '../services/app-move.js';
import { PASS_RULE_CODES } from '../services/passRule.js';
import { HttpError, bad, notFound, str, idParam, isId, isDate } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

const allApps = async () => (await query('SELECT id, department_id FROM applications')).rows;

// A request concerns one application; approving and reading it need that application in scope (ETS-SEC-007).
// A move (1.10.0) concerns two: its source (app_id) and its destination (target_app_id).
const appOf = (rq, apps) => apps.find(a => a.id === rq.app_id);
const targetOf = (rq, apps) => (rq.target_app_id ? apps.find(a => a.id === rq.target_app_id) : null);
const isMove = rq => rq.kind === 'move_function';
const isMoveApp = rq => rq.kind === 'move_application';

function abilities(user, rq, apps) {
  const pending = rq.status === 'pending';
  const notMine = rq.requested_by !== user.id;
  if (isMoveApp(rq)) {
    // an application move (1.12.16): the source department's lead, then the destination's (one when the same person
    // leads both); never the requester. Either lead may reject while it is pending.
    const src = isDeptApprover(user, rq.department_id), dst = isDeptApprover(user, rq.target_department_id);
    const stage = rq.source_approved_by ? 'target' : 'source';
    const approve = pending && notMine && (stage === 'source' ? src : dst);
    return { approve, reject: pending && notMine && (src || dst), withdraw: pending && !notMine, stage: pending ? stage : null,
      approve_as: approve ? (stage === 'source' ? (dst ? 'both' : 'source') : 'target') : null };
  }
  if (isMove(rq)) {
    // two approvals: the source application's team lead, then the destination's (one when the same person is both);
    // never the requester. Either of them may reject while it is pending.
    const src = isAppApprover(user, appOf(rq, apps)), dst = isAppApprover(user, targetOf(rq, apps));
    const stage = rq.source_approved_by ? 'target' : 'source';
    const approve = pending && notMine && (stage === 'source' ? src : dst);
    return { approve, reject: pending && notMine && (src || dst), withdraw: pending && !notMine, stage: pending ? stage : null,
      approve_as: approve ? (stage === 'source' ? (dst ? 'both' : 'source') : 'target') : null };
  }
  const approver = isAppApprover(user, appOf(rq, apps)) && notMine;
  // a returned request (1.12.28): the lead sent it back to the requester, or to their substitute when on leave —
  // that user (returned_to) and the original author may resubmit it (→ pending again) or withdraw it.
  const returned = rq.status === 'returned';
  const mineReturned = returned && (rq.returned_to === user.id || rq.requested_by === user.id);
  return { approve: pending && approver, reject: pending && approver,
    withdraw: (pending && rq.requested_by === user.id) || mineReturned, resubmit: mineReturned };
}
// Who may see a request: its author, the application's approvers, and readers of approvals with that application in
// scope — for a move, with either of its applications in scope. A returned request is also seen by the user it was
// returned to (its substitute, who is neither the author nor an approver).
const visible = (user, rq, apps) => {
  if (rq.requested_by === user.id) return true;
  if (rq.status === 'returned' && rq.returned_to === user.id) return true;
  // an application move is seen by the leads of either department and by full-scope / final approvers covering one
  if (isMoveApp(rq)) {
    return [rq.department_id, rq.target_department_id].some(dep => !!dep && coversDept(user, dep) &&
      (isDeptApprover(user, dep) || user.fullScope || hasPerm(user, 'apv_final')));
  }
  return [appOf(rq, apps), targetOf(rq, apps)].some(app => !!app && canSeeApp(user, app) &&
    (isAppApprover(user, app) || user.fullScope || hasPerm(user, 'apv_final')));
};

const COLS = `r.*, d.name_ar AS dept_name_ar, d.name_en AS dept_name_en, a.name_ar AS app_name_ar, a.name_en AS app_name_en, a.icon,
  ur.full_name AS requested_by_name, ud.full_name AS decided_by_name, urt.full_name AS returned_to_name,
  ta.name_ar AS target_app_name_ar, ta.name_en AS target_app_name_en, ta.icon AS target_icon,
  td.name_ar AS target_dept_name_ar, td.name_en AS target_dept_name_en,
  usa.full_name AS source_approved_by_name, uta.full_name AS target_approved_by_name,
  (SELECT count(*)::int FROM edit_request_items i WHERE i.request_id=r.id) AS item_count`;
const JOINS = `JOIN departments d ON d.id=r.department_id JOIN applications a ON a.id=r.app_id
  LEFT JOIN applications ta ON ta.id=r.target_app_id LEFT JOIN departments td ON td.id=r.target_department_id
  LEFT JOIN users ur ON ur.id=r.requested_by LEFT JOIN users ud ON ud.id=r.decided_by
  LEFT JOIN users urt ON urt.id=r.returned_to
  LEFT JOIN users usa ON usa.id=r.source_approved_by LEFT JOIN users uta ON uta.id=r.target_approved_by`;

async function items(ids) {
  if (!ids.length) return [];
  return (await query(`SELECT i.*, f.code, f.name_ar AS fn_name_ar FROM edit_request_items i
    LEFT JOIN functions f ON f.id=i.function_id WHERE i.request_id = ANY($1) ORDER BY i.id`, [ids])).rows;
}

// Filters of the Approvals screen (1.12.1), also taken by its Excel export. Every one only narrows the list: what a
// user may see is still decided by visible() below, after the query.
export const RQ_KINDS = ['function', 'bulk', 'report', 'add_function', 'remove_function', 'restore_function', 'move_function', 'move_application'];
// a changed field; 'name' is a rename (the Arabic or the English name)
const FIELD_OF = f => (f === 'name_ar' || f === 'name_en' ? 'name' : f);
const FIELDS_IN = f => (f === 'name' ? ['name_ar', 'name_en'] : [f]);
export const RQ_FILTERS = ['status', 'mine', 'awaiting', 'returned', 'dept', 'app', 'kind', 'field', 'requester', 'decided_by', 'from', 'to', 'q'];
const userId = (v, field) => {
  if (!/^[0-9]{1,10}$/.test(v) || !isId(+v)) throw bad('invalid_value', { field });
  return +v;
};

function filterSql(user, qs) {
  const params = [], where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', '$' + params.length)); };
  const s = k => (typeof qs[k] === 'string' ? qs[k] : '');
  if (qs.status) add('r.status=?', str(qs.status, 20));
  if (qs.mine === '1') add('r.requested_by=?', user.id);
  // «returned to me» (1.12.28): the requests a lead sent back for this user to act on (the requester or substitute)
  if (qs.returned === '1') { add('r.returned_to=?', user.id); add('r.status=?', 'returned'); }
  // a move belongs to both of its departments / applications
  if (s('dept')) add('(r.department_id=? OR r.target_department_id=?)', str(qs.dept, 50));
  if (s('app')) add('(r.app_id=? OR r.target_app_id=?)', str(qs.app, 50));
  if (s('kind')) {
    if (!RQ_KINDS.includes(qs.kind)) throw bad('invalid_value', { field: 'kind' });
    add('r.kind=?', qs.kind);
  }
  if (s('field')) {
    if (!/^[a-z_]{1,40}$/.test(qs.field)) throw bad('invalid_value', { field: 'field' });
    add('EXISTS (SELECT 1 FROM edit_request_items fi WHERE fi.request_id=r.id AND fi.field = ANY(?))', FIELDS_IN(qs.field));
  }
  if (s('requester')) add('r.requested_by=?', userId(qs.requester, 'requester'));
  // who decided it, or signed one stage of a move
  if (s('decided_by')) add('(r.decided_by=? OR r.source_approved_by=? OR r.target_approved_by=?)', userId(qs.decided_by, 'decided_by'));
  for (const k of ['from', 'to']) if (s(k) && !isDate(qs[k])) throw bad('invalid_value', { field: k });
  if (s('from')) add('r.requested_at >= ?::date', qs.from);
  if (s('to')) add('r.requested_at < (?::date + 1)', qs.to);
  // free text: the request number, its summary / reason, departments, applications, requester, and its items' codes / names;
  // «#12» is request 12 only
  const q = str(qs.q, 200);
  if (/^#[0-9]{1,10}$/.test(q)) add('r.id::text = ?', q.slice(1));
  else if (q) {
    params.push(q, '%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    const eq = '$' + (params.length - 1), like = '$' + params.length;
    where.push(`(r.id::text = ${eq} OR concat_ws(' ', r.summary, r.reason, d.name_ar, d.name_en, a.id, a.name_ar, a.name_en, td.name_ar, td.name_en,
      ta.id, ta.name_ar, ta.name_en, ur.full_name, ur.username) ILIKE ${like}
      OR EXISTS (SELECT 1 FROM edit_request_items qi JOIN functions qf ON qf.id=qi.function_id WHERE qi.request_id=r.id
        AND concat_ws(' ', qf.code, qf.name_ar, qf.name_en) ILIKE ${like}))`);
  }
  return { params, where };
}

// The requests a user may see, with their items: the Approvals screen and its Excel export (routes/export.js).
export async function listRequests(user, qs = {}, { limit = 300, meta = false } = {}) {
  const { params, where } = filterSql(user, qs);
  const rows = (await query(`SELECT ${COLS} FROM edit_requests r ${JOINS}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.requested_at DESC LIMIT ${limit | 0}`, params)).rows;
  const apps = await allApps();
  let list = rows.filter(x => visible(user, x, apps));
  // «awaiting my approval»: the requests this user may approve now
  if (qs.awaiting === '1') list = list.filter(x => abilities(user, x, apps).approve);
  const its = await items(list.map(x => x.id));
  for (const x of list) {
    x.can = abilities(user, x, apps); x.items = its.filter(i => i.request_id === x.id);
    // a pending move: the weight share as it would be now (applied at approval) next to the one when it was requested
    if (isMove(x) && x.status === 'pending') x.move_now = await currentShare({ query }, x.app_id, x.items.map(i => i.function_id).filter(Boolean));
  }
  return meta ? { requests: list, truncated: rows.length >= (limit | 0) } : list;
}

// The choices of the screen's filters, taken only from the requests this user may see (with the chosen status):
// their departments and applications (both sides of a move), requesters, deciders, kinds and changed fields.
async function facets(user, qs) {
  const apps = await allApps();
  const st = str(qs.status, 20);
  const rows = (await query(`SELECT id, kind, app_id, department_id, target_app_id, target_department_id, requested_by, decided_by,
    source_approved_by, target_approved_by FROM edit_requests ${st ? 'WHERE status=$1' : ''}`, st ? [st] : [])).rows.filter(x => visible(user, x, apps));
  const set = f => [...new Set(rows.flatMap(f).filter(v => v !== null && v !== undefined))];
  const ids = rows.map(x => x.id);
  const deptIds = set(x => [x.department_id, x.target_department_id]), appIds = set(x => [x.app_id, x.target_app_id]);
  const reqIds = set(x => [x.requested_by]), decIds = set(x => [x.decided_by, x.source_approved_by, x.target_approved_by]);
  const [depts, appRows, users, fields] = await Promise.all([
    query('SELECT id, name_ar, name_en FROM departments WHERE id = ANY($1) ORDER BY sort, id', [deptIds]),
    query('SELECT id, department_id, name_ar, name_en FROM applications WHERE id = ANY($1) ORDER BY sort, id', [appIds]),
    query('SELECT id, full_name, username FROM users WHERE id = ANY($1) ORDER BY full_name, id', [[...new Set([...reqIds, ...decIds])]]),
    ids.length ? query('SELECT DISTINCT field FROM edit_request_items WHERE request_id = ANY($1)', [ids]) : { rows: [] },
  ]);
  const person = u => ({ id: u.id, name: u.full_name || u.username });
  return {
    departments: depts.rows, applications: appRows.rows,
    requesters: users.rows.filter(u => reqIds.includes(u.id)).map(person),
    deciders: users.rows.filter(u => decIds.includes(u.id)).map(person),
    kinds: RQ_KINDS.filter(k => rows.some(x => x.kind === k)),
    fields: [...new Set(fields.rows.map(x => FIELD_OF(x.field)))].sort(),
  };
}

r.get('/', async (req, res) => res.json(await listRequests(req.user, req.query, { meta: true })));
r.get('/facets', async (req, res) => res.json(await facets(req.user, req.query)));

r.get('/pending-count', async (req, res) => {
  const rows = (await query(`SELECT id, department_id, app_id, requested_by, kind, target_app_id, target_department_id, source_approved_by FROM edit_requests WHERE status='pending'`)).rows;
  const apps = await allApps();
  // returned to me (1.12.28): requests a lead sent back for this user (author or substitute) to act on
  const returned = (await query(`SELECT count(*)::int AS n FROM edit_requests WHERE status='returned' AND returned_to=$1`, [req.user.id])).rows[0].n;
  res.json({
    awaiting_me: rows.filter(x => abilities(req.user, { ...x, status: 'pending' }, apps).approve).length,
    mine: rows.filter(x => x.requested_by === req.user.id).length,
    returned_to_me: returned,
  });
});

// The reject reason is required and, when it RETURNS the request to its author (every kind but a move), uses the
// same 3–500 rule as a move / rename / exclusion reason. A move reject keeps its older rule (any non-empty text).
export const RETURN_REASON_MIN = 3, RETURN_REASON_MAX = 500;
function returnReason(body) {
  const v = str(body?.reason, RETURN_REASON_MAX);
  if (v.replace(/\s/gu, '').length < RETURN_REASON_MIN) throw bad('reason_required', { min: RETURN_REASON_MIN });
  return v;
}
const requireMoveReason = v => { if (!v) throw bad('reason_required'); return v; };

async function decide(req, res, action) {
  const id = idParam(req.params.id);
  const moveReason = str(req.body?.reason, 1000) || null;
  const apps = await allApps();
  const out = await tx(async c => {
    const rq = (await c.query('SELECT * FROM edit_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!rq) throw notFound();
    if (rq.status !== 'pending') throw bad('request_not_pending', { status: rq.status });
    if (!abilities(req.user, rq, apps)[action]) throw new HttpError(403, 'cannot_approve', { stage: action });
    const move = isMove(rq) || isMoveApp(rq);
    // a reject of a simple request RETURNS it to its author (or substitute); a move reject closes it as before
    const reason = action === 'reject' ? (move ? requireMoveReason(moveReason) : returnReason(req.body)) : moveReason;
    if (action === 'reject' && !move) {
      const route = await computeReturnTo(c, rq);
      await c.query(`UPDATE edit_requests SET status='returned', returned_reason=$2, returned_at=now(), returned_to=$3,
        decided_by=$4, decided_at=now(), reason=$2 WHERE id=$1`, [id, reason, route.to, req.user.id]);
      await logAudit(req, { db: c, action: 'edit_return', entity: 'edit_request', entityId: id, summary: reason,
        context: await requestContext(c, rq, req, { reason, returned_to: route.to, substitute: route.substitute }) });
      return { ok: true, returned: true, returned_to: route.to, substitute: route.substitute, app_id: rq.app_id, rq, status: 'returned', route, reason };
    }
    if (action === 'approve') {
      // the author must still be allowed to make these changes (active, in scope, permissions) — ETS-SEC-027
      const blocked = await requesterBlocked(c, rq);
      if (blocked) throw new HttpError(409, 'requester_not_allowed', { reason: blocked });
      if (isMoveApp(rq)) {
        const m = await approveAppMove(c, rq, req, { reason });
        return m.applied ? { applied: true, applied_changes: 1, skipped_changes: 0, stage: m.stage, app_moved: true, weight: m.out.weight,
          app_id: rq.app_id, rq, result: m.result } : { ok: true, applied: false, stage: m.stage, app_id: rq.app_id, rq, status: 'pending' };
      }
      if (isMove(rq)) {
        const m = await approveMove(c, rq, req, { reason });
        return m.applied ? { applied: true, applied_changes: m.result.applied, skipped_changes: 0, stage: m.stage, moved: m.out.items, weight: m.out.weight,
          app_id: rq.app_id, rq, result: m.result } : { ok: true, applied: false, stage: m.stage, app_id: rq.app_id, rq, status: 'pending' };
      }
      const result = await applyRequest(c, rq, req);
      await c.query(`UPDATE edit_requests SET status='applied', decided_by=$2, decided_at=now(), reason=$3, apply_result=$4 WHERE id=$1`,
        [id, req.user.id, reason, JSON.stringify(result)]);
      await logAudit(req, { db: c, action: 'edit_approve', entity: 'edit_request', entityId: id,
        summary: `${rq.app_id}: ${result.applied} applied, ${result.skipped} skipped`, newValue: result,
        context: await requestContext(c, rq, req, { reason }) });
      return { applied: true, applied_changes: result.applied, skipped_changes: result.skipped, app_id: rq.app_id, rq, result };
    }
    const status = action === 'reject' ? 'rejected' : 'withdrawn';
    await c.query(`UPDATE edit_requests SET status=$2, decided_by=$3, decided_at=now(), reason=$4 WHERE id=$1`, [id, status, req.user.id, reason]);
    await logAudit(req, { db: c, action: `edit_${action}`, entity: 'edit_request', entityId: id, summary: reason,
      context: await requestContext(c, rq, req, { reason }) });
    return { ok: true, app_id: rq.app_id, rq, status, reason };
  });
  // alerts (after COMMIT): a returned request tells the user it went to (A7); every other decision tells the author
  // (A3). Either way the approvers' «waiting» alert closes when nothing is left pending there.
  if (out.returned) await requestReturned(out.rq, { reason: out.reason, returnedTo: out.route.to, substitute: out.route.substitute });
  else await requestDecided(out.rq, { status: out.applied ? 'applied' : out.status, reason: out.reason, result: out.result });
  await requestsSettled(out.rq.app_id);
  if (out.rq.target_app_id) await requestsSettled(out.rq.target_app_id);
  // after COMMIT: applied changes, or the end of an "awaiting approval" badge — a move: both applications
  if (isMoveApp(out.rq)) {
    await publishChange({ dept_id: out.rq.department_id });                                   // the source department's total
    await publishChange({ dept_id: out.rq.target_department_id, app_id: out.rq.app_id });     // the destination, with the moved application
    if (out.applied) await applicationMovedIn(out.rq.app_id, out.rq.department_id, out.rq.target_department_id, [out.rq.requested_by, req.user.id]);    // T9
  } else if (isMove(out.rq)) {
    await publishApps([appOf(out.rq, apps), targetOf(out.rq, apps)]);
    if (out.applied) await itemsMovedIn(out.rq.app_id, out.rq.target_app_id, out.applied_changes, [out.rq.requested_by, req.user.id]);    // T8
  } else {
    const app = apps.find(a => a.id === out.app_id);
    publishChange(app ? { dept_id: app.department_id, app_id: app.id } : {});
  }
  delete out.rq; delete out.result; delete out.status; delete out.app_id; delete out.route; delete out.reason;
  res.json(out);
}

r.post('/:id/approve', (req, res) => decide(req, res, 'approve'));
r.post('/:id/reject', (req, res) => decide(req, res, 'reject'));

// Withdraw (1.12.28): a still-pending request by its author, or a returned request by the user it was returned to
// (requester or substitute) — it is closed. Resubmit: a returned request goes back to 'pending' and re-enters the
// approval flow, after the author's current rights are re-checked (ETS-SEC-027), so a no-longer-allowed change
// cannot be resubmitted. Only returned_to or the original author may act (abilities.withdraw / .resubmit).
async function returnedAction(req, res, action) {
  const id = idParam(req.params.id);
  const apps = await allApps();
  const out = await tx(async c => {
    const rq = (await c.query('SELECT * FROM edit_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!rq) throw notFound();
    const can = abilities(req.user, rq, apps);
    if (!can[action]) throw new HttpError(403, 'cannot_approve', { stage: action });
    if (action === 'withdraw') {        // pending author withdraw still flows through decide(); this handles returned
      if (rq.status === 'pending') return null;      // let the pending path handle it
      await c.query(`UPDATE edit_requests SET status='withdrawn', decided_by=$2, decided_at=now() WHERE id=$1`, [id, req.user.id]);
      await logAudit(req, { db: c, action: 'edit_withdraw', entity: 'edit_request', entityId: id, summary: 'withdrawn after return',
        context: await requestContext(c, rq, req, { withdrawn_after_return: true }) });
      return { ok: true, status: 'withdrawn', rq };
    }
    // resubmit
    if (rq.status !== 'returned') throw bad('request_not_returned', { status: rq.status });
    const blocked = await requesterBlocked(c, rq);
    if (blocked) throw new HttpError(409, 'requester_not_allowed', { reason: blocked });
    await c.query(`UPDATE edit_requests SET status='pending', requested_at=now(), returned_reason=NULL, returned_at=NULL,
      returned_to=NULL, decided_by=NULL, decided_at=NULL, reason=NULL WHERE id=$1`, [id]);
    await logAudit(req, { db: c, action: 'edit_resubmit', entity: 'edit_request', entityId: id, summary: 'resubmitted after return',
      context: await requestContext(c, rq, req, { resubmitted: true }) });
    return { ok: true, status: 'pending', rq };
  });
  if (out === null) return decide(req, res, 'withdraw');
  const app = apps.find(a => a.id === out.rq.app_id);
  if (out.status === 'pending') await requestCreated({ ...out.rq, status: 'pending' });   // A1: the approvers again
  await requestsSettled(out.rq.app_id);
  if (out.rq.target_app_id) await requestsSettled(out.rq.target_app_id);
  publishChange(app ? { dept_id: app.department_id, app_id: app.id } : {});
  res.json({ ok: true, status: out.status });
}

r.post('/:id/withdraw', (req, res) => returnedAction(req, res, 'withdraw'));
r.post('/:id/resubmit', (req, res) => returnedAction(req, res, 'resubmit'));

// Approve every pending request of a department the user leads (or a list of ids).
r.post('/approve-all', async (req, res) => {
  const apps = await allApps();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isId) : null;
  const rows = (await query(`SELECT * FROM edit_requests WHERE status='pending' ${ids ? 'AND id = ANY($1)' : ''} ORDER BY requested_at`, ids ? [ids] : [])).rows
    .filter(x => abilities(req.user, x, apps).approve);
  let applied = 0, skipped = 0, blocked = 0;
  const moved = [];
  for (const rq of rows) {
    // a request the «نجح» = 100 % rule now refuses (1.8.1), or a rename of a name changed since (1.9.1), is left pending
    const refused = await tx(async c => {
      const cur = (await c.query('SELECT status, source_approved_by FROM edit_requests WHERE id=$1 FOR UPDATE', [rq.id])).rows[0];
      if (cur.status !== 'pending') return;
      if (!abilities(req.user, { ...rq, ...cur }, apps).approve) return;      // e.g. a move whose stage changed meanwhile
      if (await requesterBlocked(c, rq)) { blocked++; return; }     // left pending for a decision one by one
      if (isMoveApp(rq)) {
        // an application move: the stage this approver signs (the last one applies it); one that can no longer be made stays pending
        const m = await approveAppMove(c, { ...rq, ...cur }, req, {});
        if (m.applied) { applied += 1; moved.push({ rq, n: 1 }); }
        return;
      }
      if (isMove(rq)) {
        // a move: the stage this approver signs (the last one applies it); one that can no longer be made stays pending
        const m = await approveMove(c, { ...rq, ...cur }, req, {});
        if (m.applied) { applied += m.result.applied; moved.push({ rq, n: m.result.applied }); }
        return;
      }
      const result = await applyRequest(c, rq, req);
      applied += result.applied; skipped += result.skipped;
      await c.query(`UPDATE edit_requests SET status='applied', decided_by=$2, decided_at=now(), apply_result=$3 WHERE id=$1`,
        [rq.id, req.user.id, JSON.stringify(result)]);
      await logAudit(req, { db: c, action: 'edit_approve', entity: 'edit_request', entityId: rq.id, summary: `bulk approval`, newValue: result,
        context: await requestContext(c, rq, req, { bulk: true }) });
    }).then(() => false, e => {
      if (PASS_RULE_CODES.includes(e.code) || e.code === 'name_changed' || (e.status === 409 && String(e.code).startsWith('move_'))) return true;
      throw e;
    });
    if (refused) { blocked++; continue; }
    if (isMoveApp(rq)) {                                               // committed: both departments
      await publishChange({ dept_id: rq.department_id });
      await publishChange({ dept_id: rq.target_department_id, app_id: rq.app_id });
      const m = moved.find(x => x.rq === rq);
      if (m) await applicationMovedIn(rq.app_id, rq.department_id, rq.target_department_id, [rq.requested_by, req.user.id]);
    } else if (isMove(rq)) {                                           // committed: both applications
      await publishApps([appOf(rq, apps), targetOf(rq, apps)]);
      const m = moved.find(x => x.rq === rq);
      if (m) await itemsMovedIn(rq.app_id, rq.target_app_id, m.n, [rq.requested_by, req.user.id]);
    } else publishChange({ dept_id: rq.department_id, app_id: rq.app_id });   // this request's transaction has committed
    if ((await query('SELECT status FROM edit_requests WHERE id=$1', [rq.id])).rows[0]?.status === 'applied') {
      const res2 = (await query('SELECT apply_result FROM edit_requests WHERE id=$1', [rq.id])).rows[0]?.apply_result;
      await requestDecided(rq, { status: 'applied', result: res2 });
    }
  }
  for (const appId of new Set(rows.flatMap(x => [x.app_id, x.target_app_id]).filter(Boolean))) await requestsSettled(appId);
  res.json({ requests: rows.length - blocked, applied_changes: applied, skipped_changes: skipped, blocked_requests: blocked });
});

export default r;

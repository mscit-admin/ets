// Edit requests made in the screens by data-entry users, approved by the department team lead only.
import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, hasPerm, canSeeApp } from '../middleware/auth.js';
import { isAppApprover, applyRequest, requestContext, requesterBlocked } from '../services/edits.js';
import { logAudit } from '../services/logs.js';
import { publishChange } from '../services/live.js';
import { requestDecided, requestsSettled } from '../services/notify-events.js';
import { PASS_RULE_CODES } from '../services/passRule.js';
import { HttpError, bad, notFound, str, idParam, isId } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

const allApps = async () => (await query('SELECT id, department_id FROM applications')).rows;

// A request concerns one application; approving and reading it need that application in scope (ETS-SEC-007).
const appOf = (rq, apps) => apps.find(a => a.id === rq.app_id);

function abilities(user, rq, apps) {
  const pending = rq.status === 'pending';
  const approver = isAppApprover(user, appOf(rq, apps)) && rq.requested_by !== user.id;
  return { approve: pending && approver, reject: pending && approver, withdraw: pending && rq.requested_by === user.id };
}
// Who may see a request: its author, the application's approvers, and readers of approvals with that application in scope.
const visible = (user, rq, apps) => {
  if (rq.requested_by === user.id) return true;
  const app = appOf(rq, apps);
  return !!app && canSeeApp(user, app) && (isAppApprover(user, app) || user.fullScope || hasPerm(user, 'apv_final'));
};

const COLS = `r.*, d.name_ar AS dept_name_ar, d.name_en AS dept_name_en, a.name_ar AS app_name_ar, a.name_en AS app_name_en, a.icon,
  ur.full_name AS requested_by_name, ud.full_name AS decided_by_name,
  (SELECT count(*)::int FROM edit_request_items i WHERE i.request_id=r.id) AS item_count`;
const JOINS = `JOIN departments d ON d.id=r.department_id JOIN applications a ON a.id=r.app_id
  LEFT JOIN users ur ON ur.id=r.requested_by LEFT JOIN users ud ON ud.id=r.decided_by`;

async function items(ids) {
  if (!ids.length) return [];
  return (await query(`SELECT i.*, f.code, f.name_ar AS fn_name_ar FROM edit_request_items i
    LEFT JOIN functions f ON f.id=i.function_id WHERE i.request_id = ANY($1) ORDER BY i.id`, [ids])).rows;
}

// The requests a user may see, with their items: the Approvals screen and its Excel export (routes/export.js).
export async function listRequests(user, qs = {}, { limit = 300 } = {}) {
  const params = [], where = [];
  if (qs.status) { params.push(str(qs.status, 20)); where.push(`r.status=$${params.length}`); }
  if (qs.mine === '1') { params.push(user.id); where.push(`r.requested_by=$${params.length}`); }
  const rows = (await query(`SELECT ${COLS} FROM edit_requests r ${JOINS}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.requested_at DESC LIMIT ${limit | 0}`, params)).rows;
  const apps = await allApps();
  const list = rows.filter(x => visible(user, x, apps));
  const its = await items(list.map(x => x.id));
  for (const x of list) { x.can = abilities(user, x, apps); x.items = its.filter(i => i.request_id === x.id); }
  return list;
}

r.get('/', async (req, res) => res.json({ requests: await listRequests(req.user, req.query) }));

r.get('/pending-count', async (req, res) => {
  const rows = (await query(`SELECT id, department_id, app_id, requested_by FROM edit_requests WHERE status='pending'`)).rows;
  const apps = await allApps();
  res.json({
    awaiting_me: rows.filter(x => abilities(req.user, { ...x, status: 'pending' }, apps).approve).length,
    mine: rows.filter(x => x.requested_by === req.user.id).length,
  });
});

async function decide(req, res, action) {
  const id = idParam(req.params.id);
  const reason = str(req.body?.reason, 1000) || null;
  if (action === 'reject' && !reason) throw bad('reason_required');
  const apps = await allApps();
  const out = await tx(async c => {
    const rq = (await c.query('SELECT * FROM edit_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!rq) throw notFound();
    if (rq.status !== 'pending') throw bad('request_not_pending', { status: rq.status });
    if (!abilities(req.user, rq, apps)[action]) throw new HttpError(403, 'cannot_approve', { stage: action });
    if (action === 'approve') {
      // the author must still be allowed to make these changes (active, in scope, permissions) — ETS-SEC-027
      const blocked = await requesterBlocked(c, rq);
      if (blocked) throw new HttpError(409, 'requester_not_allowed', { reason: blocked });
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
    return { ok: true, app_id: rq.app_id, rq, status };
  });
  // alerts (after COMMIT): the author hears the decision; the approvers' «waiting» alert closes when nothing is left
  await requestDecided(out.rq, { status: out.applied ? 'applied' : out.status, reason, result: out.result });
  await requestsSettled(out.rq.app_id);
  delete out.rq; delete out.result; delete out.status;
  // after COMMIT: applied changes, or the end of an "awaiting approval" badge
  const app = apps.find(a => a.id === out.app_id);
  publishChange(app ? { dept_id: app.department_id, app_id: app.id } : {});
  delete out.app_id;
  res.json(out);
}

r.post('/:id/approve', (req, res) => decide(req, res, 'approve'));
r.post('/:id/reject', (req, res) => decide(req, res, 'reject'));
r.post('/:id/withdraw', (req, res) => decide(req, res, 'withdraw'));

// Approve every pending request of a department the user leads (or a list of ids).
r.post('/approve-all', async (req, res) => {
  const apps = await allApps();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isId) : null;
  const rows = (await query(`SELECT * FROM edit_requests WHERE status='pending' ${ids ? 'AND id = ANY($1)' : ''} ORDER BY requested_at`, ids ? [ids] : [])).rows
    .filter(x => abilities(req.user, x, apps).approve);
  let applied = 0, skipped = 0, blocked = 0;
  for (const rq of rows) {
    // a request the «نجح» = 100 % rule now refuses (1.8.1) is left pending, like a blocked one
    const refused = await tx(async c => {
      const cur = (await c.query('SELECT status FROM edit_requests WHERE id=$1 FOR UPDATE', [rq.id])).rows[0];
      if (cur.status !== 'pending') return;
      if (await requesterBlocked(c, rq)) { blocked++; return; }     // left pending for a decision one by one
      const result = await applyRequest(c, rq, req);
      applied += result.applied; skipped += result.skipped;
      await c.query(`UPDATE edit_requests SET status='applied', decided_by=$2, decided_at=now(), apply_result=$3 WHERE id=$1`,
        [rq.id, req.user.id, JSON.stringify(result)]);
      await logAudit(req, { db: c, action: 'edit_approve', entity: 'edit_request', entityId: rq.id, summary: `bulk approval`, newValue: result,
        context: await requestContext(c, rq, req, { bulk: true }) });
    }).then(() => false, e => { if (PASS_RULE_CODES.includes(e.code)) return true; throw e; });
    if (refused) { blocked++; continue; }
    publishChange({ dept_id: rq.department_id, app_id: rq.app_id });   // this request's transaction has committed
    if ((await query('SELECT status FROM edit_requests WHERE id=$1', [rq.id])).rows[0]?.status === 'applied') {
      const res2 = (await query('SELECT apply_result FROM edit_requests WHERE id=$1', [rq.id])).rows[0]?.apply_result;
      await requestDecided(rq, { status: 'applied', result: res2 });
    }
  }
  for (const appId of new Set(rows.map(x => x.app_id))) await requestsSettled(appId);
  res.json({ requests: rows.length - blocked, applied_changes: applied, skipped_changes: skipped, blocked_requests: blocked });
});

export default r;

// Edit requests made in the screens by data-entry users, approved by the department team lead only.
import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, hasPerm, canSeeDept } from '../middleware/auth.js';
import { isDeptApprover, applyRequest } from '../services/edits.js';
import { logAudit } from '../services/logs.js';
import { HttpError, bad, notFound, str } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

const allApps = async () => (await query('SELECT id, department_id FROM applications')).rows;

function abilities(user, rq, apps) {
  const pending = rq.status === 'pending';
  const approver = isDeptApprover(user, rq.department_id, apps) && rq.requested_by !== user.id;
  return { approve: pending && approver, reject: pending && approver, withdraw: pending && rq.requested_by === user.id };
}
// Who may see a request: its author, the department's approvers, and full-scope readers of logs/approvals.
const visible = (user, rq, apps) => rq.requested_by === user.id || canSeeDept(user, rq.department_id, apps) &&
  (isDeptApprover(user, rq.department_id, apps) || user.fullScope || hasPerm(user, 'apv_final'));

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

r.get('/', async (req, res) => {
  const params = [], where = [];
  if (req.query.status) { params.push(str(req.query.status, 20)); where.push(`r.status=$${params.length}`); }
  if (req.query.mine === '1') { params.push(req.user.id); where.push(`r.requested_by=$${params.length}`); }
  const rows = (await query(`SELECT ${COLS} FROM edit_requests r ${JOINS}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.requested_at DESC LIMIT 300`, params)).rows;
  const apps = await allApps();
  const list = rows.filter(x => visible(req.user, x, apps));
  const its = await items(list.map(x => x.id));
  for (const x of list) { x.can = abilities(req.user, x, apps); x.items = its.filter(i => i.request_id === x.id); }
  res.json({ requests: list });
});

r.get('/pending-count', async (req, res) => {
  const rows = (await query(`SELECT id, department_id, requested_by FROM edit_requests WHERE status='pending'`)).rows;
  const apps = await allApps();
  res.json({
    awaiting_me: rows.filter(x => abilities(req.user, { ...x, status: 'pending' }, apps).approve).length,
    mine: rows.filter(x => x.requested_by === req.user.id).length,
  });
});

async function decide(req, res, action) {
  const id = parseInt(req.params.id, 10);
  const reason = str(req.body?.reason, 1000) || null;
  if (action === 'reject' && !reason) throw bad('reason_required');
  const apps = await allApps();
  const out = await tx(async c => {
    const rq = (await c.query('SELECT * FROM edit_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!rq) throw notFound();
    if (rq.status !== 'pending') throw bad('request_not_pending', { status: rq.status });
    if (!abilities(req.user, rq, apps)[action]) throw new HttpError(403, 'cannot_approve', { stage: action });
    if (action === 'approve') {
      const result = await applyRequest(c, id, rq.requested_by);
      await c.query(`UPDATE edit_requests SET status='applied', decided_by=$2, decided_at=now(), reason=$3, apply_result=$4 WHERE id=$1`,
        [id, req.user.id, reason, JSON.stringify(result)]);
      await logAudit(req, { db: c, action: 'edit_approve', entity: 'edit_request', entityId: id,
        summary: `${rq.app_id}: ${result.applied} applied, ${result.skipped} skipped`, newValue: result });
      return { applied: true, applied_changes: result.applied, skipped_changes: result.skipped };
    }
    const status = action === 'reject' ? 'rejected' : 'withdrawn';
    await c.query(`UPDATE edit_requests SET status=$2, decided_by=$3, decided_at=now(), reason=$4 WHERE id=$1`, [id, status, req.user.id, reason]);
    await logAudit(req, { db: c, action: `edit_${action}`, entity: 'edit_request', entityId: id, summary: reason });
    return { ok: true };
  });
  res.json(out);
}

r.post('/:id/approve', (req, res) => decide(req, res, 'approve'));
r.post('/:id/reject', (req, res) => decide(req, res, 'reject'));
r.post('/:id/withdraw', (req, res) => decide(req, res, 'withdraw'));

// Approve every pending request of a department the user leads (or a list of ids).
r.post('/approve-all', async (req, res) => {
  const apps = await allApps();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Number.isInteger) : null;
  const rows = (await query(`SELECT * FROM edit_requests WHERE status='pending' ${ids ? 'AND id = ANY($1)' : ''} ORDER BY requested_at`, ids ? [ids] : [])).rows
    .filter(x => abilities(req.user, x, apps).approve);
  let applied = 0, skipped = 0;
  for (const rq of rows) {
    await tx(async c => {
      const cur = (await c.query('SELECT status FROM edit_requests WHERE id=$1 FOR UPDATE', [rq.id])).rows[0];
      if (cur.status !== 'pending') return;
      const result = await applyRequest(c, rq.id, rq.requested_by);
      applied += result.applied; skipped += result.skipped;
      await c.query(`UPDATE edit_requests SET status='applied', decided_by=$2, decided_at=now(), apply_result=$3 WHERE id=$1`,
        [rq.id, req.user.id, JSON.stringify(result)]);
      await logAudit(req, { db: c, action: 'edit_approve', entity: 'edit_request', entityId: rq.id, summary: `bulk approval`, newValue: result });
    });
  }
  res.json({ requests: rows.length, applied_changes: applied, skipped_changes: skipped });
});

export default r;

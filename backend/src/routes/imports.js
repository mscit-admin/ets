// Team result files (JSON from the original tracker page) → pending batch → two approvals → applied.
//
// The uploader picks one option:
//   { target: 'department', department_id }  one department's functions and application weights
//   { target: 'reports' }                     the reports track of every department in the uploader's scope
// Approvals: team lead (apv_dept, scope must cover every department in the batch) and
// project / technical manager (apv_final) — two different people, any order.
import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm, hasPerm, canSeeDept } from '../middleware/auth.js';
import { parseLegacy } from '../services/legacy.js';
import { diffTarget, impactSummary, applyBatch } from '../services/imports.js';
import { logAudit, logSystem } from '../services/logs.js';
import { namedItems, logAppliedChanges, loadUser, userRef } from '../services/audit.js';
import { largeJson } from '../middleware/body.js';
import { HttpError, bad, notFound, str, idParam } from '../utils/http.js';

const r = Router();
r.use(requireAuth);

const loadMeta = async () => ({
  apps: (await query('SELECT id, department_id FROM applications')).rows,
  depts: (await query('SELECT id, name_ar, name_en, short_ar, short_en, is_base FROM departments ORDER BY sort')).rows,
});

function parseContent(body) {
  try {
    const p = typeof body?.content === 'string' ? parseLegacy(body.content) : body?.payload;
    if (!p || typeof p !== 'object' || !p.f) throw new Error();
    return p;
  } catch { throw bad('invalid_import_file'); }
}
const fileTs = p => (+p.ts > 0 && !Number.isNaN(new Date(+p.ts).getTime()) ? new Date(+p.ts) : null);   // 1e300 → null, not a 500

// Departments a reports import covers for this user: departments with a reports track, within scope.
const reportDepts = (user, meta) => meta.depts.filter(d => !d.is_base && canSeeDept(user, d.id, meta.apps)).map(d => d.id);

const sees = (user, b, meta) => {
  const ds = b.departments?.length ? b.departments : b.department_id ? [b.department_id] : [];
  return { any: ds.length === 0 ? user.fullScope : ds.some(d => canSeeDept(user, d, meta.apps)),
    all: ds.every(d => canSeeDept(user, d, meta.apps)) };
};

async function abilities(user, b, meta) {
  const pending = b.status === 'pending';
  const s = sees(user, b, meta);
  return {
    approve_lead: pending && !b.lead_by && hasPerm(user, 'apv_dept') && s.all && b.final_by !== user.id,
    approve_final: pending && !b.final_by && hasPerm(user, 'apv_final') && b.lead_by !== user.id,
    reject: pending && ((hasPerm(user, 'apv_dept') && s.all) || hasPerm(user, 'apv_final')),
  };
}

// Context of an audit row about a batch: the file, who sent and approved it, and its changes.
async function batchContext(c, b) {
  const changes = (await c.query('SELECT * FROM import_changes WHERE batch_id=$1 ORDER BY id', [b.id])).rows;
  return { via: 'import', batch_id: b.id, target: b.target, department_id: b.department_id, departments: b.departments, filename: b.filename,
    uploaded_by: userRef(await loadUser(c, b.uploaded_by)), lead_by: userRef(await loadUser(c, b.lead_by)),
    final_by: userRef(await loadUser(c, b.final_by)), items: await namedItems(c, changes) };
}

// 1) Read a file and list the import options with the number of changes in each.
r.post('/preview', requirePerm('imp'), largeJson, async (req, res) => {
  const p = parseContent(req.body);
  const meta = await loadMeta();
  const options = [];
  await tx(async c => {
    for (const d of meta.depts) {
      if (!canSeeDept(req.user, d.id, meta.apps)) continue;
      const ch = await diffTarget(c, p, 'department', [d.id]);
      options.push({ target: 'department', department_id: d.id, name_ar: d.name_ar, name_en: d.name_en,
        changes: ch.length, summary: ch.length ? await impactSummary(c, ch) : null });
    }
    const rd = reportDepts(req.user, meta);
    if (rd.length) {
      const ch = await diffTarget(c, p, 'reports', rd);
      options.push({ target: 'reports', department_id: null, departments: rd, changes: ch.length,
        summary: ch.length ? await impactSummary(c, ch) : null });
    }
  });
  res.json({ file_ts: fileTs(p), options });
});

// 2) Submit the chosen part of the file for approval.
r.post('/', requirePerm('imp'), largeJson, async (req, res) => {
  const p = parseContent(req.body);
  const target = req.body?.target === 'reports' ? 'reports' : 'department';
  const meta = await loadMeta();
  let deptIds, deptId = null;
  if (target === 'department') {
    deptId = str(req.body?.department_id, 20);
    if (!meta.depts.some(d => d.id === deptId)) throw bad('department_required');
    if (!canSeeDept(req.user, deptId, meta.apps)) throw new HttpError(403, 'out_of_scope', { department: deptId });
    deptIds = [deptId];
  } else {
    deptIds = reportDepts(req.user, meta);
    if (!deptIds.length) throw new HttpError(403, 'out_of_scope', { target: 'reports' });
  }
  const filename = str(req.body?.filename, 200) || null;

  const batch = await tx(async c => {
    const changes = await diffTarget(c, p, target, deptIds);
    const summary = await impactSummary(c, changes);
    const touched = target === 'department' ? deptIds : summary.departments.map(d => d.id);
    // a newer file for the same option replaces the one still waiting
    const sup = target === 'department'
      ? await c.query(`UPDATE import_batches SET status='superseded' WHERE status='pending' AND target='department' AND department_id=$1 RETURNING id`, [deptId])
      : await c.query(`UPDATE import_batches SET status='superseded' WHERE status='pending' AND target='reports' AND uploaded_by=$1 RETURNING id`, [req.user.id]);
    const b = (await c.query(`INSERT INTO import_batches(target, department_id, departments, filename, file_ts, status, change_count, summary, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [target, deptId, touched, filename, fileTs(p), changes.length ? 'pending' : 'no_changes', changes.length,
        JSON.stringify({ ...summary, superseded: sup.rows.map(x => x.id) }), req.user.id])).rows[0];
    for (const ch of changes) {
      await c.query(`INSERT INTO import_changes(batch_id, kind, app_id, function_id, code, field, old_value, new_value)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [b.id, ch.kind, ch.app_id, ch.function_id || null, ch.code || null, ch.field, JSON.stringify(ch.old_value), JSON.stringify(ch.new_value)]);
    }
    await logAudit(req, { db: c, action: 'import_submit', entity: 'import_batch', entityId: b.id,
      summary: `${target === 'reports' ? 'reports' : deptId}: ${changes.length} changes${filename ? ' from ' + filename : ''}`,
      newValue: { target, department: deptId, departments: touched, changes: changes.length, superseded: sup.rows.map(x => x.id) },
      context: { via: 'import', batch_id: b.id, target, department_id: deptId, departments: touched, filename,
        project: summary.project, items: await namedItems(c, changes) } });
    return b;
  });
  res.status(201).json({ batch });
});

const LIST_COLS = `b.*, d.name_ar AS dept_name_ar, d.name_en AS dept_name_en,
  uu.full_name AS uploaded_by_name, ul.full_name AS lead_by_name, uf.full_name AS final_by_name, ur.full_name AS rejected_by_name`;
const LIST_JOINS = `LEFT JOIN departments d ON d.id=b.department_id
  LEFT JOIN users uu ON uu.id=b.uploaded_by LEFT JOIN users ul ON ul.id=b.lead_by
  LEFT JOIN users uf ON uf.id=b.final_by LEFT JOIN users ur ON ur.id=b.rejected_by`;

r.get('/', async (req, res) => {
  const params = [], where = [];
  if (req.query.status) { params.push(str(req.query.status, 20)); where.push(`b.status=$${params.length}`); }
  const rows = (await query(`SELECT ${LIST_COLS} FROM import_batches b ${LIST_JOINS}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.uploaded_at DESC LIMIT 300`, params)).rows;
  const meta = await loadMeta();
  const visible = rows.filter(b => sees(req.user, b, meta).any);
  for (const b of visible) b.can = await abilities(req.user, b, meta);
  res.json({ batches: visible, can_import: hasPerm(req.user, 'imp') });
});

// Batches waiting for this user's signature (sidebar badge, dashboard notice).
r.get('/pending-count', async (req, res) => {
  const rows = (await query(`SELECT * FROM import_batches WHERE status='pending'`)).rows;
  const meta = await loadMeta();
  let mine = 0, visible = 0;
  for (const b of rows) {
    if (!sees(req.user, b, meta).any) continue;
    visible++;
    const a = await abilities(req.user, b, meta);
    if (a.approve_lead || a.approve_final) mine++;
  }
  res.json({ awaiting_me: mine, pending: visible });
});

r.get('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const b = (await query(`SELECT ${LIST_COLS} FROM import_batches b ${LIST_JOINS} WHERE b.id=$1`, [id])).rows[0];
  if (!b) throw notFound();
  const meta = await loadMeta();
  if (!sees(req.user, b, meta).any) throw new HttpError(403, 'out_of_scope');
  const changes = (await query(`SELECT ch.*, a.name_ar AS app_name_ar, a.name_en AS app_name_en, a.icon, a.department_id, f.name_ar AS fn_name_ar, f.source
    FROM import_changes ch JOIN applications a ON a.id=ch.app_id LEFT JOIN functions f ON f.id=ch.function_id
    WHERE ch.batch_id=$1 ORDER BY a.sort, ch.kind, f.sort, ch.id`, [id])).rows;
  res.json({ batch: { ...b, can: await abilities(req.user, b, meta) }, changes, departments: meta.depts });
});

r.post('/:id/approve', async (req, res) => {
  const id = idParam(req.params.id);
  const stage = req.body?.stage;
  if (!['lead', 'final'].includes(stage)) throw bad('invalid_value', { field: 'stage' });
  const note = str(req.body?.note, 1000) || null;
  const meta = await loadMeta();
  const result = await tx(async c => {
    const b = (await c.query('SELECT * FROM import_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!b) throw notFound();
    if (b.status !== 'pending') throw bad('batch_not_pending', { status: b.status });
    const can = await abilities(req.user, b, meta);
    if (!(stage === 'lead' ? can.approve_lead : can.approve_final)) throw new HttpError(403, 'cannot_approve', { stage });
    const u = (await c.query(`UPDATE import_batches SET ${stage}_by=$2, ${stage}_at=now(), ${stage}_note=$3 WHERE id=$1 RETURNING *`,
      [id, req.user.id, note])).rows[0];
    const ctx = await batchContext(c, u);
    await logAudit(req, { db: c, action: `import_approve_${stage}`, entity: 'import_batch', entityId: id, summary: note, context: { ...ctx, note } });
    if (u.lead_by && u.final_by) {
      const r2 = await applyBatch(c, id, req.user.id);
      await c.query(`UPDATE import_batches SET status='applied', applied_at=now(), apply_result=$2 WHERE id=$1`, [id, JSON.stringify(r2)]);
      // one row per changed item, in the name of the employee who sent the file
      const done = (await c.query('SELECT * FROM import_changes WHERE batch_id=$1 AND applied ORDER BY id', [id])).rows;
      await logAppliedChanges(req, c, done, { actor: ctx.uploaded_by, context: { via: 'import', batch_id: id, filename: u.filename,
        requested_by: ctx.uploaded_by, approved_by: ctx.lead_by, final_by: ctx.final_by } });
      await logAudit(req, { db: c, action: 'import_apply', entity: 'import_batch', entityId: id,
        summary: `${r2.applied} applied, ${r2.skipped} skipped`, newValue: r2, context: ctx });
      return { applied: true, applied_changes: r2.applied, skipped_changes: r2.skipped };
    }
    return { applied: false };
  });
  if (result.applied) logSystem('import_applied', `import batch ${id} applied`, result);
  res.json(result);
});

r.post('/:id/reject', async (req, res) => {
  const id = idParam(req.params.id);
  const reason = str(req.body?.reason, 1000);
  if (!reason) throw bad('reason_required');
  const meta = await loadMeta();
  await tx(async c => {
    const b = (await c.query('SELECT * FROM import_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!b) throw notFound();
    if (b.status !== 'pending') throw bad('batch_not_pending', { status: b.status });
    if (!(await abilities(req.user, b, meta)).reject) throw new HttpError(403, 'cannot_approve', { stage: 'reject' });
    await c.query(`UPDATE import_batches SET status='rejected', rejected_by=$2, rejected_at=now(), reject_reason=$3 WHERE id=$1`, [id, req.user.id, reason]);
    await logAudit(req, { db: c, action: 'import_reject', entity: 'import_batch', entityId: id, summary: reason,
      context: { ...await batchContext(c, b), reason } });
  });
  res.json({ ok: true });
});

export default r;

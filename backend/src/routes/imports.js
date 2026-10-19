// Team result files (JSON from the original tracker page) → pending batch → two approvals → applied.
//
// The uploader picks one option:
//   { target: 'department', department_id }  one department's functions and application weights
//   { target: 'reports' }                     the reports track of every department in the uploader's scope
// Approvals: team lead (apv_dept) and project / technical manager (apv_final) — two different people, neither of
// them the uploader, any order (owner decision, ETS-SEC-025). Both need every application the batch changes in
// their scope; an application-scoped user only uploads, sees and signs changes of their own applications (ETS-SEC-007).
import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm, hasPerm, canSeeApp, canSeeDept, coversDept, loadUserContext } from '../middleware/auth.js';
import { parseLegacy } from '../services/legacy.js';
import { diffTarget, impactSummary, applyBatch, passErrors } from '../services/imports.js';
import { itemList } from '../services/passRule.js';
import { logAudit, logSystem } from '../services/logs.js';
import { publishChange } from '../services/live.js';
import { namedItems, logAppliedChanges, loadUser, userRef, originIp } from '../services/audit.js';
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
// Applications in the user's scope (a file's changes to other applications are ignored).
const scopeApps = (user, meta) => new Set(meta.apps.filter(a => canSeeApp(user, a)).map(a => a.id));

// Applications each batch changes: Map batch id → [app ids].
async function batchApps(c, ids) {
  if (!ids.length) return new Map();
  const rows = (await c.query('SELECT batch_id, array_agg(DISTINCT app_id) AS apps FROM import_changes WHERE batch_id = ANY($1) GROUP BY 1', [ids])).rows;
  return new Map(rows.map(x => [x.batch_id, x.apps]));
}

// any: the user sees part of the batch; all: every change of the batch is in the user's scope.
// A batch without changes is judged by its departments (all = whole departments in scope).
const sees = (user, b, meta, appIds = []) => {
  if (appIds.length) {
    const ok = appIds.map(id => { const a = meta.apps.find(x => x.id === id); return !!a && canSeeApp(user, a); });
    return { any: ok.some(Boolean), all: ok.every(Boolean) };
  }
  const ds = b.departments?.length ? b.departments : b.department_id ? [b.department_id] : [];
  return { any: ds.length === 0 ? user.fullScope : ds.some(d => canSeeDept(user, d, meta.apps)),
    all: ds.length === 0 ? user.fullScope : ds.every(d => coversDept(user, d)) };
};

// A reader who sees only part of a batch gets figures computed from the changes they may see: the per-application
// figures of their own applications, the department figures of departments they fully cover, the change count,
// counts and apply result of the visible changes only, and no project figure (it mixes in the other applications'
// changes — V2-N2). visible: the batch's import_changes rows in the reader's scope (kind, function_id, applied).
function forReader(user, b, meta, appIds, visible) {
  if (user.fullScope || sees(user, b, meta, appIds).all) return b;
  const inScope = x => { const a = meta.apps.find(y => y.id === x.id); return !!a && canSeeApp(user, a); };
  const sm = b.summary || {};
  const fns = visible.filter(c => c.kind === 'function');
  const summary = { ...sm,
    applications: Array.isArray(sm.applications) ? sm.applications.filter(inScope) : sm.applications,
    departments: Array.isArray(sm.departments) ? sm.departments.filter(d => coversDept(user, d.id)) : sm.departments,
    project: null,
    counts: { total: visible.length, functions: new Set(fns.map(c => c.function_id)).size,
      reports: visible.filter(c => c.kind === 'report').length, weights: visible.filter(c => c.kind === 'weight').length } };
  const out = { ...b, summary, change_count: visible.length };
  if (b.apply_result) out.apply_result = { applied: visible.filter(c => c.applied === true).length, skipped: visible.filter(c => c.applied === false).length };
  return out;
}

// The changes of these batches that the user may see: Map batch id → rows (only batches the user sees partly).
async function visibleChanges(user, meta, rows, appsOf) {
  const ids = rows.filter(b => !user.fullScope && !sees(user, b, meta, appsOf.get(b.id) || []).all).map(b => b.id);
  const out = new Map(ids.map(id => [id, []]));
  if (!ids.length) return out;
  const q = await query('SELECT batch_id, kind, app_id, function_id, applied FROM import_changes WHERE batch_id = ANY($1)', [ids]);
  for (const ch of q.rows) {
    const a = meta.apps.find(x => x.id === ch.app_id);
    if (a && canSeeApp(user, a)) out.get(ch.batch_id).push(ch);
  }
  return out;
}

function abilities(user, b, meta, appIds) {
  const pending = b.status === 'pending';
  const s = sees(user, b, meta, appIds);
  const notUploader = b.uploaded_by !== user.id;
  return {
    approve_lead: pending && !b.lead_by && hasPerm(user, 'apv_dept') && s.all && notUploader && b.final_by !== user.id,
    approve_final: pending && !b.final_by && hasPerm(user, 'apv_final') && s.all && notUploader && b.lead_by !== user.id,
    reject: pending && s.all && (hasPerm(user, 'apv_dept') || hasPerm(user, 'apv_final')),
  };
}

// When the second signature would apply the batch: the uploader must still be active, hold 'imp' and have every
// changed application in scope (ETS-SEC-027). Returns null when allowed, else the reason.
async function uploaderBlocked(b, meta, appIds) {
  const u = await loadUserContext(b.uploaded_by);
  if (!u || !u.is_active) return 'requester_inactive';
  if (!hasPerm(u, 'imp')) return 'requester_lacks_permission';
  if (!sees(u, b, meta, appIds).all) return 'requester_out_of_scope';
  return null;
}

// Context of an audit row about a batch: the file, who sent and approved it, and its changes.
async function batchContext(c, b) {
  const changes = (await c.query('SELECT * FROM import_changes WHERE batch_id=$1 ORDER BY id', [b.id])).rows;
  return { via: 'import', batch_id: b.id, target: b.target, department_id: b.department_id, departments: b.departments, filename: b.filename,
    uploaded_by: userRef(await loadUser(c, b.uploaded_by)), lead_by: userRef(await loadUser(c, b.lead_by)),
    final_by: userRef(await loadUser(c, b.final_by)), items: await namedItems(c, changes) };
}

// Live updates after a batch changed (COMMIT done): one event per department it concerns, ids only.
function publishBatch(b) {
  const ds = b?.departments?.length ? b.departments : b?.department_id ? [b.department_id] : [];
  if (!ds.length) return publishChange();
  for (const d of ds) publishChange({ dept_id: d });
}

// 1) Read a file and list the import options with the number of changes in each.
r.post('/preview', requirePerm('imp'), largeJson, async (req, res) => {
  const p = parseContent(req.body);
  const meta = await loadMeta();
  const options = [];
  const only = scopeApps(req.user, meta);
  await tx(async c => {
    for (const d of meta.depts) {
      if (!canSeeDept(req.user, d.id, meta.apps)) continue;
      const ch = await diffTarget(c, p, 'department', [d.id], only);
      options.push({ target: 'department', department_id: d.id, name_ar: d.name_ar, name_en: d.name_en,
        changes: ch.length, summary: ch.length ? await impactSummary(c, ch) : null, errors: await passErrors(c, ch) });
    }
    const rd = reportDepts(req.user, meta);
    if (rd.length) {
      const ch = await diffTarget(c, p, 'reports', rd, only);
      options.push({ target: 'reports', department_id: null, departments: rd, changes: ch.length,
        summary: ch.length ? await impactSummary(c, ch) : null, errors: [] });
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
    const changes = await diffTarget(c, p, target, deptIds, scopeApps(req.user, meta));
    // rows breaking «نجح» needs 100 % (1.8.1): the part of the file is refused, with the list (as in the preview)
    const errors = await passErrors(c, changes);
    if (errors.length) throw bad('import_has_row_errors', { count: errors.length, errors: errors.slice(0, 200), list: itemList(errors) });
    const summary = await impactSummary(c, changes);
    const touched = target === 'department' ? deptIds : summary.departments.map(d => d.id);
    // A newer file for the same option replaces the one still waiting — never when it has no changes, and only a
    // batch nobody has signed yet that is the uploader's own or lies entirely within the uploader's scope; a batch
    // an approver has started signing is kept (ETS-SEC-026).
    const sup = { rows: [] };
    if (changes.length) {
      const waiting = target === 'department'
        ? (await c.query(`SELECT * FROM import_batches WHERE status='pending' AND target='department' AND department_id=$1 FOR UPDATE`, [deptId])).rows
        : (await c.query(`SELECT * FROM import_batches WHERE status='pending' AND target='reports' AND uploaded_by=$1 FOR UPDATE`, [req.user.id])).rows;
      const appsOf = await batchApps(c, waiting.map(x => x.id));
      const ids = waiting.filter(x => !x.lead_by && !x.final_by &&
        (x.uploaded_by === req.user.id || sees(req.user, x, meta, appsOf.get(x.id) || []).all)).map(x => x.id);
      if (ids.length) sup.rows = (await c.query(`UPDATE import_batches SET status='superseded' WHERE id = ANY($1) RETURNING id`, [ids])).rows;
    }
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
  if (batch.status === 'pending') publishBatch(batch);       // "pending import" notices
  res.status(201).json({ batch });
});

const LIST_COLS = `b.*, d.name_ar AS dept_name_ar, d.name_en AS dept_name_en,
  uu.full_name AS uploaded_by_name, ul.full_name AS lead_by_name, uf.full_name AS final_by_name, ur.full_name AS rejected_by_name`;
const LIST_JOINS = `LEFT JOIN departments d ON d.id=b.department_id
  LEFT JOIN users uu ON uu.id=b.uploaded_by LEFT JOIN users ul ON ul.id=b.lead_by
  LEFT JOIN users uf ON uf.id=b.final_by LEFT JOIN users ur ON ur.id=b.rejected_by`;

// The batches a user may see (figures limited to their scope): the Imports screen and its Excel export.
export async function listBatches(user, qs = {}, { limit = 300 } = {}) {
  const params = [], where = [];
  if (qs.status) { params.push(str(qs.status, 20)); where.push(`b.status=$${params.length}`); }
  const rows = (await query(`SELECT ${LIST_COLS} FROM import_batches b ${LIST_JOINS}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.uploaded_at DESC LIMIT ${limit | 0}`, params)).rows;
  const meta = await loadMeta();
  const appsOf = await batchApps({ query }, rows.map(b => b.id));
  const seen = rows.filter(b => sees(user, b, meta, appsOf.get(b.id)).any);
  const vis = await visibleChanges(user, meta, seen, appsOf);
  return seen.map(b => ({ ...forReader(user, b, meta, appsOf.get(b.id), vis.get(b.id) || []), can: abilities(user, b, meta, appsOf.get(b.id)) }));
}

r.get('/', async (req, res) => res.json({ batches: await listBatches(req.user, req.query), can_import: hasPerm(req.user, 'imp') }));

// Batches waiting for this user's signature (sidebar badge, dashboard notice).
r.get('/pending-count', async (req, res) => {
  const rows = (await query(`SELECT * FROM import_batches WHERE status='pending'`)).rows;
  const meta = await loadMeta();
  const appsOf = await batchApps({ query }, rows.map(b => b.id));
  let mine = 0, visible = 0;
  for (const b of rows) {
    if (!sees(req.user, b, meta, appsOf.get(b.id)).any) continue;
    visible++;
    const a = abilities(req.user, b, meta, appsOf.get(b.id));
    if (a.approve_lead || a.approve_final) mine++;
  }
  res.json({ awaiting_me: mine, pending: visible });
});

// One batch and the changes the user may see: the batch screen and its Excel export.
export async function batchDetail(user, rawId) {
  const id = idParam(rawId);
  const b = (await query(`SELECT ${LIST_COLS} FROM import_batches b ${LIST_JOINS} WHERE b.id=$1`, [id])).rows[0];
  if (!b) throw notFound();
  const meta = await loadMeta();
  const apps = (await batchApps({ query }, [id])).get(id);
  if (!sees(user, b, meta, apps).any) throw new HttpError(403, 'out_of_scope');
  // only the changes of applications in the reader's scope (ETS-SEC-007)
  const changes = (await query(`SELECT ch.*, a.name_ar AS app_name_ar, a.name_en AS app_name_en, a.icon, a.department_id, f.name_ar AS fn_name_ar, f.source
    FROM import_changes ch JOIN applications a ON a.id=ch.app_id LEFT JOIN functions f ON f.id=ch.function_id
    WHERE ch.batch_id=$1 ORDER BY a.sort, ch.kind, f.sort, ch.id`, [id])).rows.filter(ch => canSeeApp(user, { id: ch.app_id, department_id: ch.department_id }));
  return { batch: { ...forReader(user, b, meta, apps, changes), can: abilities(user, b, meta, apps) }, changes, departments: meta.depts };
}

r.get('/:id', async (req, res) => res.json(await batchDetail(req.user, req.params.id)));

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
    const apps = (await batchApps(c, [id])).get(id);
    const can = abilities(req.user, b, meta, apps);
    if (!(stage === 'lead' ? can.approve_lead : can.approve_final)) throw new HttpError(403, 'cannot_approve', { stage });
    if (b.lead_by || b.final_by) {                 // this signature completes the batch → it will be applied
      const blocked = await uploaderBlocked(b, meta, apps);
      if (blocked) throw new HttpError(409, 'requester_not_allowed', { reason: blocked });
    }
    const u = (await c.query(`UPDATE import_batches SET ${stage}_by=$2, ${stage}_at=now(), ${stage}_note=$3 WHERE id=$1 RETURNING *`,
      [id, req.user.id, note])).rows[0];
    const ctx = await batchContext(c, u);
    await logAudit(req, { db: c, action: `import_approve_${stage}`, entity: 'import_batch', entityId: id, summary: note, context: { ...ctx, note } });
    if (u.lead_by && u.final_by) {
      const { reasons, ...r2 } = await applyBatch(c, id, req.user.id);
      await c.query(`UPDATE import_batches SET status='applied', applied_at=now(), apply_result=$2 WHERE id=$1`, [id, JSON.stringify(r2)]);
      // one row per changed item, in the name of the employee who sent the file
      const done = (await c.query('SELECT * FROM import_changes WHERE batch_id=$1 AND applied ORDER BY id', [id])).rows;
      // in the uploader's name with the uploader's IP; the approver's IP stays in the context (ETS-SEC-052)
      await logAppliedChanges(req, c, [...done, ...reasons], { actor: ctx.uploaded_by, actorIp: await originIp(c, 'import_submit', 'import_batch', id),
        context: { via: 'import', batch_id: id, filename: u.filename, requested_by: ctx.uploaded_by, approved_by: ctx.lead_by,
          final_by: ctx.final_by, approver_ip: req.ip || null } });
      await logAudit(req, { db: c, action: 'import_apply', entity: 'import_batch', entityId: id,
        summary: `${r2.applied} applied, ${r2.skipped} skipped`, newValue: r2, context: ctx });
      return { applied: true, applied_changes: r2.applied, skipped_changes: r2.skipped, batch: u };
    }
    return { applied: false, batch: u };
  });
  if (result.applied) logSystem('import_applied', `import batch ${id} applied`, result);
  publishBatch(result.batch);
  delete result.batch;
  res.json(result);
});

r.post('/:id/reject', async (req, res) => {
  const id = idParam(req.params.id);
  const reason = str(req.body?.reason, 1000);
  if (!reason) throw bad('reason_required');
  const meta = await loadMeta();
  const rejected = await tx(async c => {
    const b = (await c.query('SELECT * FROM import_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!b) throw notFound();
    if (b.status !== 'pending') throw bad('batch_not_pending', { status: b.status });
    if (!abilities(req.user, b, meta, (await batchApps(c, [id])).get(id)).reject) throw new HttpError(403, 'cannot_approve', { stage: 'reject' });
    await c.query(`UPDATE import_batches SET status='rejected', rejected_by=$2, rejected_at=now(), reject_reason=$3 WHERE id=$1`, [id, req.user.id, reason]);
    await logAudit(req, { db: c, action: 'import_reject', entity: 'import_batch', entityId: id, summary: reason,
      context: { ...await batchContext(c, b), reason } });
    return b;
  });
  publishBatch(rejected);
  res.json({ ok: true });
});

export default r;

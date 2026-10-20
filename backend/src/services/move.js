// Moving function / report items to another application, possibly of another department (1.10.0, migration 019).
//
//   - the item keeps its id, its values (weight, progress, statuses, note), its exclusion reason and duplicate links;
//     it gets a new "C<n>" code in the destination (services/functions.js nextCode) and goes to the end of its list;
//   - where it came from is kept in function_moves (the badge «منقول من …», the seed guard, code numbering, logs);
//   - fixed weighting mode: the item's share of the source application's weight goes with it (weightTransfer below);
//     auto mode: nothing to transfer, an application's weight is the sum of its counted items;
//   - one strict audit row per item ('move'), plus the two applications' weight changes when a share moved.
// Who may move: permission 'mov' and both applications in scope (routes/tracker.js). Directly when the user is an
// approver of both applications, holds 'cfg' or 'apv_final', or approvals are off; otherwise a 'move_function'
// request approved by the source application's team lead, then the destination's (routes/approvals.js).
import { appCalc, CALC_FUNCTIONS_SQL } from './calc.js';
import { getSetting } from './settings.js';
import { hasPerm, canSeeApp } from '../middleware/auth.js';
import { isAppApprover, requestContext } from './edits.js';
import { loadUser, userRef, originIp } from './audit.js';
import { logAudit } from './logs.js';
import { nextCode } from './functions.js';
import { NOTE_MIN, NOTE_MAX } from './disable.js';
import { HttpError, bad } from '../utils/http.js';

export const MOVE_MAX = 200;                       // items in one bulk move
export const REASON_MIN = NOTE_MIN, REASON_MAX = NOTE_MAX;   // same rule as a rename / an exclusion note
export const APP_WEIGHT_MAX = 1000;                // as PUT /tracker/weights

// The reason of a move: required, 3–500 characters, spaces not counted.
export function parseMoveReason(raw) {
  if (raw === undefined || raw === null) throw bad('move_reason_required', { min: REASON_MIN });
  if (typeof raw !== 'string') throw bad('invalid_value', { field: 'reason' });
  const reason = raw.trim();
  if (reason.length > REASON_MAX) throw bad('invalid_value', { field: 'reason', max: REASON_MAX });
  if (reason.replace(/\s/gu, '').length < REASON_MIN) throw bad('move_reason_required', { min: REASON_MIN });
  return reason;
}

// Does this user's move from src to dst wait for the team leads? (apps: { id, department_id })
export async function moveNeedsApproval(user, src, dst) {
  if (!(await getSetting('approval.edits_need_lead'))) return false;
  if (hasPerm(user, 'cfg') || hasPerm(user, 'apv_final')) return false;     // administrators, project / technical managers
  return !(isAppApprover(user, src) && isAppApprover(user, dst));
}

const cents = v => Math.round((+v || 0) * 100);

/**
 * The application weight that goes with the items (pure; srcFunctions: the source application's rows as
 * CALC_FUNCTIONS_SQL, i.e. not removed). Fixed mode:
 *   share = weight(src) × Σ weight(moved items that count) / Σ weight(src items that count)
 * where "count" = enabled (and not removed): the denominator is appCalc().weight, the very weight auto mode gives the
 * application. An excluded item carries 0; a zero denominator carries 0. Every item of a bulk move is measured
 * against the source as it is BEFORE the move, so the order does not matter. The total is rounded to 0.01 (the scale
 * of applications.weight, numeric(6,2)) and never exceeds weight(src) (src never goes negative); the source loses
 * exactly what the destination gains, so the sum of the two weights is unchanged. Per-item shares are rounded too and
 * the rounding remainder is put on the last counted item, so they add up to the total.
 * Auto mode: nothing is transferred (0).
 */
export function weightTransfer({ mode, srcWeight, srcFunctions, ids }) {
  const set = new Set(ids);
  const per = new Map(ids.map(id => [id, 0]));
  const denominator = appCalc(srcFunctions, 0).weight;
  const counted = srcFunctions.filter(f => set.has(f.id) && f.enabled);
  const movedWeight = counted.reduce((s, f) => s + +f.weight, 0);
  const srcC = cents(srcWeight);
  if (mode === 'auto' || !(denominator > 0) || !counted.length) {
    return { mode: mode === 'auto' ? 'auto' : 'fixed', share: 0, per, denominator, moved_weight: movedWeight, clamped: false,
      src_before: srcC / 100, src_after: srcC / 100 };
  }
  const raw = (+srcWeight * movedWeight) / denominator;
  const totalC = Math.max(0, Math.min(Math.round(raw * 100), srcC));
  let used = 0;
  counted.forEach((f, i) => {
    const c = i === counted.length - 1 ? totalC - used : Math.max(0, Math.min(Math.round(((+srcWeight * +f.weight) / denominator) * 100), totalC - used));
    per.set(f.id, c / 100);
    used += c;
  });
  return { mode: 'fixed', share: totalC / 100, per, denominator, moved_weight: movedWeight, clamped: Math.round(raw * 100) > srcC,
    src_before: srcC / 100, src_after: (srcC - totalC) / 100 };
}

// The destination's weight once the share is added: refused (409) above the limit of an application weight.
export function destinationWeight(dstWeight, share) {
  const after = (cents(dstWeight) + cents(share)) / 100;
  if (after > APP_WEIGHT_MAX) throw new HttpError(409, 'move_weight_out_of_range', { max: APP_WEIGHT_MAX, after });
  return after;
}

/**
 * Items that cannot be moved now (409): removed, an edit request still pending about them, or a pending import batch
 * that changes them. exceptRequest: the move request being approved (its own items do not block it).
 * fns: rows { id, code, removed_at }.
 */
export async function checkMovable(c, fns, { exceptRequest = null } = {}) {
  const removed = fns.filter(f => f.removed_at);
  if (removed.length) throw new HttpError(409, 'move_function_removed', { items: removed.map(f => ({ function_id: f.id, code: f.code })) });
  const ids = fns.map(f => f.id);
  const code = new Map(fns.map(f => [f.id, f.code]));
  const reqs = (await c.query(`SELECT DISTINCT i.function_id, r.id AS request_id FROM edit_request_items i JOIN edit_requests r ON r.id=i.request_id
    WHERE r.status='pending' AND i.function_id = ANY($1) AND r.id IS DISTINCT FROM $2::int ORDER BY 1, 2`, [ids, exceptRequest])).rows;
  if (reqs.length) {
    throw new HttpError(409, 'move_pending_request', { items: reqs.map(x => ({ function_id: x.function_id, code: code.get(x.function_id), request_id: x.request_id })),
      list: [...new Set(reqs.map(x => code.get(x.function_id)))].join('، ') });
  }
  const imps = (await c.query(`SELECT DISTINCT ch.function_id, b.id AS batch_id FROM import_changes ch JOIN import_batches b ON b.id=ch.batch_id
    WHERE b.status='pending' AND ch.function_id = ANY($1) ORDER BY 1, 2`, [ids])).rows;
  if (imps.length) {
    throw new HttpError(409, 'move_pending_import', { items: imps.map(x => ({ function_id: x.function_id, code: code.get(x.function_id), batch_id: x.batch_id })),
      list: [...new Set(imps.map(x => code.get(x.function_id)))].join('، ') });
  }
}

const weightMode = async c => (await c.query(`SELECT value FROM settings WHERE key='calc.weight_mode'`)).rows[0]?.value === 'auto' ? 'auto' : 'fixed';
const userName = async (c, id) => (id ? (await c.query('SELECT full_name, username FROM users WHERE id=$1', [id])).rows[0] : null);
const names = (x, p) => ({ [p + '_name_ar']: x.name_ar, [p + '_name_en']: x.name_en });

/**
 * Moves the items (ids, all in application srcId) to dstId inside the caller's transaction c. The two applications
 * are locked FOR UPDATE in id order (no deadlock between two moves in opposite directions), then the items; every
 * check is made again on the locked rows, the weight share is computed from the source as it is now.
 * actor / actorIp / context: an approved request — the move is recorded in the requester's name (services/edits.js).
 * Returns { items: [{ function_id, from_code, to_code, weight_share }], weight: {...}, src, dst } — the caller publishes
 * the live change and the notification after COMMIT.
 */
export async function applyMove(c, req, { srcId, dstId, ids, reason, userId = req.user.id, actor = null, actorIp = null, context = null, requestId = null }) {
  const apps = (await c.query(`SELECT a.*, d.name_ar AS dept_name_ar, d.name_en AS dept_name_en FROM applications a
    JOIN departments d ON d.id=a.department_id WHERE a.id = ANY($1) ORDER BY a.id FOR UPDATE OF a`, [[srcId, dstId]])).rows;
  const src = apps.find(a => a.id === srcId), dst = apps.find(a => a.id === dstId);
  if (!dst) throw new HttpError(409, 'move_target_missing', { application: dstId });
  if (!src) throw new HttpError(409, 'move_source_changed');
  const fns = (await c.query('SELECT * FROM functions WHERE id = ANY($1) ORDER BY sort, id FOR UPDATE', [ids])).rows;
  if (fns.length !== new Set(ids).size) throw new HttpError(409, 'move_source_changed', { missing: ids.filter(id => !fns.some(f => f.id === id)) });
  const away = fns.filter(f => f.app_id !== srcId);
  if (away.length) throw new HttpError(409, 'move_source_changed', { items: away.map(f => ({ function_id: f.id, code: f.code, app_id: f.app_id })) });
  await checkMovable(c, fns, { exceptRequest: requestId });

  const mode = await weightMode(c);
  const srcFunctions = (await c.query(CALC_FUNCTIONS_SQL + ' AND app_id=$1', [srcId])).rows;
  const tr = weightTransfer({ mode, srcWeight: src.weight, srcFunctions, ids: fns.map(f => f.id) });
  const dstAfter = tr.share > 0 ? destinationWeight(dst.weight, tr.share) : +dst.weight;
  const weight = { mode: tr.mode, share: tr.share, src: { before: +src.weight, after: tr.src_after }, dst: { before: +dst.weight, after: dstAfter } };
  const ctxBase = { ...(context || {}), from_app_id: src.id, from_dept_id: src.department_id, to_app_id: dst.id, to_dept_id: dst.department_id,
    ...names(src, 'from_app'), ...names({ name_ar: src.dept_name_ar, name_en: src.dept_name_en }, 'from_dept'),
    ...names(dst, 'to_app'), ...names({ name_ar: dst.dept_name_ar, name_en: dst.dept_name_en }, 'to_dept'),
    weight_mode: tr.mode, ...(requestId ? { request_id: requestId } : {}), ...(fns.length > 1 ? { bulk: true, count: fns.length } : {}) };

  const out = [];
  for (const f of fns) {
    const code = await nextCode(c, dstId);
    const sort = (await c.query('SELECT COALESCE(max(sort), 0) + 1 AS s FROM functions WHERE app_id=$1', [dstId])).rows[0].s;
    await c.query('UPDATE functions SET app_id=$2, code=$3, sort=$4, updated_at=now(), updated_by=$5 WHERE id=$1', [f.id, dstId, code, sort, userId]);
    const share = tr.per.get(f.id) || 0;
    await c.query(`INSERT INTO function_moves(function_id, from_app_id, to_app_id, from_code, to_code, from_dept_id, to_dept_id, weight_mode,
        weight_share, reason, moved_by, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [f.id, srcId, dstId, f.code, code, src.department_id, dst.department_id, tr.mode, share, reason, userId, requestId]);
    await logAudit(req, { db: c, actor, actorIp, action: 'move', entity: 'function', entityId: f.id,
      summary: `${srcId}/${f.code} → ${dstId}/${code} ${f.name_ar.slice(0, 80)}`,
      oldValue: { app_id: srcId, dept_id: src.department_id, code: f.code, app_weight_src: weight.src.before },
      newValue: { app_id: dstId, dept_id: dst.department_id, code, app_weight_dst: weight.dst.after, weight_share: share, reason },
      context: { ...ctxBase, code_before: f.code, code_after: code, name_ar: f.name_ar, name_en: f.name_en, item_type: f.item_type,
        enabled: f.enabled, src_weight: weight.src, dst_weight: weight.dst, total_share: tr.share } });
    out.push({ function_id: f.id, from_code: f.code, to_code: code, weight_share: share, enabled: f.enabled });
  }

  if (tr.share > 0) {
    // the Weights history shows both changes, with the reason of the move
    const codes = out.map(x => x.from_code);
    const why = `نقل البند ${codes.join('، ')} من ${src.name_ar} إلى ${dst.name_ar}`;
    for (const [a, w] of [[src, weight.src], [dst, weight.dst]]) {
      await c.query('UPDATE applications SET weight=$2, updated_at=now(), updated_by=$3 WHERE id=$1', [a.id, w.after, userId]);
      await logAudit(req, { db: c, actor, actorIp, action: 'update', entity: 'application', entityId: a.id, summary: 'weight',
        oldValue: { weight: w.before }, newValue: { weight: w.after },
        context: { ...ctxBase, via: context?.via || 'move', move: true, reason: why, move_reason: reason, codes, function_ids: out.map(x => x.function_id),
          weight_share: tr.share, side: a.id === src.id ? 'source' : 'destination' } });
    }
  }
  return { items: out, weight, src: { id: src.id, department_id: src.department_id }, dst: { id: dst.id, department_id: dst.department_id },
    by: await userName(c, userId) };
}

// Weight share the items would carry if the move were made now (approval screen: request time vs now).
export async function currentShare(c, srcId, ids) {
  const a = (await c.query('SELECT weight FROM applications WHERE id=$1', [srcId])).rows[0];
  if (!a) return null;
  const srcFunctions = (await c.query(CALC_FUNCTIONS_SQL + ' AND app_id=$1', [srcId])).rows;
  const tr = weightTransfer({ mode: await weightMode(c), srcWeight: a.weight, srcFunctions, ids });
  return { mode: tr.mode, share: tr.share, src_before: tr.src_before, src_after: tr.src_after,
    still_in_source: ids.every(id => srcFunctions.some(f => f.id === id)) };
}

// The history of moves of these items (application page: badge and details). Names of an application / department
// outside the reader's scope are left out (as the duplicate links, services/disable.js).
export async function movesOf(c, user, ids) {
  if (!ids.length) return new Map();
  const rows = (await c.query(`SELECT m.id, m.function_id, m.from_app_id, m.to_app_id, m.from_code, m.to_code, m.from_dept_id, m.to_dept_id,
      m.weight_mode, m.weight_share, m.reason, m.moved_at, m.request_id, u.full_name AS moved_by_name,
      fa.name_ar AS from_app_name_ar, fa.name_en AS from_app_name_en, fd.name_ar AS from_dept_name_ar, fd.name_en AS from_dept_name_en,
      ta.name_ar AS to_app_name_ar, ta.name_en AS to_app_name_en, td.name_ar AS to_dept_name_ar, td.name_en AS to_dept_name_en
    FROM function_moves m LEFT JOIN users u ON u.id=m.moved_by
      JOIN applications fa ON fa.id=m.from_app_id JOIN departments fd ON fd.id=m.from_dept_id
      JOIN applications ta ON ta.id=m.to_app_id JOIN departments td ON td.id=m.to_dept_id
    WHERE m.function_id = ANY($1) ORDER BY m.moved_at, m.id`, [ids])).rows;
  const out = new Map();
  for (const m of rows) {
    for (const side of ['from', 'to']) {
      if (!canSeeApp(user, { id: m[side + '_app_id'], department_id: m[side + '_dept_id'] })) {
        for (const k of ['_app_name_ar', '_app_name_en', '_dept_name_ar', '_dept_name_en']) m[side + k] = null;
      }
    }
    (out.get(m.function_id) || out.set(m.function_id, []).get(m.function_id)).push(m);
  }
  return out;
}

/**
 * Approval of a 'move_function' request (routes/approvals.js; the caller checked that req.user may approve the stage
 * that is due and that the requester is still allowed — requesterBlocked). Two stages: the source application's team
 * lead, then the destination's; an approver of both completes the two at once. Every item is checked again at each
 * stage; at the last one the move is applied in the requester's name (the approvers in its context), with the weight
 * share computed from the source as it is now. Returns { applied, stage, result?, out? }.
 */
export async function approveMove(c, rq, req, { reason = null } = {}) {
  const apps = (await c.query('SELECT id, department_id FROM applications WHERE id = ANY($1)', [[rq.app_id, rq.target_app_id]])).rows;
  const dst = apps.find(a => a.id === rq.target_app_id);
  if (!dst) throw new HttpError(409, 'move_target_missing', { application: rq.target_app_id });
  const items = (await c.query(`SELECT * FROM edit_request_items WHERE request_id=$1 AND field='move' ORDER BY id`, [rq.id])).rows;
  const ids = items.map(i => i.function_id).filter(Boolean);
  const fns = (await c.query('SELECT id, app_id, code, removed_at FROM functions WHERE id = ANY($1)', [ids])).rows;
  if (!ids.length || fns.length !== ids.length || fns.some(f => f.app_id !== rq.app_id)) {
    throw new HttpError(409, 'move_source_changed', { items: fns.filter(f => f.app_id !== rq.app_id).map(f => ({ function_id: f.id, code: f.code, app_id: f.app_id })) });
  }
  await checkMovable(c, fns, { exceptRequest: rq.id });
  const stage = rq.source_approved_by ? 'target' : 'source';
  let sourceBy = rq.source_approved_by;
  if (stage === 'source') {
    sourceBy = req.user.id;
    await c.query('UPDATE edit_requests SET source_approved_by=$2, source_approved_at=now() WHERE id=$1', [rq.id, req.user.id]);
    if (!isAppApprover(req.user, dst)) {
      await logAudit(req, { db: c, action: 'edit_approve_source', entity: 'edit_request', entityId: rq.id,
        summary: `${rq.app_id} → ${rq.target_app_id}: source approved`, newValue: { stage: 'source' },
        context: await requestContext(c, rq, req, { reason, stage: 'source' }) });
      return { applied: false, stage: 'source' };
    }
  }
  await c.query('UPDATE edit_requests SET target_approved_by=$2, target_approved_at=now() WHERE id=$1', [rq.id, req.user.id]);
  const actor = userRef(await loadUser(c, rq.requested_by));
  const actorIp = await originIp(c, 'edit_request', 'edit_request', rq.id);
  const via = { via: 'edit_request', request_id: rq.id, requested_by: actor, approved_by: userRef(req.user), approver_ip: req.ip || null,
    source_approved_by: userRef(await loadUser(c, sourceBy)), target_approved_by: userRef(req.user) };
  const out = await applyMove(c, req, { srcId: rq.app_id, dstId: rq.target_app_id, ids, reason: rq.meta?.reason || items[0]?.meta?.reason || '—',
    userId: rq.requested_by, actor, actorIp, context: via, requestId: rq.id });
  await c.query('UPDATE edit_request_items SET applied=true, note=NULL WHERE request_id=$1', [rq.id]);
  const result = { applied: out.items.length, skipped: 0, moved: out.items, weight: out.weight };
  await c.query(`UPDATE edit_requests SET status='applied', decided_by=$2, decided_at=now(), reason=$3, apply_result=$4 WHERE id=$1`,
    [rq.id, req.user.id, reason, JSON.stringify(result)]);
  const done = stage === 'source' ? 'both' : 'target';
  await logAudit(req, { db: c, action: 'edit_approve', entity: 'edit_request', entityId: rq.id,
    summary: `${rq.app_id} → ${rq.target_app_id}: ${out.items.length} moved`, newValue: { applied: out.items.length, skipped: 0, weight_share: out.weight.share },
    context: await requestContext(c, rq, req, { reason, stage: done }) });
  return { applied: true, stage: done, result, out };
}

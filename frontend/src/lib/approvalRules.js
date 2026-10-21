// Edit requests (backend routes/approvals.js): how a request's changes read, which approval stage a move waits for,
// what the answer of approve / reject / withdraw / approve-all says, and who sees the approvals screen. Plain data and
// functions, no imports: used by pages/Approvals.jsx and the mobile app (mobile/src/shared/web.ts). The server decides
// what each user may do (request.can.approve / reject / withdraw / approve_as); the screens only show it.

export const RQ_STATUSES = ['pending', 'applied', 'rejected', 'superseded', 'withdrawn'];
export const RQ_STATUS_COLOR = { pending: 'orange', applied: 'green', rejected: 'red', superseded: 'gray', withdrawn: 'gray' };
export const RQ_FIELD_LABEL = { progress: 'progress', weight: 'weight', enabled: 'enabled', test_status: 'test_status',
  notif_status: 'notif_status', review_status: 'review_status', note: 'note', status: 'report_status', name_ar: 'au_f_name_ar', name_en: 'au_f_name_en',
  create: 'fn_add', removed: 'fn_remove', item_type: 'item_type', move: 'mv_field' };

// A before / after value of a request item as text. h: { t, nm, pc }; kind: 'function' | 'report'.
export function fmtChange(h, kind, field, v) {
  const { t, nm, pc } = h;
  if (v === null || v === undefined || v === '') return '—';
  // a move (1.10.0): before = «application/code», after = the destination application
  if (field === 'move') return v.code ? `${v.app_id}/${v.code}` : nm(v) || v.app_id;
  if (field === 'create') return `${v.name_ar} · ${t('weight')} ⁦${v.weight}⁩ · ⁦${pc(v.progress)}%⁩ · ${v.enabled ? t('include_in_calc') : t('exclude_hint')}`
    + (v.item_type === 'report' ? ' · ' + t('it_report') : '');
  if (field === 'item_type') return t('it_' + v);
  if (field === 'removed') return v.removed ? `${t('fn_state_removed')}${v.reason ? ' — ' + v.reason : ''}` : t('fn_state_present');
  const P = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_' };
  if (P[field]) return t(P[field] + v);
  if (kind === 'report' && field === 'status') return t('rs_' + v);
  if (field === 'progress') return pc(v) + '%';
  if (field === 'enabled') return v ? t('yes') : t('no');
  return String(v);
}

// The rename reason is shown once per item: on its Arabic name, or on its English name when only that changes.
export const showRenameReason = (i, items) => !!i.meta?.rename_reason &&
  (i.field === 'name_ar' || !items.some(x => x.function_id === i.function_id && x.field === 'name_ar'));

// A move request (1.10.0) needs two approvals: the source application's team lead, then the destination's.
//   sourceDone / targetDone: who signed and when; waitKey: the message of the stage still awaited (pending only).
export function moveStage(rq) {
  return {
    sourceDone: rq.source_approved_by_name ? { name: rq.source_approved_by_name, at: rq.source_approved_at } : null,
    targetDone: rq.target_approved_by_name ? { name: rq.target_approved_by_name, at: rq.target_approved_at } : null,
    waiting: rq.status === 'pending' ? (rq.source_approved_by ? 'target' : 'source') : null,
    waitKey: rq.status === 'pending' ? (rq.source_approved_by ? 'mv_rq_wait_target' : 'mv_rq_wait_source') : null,
  };
}
export const isMoveRequest = rq => rq.kind === 'move_function';
// Label of the approve button: «اعتماد», or for a move «اعتماد المصدر» / «اعتماد الوجهة» / «اعتماد المرحلتين».
export const approveLabelKey = can => (can?.approve_as ? 'approve_' + can.approve_as : 'approve');
export const canApproveAny = requests => (requests || []).some(r => r.can?.approve);

// The toast after a decision ({ key, vars, kind }).
export function decisionToast(r) {
  if (r?.applied) return { key: 'applied_result', vars: { a: r.applied_changes, s: r.skipped_changes }, kind: 'green' };
  if (r?.stage === 'source') return { key: 'mv_source_approved', vars: {}, kind: 'green' };
  return { key: 'saved', vars: {}, kind: 'green' };
}
// The toasts after «اعتماد الكل»: what was applied, then the requests left pending (red) when there are any.
export function approveAllToasts(r) {
  const out = [{ key: 'applied_result', vars: { a: r.applied_changes, s: r.skipped_changes }, kind: 'green' }];
  if (r.blocked_requests) out.push({ key: 'blocked_requests_n', vars: { n: r.blocked_requests }, kind: 'red' });
  return out;
}
// A rejection needs a reason (also enforced by the server: reason_required); the message key when it is missing.
export const REJECT_MAX = 1000;
export const rejectProblem = v => (String(v ?? '').trim() ? null : 'err_reason_required');

// Who needs the approvals screen: an approver (team lead / final approval), or a user with requests of their own still
// pending or waiting for them (GET /approvals/pending-count → { awaiting_me, mine }).
export const APPROVER_PERMS = ['apv_dept', 'apv_final'];
export const showsApprovals = (permissions, counts) =>
  (permissions || []).some(p => APPROVER_PERMS.includes(p)) || (counts?.mine || 0) > 0 || (counts?.awaiting_me || 0) > 0;

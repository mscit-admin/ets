// Phase 2: the approval rules shared with the web (frontend/src/lib/approvalRules.js) — stages of a move, button labels,
// the toasts after a decision, the reject rule, who sees the approvals tab, and how a change reads.
import {
  approveAllToasts, approveLabelKey, canApproveAny, decisionToast, fmtChange, moveStage, pc, rejectProblem, showRenameReason, showsApprovals,
} from '@/shared/web';
import { translator } from '@/lib/i18n';

const t = translator('en');
const ta = translator('ar');

describe('a move request: two approvals', () => {
  it('waits for the source, then the destination', () => {
    expect(moveStage({ status: 'pending', source_approved_by: null })).toEqual({ sourceDone: null, targetDone: null, waiting: 'source', waitKey: 'mv_rq_wait_source' });
    const half = moveStage({ status: 'pending', source_approved_by: 5, source_approved_by_name: 'خالد', source_approved_at: '2026-10-01T10:00:00Z' });
    expect(half).toMatchObject({ sourceDone: { name: 'خالد', at: '2026-10-01T10:00:00Z' }, waiting: 'target', waitKey: 'mv_rq_wait_target' });
    expect(ta(half.waitKey!)).toBe('بانتظار اعتماد رئيس فريق التطبيق الوجهة');
    expect(moveStage({ status: 'applied', source_approved_by: 5, source_approved_by_name: 'خالد', target_approved_by_name: 'منى' }))
      .toMatchObject({ waiting: null, waitKey: null, targetDone: { name: 'منى' } });
  });
  it('labels the approve button by the stage this user signs', () => {
    expect(approveLabelKey({ approve_as: 'source' })).toBe('approve_source');
    expect(approveLabelKey({ approve_as: 'both' })).toBe('approve_both');
    expect(approveLabelKey({ approve_as: null })).toBe('approve');
    expect(approveLabelKey(undefined)).toBe('approve');
    for (const k of ['approve_source', 'approve_target', 'approve_both', 'approve']) expect(t(k)).not.toBe(k);
  });
});

describe('decisions', () => {
  it('toasts like the web', () => {
    expect(decisionToast({ applied: true, applied_changes: 3, skipped_changes: 1 })).toEqual({ key: 'applied_result', vars: { a: 3, s: 1 }, kind: 'green' });
    expect(decisionToast({ applied: false, stage: 'source' }).key).toBe('mv_source_approved');
    expect(decisionToast({ ok: true }).key).toBe('saved');
    expect(approveAllToasts({ applied_changes: 4, skipped_changes: 0, blocked_requests: 0 })).toHaveLength(1);
    const two = approveAllToasts({ applied_changes: 4, skipped_changes: 0, blocked_requests: 2 });
    expect(two[1]).toEqual({ key: 'blocked_requests_n', vars: { n: 2 }, kind: 'red' });
  });
  it('a rejection needs a reason', () => {
    expect(rejectProblem('')).toBe('err_reason_required');
    expect(rejectProblem('   ')).toBe('err_reason_required');
    expect(rejectProblem('خارج النطاق')).toBeNull();
  });
  it('approve-all only when one request can be approved', () => {
    expect(canApproveAny([{ can: { approve: false } }, { can: { approve: true } }])).toBe(true);
    expect(canApproveAny([{ can: { approve: false } }])).toBe(false);
    expect(canApproveAny(undefined)).toBe(false);
  });
});

describe('who sees the approvals tab', () => {
  it('approvers, and users with requests of their own', () => {
    expect(showsApprovals(['pct', 'apv_dept'], { mine: 0, awaiting_me: 0 })).toBe(true);
    expect(showsApprovals(['apv_final'], null)).toBe(true);
    expect(showsApprovals(['pct', 'tst'], { mine: 1, awaiting_me: 0 })).toBe(true);
    expect(showsApprovals(['pct', 'tst'], { mine: 0, awaiting_me: 0 })).toBe(false);
    expect(showsApprovals([], { mine: 0 })).toBe(false);
  });
});

describe('how a change reads', () => {
  const h = { t, nm: (o: Record<string, unknown> | null | undefined) => String(o?.name_en ?? ''), pc };
  it('values of every field', () => {
    expect(fmtChange(h, 'function', 'progress', 80)).toBe(pc(80) + '%');
    expect(fmtChange(h, 'function', 'test_status', 2)).toBe('Passed');
    expect(fmtChange(h, 'function', 'enabled', false)).toBe(t('no'));
    expect(fmtChange(h, 'function', 'move', { app_id: 'att', code: 'C3' })).toBe('att/C3');
    expect(fmtChange(h, 'function', 'move', { app_id: 'att', name_en: 'Attendance' })).toBe('Attendance');
    expect(fmtChange(h, 'function', 'removed', { removed: true, reason: 'dup' })).toBe(`${t('fn_state_removed')} — dup`);
    expect(fmtChange(h, 'report', 'status', 1)).toBe(t('rs_1'));
    expect(fmtChange(h, 'function', 'note', '')).toBe('—');
    expect(fmtChange(h, 'function', 'create', { name_ar: 'جديد', weight: 1, progress: 0, enabled: true, item_type: 'report' })).toContain(t('it_report'));
  });
  it('shows a rename reason once per item', () => {
    const items = [{ function_id: 1, field: 'name_ar', meta: { rename_reason: 'r' } }, { function_id: 1, field: 'name_en', meta: { rename_reason: 'r' } },
      { function_id: 2, field: 'name_en', meta: { rename_reason: 'r' } }];
    expect(items.map(i => showRenameReason(i, items))).toEqual([true, false, true]);
  });
});

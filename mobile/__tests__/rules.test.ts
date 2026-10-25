// Phase 2: the edit rules shared with the web (frontend/src/lib/itemRules.js) and the app's own edit helpers
// (src/lib/edit.ts) — the same checks the dialogs make before sending, and the server makes again.
import {
  NOTE_MAX, PASS, REASON_MAX, blockedItemKey, blockedItems, clampNum, emptyMove, emptyReason, fmtPending, moveReady,
  moveReasonProblem, needsNote, noteProblem, noteReasons, pc, pctDelta, pendingByFunction, pendingDetails, pendingLifecycle,
  pendingSummary, progressPassProblem, reasonBody, reasonLength, reasonProblem, reasonText, renameBody, renameCheck,
  renameReasonProblem, statusPassProblem, weightDelta, countDelta, type PendingValue,
} from '@/shared/web';
import { bulkFields, canBulk, canEditAny, editability, emptyNewItem, firstBulkField, mergeRows, newItemBody, newItemReady, NO_CAN } from '@/lib/edit';
import { visibleItems } from '@/lib/items';
import { translator } from '@/lib/i18n';
import type { Can, Item } from '@/lib/types';

const t = translator('en');
const ta = translator('ar');
const item = (o: Partial<Item> = {}): Item => ({ id: 1, app_id: 'per', code: 'D1', source: 'design', name_ar: 'بند', name_en: 'Item', vendor_status: 0,
  weight: 1, progress: 50, enabled: true, test_status: 0, notif_status: 0, review_status: 0, note: '', ...o });

describe('«نجح» needs 100 %', () => {
  it('refuses «نجح» below 100 % with the web message, never fills 100 in', () => {
    const p = statusPassProblem(item({ progress: 80 }), 'test_status', PASS);
    expect(p).toEqual({ key: 'pass_needs_100_now', vars: { progress: '80' } });
    expect(t(p!.key, p!.vars)).toContain('80%');
    expect(statusPassProblem(item({ progress: 100 }), 'test_status', PASS)).toBeNull();
    // «نجح مع ملاحظة» (1) and «فشل» have no progress rule
    expect(statusPassProblem(item({ progress: 10 }), 'test_status', 1)).toBeNull();
    expect(statusPassProblem(item({ progress: 10 }), 'test_status', 3)).toBeNull();
    expect(statusPassProblem(item({ progress: 10 }), 'review_status', 2)).toBeNull();
  });
  it('refuses a progress below 100 on a passed item', () => {
    expect(progressPassProblem(item({ test_status: 2, progress: 100 }), 82.5)).toEqual({ key: 'pass_lower_blocked', vars: { progress: '82.5' } });
    expect(progressPassProblem(item({ test_status: 2, progress: 100 }), 100)).toBeNull();
    expect(progressPassProblem(item({ test_status: 1, progress: 100 }), 30)).toBeNull();
    expect(ta('pass_lower_blocked', { progress: '82.5' })).toContain('82.5%');
  });
  it('lists the items a bulk set refused', () => {
    const e = { data: { items: [{ function_id: 3, code: 'D3', error: 'pass_requires_100', current_progress: 40 }, { function_id: 4, code: 'D4', error: 'progress_below_100_while_passed', current_progress: 100 }] } };
    expect(blockedItems(e).map(x => blockedItemKey(x))).toEqual(['bulk_item_below_100', 'bulk_item_passed']);
    expect(blockedItems(new Error('x'))).toEqual([]);
  });
  it('clamps typed numbers', () => {
    expect(clampNum('120', 0, 100)).toBe(100);
    expect(clampNum('-3', 0, 100)).toBe(0);
    expect(clampNum('12,5', 0, 100)).toBe(12.5);
    expect(clampNum('abc', 0, 100)).toBeNull();
  });
});

describe('notes of "… with notes" statuses', () => {
  it('requires a note and says which status', () => {
    expect(needsNote(item({ test_status: 1 }))).toBe(true);
    expect(needsNote(item({ notif_status: 2 }))).toBe(true);
    expect(needsNote(item({ review_status: 3 }))).toBe(true);
    expect(needsNote(item({ test_status: 2, notif_status: 1, review_status: 1 }))).toBe(false);
    expect(noteReasons(t, item({ test_status: 1, review_status: 3 }))).toEqual([`${t('test_status')}: Passed with note`, `${t('review_status')}: ${t('rv_3')}`]);
  });
});

describe('reasons: 3–500 characters, spaces not counted', () => {
  it('reasonLength', () => {
    expect(reasonLength('')).toBe('required');
    expect(reasonLength('a b')).toBe('required');            // 2 characters without the space
    expect(reasonLength(' a b c ')).toBeNull();
    expect(reasonLength('x'.repeat(REASON_MAX))).toBeNull();
    expect(reasonLength('x'.repeat(REASON_MAX + 1))).toBe('too_long');
    expect(reasonLength('  ' + 'x'.repeat(REASON_MAX) + '  ')).toBeNull();     // trimmed first
  });
  it('exclusion: category, duplicates, note', () => {
    const v = emptyReason<{ id: number; app_id: string; code: string }>();
    expect(reasonProblem(v)).toBe('dr_pick_reason');
    expect(reasonProblem({ ...v, reason: 'duplicate', note: 'مكرر مع غيره' })).toBe('dr_pick_duplicates');
    expect(reasonProblem({ ...v, reason: 'other', note: 'ab' })).toBe('dr_note_required');
    expect(noteProblem({ note: 'x'.repeat(NOTE_MAX + 1) })).toBe('dr_note_too_long');
    const ok = { reason: 'duplicate', note: '  نفس الوظيفة  ', duplicates: [{ id: 7, app_id: 'per', code: 'D7' }, { id: 9, app_id: 'att', code: 'A2' }] };
    expect(reasonProblem(ok)).toBeNull();
    expect(reasonBody(ok)).toEqual({ disabled_reason: 'duplicate', disabled_note: 'نفس الوظيفة', duplicate_of: [7, 9] });
    expect(reasonBody({ ...ok, reason: 'out_of_scope' })).toEqual({ disabled_reason: 'out_of_scope', disabled_note: 'نفس الوظيفة' });
    expect(reasonText(t, 'en', { disabled_reason: 'duplicate', duplicate_of: ok.duplicates, disabled_note: 'n' }, 'per')).toBe(`${t('dr_duplicate_of_list', { codes: 'D7, att/A2' })} — n`);
    expect(t('dr_note_required', { min: 3 })).toMatch(/3/);
  });
  it('rename: name required, unchanged, duplicate name, English name cleared', () => {
    const f = item({ name_ar: 'إدخال الموظف', name_en: 'Employee entry' });
    const others = [f, item({ id: 2, name_ar: 'تقرير الرواتب' }), item({ id: 3, name_ar: 'محذوف', removed_at: '2026-01-01' })];
    expect(renameCheck(f, { ar: '', en: '', reason: 'سبب كافٍ' }, others).arProblem).toBe('rn_name_required');
    const same = renameCheck(f, { ar: 'إدخال الموظف', en: 'Employee entry', reason: 'سبب كافٍ' }, others);
    expect(same).toMatchObject({ unchanged: true, ok: false });
    const dup = renameCheck(f, { ar: ' تقرير الرواتب ', en: 'Employee entry', reason: 'سبب كافٍ' }, others);
    expect(dup).toMatchObject({ dup: true, ok: true, arChanged: true, enChanged: false });
    expect(renameCheck(f, { ar: 'محذوف', en: 'Employee entry', reason: 'سبب كافٍ' }, others).dup).toBe(false);   // removed ones do not count
    expect(renameCheck(f, { ar: 'اسم جديد', en: 'Employee entry', reason: 'ab' }, others)).toMatchObject({ rProblem: 'rn_reason_required', ok: false });
    expect(renameReasonProblem('x'.repeat(501))).toBe('rn_reason_too_long');
    const clear = renameCheck(f, { ar: 'إدخال الموظف', en: '  ', reason: ' تصحيح الاسم ' }, others);
    expect(renameBody(clear, ' تصحيح الاسم ')).toEqual({ rename_reason: 'تصحيح الاسم', name_en: null });
  });
  it('move: reason and a ready preview', () => {
    expect(moveReasonProblem('')).toBe('mv_reason_required');
    const v = { ...emptyMove, dept: 'hr', app: 'per', reason: 'يخص شؤون العاملين' };
    const data = { weight: { overflow: false } };
    expect(moveReady(v, { data, error: null, loading: false })).toBe(true);
    expect(moveReady(v, { data, error: null, loading: true })).toBe(false);
    expect(moveReady(v, { data: { weight: { overflow: true } }, error: null, loading: false })).toBe(false);
    expect(moveReady({ ...v, app: '' }, { data, error: null, loading: false })).toBe(false);
    expect(moveReady({ ...v, reason: 'ab' }, { data, error: null, loading: false })).toBe(false);
  });
});

describe('values waiting for approval', () => {
  const pending: PendingValue[] = [
    { function_id: 1, field: 'name_ar', new_value: 'اسم جديد', meta: { rename_reason: 'تصحيح' }, requested_by_name: 'سالم' },
    { function_id: 1, field: 'progress', new_value: 80, requested_by_name: 'سالم' },
    { function_id: 2, field: 'enabled', new_value: false, meta: { disabled_reason: 'out_of_scope', disabled_note: 'لاحقاً' }, requested_by_name: 'سالم' },
    { function_id: 3, field: 'move', new_value: { app_id: 'att', name_ar: 'الحضور', name_en: 'Attendance' }, requested_by_name: 'سالم' },
    { function_id: null, field: 'create', new_value: { name_ar: 'جديد' }, requested_by_name: 'سالم' },
    { function_id: 4, field: 'removed', new_value: { removed: true, reason: 'x' }, requested_by_name: 'سالم' },
  ];
  const h = (tt: typeof t, lang: 'ar' | 'en') => ({ t: tt, nm: (o: Record<string, unknown> | null | undefined) => String(o?.[`name_${lang}`] ?? ''), lang, pc, appId: 'per' });
  it('groups them per item, lifecycle apart', () => {
    const by = pendingByFunction(pending);
    expect(Object.keys(by).map(Number)).toEqual([1, 2, 3]);
    expect(pendingLifecycle(pending).map(p => p.field)).toEqual(['create', 'removed']);
  });
  it('reads like the web: «تعديل الاسم إلى «…»», progress, exclusion with its reason, move', () => {
    const by = pendingByFunction(pending);
    expect(pendingSummary(h(ta, 'ar'), by[1])).toBe('تعديل الاسم إلى «اسم جديد» · ' + ta('progress') + ' ⁦' + pc(80) + '%⁩');
    expect(pendingSummary(h(t, 'en'), by[3])).toBe(t('mv_pending', { app: 'Attendance' }));
    expect(fmtPending(h(t, 'en'), 'enabled', false, by[2][0].meta)).toBe('✗ (' + t('dr_out_of_scope') + ' — لاحقاً)');
    expect(pendingDetails(h(t, 'en'), by[1])[0]).toContain(t('rn_reason') + ': تصحيح — سالم');
  });
});

describe('impact deltas', () => {
  it('colours and signs like the web', () => {
    expect(pctDelta(40, 45.5, pc)).toEqual({ text: '+' + pc(5.5), tone: 'green' });
    expect(pctDelta(40, 39, pc)).toEqual({ text: pc(-1), tone: 'red' });
    expect(pctDelta(40, 40.01, pc)).toEqual({ text: '—', tone: 'muted' });
    expect(weightDelta(7, 6.5)).toEqual({ text: '-0.50', tone: 'plain' });
    expect(countDelta(2)).toBe('+2');
    expect(countDelta(0)).toBe('—');
  });
});

describe('what the reader may change (can flags, as the web)', () => {
  const member: Can = { pct: true, wgt: false, tst: true, tog: true, ren: true, mov: false, rep: true };
  const lead: Can = { ...member, mov: true };
  const admin: Can = { ...lead, wgt: true };
  it('an observer has no control at all', () => {
    expect(canEditAny(NO_CAN)).toBe(false);
    expect(canBulk(NO_CAN)).toBe(false);
    expect(Object.values(editability(NO_CAN, item())).some(Boolean)).toBe(false);
  });
  it('a member: no weight, no move; an excluded item keeps its values', () => {
    expect(editability(member, item())).toMatchObject({ progress: true, test: true, weight: false, move: false, rename: true, toggle: true });
    expect(editability(member, item({ enabled: false }))).toMatchObject({ progress: false, test: false, notif: false, review: false, toggle: true });
    expect(editability(admin, item())).toMatchObject({ weight: true, move: true });
    expect(editability(admin, item({ removed_at: '2026-01-01' }))).toMatchObject({ restore: true, remove: false, rename: false, move: false, progress: false });
  });
  it('bulk options in the web order', () => {
    expect(bulkFields(member)).toEqual(['progress', 'test_status', 'exclude', 'item_type']);
    expect(bulkFields(lead)).toEqual(['progress', 'test_status', 'exclude', 'item_type', 'move']);
    expect(bulkFields({ ...NO_CAN, tst: true })).toEqual(['test_status']);
    expect(firstBulkField(lead, 0)).toBe('progress');
    expect(firstBulkField(lead, 3)).toBe('exclude');
    expect(firstBulkField({ ...NO_CAN, mov: true }, 2)).toBe('move');
  });
  it('a new item needs its Arabic name', () => {
    const v = emptyNewItem();
    expect(newItemReady(v)).toBe(false);
    expect(newItemReady({ ...v, name_ar: '  ' })).toBe(false);
    expect(newItemBody({ ...v, name_ar: 'بند', weight: '2.5', progress: 'x' })).toMatchObject({ name_ar: 'بند', weight: 2.5, progress: 0, enabled: true, item_type: 'function' });
  });
});

describe('edits are not clobbered by reloads', () => {
  it('keeps the rows being saved, takes the others from the server', () => {
    const cur = [item({ id: 1, progress: 90 }), item({ id: 2, progress: 10 })];
    const server = [item({ id: 1, progress: 50 }), item({ id: 2, progress: 20 }), item({ id: 3 })];
    expect(mergeRows(server, cur, new Map([[1, 1]])).map(x => x.progress)).toEqual([90, 20, 50]);
    expect(mergeRows(server, cur, new Map())).toBe(server);
  });
  it('removed items only on request', () => {
    const list = [item({ id: 1 }), item({ id: 2, removed_at: '2026-01-01' })];
    expect(visibleItems(list, { q: '', test: '', showOff: false }).map(x => x.id)).toEqual([1]);
    expect(visibleItems(list, { q: '', test: '', showOff: false, showRemoved: true }).map(x => x.id)).toEqual([1, 2]);
  });
});

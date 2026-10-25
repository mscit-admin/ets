// Rules of editing an item (function / report) of an application: the required notes of "… with notes" statuses,
// «نجح» = 100 %, the reasons of an exclusion / a rename / a move (3–500 characters, spaces not counted), the pending
// values shown on a row, and the before → after deltas of an impact. Plain data and functions, no imports: used by
// pages/Application.jsx, components/DisableReason.jsx, RenameDialog.jsx, MoveDialog.jsx, ItemType.jsx and the mobile
// app (mobile/src/shared/web.ts). The server enforces every one of these rules again (routes/tracker.js,
// services/passRule.js, services/disable.js, services/rename.js, services/move.js); the screens check them first so
// the user sees the same message before a request is sent.

// ---- item type (1.8.0) and source
export const ITEM_TYPES = ['function', 'report'];
export const typeOf = f => (f.item_type === 'report' ? 'report' : 'function');
export const SRC_COLOR = { design: 'blue', vendor_list: 'cyan', experience: 'purple', custom: 'gray' };
export const SOURCES = ['design', 'vendor_list', 'experience', 'custom'];

// ---- statuses and their required note
// "… with notes" statuses: choosing one makes the note mandatory (also enforced by the server). A field may have
// more than one such value — test_status needs a note for both «نجح مع ملاحظة» (1) and «إعادة الاختبار» (4, 1.12.25).
export const NOTE_REQUIRED = { test_status: [1, 4], notif_status: [2], review_status: [3] };
export const STATUS_PREFIX = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_' };
export const STATUS_VALUES = [0, 1, 2, 3];
export const needsNote = f => Object.entries(NOTE_REQUIRED).some(([k, vs]) => vs.includes(f[k]));
export const NOTE_FIELD_MAX = 2000;
// Which "with notes" status(es) make the note mandatory, e.g. ["حالة الاختبار: نجح مع ملاحظة"].
export const noteReasons = (t, after) => Object.entries(NOTE_REQUIRED).flatMap(([k, vs]) => vs.filter(v => after[k] === v)
  .map(v => `${t(k)}: ${t(STATUS_PREFIX[k] + v)}`));

// ---- «نجح» = 100 % (1.8.1, auto-filled since 1.12.21)
// The test status «نجح» (2) means the item is 100 % done. Choosing «نجح» no longer needs 100 % first: selecting it now
// brings the progress up to 100 automatically (the web screen asks to confirm, then the server sets both together —
// the server is the single source of truth). The progress of a passed item still cannot be *lowered* below 100 while
// it stays «نجح» (progressPassProblem). «نجح مع ملاحظة» (1) has no progress rule. Items passed below 100 % before
// 1.8.1 are flagged (passConflict). statusPassProblem is kept for the mobile app, which still blocks «نجح» below 100.
export const PASS = 2;
export const passConflict = f => f.test_status === PASS && +f.progress < 100;
// 80 → "80", 82.5 → "82.5" (alerts)
export const pctText = v => String(Math.round((+v || 0) * 100) / 100);
// Does choosing this status mean «نجح» (PASS) on an item below 100 %? → the web screen confirms, then auto-sets 100 %.
export const passAutoFill = (f, field, v) => field === 'test_status' && v === PASS && +f.progress < 100;
// (mobile, still blocking) The message (key + values) when this status cannot be saved on item f, else null.
export const statusPassProblem = (f, field, v) =>
  (field === 'test_status' && v === PASS && +f.progress < 100 ? { key: 'pass_needs_100_now', vars: { progress: pctText(f.progress) } } : null);
// The message when this progress cannot be saved on item f, else null (lowering progress below 100 on a passed item).
export const progressPassProblem = (f, v) =>
  (f.test_status === PASS && v < 100 ? { key: 'pass_lower_blocked', vars: { progress: pctText(v) } } : null);
// The items a bulk set refused (server answer of progress_below_100_while_passed), and their line.
export const blockedItems = e => (Array.isArray(e?.data?.items) ? e.data.items : []);
export const blockedItemKey = x => (x.error === 'pass_requires_100' ? 'bulk_item_below_100' : 'bulk_item_passed');

// A number typed in a cell: clamped to [min, max]; null when it is not a number.
export const clampNum = (v, min, max) => {
  const n = Math.min(max, Math.max(min, parseFloat(String(v).replace(',', '.'))));
  return Number.isFinite(n) ? n : null;
};

// ---- reasons: 3–500 characters, spaces not counted (exclusion note 1.5.1, rename 1.9.1, move 1.10.0)
export const REASON_MIN = 3, REASON_MAX = 500;
// 'too_long' | 'required' | null
export function reasonLength(v, min = REASON_MIN, max = REASON_MAX) {
  const r = String(v ?? '').trim();
  if (r.length > max) return 'too_long';
  if (r.replace(/\s/gu, '').length < min) return 'required';
  return null;
}

// ---- exclusion (backend services/disable.js, migration 013)
export const DISABLE_REASONS = ['duplicate', 'out_of_scope', 'not_required', 'other'];
export const NOTE_MAX = REASON_MAX;
export const NOTE_MIN = REASON_MIN;           // the note is required for every reason (1.5.1)
export const emptyReason = () => ({ reason: '', note: '', duplicates: [] });
// null when the note can be sent, else the message key of the problem (same rule as the server).
export function noteProblem(v) {
  const p = reasonLength(v.note, NOTE_MIN, NOTE_MAX);
  return p === 'too_long' ? 'dr_note_too_long' : p === 'required' ? 'dr_note_required' : null;
}
// null when the reason can be sent, else the message key of what is missing.
export function reasonProblem(v) {
  if (!DISABLE_REASONS.includes(v.reason)) return 'dr_pick_reason';
  if (v.reason === 'duplicate' && !v.duplicates.length) return 'dr_pick_duplicates';
  return noteProblem(v);
}
// The request body fields of a reason.
export const reasonBody = v => ({ disabled_reason: v.reason, disabled_note: v.note.trim(),
  ...(v.reason === 'duplicate' ? { duplicate_of: v.duplicates.map(d => d.id) } : {}) });
// "D3" for a function of the same application, "att/D3" for one of another application.
export const dupCode = (d, appId) => (d.app_id && d.app_id !== appId ? `${d.app_id}/${d.code}` : d.code);
// The reason as one line of text (approvals screen, pending badges): «مكررة مع D3، D5 — note».
export function reasonText(t, lang, m, appId) {
  if (!m) return '';
  const sep = lang === 'ar' ? '، ' : ', ';
  const dups = (m.duplicate_of || []).map(d => dupCode(d, appId)).join(sep);
  const r = m.disabled_reason === 'duplicate' && dups ? t('dr_duplicate_of_list', { codes: dups }) : m.disabled_reason ? t('dr_' + m.disabled_reason) : t('dr_none');
  return [r, m.disabled_note].filter(Boolean).join(' — ');
}

// ---- rename (1.9.1, backend services/rename.js): the code stays, the Arabic name is required, the English name may be
// cleared, the reason is required. Sent on its own; a member's rename waits for the team lead (202).
export const NAME_MAX = 500;
export function renameReasonProblem(v) {
  const p = reasonLength(v);
  return p === 'too_long' ? 'rn_reason_too_long' : p === 'required' ? 'rn_reason_required' : null;
}
// The state of the rename form. others: the other items of the application (the "same name" notice).
export function renameCheck(f, { ar, en, reason }, others = []) {
  const newAr = String(ar ?? '').trim(), newEn = String(en ?? '').trim();
  const arChanged = newAr !== f.name_ar, enChanged = newEn !== (f.name_en || '');
  const arProblem = !newAr ? 'rn_name_required' : newAr.length > NAME_MAX ? 'rn_name_too_long' : null;
  const enProblem = newEn.length > NAME_MAX ? 'rn_name_too_long' : null;
  const rProblem = renameReasonProblem(reason);
  const unchanged = !arChanged && !enChanged;
  const dup = !!(arChanged && newAr && others.some(o => o.id !== f.id && !o.removed_at && (o.name_ar || '').trim().toLowerCase() === newAr.toLowerCase()));
  return { newAr, newEn, arChanged, enChanged, arProblem, enProblem, rProblem, unchanged, dup,
    ok: !arProblem && !enProblem && !rProblem && !unchanged };
}
export const renameBody = (c, reason) => ({ rename_reason: String(reason).trim(), ...(c.arChanged ? { name_ar: c.newAr } : {}),
  ...(c.enChanged ? { name_en: c.newEn || null } : {}) });

// ---- move to another application (1.10.0, backend services/move.js)
export const MOVE_MAX = 200;
export function moveReasonProblem(v) {
  const p = reasonLength(v);
  return p === 'too_long' ? 'mv_reason_too_long' : p === 'required' ? 'mv_reason_required' : null;
}
export const emptyMove = { dept: '', app: '', reason: '', touched: false };
// pv: the preview state { data, error, loading } of the destination
export const moveReady = (v, pv) => !!v.app && !moveReasonProblem(v.reason) && !!pv?.data && !pv.error && !pv.loading && !pv.data.weight.overflow;
// a department's own application when it has only one (picked for the user)
export const moveAppAfterDept = d => (d?.applications?.length === 1 ? d.applications[0].id : '');
export const num2 = v => (Number.isFinite(+v) ? (Math.round(+v * 100) / 100).toFixed(2) : '—');

// ---- before → after of an impact: the change, its sign and its colour ('muted' | 'green' | 'red')
export function pctDelta(before, after, pc) {
  const d = after - before;
  if (Math.abs(d) < 0.05) return { text: '—', tone: 'muted' };
  return { text: (d > 0 ? '+' : '') + pc(d), tone: d > 0 ? 'green' : 'red' };
}
export function weightDelta(before, after) {
  const d = after - before;
  if (Math.abs(d) < 0.005) return { text: '—', tone: 'muted' };
  return { text: (d > 0 ? '+' : '') + num2(d), tone: 'plain' };
}
export const countDelta = d => (d > 0 ? '+' + d : d || '—');

// ---- values waiting for the team lead (GET /tracker/applications/:id → pending)
export const FIELD_LABEL = { progress: 'progress', weight: 'weight', enabled: 'enabled', test_status: 'test_status',
  notif_status: 'notif_status', review_status: 'review_status', note: 'note', item_type: 'item_type',
  name_ar: 'au_f_name_ar', name_en: 'au_f_name_en', move: 'mv_field' };
export const NAME_FIELDS = new Set(['name_ar', 'name_en']);      // a pending rename (1.9.1)
// per item: { [function_id]: [{field, new_value, meta, requested_by_name}] } — add / remove / restore requests are
// listed apart (pendingLifecycle)
export function pendingByFunction(pending) {
  const out = {};
  for (const p of pending || []) if (p.function_id && p.field !== 'removed' && p.field !== 'create') (out[p.function_id] ||= []).push(p);
  return out;
}
export const pendingLifecycle = pending => (pending || []).filter(p => p.field === 'create' || p.field === 'removed');
// A pending value as text. h: { t, nm, lang, pc, appId }
export function fmtPending(h, field, v, meta) {
  const { t, nm, lang, pc, appId } = h;
  if (STATUS_PREFIX[field]) return t(STATUS_PREFIX[field] + v);
  if (field === 'progress') return '⁦' + pc(v) + '%⁩';   // keep "80.0%" in Arabic text
  if (field === 'enabled') return v ? '✓' : '✗' + (meta ? ' (' + reasonText(t, lang, meta, appId) + ')' : '');
  if (field === 'item_type') return t('it_' + v);
  if (field === 'note') return '✎';
  if (NAME_FIELDS.has(field)) return v ? '«' + v + '»' : t('rn_cleared');
  if (field === 'move') return t('mv_pending', { app: nm(v) || v?.app_id || '' });
  return String(v);
}
// The short text of a row's pending changes: «تعديل الاسم إلى «…»» · «الإنجاز 80%» …
export const pendingSummary = (h, list) => list.map(p => (NAME_FIELDS.has(p.field)
  ? h.t(p.field === 'name_ar' ? 'rn_pending' : 'rn_pending_en', { name: fmtPending(h, p.field, p.new_value) })
  : p.field === 'move' ? fmtPending(h, p.field, p.new_value)
    : `${h.t(FIELD_LABEL[p.field] || p.field)} ${fmtPending(h, p.field, p.new_value, p.meta)}`)).join(' · ');
// The long text (tooltip / details): one line per change, with the rename reason and who asked.
export const pendingDetails = (h, list) => list.map(p => `${h.t(FIELD_LABEL[p.field] || p.field)}: ${fmtPending(h, p.field, p.new_value, p.meta)}`
  + `${p.meta?.rename_reason ? ' — ' + h.t('rn_reason') + ': ' + p.meta.rename_reason : ''} — ${p.requested_by_name}`);

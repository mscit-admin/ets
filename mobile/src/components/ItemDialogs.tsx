// The editing dialogs of an application's items, as bottom sheets — ports of the web's dialogs with the same
// endpoints, rules and messages (the rules are shared: frontend/src/lib/itemRules.js):
//   NoteDialog      the note; required with a "… with notes" status (pages/Application.jsx NoteModal)
//   ReasonForm      why an item is excluded: category, the items it duplicates, note 3–500 (components/DisableReason.jsx)
//   LifecycleDialog include / exclude / remove / restore with the before → after impact (ConfirmModal)
//   RenameDialog    new names + required reason, «same name» notice (components/RenameDialog.jsx)
//   MoveDialog      module → application, required reason, impact on both apps (components/MoveDialog.jsx)
//   AddItemDialog   a new item (AddModal);  BulkDialog  «تعيين جماعي» (BulkModal);  MoveHistory
// A change by a team member answers 202 "pending": «أُرسل للاعتماد» (blue) like the web; errors show err_<code>.
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { isPending, path, qs } from '@/lib/api';
import { toast } from '@/lib/toast';
import { emptyNewItem, newItemBody, newItemPreview, newItemReady, bulkFields, firstBulkField, type BulkField } from '@/lib/edit';
import type { Can, FnOption, Item, MoveImpactData, MoveTargets } from '@/lib/types';
import {
  DISABLE_REASONS, EXTRA_MODULES, ITEM_TYPES, MOVE_MAX, NAME_MAX, NOTE_FIELD_MAX, NOTE_MAX, NOTE_MIN, REASON_MAX, REASON_MIN, STANDARD_MODULES,
  blockedItemKey, blockedItems, dupCode, emptyMove, emptyReason, moveAppAfterDept, moveReady, moveReasonProblem, needsNote,
  noteProblem, noteReasons, pctText, reasonBody, reasonProblem, renameBody, renameCheck, type MoveValue, type ReasonValue,
} from '@/shared/web';
import { colors, fontSize, space } from '@/theme';
import { ImpactTable, MoveImpact, useImpact } from './Impact';
import { MultiPicker } from './MultiPicker';
import { Choice, Input, NumStepper, SwitchRow, TextArea } from './form';
import { Sheet, SheetActions } from './Sheet';
import { Alert, Button, Txt } from './ui';

type Done = () => void;
const R = (o: object | null | undefined) => o as Record<string, unknown> | null;

function ItemLine({ f }: { f: Item }) {
  return <Txt size={fontSize.m} color={colors.gray700}><Txt w={700} size={fontSize.m} style={st.code}>{f.code}</Txt> {f.name_ar}</Txt>;
}
function ErrBox({ err }: { err: unknown }) {
  const { errText, t } = useI18n();
  if (!err) return null;
  const blocked = blockedItems(err);
  return (
    <Alert kind="red" icon="alert">
      <Txt size={fontSize.m} color={colors.text}>{errText(err)}</Txt>
      {blocked.length ? (
        <View style={st.gapXs}>
          <Txt w={700} size={fontSize.s}>{t('bulk_blocked_items', { n: ((err as { data?: { count?: number } }).data?.count) ?? blocked.length })}</Txt>
          {blocked.map(x => (
            <Txt key={x.function_id} size={fontSize.s}>{x.code} {x.name_ar} — {t(blockedItemKey(x), { progress: pctText(x.current_progress) })}</Txt>
          ))}
        </View>
      ) : null}
    </Alert>
  );
}
const sentOr = (t: (k: string) => string, r: unknown, done: string) => {
  if (isPending(r)) toast(t('sent_for_approval'), 'blue'); else toast(t(done), 'green');
};

// ---- note
export function NoteDialog({ f, pending, canEdit, onClose, onSave }: {
  f: Item; pending?: Record<string, number> | null; canEdit: boolean; onClose: () => void; onSave: (note: string) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [v, setV] = useState(f.note || '');
  const [busy, setBusy] = useState(false);
  const after = { ...f, ...(pending || {}) };
  const required = needsNote(after);
  const empty = !v.trim();
  const save = async (note: string) => { setBusy(true); try { await onSave(note); } finally { setBusy(false); } };
  return (
    <Sheet title={required ? t('note_required_title') : t('edit_note')} sub={f.name_ar} onClose={onClose}
      footer={canEdit ? (
        <View style={st.row}>
          {pending ? <Button kind="default" title={t('cancel')} onPress={onClose} style={st.flex} />
            : <Button kind="default" title={t('clear')} onPress={() => save('')} disabled={required || busy} style={st.flex} />}
          <Button title={t('save')} onPress={() => save(v)} disabled={required && empty} busy={busy} style={st.flex} testID="note-save" />
        </View>
      ) : undefined}>
      {required ? <Alert kind="orange">{t('note_required_msg')} {noteReasons(t, after).join(' · ')}</Alert> : null}
      <TextArea label={t('note')} value={v} onChangeText={setV} editable={canEdit} maxLength={NOTE_FIELD_MAX}
        placeholder={required ? t('note_required_placeholder') : ''} error={required && empty ? t('note_required_hint') : null} />
    </Sheet>
  );
}

// ---- why an item is excluded
export function ReasonForm({ appId, excludeIds, value, onChange, showErrors }: {
  appId: string; excludeIds: number[]; value: ReasonValue<FnOption>; onChange: (v: ReasonValue<FnOption>) => void; showErrors: boolean;
}) {
  const { t, nm } = useI18n();
  const { api } = useSession();
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<ReasonValue<FnOption>>) => onChange({ ...value, ...patch });
  const problem = reasonProblem(value);
  const noteErr = noteProblem(value);
  const showNoteErr = !!noteErr && (showErrors || touched);
  const load = (q: string, all: boolean) => api.get<{ options: FnOption[] }>('/tracker/function-options' + qs({
    app_id: all ? '' : appId, all: all ? 1 : '', q, exclude: excludeIds.join(',') })).then(r => r.options);
  return (
    <View style={st.gapL}>
      <Choice label={t('dr_reason')} required value={value.reason} invalid={showErrors && problem === 'dr_pick_reason'} testID="dr-reasons"
        options={DISABLE_REASONS.map(r => ({ value: r, label: t('dr_' + r), hint: t('dr_hint_' + r) }))}
        onChange={r => set({ reason: r, duplicates: r === 'duplicate' ? value.duplicates : [] })} />
      {value.reason === 'duplicate' ? (
        <MultiPicker<FnOption> value={value.duplicates} onChange={duplicates => set({ duplicates })} load={load} testID="dr-duplicates"
          label={t('dr_duplicates')} placeholder={t('dr_duplicates_placeholder')} allLabel={t('dr_search_all')} hint={t('dr_duplicates_hint')}
          invalid={showErrors && problem === 'dr_pick_duplicates'} chipLabel={o => dupCode(o, appId)}
          optionLabel={o => `${o.code} ${o.name_ar}`} optionSub={o => nm(R(o), 'app_name') || o.app_id} />
      ) : null}
      <TextArea label={t('dr_note')} required value={value.note} maxLength={NOTE_MAX + 50} placeholder={t('dr_note_placeholder')}
        onChangeText={note => { set({ note }); if (note.trim()) setTouched(true); }} onBlur={() => setTouched(true)}
        hint={t('dr_note_hint', { min: NOTE_MIN })} count={value.note.trim().length} max={NOTE_MAX}
        error={showNoteErr ? t(noteErr!, { min: NOTE_MIN }) : null} testID="dr-note" />
      {showErrors && problem && problem !== noteErr ? <Alert kind="red">{t(problem)}</Alert> : null}
    </View>
  );
}

// ---- include / exclude / remove / restore (with the impact)
export type LifecycleMode = 'include' | 'exclude' | 'remove' | 'restore';
export function LifecycleDialog({ app, f, mode, onClose, onDone, onInclude }: {
  app: { id: string }; f: Item; mode: LifecycleMode; onClose: () => void; onDone: Done;
  /** including again needs no reason: saved like the other fields (the screen's own PATCH with its in-flight rule) */
  onInclude: () => void;
}) {
  const { t } = useI18n();
  const { api } = useSession();
  const [reason, setReason] = useState('');
  const [why, setWhy] = useState<ReasonValue<FnOption>>(emptyReason);
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const body = mode === 'remove' ? { drop: [f.id] } : { set: [{ function_id: f.id, enabled: mode !== 'exclude' }] };
  const impact = useImpact(app.id, body, mode + f.id);
  const title = { remove: t('fn_remove_title'), restore: t('fn_restore_title'), include: t('include_title'), exclude: t('exclude_title') }[mode];
  const confirm = { remove: t('confirm_remove'), restore: t('confirm_restore'), include: t('confirm_include'), exclude: t('confirm_exclude') }[mode];
  const run = async () => {
    if (mode === 'include') { onInclude(); return; }
    if (mode === 'exclude') {
      setTried(true);
      if (reasonProblem(why)) return;
      setBusy(true); setErr(null);
      try {
        const r = await api.patch(path`/tracker/functions/${f.id}`, { enabled: false, ...reasonBody(why) });
        sentOr(t, r, 'fn_excluded');
        onDone();
      } catch (e) { setErr(e); setBusy(false); }
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/functions/${f.id}/${mode}`, mode === 'remove' ? { reason } : {});
      sentOr(t, r, mode === 'remove' ? 'fn_removed' : 'fn_restored');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Sheet title={title} onClose={onClose} testID={'lifecycle-' + mode}
      footer={<SheetActions onCancel={onClose} title={confirm} onPress={run} busy={busy} danger={mode === 'remove' || mode === 'exclude'}
        disabled={(mode === 'remove' && !reason.trim()) || (mode === 'exclude' && !!noteProblem(why))} testID="lifecycle-confirm" />}>
      <ErrBox err={err} />
      <ItemLine f={f} />
      {mode === 'remove' ? <Alert kind="orange">{f.source === 'custom' ? t('fn_remove_msg_custom') : t('fn_remove_msg_scope')}</Alert> : null}
      {mode === 'include' || mode === 'exclude' ? <Alert kind="blue">{mode === 'include' ? t('include_msg') : t('exclude_msg')}</Alert> : null}
      {mode === 'exclude' ? <ReasonForm appId={app.id} excludeIds={[f.id]} value={why} onChange={setWhy} showErrors={tried} /> : null}
      {mode === 'remove' ? (
        <TextArea label={t('remove_reason')} required value={reason} onChangeText={setReason} maxLength={1000} testID="remove-reason" />
      ) : null}
      <ImpactTable impact={impact} />
    </Sheet>
  );
}

// ---- rename
export function RenameDialog({ f, others, onClose, onDone }: { f: Item; others: Item[]; onClose: () => void; onDone: Done }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [ar, setAr] = useState(f.name_ar || '');
  const [en, setEn] = useState(f.name_en || '');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const c = renameCheck(f, { ar, en, reason }, others);
  const run = async () => {
    if (!c.ok || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.patch<{ warning?: string }>(path`/tracker/functions/${f.id}`, renameBody(c, reason));
      sentOr(t, r, 'rn_done');
      if (r?.warning === 'duplicate_name') toast(t('rn_duplicate_notice'), 'orange');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Sheet title={t('rn_title')} onClose={onClose} testID="rename"
      footer={<SheetActions onCancel={onClose} title={t('rn_confirm')} onPress={run} disabled={!c.ok} busy={busy} testID="rename-confirm" />}>
      <ErrBox err={err} />
      <View style={st.kv}>
        <Txt size={fontSize.s} color={colors.textMuted}>{t('rn_code')}: <Txt w={700} size={fontSize.s} style={st.code}>{f.code}</Txt> · {t('rn_code_fixed')}</Txt>
        <Txt size={fontSize.s} color={colors.textMuted}>{t('rn_current')}: <Txt size={fontSize.s}>{f.name_ar}</Txt>{f.name_en ? ` · ${f.name_en}` : ''}</Txt>
      </View>
      <TextArea label={t('rn_new_ar')} required value={ar} onChangeText={setAr} maxLength={NAME_MAX + 50}
        error={c.arProblem ? t(c.arProblem, { max: NAME_MAX }) : null} style={st.short} testID="rename-ar" />
      {c.dup ? <Alert kind="orange">{t('rn_duplicate_notice')}</Alert> : null}
      <Input label={t('rn_new_en')} value={en} onChangeText={setEn} maxLength={NAME_MAX + 50} ltr
        hint={c.enProblem ? t(c.enProblem, { max: NAME_MAX }) : t('rn_en_hint')} error={c.enProblem ? t(c.enProblem, { max: NAME_MAX }) : null} />
      <TextArea label={t('rn_reason')} required value={reason} maxLength={REASON_MAX + 50} placeholder={t('rn_reason_placeholder')}
        onChangeText={v => { setReason(v); if (v.trim()) setTouched(true); }} onBlur={() => setTouched(true)}
        hint={t('rn_reason_hint', { min: REASON_MIN })} count={reason.trim().length} max={REASON_MAX}
        error={c.rProblem && touched ? t(c.rProblem, { min: REASON_MIN }) : null} testID="rename-reason" />
      {c.unchanged && touched ? <Txt size={fontSize.s} color={colors.textMuted}>{t('rn_unchanged')}</Txt> : null}
    </Sheet>
  );
}

// ---- move to another application
type Preview = { data: MoveImpactData | null; error: unknown; loading: boolean };
const moduleOf = (id: string) => [...STANDARD_MODULES, ...EXTRA_MODULES].find(m => m.depts.includes(id)) || null;

function useMoveTargets(appId: string) {
  const { api } = useSession();
  const [v, setV] = useState<{ departments: MoveTargets['departments'] | null; error: unknown }>({ departments: null, error: null });
  useEffect(() => {
    let alive = true;
    api.get<MoveTargets>(path`/tracker/move-targets` + qs({ app_id: appId }))
      .then(r => { if (alive) setV({ departments: r.departments, error: null }); })
      .catch(e => { if (alive) setV({ departments: [], error: e }); });
    return () => { alive = false; };
  }, [api, appId]);
  return v;
}
function useMovePreview(appId: string, ids: number[], toApp: string, single: boolean): Preview {
  const { api } = useSession();
  const key = toApp && ids.length ? `${toApp}|${ids.join(',')}` : '';
  const [res, setRes] = useState<{ key: string; data: MoveImpactData | null; error: unknown }>({ key: '', data: null, error: null });
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const [to, list] = key.split('|');
    const idList = list.split(',').map(Number);
    const h = setTimeout(() => {
      const req = single ? api.post<MoveImpactData>(path`/tracker/functions/${idList[0]}/move/preview`, { to_app_id: to })
        : api.post<MoveImpactData>(path`/tracker/applications/${appId}/bulk-move/preview`, { to_app_id: to, function_ids: idList });
      req.then(r => { if (alive) setRes({ key, data: r, error: null }); }).catch(e => { if (alive) setRes({ key, data: null, error: e }); });
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [api, appId, key, single]);
  // the answer for what is chosen now; while it is on its way: loading
  return useMemo(() => (!key ? { data: null, error: null, loading: false }
    : res.key === key ? { data: res.data, error: res.error, loading: false } : { data: null, error: null, loading: true }), [key, res]);
}

export function MoveFields({ appId, ids, single, value, onChange, onPreview, showErrors }: {
  appId: string; ids: number[]; single?: boolean; value: MoveValue; onChange: (v: MoveValue) => void; onPreview: (p: Preview) => void; showErrors: boolean;
}) {
  const { t, nm, errText } = useI18n();
  const { departments, error } = useMoveTargets(appId);
  const dept = departments?.find(d => d.id === value.dept) || null;
  const pv = useMovePreview(appId, ids, value.app, !!single);
  useEffect(() => { onPreview(pv); }, [pv]); // eslint-disable-line react-hooks/exhaustive-deps
  const rProblem = moveReasonProblem(value.reason);
  const showReasonErr = !!rProblem && (showErrors || value.touched);
  if (error) return <Alert kind="red">{errText(error)}</Alert>;
  if (!departments) return <Txt size={fontSize.s} color={colors.textMuted}>{t('loading')}…</Txt>;
  if (!departments.length) return <Alert kind="orange">{t('mv_no_targets')}</Alert>;
  return (
    <View style={st.gapL}>
      <Choice label={t('mv_module')} required value={value.dept} testID="mv-module"
        options={departments.map(d => {
          const m = moduleOf(d.id);
          const mod = m ? nm(R(m)) : null;
          return { value: d.id, label: nm(R(d)), hint: mod && mod !== nm(R(d)) ? mod : undefined };
        })}
        onChange={id => onChange({ ...value, dept: id, app: moveAppAfterDept(departments.find(x => x.id === id)) })} />
      {dept ? (
        <Choice label={t('mv_app')} required value={value.app} testID="mv-app"
          options={dept.applications.map(a => ({ value: a.id, label: nm(R(a)) }))} onChange={id => onChange({ ...value, app: id })} />
      ) : <Txt size={fontSize.s} color={colors.textMuted}>{t('mv_app_first')}</Txt>}
      <TextArea label={t('mv_reason')} required value={value.reason} maxLength={REASON_MAX + 50} placeholder={t('mv_reason_placeholder')}
        onChangeText={r => onChange({ ...value, reason: r, touched: value.touched || !!r.trim() })}
        onBlur={() => onChange({ ...value, touched: true })} hint={t('mv_reason_hint', { min: REASON_MIN })}
        count={value.reason.trim().length} max={REASON_MAX} error={showReasonErr ? t(rProblem!, { min: REASON_MIN }) : null} testID="mv-reason" />
      {!value.app ? <Txt size={fontSize.s} color={colors.textMuted}>{t('mv_impact_pick')}</Txt>
        : pv.error ? <Alert kind="red">{errText(pv.error)}</Alert>
          : pv.data ? (
            <View style={st.gapM}>
              {pv.data.needs_approval ? <Alert kind="blue">{t('mv_needs_approval')}</Alert> : null}
              <MoveImpact impact={pv.data} />
            </View>
          ) : <Txt size={fontSize.s} color={colors.textMuted}>{t('loading')}…</Txt>}
      <Txt size={fontSize.xs} color={colors.textMuted}>{t('mv_code_note')}</Txt>
    </View>
  );
}

export function MoveDialog({ app, f, onClose, onDone }: { app: { id: string; name_ar: string; name_en: string }; f: Item; onClose: () => void; onDone: Done }) {
  const { t, nm } = useI18n();
  const { api } = useSession();
  const [v, setV] = useState<MoveValue>(emptyMove);
  const [pv, setPv] = useState<Preview | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const ids = useMemo(() => [f.id], [f.id]);
  const ok = moveReady(v, pv);
  const run = async () => {
    setTried(true);
    if (!ok || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/functions/${f.id}/move`, { to_app_id: v.app, reason: v.reason.trim() });
      sentOr(t, r, 'mv_done');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Sheet title={t('mv_title')} onClose={onClose} full testID="move"
      footer={<SheetActions onCancel={onClose} title={t('mv_confirm')} onPress={run} disabled={!ok} busy={busy} testID="move-confirm" />}>
      <ErrBox err={err} />
      <View style={st.kv}>
        <Txt size={fontSize.s} color={colors.textMuted}>{t('mv_item')}: <Txt w={700} size={fontSize.s} style={st.code}>{f.code}</Txt> {f.name_ar}</Txt>
        <Txt size={fontSize.s} color={colors.textMuted}>{t('application')}: {nm(R(app))}</Txt>
      </View>
      <MoveFields appId={app.id} ids={ids} single value={v} onChange={setV} onPreview={setPv} showErrors={tried} />
    </Sheet>
  );
}

// ---- add an item
export function AddItemDialog({ app, onClose, onDone }: { app: { id: string }; onClose: () => void; onDone: Done }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [f, setF] = useState(emptyNewItem);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const preview = newItemPreview(f);
  const impact = useImpact(app.id, { add: preview }, JSON.stringify(preview));
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/applications/${app.id}/functions`, newItemBody(f));
      sentOr(t, r, 'fn_added');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Sheet title={t('add_function')} onClose={onClose} full testID="add-item"
      footer={<SheetActions onCancel={onClose} title={t('confirm_add')} onPress={run} disabled={!newItemReady(f)} busy={busy} testID="add-confirm" />}>
      <ErrBox err={err} />
      <TextArea label={t('fn_name_ar')} required value={f.name_ar} onChangeText={v => setF({ ...f, name_ar: v })} style={st.short} testID="add-name" />
      <Input label={t('fn_name_en')} value={f.name_en} onChangeText={v => setF({ ...f, name_en: v })} ltr />
      <Input label={t('requirement_reason')} value={f.reference} onChangeText={v => setF({ ...f, reference: v })} />
      <NumStepper label={t('weight')} value={+f.weight} min={0} max={1000} step={0.5} onCommit={v => setF(x => ({ ...x, weight: String(v) }))} />
      <NumStepper label={t('progress') + ' %'} value={+f.progress} min={0} max={100} step={5} onCommit={v => setF(x => ({ ...x, progress: String(v) }))} />
      <TypeChoice value={f.item_type} onChange={v => setF({ ...f, item_type: v })} label={t('item_type')} />
      <SwitchRow label={t('include_in_calc')} value={f.enabled} onValueChange={v => setF({ ...f, enabled: v })} />
      <ImpactTable impact={impact} />
    </Sheet>
  );
}

export function TypeChoice({ value, onChange, label, disabled }: { value: 'function' | 'report'; onChange: (v: 'function' | 'report') => void; label: string; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <Choice label={label} value={value} onChange={onChange} disabled={disabled}
      options={ITEM_TYPES.map(v => ({ value: v, label: t('it_' + v), icon: v === 'report' ? 'item_report' : 'item_function',
        hint: t(v === 'report' ? 'it_legend_report_none' : 'it_legend_function') }))} />
  );
}

// ---- «تعيين جماعي»
export function BulkDialog({ app, can, picked, onClose, onDone }: {
  app: { id: string }; can: Can; picked: FnOption[]; onClose: () => void; onDone: Done;
}) {
  const { t } = useI18n();
  const { api } = useSession();
  const options = bulkFields(can);
  const [field, setField] = useState<BulkField>(() => firstBulkField(can, picked.length));
  const [value, setValue] = useState(field === 'progress' ? 100 : 2);
  const [chosen, setChosen] = useState<FnOption[]>(picked);
  const [toType, setToType] = useState<'function' | 'report'>('report');
  const [why, setWhy] = useState<ReasonValue<FnOption>>(emptyReason);
  const [mv, setMv] = useState<MoveValue>(emptyMove);
  const [mvPreview, setMvPreview] = useState<Preview | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const exclude = field === 'exclude', retype = field === 'item_type', move = field === 'move';
  const ids = useMemo(() => chosen.map(x => x.id), [chosen]);
  const run = async () => {
    if (move) {
      setTried(true);
      if (!chosen.length || !moveReady(mv, mvPreview)) return;
      setBusy(true); setErr(null);
      try {
        const r = await api.post<{ moved?: unknown[] }>(path`/tracker/applications/${app.id}/bulk-move`, { to_app_id: mv.app, function_ids: ids, reason: mv.reason.trim() });
        if (isPending(r)) toast(t('sent_for_approval'), 'blue'); else toast(t('mv_done_n', { n: r.moved?.length ?? chosen.length }), 'green');
        onDone();
      } catch (e) { setErr(e); setBusy(false); }
      return;
    }
    let body: Record<string, unknown> = { field, value: +value };
    if (exclude) {
      setTried(true);
      if (!chosen.length || reasonProblem(why)) return;
      body = { field: 'enabled', value: false, function_ids: ids, ...reasonBody(why) };
    }
    if (retype) {
      setTried(true);
      if (!chosen.length) return;
      body = { field: 'item_type', value: toType, function_ids: ids };
    }
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ updated?: number }>(path`/tracker/applications/${app.id}/bulk`, body);
      if (isPending(r)) toast(t('sent_for_approval'), 'blue'); else toast(t('done_n', { n: r.updated ?? 0 }), 'green');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  const loadOwn = (q: string) => api.get<{ options: FnOption[] }>('/tracker/function-options' + qs({ app_id: app.id, q })).then(r => r.options);
  // a move may take excluded items too (they carry no weight)
  const loadAll = (q: string) => api.get<{ options: FnOption[] }>('/tracker/function-options' + qs({ app_id: app.id, q, with_off: 1 })).then(r => r.options);
  const picker = (label: string, none: string, load: (q: string) => Promise<FnOption[]>, testID: string) => (
    <View style={st.gapXs}>
      <MultiPicker<FnOption> value={chosen} onChange={setChosen} load={q => load(q)} label={label} placeholder={t('dr_duplicates_placeholder')}
        invalid={tried && !chosen.length} chipLabel={o => o.code} optionLabel={o => `${o.code} ${o.name_ar}`} testID={testID}
        optionSub={o => (o.enabled === false ? t('mv_not_counted') : null)} />
      {tried && !chosen.length ? <Txt size={fontSize.xs} color={colors.text}>{t(none)}</Txt> : null}
    </View>
  );
  const label = { progress: t('bulk_progress'), test_status: t('bulk_test'), exclude: t('bulk_exclude'), item_type: t('bulk_type'), move: t('bulk_move') };
  const confirm = exclude ? t('confirm_exclude_n', { n: chosen.length }) : retype ? t('confirm_type_n', { n: chosen.length })
    : move ? t('mv_confirm_n', { n: chosen.length }) : t('apply');
  return (
    <Sheet title={move ? t('mv_title_bulk') : t('bulk_set')} onClose={onClose} full testID="bulk"
      footer={<SheetActions onCancel={onClose} title={confirm} onPress={run} busy={busy} danger={exclude} testID="bulk-confirm"
        disabled={(exclude && !!noteProblem(why)) || (move && (!chosen.length || chosen.length > MOVE_MAX || !moveReady(mv, mvPreview)))} />}>
      <ErrBox err={err} />
      <Choice label={t('bulk_set')} value={field} testID="bulk-field"
        options={options.map(o => ({ value: o, label: label[o] }))}
        onChange={o => { setField(o); setValue(o === 'progress' ? 100 : 2); setTried(false); setErr(null); }} />
      {field === 'progress' ? (
        <NumStepper label={t('progress') + ' %'} value={value} min={0} max={100} step={5} onCommit={setValue} />
      ) : null}
      {field === 'test_status' ? (
        <Choice label={t('test_status')} value={value} onChange={setValue}
          options={[0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ value: i, label: t('ts_' + i) }))} />
      ) : null}
      {exclude ? (
        <>
          <Alert kind="blue">{t('exclude_msg')}</Alert>
          {picker(t('bulk_exclude_pick'), 'bulk_exclude_none', loadOwn, 'bulk-pick')}
          <ReasonForm appId={app.id} excludeIds={ids} value={why} onChange={setWhy} showErrors={tried} />
        </>
      ) : null}
      {retype ? (
        <>
          <Alert kind="blue">{t('bulk_type_msg')}</Alert>
          <TypeChoice value={toType} onChange={setToType} label={t('bulk_type_to')} />
          {picker(t('bulk_type_pick'), 'bulk_type_none', loadOwn, 'bulk-pick')}
        </>
      ) : null}
      {move ? (
        <>
          <Alert kind="blue">{t('bulk_move_msg', { max: MOVE_MAX })}</Alert>
          {picker(t('bulk_move_pick'), 'bulk_move_none', loadAll, 'bulk-pick')}
          <MoveFields appId={app.id} ids={ids} value={mv} onChange={setMv} onPreview={setMvPreview} showErrors={tried} />
        </>
      ) : null}
    </Sheet>
  );
}

// ---- the item's moves (the «منقول من …» badge)
export function MoveHistory({ f, onClose }: { f: Item; onClose: () => void }) {
  const { t, nm, fmtDate } = useI18n();
  const place = (m: Record<string, unknown>, side: 'from' | 'to') =>
    `${nm(m, side + '_app_name') || m[side + '_app_id']}${nm(m, side + '_dept_name') ? ' (' + nm(m, side + '_dept_name') + ')' : ''}`;
  return (
    <Sheet title={t('mv_history_title')} sub={`${f.code} ${f.name_ar}`} onClose={onClose}>
      {(f.moves || []).map(m => {
        const r = m as unknown as Record<string, unknown>;
        return (
          <View key={m.id} style={st.hist}>
            <Txt w={600} size={fontSize.s}>{fmtDate(m.moved_at)} · {m.moved_by_name || '—'}</Txt>
            <Txt size={fontSize.s}>{t('mv_history_from')}: {place(r, 'from')} {m.from_code}</Txt>
            <Txt size={fontSize.s}>{t('mv_history_to')}: {place(r, 'to')} {m.to_code}</Txt>
            <Txt size={fontSize.s} color={colors.textMuted}>{t('mv_history_share')}: {m.weight_mode === 'auto' ? '—' : (+(m.weight_share ?? 0)).toFixed(2)}</Txt>
            {m.request_id ? <Txt size={fontSize.xs} color={colors.textMuted}>{t('mv_history_request', { id: m.request_id })}</Txt> : null}
            {m.reason ? <Txt size={fontSize.s} color={colors.gray700}>{t('reason')}: {m.reason}</Txt> : null}
          </View>
        );
      })}
    </Sheet>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  gapXs: { gap: space.xs },
  gapM: { gap: space.m },
  gapL: { gap: space.l },
  kv: { gap: 2, backgroundColor: colors.gray50, borderRadius: 8, padding: space.m },
  code: { direction: 'ltr' },
  short: { minHeight: 64 },
  hist: { gap: 2, paddingVertical: space.m, borderBottomWidth: 1, borderBottomColor: colors.border },
});

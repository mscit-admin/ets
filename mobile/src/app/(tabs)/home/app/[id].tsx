// Application (web: pages/Application.jsx): the weighted equation header (functions % + reports % = application %),
// the application's note, the requests waiting for approval, then its items as cards, 20 more each time the end of the
// list is reached. Search, test status / conflict chips, «show excluded» / «show removed» filter the list.
// Editing (phase 2) follows the server's `can` flags exactly like the web: tapping an item opens its editor (progress,
// statuses, weight, note, type, include / exclude, rename, move, remove / restore); «تعيين جماعي» works on the whole
// application or on items ticked in the list (long-press or «تحديد»); «إضافة» adds an item. A member's change answers
// 202 and waits for the team lead («أُرسل للاعتماد», then «بانتظار الاعتماد: …» on the item).
// A value the user is saving is never replaced by a reload (pull, live event, poll) before its answer comes back
// (lib/edit.ts mergeRows); a number being typed is kept until it is committed (components/form.tsx NumStepper).
// Links: ?fn=<id> brings that item into view and highlights it; ?filter=conflict shows the «نجح» below 100 % items.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { Toggle } from '@/components/Toggle';
import { useLocalSearchParams } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/useLoad';
import { ApiError, isPending, path } from '@/lib/api';
import { toast } from '@/lib/toast';
import { canBulk, canEditAny, mergeRows, NO_CAN } from '@/lib/edit';
import type { ApplicationData, FnOption, Item } from '@/lib/types';
import { colors, font, fontSize, pills, radius, space } from '@/theme';
import { AppTags } from '@/components/AppTags';
import { Icon } from '@/components/Icon';
import { ItemCard } from '@/components/ItemCard';
import { ItemEditor, type EditorAction } from '@/components/ItemEditor';
import { AddItemDialog, BulkDialog, LifecycleDialog, MoveDialog, MoveHistory, NoteDialog, RenameDialog, type LifecycleMode } from '@/components/ItemDialogs';
import { passConflict, visibleItems, type TestFilter } from '@/lib/items';
import { PctEquation } from '@/components/PctEquation';
import { TopBar } from '@/components/TopBar';
import { Alert, Button, Empty, ErrorBox, Loading, Txt, s as ui } from '@/components/ui';
import { needsNote, pc, pendingByFunction, pendingLifecycle, pendingSummary, statusPassProblem, type LiveMsg } from '@/shared/web';

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE = 20;

type Dialog =
  | { kind: 'edit'; id: number }
  | { kind: 'note'; id: number; pending?: Record<string, number> | null; back: boolean }
  | { kind: 'rename' | 'move' | 'history'; id: number; back: boolean }
  | { kind: 'life'; id: number; mode: LifecycleMode; back: boolean }
  | { kind: 'bulk'; picked: FnOption[] }
  | { kind: 'add' };

function Chip({ label, on, onPress, warn }: { label: string; on: boolean; onPress: () => void; warn?: boolean }) {
  const fg = on ? colors.white : warn ? pills.orange.text : colors.gray700;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} aria-selected={on} hitSlop={6}
      style={[st.chip, warn && !on && { backgroundColor: pills.orange.bg }, on && { backgroundColor: warn ? pills.orange.text : colors.gray900 }]}>
      {warn ? <Icon name="alert" size={13} color={fg} /> : null}
      <Txt w={600} size={fontSize.s} color={fg} style={{ lineHeight: 20 }}>{label}</Txt>
    </Pressable>
  );
}

export default function ApplicationScreen() {
  const params = useLocalSearchParams<{ id: string; fn?: string; filter?: string }>();
  const id = String(params.id);
  const { t, nm, lang, errText } = useI18n();
  const { api } = useSession();
  const [dept, setDept] = useState<string | null>(null);
  // changes to this application by other users (or project-wide ones) reload the list without losing edits
  const liveFilter = (m: LiveMsg) => (m.app_id ? m.app_id === id : !m.dept_id || m.dept_id === dept);
  const { data, error, loading, refreshing, refresh, reload, live } = useLoad(
    o => (ID.test(id) ? api.get<ApplicationData>(path`/tracker/applications/${id}`, o) : Promise.reject(new ApiError(404, 'not_found'))),
    [id], { filter: liveFilter });
  if (data && data.department?.id !== dept) setDept(data.department?.id ?? null);

  // the rows on screen: the server's, except the ones this user is saving right now
  const [fns, setFns] = useState<Item[]>([]);
  const inflight = useRef(new Map<number, number>());
  useEffect(() => { if (data) setFns(cur => mergeRows(data.functions, cur, inflight.current)); }, [data]);

  const [q, setQ] = useState('');
  const [test, setTest] = useState<TestFilter>(params.filter === 'conflict' ? 'conflict' : '');
  const [showOff, setShowOff] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [focusId, setFocusId] = useState<number | null>(null);
  const listRef = useRef<FlatList<Item>>(null);

  const shown = useMemo(() => visibleItems(fns, { q, test, showOff, showRemoved }), [fns, q, test, showOff, showRemoved]);
  const conflicts = useMemo(() => fns.filter(passConflict).length, [fns]);
  const removedCount = useMemo(() => fns.filter(f => f.removed_at).length, [fns]);
  const pendingByFn = useMemo(() => pendingByFunction(data?.pending), [data]);
  const pendingLife = useMemo(() => pendingLifecycle(data?.pending), [data]);
  const setFilter = useCallback((fn: () => void) => { fn(); setLimit(PAGE); }, []);
  const can = data?.can ?? NO_CAN;
  const editable = canEditAny(can);

  // a link to one item (?fn=<id>): show it (filters reset when they hide it), scroll to it, highlight it for a moment —
  // once per link, not on every reload
  const fnParam = Number(params.fn) || null;
  const [followed, setFollowed] = useState<{ id: number; index: number } | null>(null);
  const target = fnParam && data && followed?.id !== fnParam ? fns.find(x => x.id === fnParam) : null;
  if (target) {
    let list = shown;
    if (!shown.some(x => x.id === target.id)) {
      setQ(''); setTest(''); setShowOff(true); setShowRemoved(!!target.removed_at);
      list = visibleItems(fns, { q: '', test: '', showOff: true, showRemoved: !!target.removed_at });
    }
    const index = Math.max(0, list.findIndex(x => x.id === target.id));
    setFollowed({ id: target.id, index });
    setLimit(l => Math.max(l, index + PAGE));
    setFocusId(target.id);
  }
  useEffect(() => {
    if (!followed) return undefined;
    const h = setTimeout(() => listRef.current?.scrollToIndex({ index: followed.index, viewPosition: 0.3, animated: true }), 350);
    return () => clearTimeout(h);
  }, [followed]);
  useEffect(() => {
    if (!focusId) return undefined;
    const h = setTimeout(() => setFocusId(null), 2400);
    return () => clearTimeout(h);
  }, [focusId]);

  // one field of one item (web: patch): shown at once, sent; 202 → «أُرسل للاعتماد»; refused → back + the reason
  const patch = useCallback(async (f: Item, body: Record<string, unknown>) => {
    inflight.current.set(f.id, (inflight.current.get(f.id) || 0) + 1);
    setFns(list => list.map(x => (x.id === f.id ? { ...x, ...body } : x)));
    const done = () => { const k = (inflight.current.get(f.id) || 1) - 1; if (k > 0) inflight.current.set(f.id, k); else inflight.current.delete(f.id); };
    try {
      const r = await api.patch(path`/tracker/functions/${f.id}`, body);
      if (isPending(r)) toast(t('sent_for_approval'), 'blue');
      done();
      live();
    } catch (e) {
      done();
      toast(errText(e), 'red');
      setFns(list => list.map(x => (x.id === f.id ? f : x)));
    }
  }, [api, t, errText, live]);

  // a status: «نجح» below 100 % is not saved (the choice goes back and the toast says why); a "… with notes" status
  // on an item without a note opens the note first, then both are saved together (cancel = no change)
  const setStatus = useCallback((f: Item, field: 'test_status' | 'notif_status' | 'review_status', v: number) => {
    const problem = statusPassProblem(f, field, v);
    if (problem) { toast(t(problem.key, problem.vars), 'red'); return; }
    const after = { ...f, [field]: v };
    if (needsNote(after) && !(f.note || '').trim()) setDialog({ kind: 'note', id: f.id, pending: { [field]: v }, back: true });
    else patch(f, { [field]: v });
  }, [patch, t]);

  const byId = useCallback((fid: number) => fns.find(x => x.id === fid) ?? null, [fns]);
  const openItem = useCallback((f: Item) => {
    if (selecting) {
      setPicked(s => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; });
      return;
    }
    setDialog({ kind: 'edit', id: f.id });
  }, [selecting]);
  const startSelect = useCallback((f?: Item) => {
    setSelecting(true);
    setPicked(f && !f.removed_at ? new Set([f.id]) : new Set());
  }, []);
  const back = (d: { id: number; back: boolean }) => setDialog(d.back && byId(d.id) ? { kind: 'edit', id: d.id } : null);
  const afterDone = (d: { id: number; back: boolean }) => { live(); back(d); };

  const a = data?.application;
  if (loading && !data) return <View style={ui.flex}><TopBar back title={t('loading')} /><Loading /></View>;
  if (error || !data || !a) return <View style={ui.flex}><TopBar back title={t('application')} /><View style={st.pad}><ErrorBox error={error} onRetry={reload} /></View></View>;

  const ph = { t, nm, lang, pc, appId: a.id };
  const action = (f: Item, act: EditorAction) => {
    if (act === 'note' || act === 'rename' || act === 'move' || act === 'history') setDialog({ kind: act, id: f.id, back: true } as Dialog);
    else setDialog({ kind: 'life', id: f.id, mode: act, back: true });
  };
  const pickedOptions = (): FnOption[] => fns.filter(f => picked.has(f.id) && !f.removed_at)
    .map(f => ({ id: f.id, app_id: f.app_id, code: f.code, name_ar: f.name_ar, name_en: f.name_en, enabled: f.enabled }));

  const header = (
    <View>
      {data.needs_approval ? <Alert kind="blue" icon="info">{t('edits_need_lead_notice')}</Alert> : null}
      {!editable ? <Alert kind="gray" icon="info">{t('m_view_only_role')}</Alert> : null}
      <PctEquation calc={a.calc} settings={data.settings} />
      {(a.note_ar || a.addendum || a.scope_cut || a.extra_module) ? (
        <Alert kind={a.scope_cut ? 'orange' : 'blue'}>
          <AppTags a={a} />
          {a.note_ar ? <Txt size={fontSize.m} color={colors.text} style={{ marginTop: 4 }}>{a.note_ar}</Txt> : null}
        </Alert>
      ) : null}
      {pendingLife.length ? (
        <Alert kind="blue">
          <Txt w={700} size={fontSize.m}>{t('lifecycle_pending')}</Txt>
          {pendingLife.map((p, i) => {
            const v = (p.new_value || {}) as { name_ar?: string; removed?: boolean; reason?: string };
            const name = fns.find(f => f.id === p.function_id)?.name_ar || '';
            return (
              <Txt key={i} size={fontSize.s}>{p.field === 'create' ? `＋ ${t('fn_add')}: ${v.name_ar}` : v.removed
                ? `－ ${t('fn_remove')}: ${name} (${v.reason})` : `↺ ${t('fn_restore')}: ${name}`} — {p.requested_by_name}</Txt>
            );
          })}
        </Alert>
      ) : null}
      {editable ? (
        <View style={st.tools}>
          {canBulk(can) ? <Button kind="default" small icon="check" title={t('bulk_set')} onPress={() => setDialog({ kind: 'bulk', picked: [] })} testID="bulk-open" /> : null}
          {canBulk(can) ? <Button kind="default" small title={t('m_select')} onPress={() => (selecting ? setSelecting(false) : startSelect())} testID="select-mode" /> : null}
          {can.tog ? <Button small icon="plus" title={t('add_function')} onPress={() => setDialog({ kind: 'add' })} testID="add-open" /> : null}
        </View>
      ) : null}
      <View style={st.search}>
        <Icon name="search" size={16} color={colors.gray600} />
        <TextInput value={q} onChangeText={v => setFilter(() => setQ(v))} placeholder={t('m_search_items')} placeholderTextColor={colors.gray500}
          style={[st.searchInput, font(400)]} accessibilityLabel={t('filter')} autoCorrect={false} clearButtonMode="while-editing" />
      </View>
      <View style={st.chips}>
        <Chip label={t('m_all')} on={test === ''} onPress={() => setFilter(() => setTest(''))} />
        {(['2', '1', '3', '0'] as const).map(k => <Chip key={k} label={t('ts_' + k)} on={test === k} onPress={() => setFilter(() => setTest(test === k ? '' : k))} />)}
        {conflicts > 0 || test === 'conflict' ? <Chip warn label={t('pass_conflict_n', { n: conflicts })} on={test === 'conflict'} onPress={() => setFilter(() => setTest(test === 'conflict' ? '' : 'conflict'))} /> : null}
      </View>
      <View style={st.toggle}>
        <Txt size={fontSize.m} style={ui.flex}>{t('show_disabled')}</Txt>
        <Toggle value={showOff} onValueChange={v => setFilter(() => setShowOff(v))} accessibilityLabel={t('show_disabled')} />
      </View>
      {removedCount > 0 ? (
        <View style={st.toggle}>
          <Txt size={fontSize.m} style={ui.flex}>{t('show_removed', { n: removedCount })}</Txt>
          <Toggle value={showRemoved} onValueChange={v => setFilter(() => setShowRemoved(v))} accessibilityLabel={t('show_removed', { n: removedCount })} />
        </View>
      ) : null}
      <Txt size={fontSize.s} color={colors.textMuted} style={st.count}>{t('m_items_count', { shown: shown.length, total: fns.filter(f => !f.removed_at).length })}</Txt>
    </View>
  );

  // the open dialog (one at a time: a dialog opened from the item's editor goes back to it)
  const d = dialog;
  const df = d && 'id' in d ? byId(d.id) : null;
  let sheet = null;
  if (d?.kind === 'edit' && df) {
    sheet = <ItemEditor f={df} appId={a.id} can={can} pending={pendingByFn[df.id] || []} onClose={() => setDialog(null)}
      onPatch={patch} onStatus={setStatus} onAction={act => action(df, act)} />;
  } else if (d?.kind === 'note' && df) {
    sheet = <NoteDialog f={df} pending={d.pending} canEdit={can.tst || !!d.pending} onClose={() => back(d)}
      onSave={async note => { await patch(df, { ...(d.pending || {}), note }); back(d); }} />;
  } else if (d?.kind === 'rename' && df) {
    sheet = <RenameDialog f={df} others={fns} onClose={() => back(d)} onDone={() => afterDone(d)} />;
  } else if (d?.kind === 'move' && df) {
    sheet = <MoveDialog app={a} f={df} onClose={() => back(d)} onDone={() => { live(); setDialog(null); }} />;
  } else if (d?.kind === 'history' && df) {
    sheet = <MoveHistory f={df} onClose={() => back(d)} />;
  } else if (d?.kind === 'life' && df) {
    sheet = <LifecycleDialog app={a} f={df} mode={d.mode} onClose={() => back(d)} onDone={() => afterDone(d)}
      onInclude={() => { back(d); patch(df, { enabled: true }); }} />;
  } else if (d?.kind === 'bulk') {
    sheet = <BulkDialog app={a} can={can} picked={d.picked} onClose={() => setDialog(null)}
      onDone={() => { setDialog(null); setSelecting(false); setPicked(new Set()); live(); }} />;
  } else if (d?.kind === 'add') {
    sheet = <AddItemDialog app={a} onClose={() => setDialog(null)} onDone={() => { setDialog(null); live(); }} />;
  }

  const nPicked = picked.size;
  return (
    <View style={ui.flex}>
      <TopBar back title={nm(a as unknown as Record<string, unknown>)} sub={nm(data.department as unknown as Record<string, unknown>)} />
      <FlatList
        ref={listRef}
        data={shown.slice(0, limit)}
        keyExtractor={f => String(f.id)}
        renderItem={({ item }) => (
          <ItemCard f={item} appId={a.id} pending={!!pendingByFn[item.id]}
            pendingText={pendingByFn[item.id] ? pendingSummary(ph, pendingByFn[item.id]) : null}
            onPress={editable ? openItem : undefined} onLongPress={canBulk(can) && !selecting ? startSelect : undefined}
            selecting={selecting} selected={picked.has(item.id)} selectable={!item.removed_at} highlight={focusId === item.id} />
        )}
        extraData={[selecting, picked, focusId]}
        ListHeaderComponent={header}
        ListEmptyComponent={<Empty>{t('fn_no_matches')}</Empty>}
        ListFooterComponent={limit < shown.length ? <Loading /> : undefined}
        onEndReached={() => setLimit(l => (l < shown.length ? l + PAGE : l))}
        onEndReachedThreshold={0.6}
        onScrollToIndexFailed={info => setTimeout(() => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true }), 100)}
        contentContainerStyle={[st.list, selecting && { paddingBottom: 120 }]}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary]} tintColor={colors.primary} />}
        initialNumToRender={8}
        windowSize={7}
      />
      {selecting ? (
        <View style={[st.selectBar, { paddingBottom: space.m }]} accessibilityRole="toolbar">
          <Txt w={700} size={fontSize.m} style={ui.flex} accessibilityLiveRegion="polite">{t('m_selected_n', { n: nPicked })}</Txt>
          <Button kind="default" small title={t('cancel')} onPress={() => { setSelecting(false); setPicked(new Set()); }} />
          <Button small title={t('bulk_set')} disabled={!nPicked} testID="bulk-picked"
            onPress={() => setDialog({ kind: 'bulk', picked: pickedOptions() })} />
        </View>
      ) : null}
      {sheet}
    </View>
  );
}

const st = StyleSheet.create({
  pad: { padding: space.xl },
  list: { padding: space.xl, paddingBottom: space.xxl * 2 },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginBottom: space.l },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: space.l, marginBottom: space.m,
  },
  searchInput: { flex: 1, minHeight: 44, fontSize: 15, color: colors.text, textAlign: 'auto' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginBottom: space.m },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, minHeight: 34, borderRadius: radius.pill, backgroundColor: colors.gray100 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.m, marginBottom: space.s, minHeight: 44 },
  count: { marginBottom: space.m },
  selectBar: {
    position: 'absolute', start: 0, end: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: space.s,
    paddingHorizontal: space.xl, paddingTop: space.m, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border,
    boxShadow: '0px -2px 8px rgba(0, 0, 0, 0.06)',
  },
});

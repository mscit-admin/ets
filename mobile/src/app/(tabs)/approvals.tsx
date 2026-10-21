// الاعتمادات (web: pages/Approvals.jsx): the edit requests this user may see — status filter (pending first), «طلباتي
// فقط» — each with its application, who asked and when, its status, and the buttons the server allows (request.can):
// approve (a move: «اعتماد المصدر» / «اعتماد الوجهة» / both), reject with a required reason, withdraw one's own;
// «اعتماد الكل» approves every request this user may approve. Tapping a request opens its details: every change
// old → new, the exclusion reason and its duplicates, the rename reason, and for a move its reason, which approval is
// done or awaited, the weight share and the impact stored when it was requested. The same endpoints and messages as
// the web (GET /api/approvals, POST /api/approvals/:id/approve|reject|withdraw, /approve-all); the list follows the
// live stream. A link /approvals?mine=1 (an alert «your request was decided») opens it on «طلباتي فقط».
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Toggle } from '@/components/Toggle';
import { router, useLocalSearchParams } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/useLoad';
import { useApprovalsCount } from '@/lib/approvalsCount';
import { path, qs } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { EditRequest, Item, RequestItem } from '@/lib/types';
import {
  REJECT_MAX, RQ_FIELD_LABEL, RQ_STATUSES, RQ_STATUS_COLOR, approveAllToasts, approveLabelKey, canApproveAny, decisionToast,
  fmtChange, isMoveRequest, moveStage, pc, rejectProblem, showRenameReason, type RqStatus,
} from '@/shared/web';
import { colors, fontSize, pills, radius, space } from '@/theme';
import { Icon } from '@/components/Icon';
import { DisabledBadge, TypeChip } from '@/components/ItemCard';
import { MoveImpact } from '@/components/Impact';
import { ConfirmSheet, Sheet, SheetActions } from '@/components/Sheet';
import { TextArea } from '@/components/form';
import { TopBar } from '@/components/TopBar';
import { Alert, Button, Empty, ErrorBox, Loading, Pill, Txt, s as ui } from '@/components/ui';

type Act = 'approve' | 'reject' | 'withdraw';
const R = (o: object | null | undefined) => o as Record<string, unknown> | null;

function useRequestText() {
  const { t, nm } = useI18n();
  return (kind: string, field: string, v: unknown) => fmtChange({ t, nm, pc }, kind, field, v);
}

function RequestTitle({ rq }: { rq: EditRequest }) {
  const { t, nm } = useI18n();
  if (isMoveRequest(rq)) {
    return (
      <View style={st.titleRow}>
        <Icon name="move" size={15} color={pills.purple.text} />
        <Txt w={700} size={fontSize.m} style={ui.flex}>{t('mv_rq_title', {
          from: `${nm(R(rq), 'app_name')} (${nm(R(rq), 'dept_name')})`, to: `${nm(R(rq), 'target_app_name')} (${nm(R(rq), 'target_dept_name')})` })}</Txt>
      </View>
    );
  }
  return (
    <View style={st.titleRow}>
      <Icon name={rq.icon || 'report'} size={15} color={colors.gray700} />
      <Txt w={700} size={fontSize.m} style={ui.flex}>{nm(R(rq), 'app_name')} <Txt size={fontSize.s} color={colors.textMuted}>· {nm(R(rq), 'dept_name')}</Txt></Txt>
    </View>
  );
}

function Actions({ rq, onAct, busy }: { rq: EditRequest; onAct: (rq: EditRequest, a: Act) => void; busy: boolean }) {
  const { t } = useI18n();
  if (!rq.can.approve && !rq.can.reject && !rq.can.withdraw) return null;
  return (
    <View style={st.actions}>
      {rq.can.approve ? <Button small title={t(approveLabelKey(rq.can))} onPress={() => onAct(rq, 'approve')} busy={busy} testID={`approve-${rq.id}`} /> : null}
      {rq.can.reject ? <Button small kind="default" title={t('reject')} onPress={() => onAct(rq, 'reject')} disabled={busy} testID={`reject-${rq.id}`} /> : null}
      {rq.can.withdraw ? <Button small kind="default" title={t('withdraw')} onPress={() => onAct(rq, 'withdraw')} busy={busy} testID={`withdraw-${rq.id}`} /> : null}
    </View>
  );
}

function StageLine({ rq }: { rq: EditRequest }) {
  const { t, fmtDate } = useI18n();
  if (!isMoveRequest(rq)) return null;          // one stage: the status pill says it («بانتظار اعتماد رئيس الفريق»)
  const s = moveStage(R(rq)!);
  return (
    <View style={st.gapXs} accessibilityRole="text">
      {s.sourceDone ? <Txt size={fontSize.s} color={pills.green.text}>✓ {t('mv_rq_source_done', { name: s.sourceDone.name, date: fmtDate(s.sourceDone.at) })}</Txt> : null}
      {s.targetDone ? <Txt size={fontSize.s} color={pills.green.text}>✓ {t('mv_rq_target_done', { name: s.targetDone.name, date: fmtDate(s.targetDone.at) })}</Txt> : null}
      {s.waitKey ? <Txt w={700} size={fontSize.s} color={pills.orange.text}>⏳ {t(s.waitKey)}</Txt> : null}
    </View>
  );
}

function ItemChange({ rq, i }: { rq: EditRequest; i: RequestItem }) {
  const { t } = useI18n();
  const fmt = useRequestText();
  const meta = (i.meta || {}) as Record<string, unknown>;
  const who = i.kind === 'report' ? t('kind_report') : i.field === 'create' ? `＋ ${t('add_function')}` : `${i.code ?? ''} ${i.fn_name_ar ?? ''}`;
  const value = (v: unknown) => (i.field === 'item_type' ? <TypeChip type={v === 'report' ? 'report' : 'function'} /> : null);
  return (
    <View style={st.change}>
      <Txt w={600} size={fontSize.s}>{who}</Txt>
      <Txt size={fontSize.xs} color={colors.textMuted}>{t(RQ_FIELD_LABEL[i.field] || i.field)}</Txt>
      <View style={st.fromTo}>
        {value(i.old_value) ?? <Txt size={fontSize.s} color={colors.textMuted} style={st.shrink}>{fmt(i.kind, i.field, i.old_value)}</Txt>}
        <Txt size={fontSize.s} color={colors.textMuted}> → </Txt>
        {value(i.new_value) ?? <Txt w={700} size={fontSize.s} style={st.shrink}>{fmt(i.kind, i.field, i.new_value)}</Txt>}
        {i.applied === false ? <Pill color="red" dot={false}>✗</Pill> : null}
      </View>
      {i.field === 'enabled' && i.new_value === false ? (
        <View style={st.gapXs}>
          <View style={st.titleRow}>
            <Txt size={fontSize.xs} color={colors.textMuted}>{t('dr_reason')}:</Txt>
            <DisabledBadge f={meta as unknown as Item} appId={rq.app_id} />
          </View>
          {meta.disabled_note ? <Txt size={fontSize.xs}>{t('dr_note')}: <Txt size={fontSize.xs} color={colors.textMuted}>{String(meta.disabled_note)}</Txt></Txt> : null}
        </View>
      ) : null}
      {i.field === 'move' ? <Txt size={fontSize.xs}>{t('mv_weight_moved')}: {(+(meta.weight_share as number || 0)).toFixed(2)}</Txt> : null}
      {showRenameReason(i, rq.items) ? <Txt size={fontSize.xs}>{t('rn_reason')}: <Txt size={fontSize.xs} color={colors.textMuted}>{String(meta.rename_reason)}</Txt></Txt> : null}
      {i.applied === false && i.note ? <Txt size={fontSize.xs} color={pills.red.text}>{i.note}</Txt> : null}
    </View>
  );
}

function MoveRequest({ rq }: { rq: EditRequest }) {
  const { t } = useI18n();
  const m = rq.meta || {};
  const now = rq.move_now;
  const share = (v: unknown) => (Number.isFinite(+(v as number)) ? (+(v as number)).toFixed(2) : '—');
  return (
    <View style={st.gapM}>
      {m.reason ? <Txt size={fontSize.s}><Txt w={700} size={fontSize.s}>{t('mv_reason')}:</Txt> {m.reason}</Txt> : null}
      <View style={st.gapXs}>
        <Txt size={fontSize.s}>{t('mv_rq_share_then')}: <Txt w={700} size={fontSize.s}>{share(m.weight_share)}</Txt></Txt>
        {rq.status === 'pending' && now ? <Txt size={fontSize.s}>{t('mv_rq_share_now')}: <Txt w={700} size={fontSize.s}>{share(now.share)}</Txt></Txt> : null}
        {rq.status === 'applied' && rq.apply_result?.weight ? <Txt size={fontSize.s}>{t('mv_weight_moved')}: <Txt w={700} size={fontSize.s}>{share(rq.apply_result.weight.share)}</Txt></Txt> : null}
      </View>
      {rq.status === 'pending' && now && now.still_in_source === false ? <Alert kind="red">{t('mv_rq_moved_out')}</Alert> : null}
      {m.impact ? <MoveImpact impact={m.impact} /> : null}
    </View>
  );
}

function Decided({ rq }: { rq: EditRequest }) {
  const { t, fmtDate } = useI18n();
  if (rq.status === 'rejected') return <Alert kind="red">{t('rejected_by', { name: rq.decided_by_name })}: {rq.reason}</Alert>;
  if (rq.status === 'applied') return <Alert kind="green">{t('approved_by', { name: rq.decided_by_name })} · {fmtDate(rq.decided_at)}</Alert>;
  return null;
}

function RequestCard({ rq, onOpen, onAct, busy }: { rq: EditRequest; onOpen: (rq: EditRequest) => void; onAct: (rq: EditRequest, a: Act) => void; busy: boolean }) {
  const { t, fmtDate } = useI18n();
  const fmt = useRequestText();
  const first = rq.items.slice(0, 3);
  return (
    <View style={st.card} testID={`rq-${rq.id}`}>
      <Pressable onPress={() => onOpen(rq)} style={st.cardMain} accessibilityRole="button" accessibilityHint={t('m_open_details')}>
        <RequestTitle rq={rq} />
        <View style={st.metaRow}>
          <Pill color={RQ_STATUS_COLOR[rq.status] ?? 'gray'}>{t('rq_' + rq.status)}</Pill>
          {isMoveRequest(rq) ? <Pill color="purple" dot={false}>{t('rq_kind_move_function')}</Pill>
            : rq.kind.endsWith('_function') ? <Pill color={rq.kind === 'remove_function' ? 'red' : 'blue'} dot={false}>{t('rq_kind_' + rq.kind)}</Pill> : null}
          <Txt size={fontSize.xs} color={colors.textMuted}>{rq.requested_by_name} · {'\u2066' + fmtDate(rq.requested_at) + '\u2069'}</Txt>
        </View>
        <StageLine rq={rq} />
        {first.map(i => (
          <Txt key={i.id} size={fontSize.s} color={colors.gray700} numberOfLines={2}>
            {i.field === 'create' ? '＋ ' : (i.code ? i.code + ' · ' : '')}{t(RQ_FIELD_LABEL[i.field] || i.field)}: {fmt(i.kind, i.field, i.new_value)}
          </Txt>
        ))}
        {rq.items.length > first.length ? <Txt size={fontSize.xs} color={colors.textMuted}>+{rq.items.length - first.length}</Txt> : null}
      </Pressable>
      <Decided rq={rq} />
      <Actions rq={rq} onAct={onAct} busy={busy} />
    </View>
  );
}

function RequestDetail({ rq, onClose, onAct, busy }: { rq: EditRequest; onClose: () => void; onAct: (rq: EditRequest, a: Act) => void; busy: boolean }) {
  const { t, fmtDate } = useI18n();
  return (
    <Sheet title={t('approvals_title')} sub={`${rq.requested_by_name} · \u2066${fmtDate(rq.requested_at)}\u2069`} onClose={onClose} full testID="rq-detail"
      footer={rq.can.approve || rq.can.reject || rq.can.withdraw ? <Actions rq={rq} onAct={onAct} busy={busy} /> : undefined}>
      <RequestTitle rq={rq} />
      <View style={st.metaRow}>
        <Pill color={RQ_STATUS_COLOR[rq.status] ?? 'gray'}>{t('rq_' + rq.status)}</Pill>
        {rq.app_id ? (
          <Button kind="link" small title={t('application')} onPress={() => { onClose(); router.navigate(`/home/app/${rq.app_id}` as never); }} />
        ) : null}
      </View>
      <Decided rq={rq} />
      <StageLine rq={rq} />
      {isMoveRequest(rq) ? <MoveRequest rq={rq} /> : null}
      <View style={st.changes}>
        {rq.items.map(i => <ItemChange key={i.id} rq={rq} i={i} />)}
      </View>
    </Sheet>
  );
}

function RejectSheet({ onClose, onSubmit, busy }: { onClose: () => void; onSubmit: (reason: string) => void; busy: boolean }) {
  const { t } = useI18n();
  const [v, setV] = useState('');
  return (
    <Sheet title={t('reject')} onClose={onClose} testID="reject"
      footer={<SheetActions onCancel={onClose} title={t('reject')} danger onPress={() => onSubmit(v)} disabled={!!rejectProblem(v)} busy={busy} testID="reject-confirm" />}>
      <TextArea label={t('reject_reason')} required value={v} onChangeText={setV} maxLength={REJECT_MAX} testID="reject-reason" />
    </Sheet>
  );
}

export default function Approvals() {
  const params = useLocalSearchParams<{ mine?: string }>();
  const { t, errText } = useI18n();
  const { api } = useSession();
  const counts = useApprovalsCount();
  const [status, setStatus] = useState<RqStatus | ''>('pending');
  const [mine, setMine] = useState(params.mine === '1');
  const [open, setOpen] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<EditRequest | null>(null);
  const [askAll, setAskAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, refreshing, refresh, reload, live } = useLoad(
    o => api.get<{ requests: EditRequest[] }>('/approvals' + qs({ status, mine: mine ? 1 : '' }), o), [status, mine]);
  // a link with ?mine=1 while the screen is already open
  const [seenMine, setSeenMine] = useState(params.mine);
  if (params.mine !== seenMine) { setSeenMine(params.mine); if (params.mine === '1') setMine(true); }

  const after = useCallback(() => { live(); counts.reload(); }, [live, counts]);
  const act = useCallback(async (rq: EditRequest, action: Act, body: Record<string, unknown> = {}) => {
    if (action === 'reject' && body.reason === undefined) { setRejecting(rq); return; }
    setBusy(true);
    try {
      const r = await api.post<Record<string, unknown>>(path`/approvals/${rq.id}/${action}`, body);
      const m = decisionToast(r);
      toast(t(m.key, m.vars), 'green');
      setRejecting(null);
      setOpen(null);
      after();
    } catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  }, [api, t, errText, after]);
  const approveAll = async () => {
    setBusy(true);
    try {
      const r = await api.post<Record<string, unknown>>('/approvals/approve-all', {});
      for (const m of approveAllToasts(r)) toast(t(m.key, m.vars), m.kind);
      setAskAll(false);
      after();
    } catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  };

  const requests = data?.requests ?? [];
  const current = open ? requests.find(r => r.id === open) ?? null : null;
  const header = (
    <View>
      <Txt size={fontSize.s} color={colors.textMuted} style={st.sub}>{t('approvals_sub')}</Txt>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.tabs}>
        {(['', ...RQ_STATUSES] as (RqStatus | '')[]).map(k => (
          <Pressable key={k || 'all'} onPress={() => setStatus(k)} style={[st.tab, status === k && st.tabOn]} hitSlop={6}
            accessibilityRole="tab" accessibilityState={{ selected: status === k }} aria-selected={status === k}>
            <Txt w={600} size={fontSize.s} color={status === k ? colors.white : colors.textMuted} style={{ lineHeight: 20 }}>{k ? t('rq_' + k) : t('m_all')}</Txt>
          </Pressable>
        ))}
      </ScrollView>
      <View style={st.tools}>
        <View style={st.switchRow}>
          <Toggle value={mine} onValueChange={setMine} accessibilityLabel={t('my_requests')} />
          <Txt size={fontSize.m}>{t('my_requests')}</Txt>
        </View>
        {status === 'pending' && canApproveAny(requests) ? (
          <Button small title={t('approve_all')} onPress={() => setAskAll(true)} testID="approve-all" />
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={ui.flex}>
      <TopBar title={t('nav_approvals')} sub={counts.count.awaiting_me ? t('edits_awaiting_you', { n: counts.count.awaiting_me }) : undefined} />
      {loading && !data ? <Loading /> : error && !data ? <View style={st.pad}><ErrorBox error={error} onRetry={reload} /></View> : (
        <FlatList
          data={requests}
          keyExtractor={r => String(r.id)}
          renderItem={({ item }) => <RequestCard rq={item} onOpen={r => setOpen(r.id)} onAct={act} busy={busy} />}
          ListHeaderComponent={header}
          ListEmptyComponent={<Empty>{t('no_requests')}</Empty>}
          contentContainerStyle={st.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { counts.reload(); refresh(); }} colors={[colors.primary]} tintColor={colors.primary} />}
        />
      )}
      {current ? <RequestDetail rq={current} onClose={() => setOpen(null)} onAct={act} busy={busy} /> : null}
      {rejecting ? <RejectSheet busy={busy} onClose={() => setRejecting(null)} onSubmit={reason => act(rejecting, 'reject', { reason })} /> : null}
      {askAll ? <ConfirmSheet title={t('approve_all')} message={t('are_you_sure')} confirmTitle={t('approve_all')} busy={busy}
        onClose={() => setAskAll(false)} onConfirm={approveAll} /> : null}
    </View>
  );
}

const st = StyleSheet.create({
  pad: { padding: space.xl },
  list: { padding: space.xl, paddingBottom: space.xxl * 2 },
  sub: { marginBottom: space.m },
  tabs: { gap: space.xs, paddingBottom: space.m },
  tab: { paddingHorizontal: 12, minHeight: 34, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.gray100 },
  tabOn: { backgroundColor: colors.gray900 },
  tools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m, marginBottom: space.l, flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 44 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, marginBottom: space.m, padding: space.l, gap: space.s },
  cardMain: { gap: space.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.s, flexWrap: 'wrap' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.s, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  gapXs: { gap: 2 },
  gapM: { gap: space.m },
  changes: { gap: space.s },
  change: { backgroundColor: colors.gray50, borderRadius: radius.md, padding: space.m, gap: 2 },
  fromTo: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2 },
  shrink: { flexShrink: 1 },
});

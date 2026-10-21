// One item (function or report) of an application (web: the row of pages/Application.jsx): type chip, code, name,
// source, progress, test status with the «نجح» below 100 % conflict ⚠, the exclusion reason badge, «منقول من …» for
// a moved item, removed / awaiting-approval marks (with the values waiting: «تعديل الاسم إلى …», «الإنجاز 80%»…) and
// the note. A user who may edit opens the item editor by tapping it; in selection mode (bulk set) a tap ticks it.
import { memo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useI18n } from '@/lib/i18n';
import type { Item } from '@/lib/types';
import { SRC_COLOR, dupCode, passConflict, typeOf } from '@/lib/items';
import { TEST_COLORS, VENDOR_COLORS, pc } from '@/shared/web';
import { colors, fontSize, pills, radius, space } from '@/theme';
import { Icon } from './Icon';
import { Pill, ProgressBar, Txt, ltr, pctText } from './ui';

export function TypeChip({ type }: { type: 'function' | 'report' }) {
  const { t } = useI18n();
  const fn = type === 'function';
  return (
    <View style={[st.typeChip, { backgroundColor: fn ? colors.itFnBg : colors.itRepBg, borderColor: fn ? colors.itFnLine : colors.itRepLine }]}
      accessible accessibilityLabel={t('it_static_aria', { type: t('it_' + type) })}>
      <Icon name={fn ? 'item_function' : 'item_report'} size={13} color={fn ? colors.itFn : colors.itRep} />
      <Txt w={700} size={11.5} color={fn ? colors.itFn : colors.itRep} style={st.chipText}>{t('it_' + type)}</Txt>
    </View>
  );
}

export function DisabledBadge({ f, appId }: { f: Item; appId: string }) {
  const { t, fmtDate } = useI18n();
  const [open, setOpen] = useState(false);
  const r = f.disabled_reason;
  const dups = f.duplicate_of || [];
  const label = r === 'duplicate' && dups.length
    ? `${t('dr_duplicate_of')}: ${dups.map(d => dupCode(d, appId)).join('، ')}`
    : r ? t('dr_' + r) : t('dr_none');
  const details = [f.disabled_note && `${t('dr_note')}: ${f.disabled_note}`, f.disabled_by_name && t('dr_by', { name: f.disabled_by_name }),
    f.disabled_at && fmtDate(f.disabled_at)].filter(Boolean) as string[];
  const p = r ? pills.orange : pills.gray;
  return (
    <View style={st.drWrap}>
      <Pressable onPress={() => setOpen(o => !o)} style={[st.badge, { backgroundColor: p.bg }]} accessibilityRole="button"
        accessibilityState={{ expanded: open }} accessibilityLabel={label}>
        <Txt w={600} size={11.5} color={p.text} style={st.chipText}>{label}</Txt>
      </Pressable>
      {open ? (
        <View style={st.drDetails}>
          {(details.length ? details : [t('dr_no_details')]).map((x, i) => <Txt key={i} size={fontSize.s} color={colors.gray700}>{x}</Txt>)}
        </View>
      ) : null}
    </View>
  );
}

export function MovedBadge({ f }: { f: Item }) {
  const { t, nm, fmtDate } = useI18n();
  const [open, setOpen] = useState(false);
  const m = f.moved_from!;
  const app = nm(m as unknown as Record<string, unknown>, 'from_app_name') || t('mv_badge_other');
  const tip = t('mv_badge_tip', { date: fmtDate(m.moved_at), name: m.moved_by_name || '—', reason: m.reason ?? '' });
  return (
    <View style={st.drWrap}>
      <Pressable onPress={() => setOpen(o => !o)} style={[st.badge, { backgroundColor: pills.purple.bg }]} accessibilityRole="button"
        accessibilityLabel={t('mv_badge', { app, code: m.from_code }) + ' — ' + tip}>
        <Icon name="move" size={12} color={pills.purple.text} />
        <Txt w={600} size={11.5} color={pills.purple.text} style={st.chipText}>{t('mv_badge', { app, code: m.from_code })}</Txt>
      </Pressable>
      {open ? <View style={st.drDetails}><Txt size={fontSize.s} color={colors.gray700}>{tip}</Txt></View> : null}
    </View>
  );
}

type CardProps = {
  f: Item; appId: string; pending: boolean; pendingText?: string | null;
  onPress?: (f: Item) => void; onLongPress?: (f: Item) => void;
  selecting?: boolean; selected?: boolean; selectable?: boolean; highlight?: boolean;
};

export const ItemCard = memo(function ItemCard({ f, appId, pending, pendingText, onPress, onLongPress, selecting, selected, selectable = true, highlight }: CardProps) {
  const { t, fmtDate } = useI18n();
  const type = typeOf(f);
  const off = !!f.removed_at || !f.enabled;
  const conflict = passConflict(f);
  const press = selecting ? (selectable ? onPress : undefined) : onPress;
  const body = (
    <>
      <View style={st.title}>
        {selecting ? (
          <View style={[st.tick, selected && st.tickOn, !selectable && st.tickOff]}>{selected ? <Icon name="check" size={14} color={colors.white} /> : null}</View>
        ) : null}
        <TypeChip type={type} />
        <Txt w={600} size={fontSize.m} style={st.flex}>{f.name_ar}</Txt>
      </View>
      <View style={st.meta}>
        <Txt w={600} size={fontSize.s} color={colors.gray700} style={st.code}>{f.code}</Txt>
        <Pill color={SRC_COLOR[f.source] ?? 'gray'}>{t('src_' + f.source)}</Pill>
        {f.vendor_status > 0 ? <Pill color={VENDOR_COLORS[f.vendor_status]}>{t('vs_' + f.vendor_status)}</Pill> : null}
        {f.reference ? <Txt size={fontSize.s} color={colors.textMuted} numberOfLines={1}>{f.reference}</Txt> : null}
      </View>
      {(f.moved_from || (!f.enabled && !f.removed_at) || f.removed_at || pending) ? (
        <View style={st.meta}>
          {f.moved_from ? <MovedBadge f={f} /> : null}
          {!f.enabled && !f.removed_at ? <DisabledBadge f={f} appId={appId} /> : null}
          {f.removed_at ? <Pill color="red">{t('removed_by_on', { name: f.removed_by_name || '—', date: fmtDate(f.removed_at) })}</Pill> : null}
          {pending && !pendingText ? <Pill color="yellow" icon="clock">{t('awaiting_approval')}</Pill> : null}
        </View>
      ) : null}
      {pending && pendingText ? (
        <View style={st.pending} accessibilityLabel={`${t('awaiting_approval')}: ${pendingText}`}>
          <Txt size={fontSize.s} color={pills.yellow.text} w={600}>⏳ {t('awaiting_approval')}: {pendingText}</Txt>
        </View>
      ) : null}
      <View style={st.status}>
        <View style={st.progress}>
          <ProgressBar value={f.progress} height={5} />
          <Txt w={700} size={fontSize.m} style={st.pct}>{pctText(f.progress)}</Txt>
        </View>
        <Pill color={TEST_COLORS[f.test_status] ?? 'gray'}>{t('ts_' + f.test_status)}</Pill>
        {conflict ? (
          <View accessible accessibilityRole="image" accessibilityLabel={t('pass_conflict_hint')} style={st.conflict}>
            <Icon name="alert" size={16} color={pills.orange.text} />
          </View>
        ) : null}
      </View>
      {f.note ? (
        <View style={st.note}>
          <Icon name="note" size={14} color={pills.orange.text} />
          <Txt size={fontSize.s} color={colors.gray700} style={st.flex} numberOfLines={3}>{f.note}</Txt>
        </View>
      ) : null}
      {f.enabled && f.weight !== 1 ? <Txt size={fontSize.xs} color={colors.textMuted}>{t('weight')} {ltr(pc(f.weight))}</Txt> : null}
      {f.removed_at && f.removed_reason ? <Txt size={fontSize.xs} color={colors.textMuted}>{t('reason')}: {f.removed_reason}</Txt> : null}
    </>
  );
  const style = [st.card, type === 'report' && st.report, off && st.off, selected && st.selected, highlight && st.highlight];
  if (!press && !onLongPress) return <View style={style} testID={`item-${f.code}`}>{body}</View>;
  return (
    <Pressable onPress={press ? () => press(f) : undefined} onLongPress={onLongPress ? () => onLongPress(f) : undefined} delayLongPress={350}
      style={({ pressed }) => [...style, pressed && st.pressed]} testID={`item-${f.code}`}
      accessibilityRole={selecting ? 'checkbox' : 'button'} accessibilityState={selecting ? { checked: !!selected, disabled: !selectable } : undefined} aria-checked={selecting ? !!selected : undefined}
      accessibilityLabel={`${f.code} ${f.name_ar}`} accessibilityHint={selecting ? undefined : t('m_edit_item_hint')}>
      {body}
    </Pressable>
  );
});

const st = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: {
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: space.l,
    marginBottom: space.m, gap: space.s,
  },
  report: { borderStartWidth: 3, borderStartColor: colors.itRepStrong },
  off: { opacity: 0.62 },
  selected: { borderColor: colors.gray800, backgroundColor: colors.gray50, opacity: 1 },
  highlight: { borderColor: colors.primaryBlue, borderWidth: 2 },
  pressed: { backgroundColor: colors.gray50 },
  tick: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.gray400, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  tickOn: { backgroundColor: colors.gray900, borderColor: colors.gray900 },
  tickOff: { opacity: 0.3 },
  pending: { backgroundColor: pills.yellow.bg, borderRadius: radius.md, paddingHorizontal: space.m, paddingVertical: 4 },
  title: { flexDirection: 'row', alignItems: 'flex-start', gap: space.m },
  typeChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, borderRadius: radius.pill, borderWidth: 1, marginTop: 2 },
  chipText: { lineHeight: 19 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.s },
  code: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), direction: 'ltr' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, borderRadius: radius.pill, alignSelf: 'flex-start' },
  drWrap: { gap: 4, maxWidth: '100%' },
  drDetails: { backgroundColor: colors.gray50, borderRadius: radius.md, padding: space.m, gap: 2 },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  progress: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.m },
  pct: { minWidth: 52, textAlign: 'end' },
  conflict: { padding: 2 },
  note: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', backgroundColor: pills.orange.bg, borderRadius: radius.md, padding: space.s },
});

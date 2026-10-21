// One item's editor (web: the row of pages/Application.jsx, as a bottom sheet). Every field follows the server's
// `can` flags (lib/edit.ts editability) and saves on its own like the web's cells: the progress and the weight when
// typing ends (or shortly after the last − / + tap), a status at once. «نجح» needs 100 %: a status or a progress that
// would break it is not saved, the field goes back, and the toast says why (pass_needs_100_now / pass_lower_blocked).
// A "… with notes" status without a note opens the note first. Values waiting for approval are listed.
import { StyleSheet, View } from 'react-native';
import { useI18n } from '@/lib/i18n';
import { editability } from '@/lib/edit';
import { passConflict } from '@/lib/items';
import type { Can, Item } from '@/lib/types';
import { TEST_COLORS, pc, pendingDetails, progressPassProblem, type PendingValue, type PillColor } from '@/shared/web';
import { colors, fontSize, pills, radius, space } from '@/theme';
import { DisabledBadge, MovedBadge, TypeChip } from './ItemCard';
import { TypeChoice } from './ItemDialogs';
import { NumStepper, Section, StatusChoice, SwitchRow } from './form';
import { Sheet } from './Sheet';
import { Alert, Button, Pill, Txt, ltr, pctText } from './ui';

export type EditorAction = 'note' | 'rename' | 'move' | 'include' | 'exclude' | 'remove' | 'restore' | 'history';

export function ItemEditor({ f, appId, can, pending, onClose, onPatch, onStatus, onAction }: {
  f: Item; appId: string; can: Can; pending: PendingValue[];
  onClose: () => void;
  onPatch: (f: Item, body: Record<string, unknown>) => void;
  onStatus: (f: Item, field: 'test_status' | 'notif_status' | 'review_status', v: number) => void;
  onAction: (a: EditorAction) => void;
}) {
  const { t, nm, lang, fmtDate } = useI18n();
  const e = editability(can, f);
  const ph = { t, nm, lang, pc, appId };
  const colorsOf = TEST_COLORS as PillColor[];
  return (
    <Sheet title={`${f.code} · ${t(f.item_type === 'report' ? 'it_report' : 'it_function')}`} sub={f.name_ar} onClose={onClose} full testID="item-editor">
      <View style={st.badges}>
        <TypeChip type={f.item_type === 'report' ? 'report' : 'function'} />
        {f.removed_at ? <Pill color="red">{t('removed_by_on', { name: f.removed_by_name || '—', date: fmtDate(f.removed_at) })}</Pill> : null}
        {!f.enabled && !f.removed_at ? <DisabledBadge f={f} appId={appId} /> : null}
        {f.moved_from ? <MovedBadge f={f} /> : null}
      </View>
      {pending.length ? (
        <View style={st.pending} accessibilityRole="summary">
          <Txt w={700} size={fontSize.s} color={pills.yellow.text}>⏳ {t('awaiting_approval')}</Txt>
          {pendingDetails(ph, pending).map((x, i) => <Txt key={i} size={fontSize.s} color={colors.gray800}>{x}</Txt>)}
        </View>
      ) : null}
      {f.removed_at && f.removed_reason ? <Alert kind="gray">{t('reason')}: {f.removed_reason}</Alert> : null}

      {(e.rename || e.move || f.moves?.length) ? (
        <View style={st.actions}>
          {e.rename ? <Button kind="default" small icon="edit" title={t('rn_button')} onPress={() => onAction('rename')} testID="act-rename" /> : null}
          {e.move ? <Button kind="default" small icon="move" title={t('mv_button')} onPress={() => onAction('move')} testID="act-move" /> : null}
          {f.moves?.length ? <Button kind="default" small icon="logs" title={t('mv_history_title')} onPress={() => onAction('history')} /> : null}
        </View>
      ) : null}

      {e.toggle ? (
        <SwitchRow label={t('include_in_calc')} value={f.enabled} hint={f.enabled ? t('exclude_hint') : t('include_hint')} testID="sw-enabled"
          onValueChange={on => onAction(on ? 'include' : 'exclude')} />
      ) : null}

      <Section title={t('progress')}>
        {e.progress ? (
          <NumStepper label={t('progress') + ' %'} value={+f.progress} min={0} max={100} step={5} suffix="%" testID="ed-progress"
            onCommit={v => onPatch(f, { progress: v })}
            check={v => { const p = progressPassProblem(f, v); return p ? t(p.key, p.vars) : null; }} />
        ) : <Txt w={700} size={fontSize.l}>{pctText(f.progress)}</Txt>}
        {e.weight ? (
          <NumStepper label={t('weight')} value={+f.weight} min={0} max={1000} step={0.5} testID="ed-weight" onCommit={v => onPatch(f, { weight: v })} />
        ) : null}
      </Section>

      <Section title={t('test_status')}>
        {e.test ? (
          <StatusChoice label={t('test_status')} value={f.test_status} prefix="ts_" colorsOf={colorsOf} t={t} onChange={v => onStatus(f, 'test_status', v)} />
        ) : <Pill color={colorsOf[f.test_status] ?? 'gray'}>{t('ts_' + f.test_status)}</Pill>}
        {passConflict(f) ? <Alert kind="orange" icon="alert">{t('pass_conflict_hint')} — {t('pass_conflict_fix')}</Alert> : null}
        {e.notif ? (
          <StatusChoice label={t('notif_status')} value={f.notif_status} prefix="ns_" colorsOf={colorsOf} t={t} onChange={v => onStatus(f, 'notif_status', v)} />
        ) : <Txt size={fontSize.s} color={colors.textMuted}>{t('notif_status')}: {t('ns_' + f.notif_status)}</Txt>}
        {e.review ? (
          <StatusChoice label={t('review_status')} value={f.review_status} prefix="rv_" colorsOf={colorsOf} t={t} onChange={v => onStatus(f, 'review_status', v)} />
        ) : <Txt size={fontSize.s} color={colors.textMuted}>{t('review_status')}: {t('rv_' + f.review_status)}</Txt>}
      </Section>

      <Section title={t('note')} right={<Button kind="default" small icon="note" title={e.note ? t('edit_note') : t('note')} onPress={() => onAction('note')} testID="act-note" />}>
        <Txt size={fontSize.m} color={f.note ? colors.text : colors.textMuted}>{f.note || '—'}</Txt>
      </Section>

      {e.type ? (
        <TypeChoice label={t('item_type')} value={f.item_type === 'report' ? 'report' : 'function'} onChange={v => onPatch(f, { item_type: v })} />
      ) : null}

      {f.updated_by_name ? <Txt size={fontSize.xs} color={colors.textMuted}>{t('last_updated_by', { name: f.updated_by_name })} · {fmtDate(f.updated_at)}</Txt> : null}
      {f.enabled && f.weight !== 1 && !e.weight ? <Txt size={fontSize.xs} color={colors.textMuted}>{t('weight')} {ltr(pc(f.weight))}</Txt> : null}

      {e.remove ? <Button kind="ghost" icon="trash" title={t('fn_remove')} onPress={() => onAction('remove')} testID="act-remove" /> : null}
      {e.restore ? <Button kind="default" icon="restore" title={t('fn_restore')} onPress={() => onAction('restore')} testID="act-restore" /> : null}
    </Sheet>
  );
}

const st = StyleSheet.create({
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, alignItems: 'center' },
  pending: { backgroundColor: pills.yellow.bg, borderRadius: radius.md, padding: space.m, gap: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
});

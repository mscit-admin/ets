// Application header (web: components/PctEquation.jsx, phone layout of app.css): functions % ring × its share
// + reports % ring × its share = application % ring, the colour scale, the note and the counters.
// The numbers come from the API (application.calc) through the shared equation() helper; nothing is recomputed.
import { StyleSheet, View } from 'react-native';
import { useI18n } from '@/lib/i18n';
import { equation, pc, repParts, share, type Calc } from '@/shared/web';
import { colors, fontSize, pills, radius, space } from '@/theme';
import { Icon } from './Icon';
import { Ring } from './Ring';
import { ToneLegend } from './ToneLegend';
import { Txt, ltr, s as ui } from './ui';

function Input({ label, sub, value, w, part }: { label: string; sub?: string | null; value: number; w: number | null; part: number }) {
  return (
    <View style={st.row}>
      <Ring value={value} size={70} stroke={7} />
      <View style={st.lbl}>
        <Txt w={600} size={fontSize.m} color={colors.textMuted}>{label}</Txt>
        {sub ? <Txt w={600} size={11} color={colors.itRep}>{sub}</Txt> : null}
      </View>
      <View style={st.conn}>
        <View style={st.dash} />
        <View style={st.chip}>
          <Txt size={12.5} color={colors.gray700}>
            {w != null ? <>{ltr('× ' + share(w))} <Txt size={12.5} color={colors.gray500}>=</Txt> <Txt w={700} size={12.5}>{ltr(pc(part) + '%')}</Txt></> : ltr('× 100%')}
          </Txt>
        </View>
      </View>
    </View>
  );
}

function Stat({ label, value, bg, fg, icon }: { label: string; value: number | string; bg: string; fg: string; icon?: string }) {
  return (
    <View style={[st.stat, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={13} color={fg} /> : null}
      <Txt size={fontSize.s} color={fg === colors.text ? colors.textMuted : fg}>{label}</Txt>
      <Txt w={700} size={fontSize.base} color={fg}>{ltr(value)}</Txt>
    </View>
  );
}

export function PctEquation({ calc, settings }: { calc: Calc; settings?: { reports_share?: number } }) {
  const { t } = useI18n();
  const e = equation(calc, settings);
  const n = calc.items || { function: calc.count, report: 0 };
  const note = !e.withFunctions ? t('eq_only_reports')
    : e.withReports ? t('app_pct_note', { fw: ltr(share(e.fw)), rw: ltr(share(e.rw)) }) : t('eq_no_reports');
  return (
    <View style={[ui.card, st.card]}>
      <View>
        {e.withFunctions && <Input label={t('fn_progress')} value={e.fn} w={e.both ? e.fw : null} part={e.fnPart} />}
        {e.both && <View style={st.plus}><Txt w={700} size={15} color={colors.gray700} center>+</Txt></View>}
        {e.withReports && e.rep != null && (
          <Input label={t('report_progress')} sub={repParts(t, calc)} value={e.rep} w={e.both ? e.rw : null} part={e.repPart} />
        )}
      </View>
      <View style={st.join}>
        <View style={st.vdash} />
        <View style={st.sign}><Txt w={700} size={16} color={colors.gray700} center>=</Txt></View>
      </View>
      <View style={st.result}>
        <Ring value={e.result} size={136} stroke={13} big />
        <Txt w={700} size={fontSize.m}>{t('app_progress')}</Txt>
      </View>
      <ToneLegend low={t('eq_critical')} mid={t('eq_fair')} high={t('eq_good')} />
      <View style={st.foot}>
        <Txt size={fontSize.s} color={colors.textMuted}>{note}</Txt>
        <View style={st.stats}>
          <Stat label={t('weight')} value={pc(calc.weight)} bg={colors.gray50} fg={colors.text} />
          <Stat label={t('it_functions')} value={n.function} bg={colors.itFnBg} fg={colors.itFn} icon="item_function" />
          <Stat label={t('it_reports')} value={n.report} bg={colors.itRepBg} fg={colors.itRep} icon="item_report" />
          <Stat label={t('ts_2')} value={calc.tests[2]} bg={pills.green.bg} fg={pills.green.text} />
          <Stat label={t('ts_3')} value={calc.tests[3]} bg={pills.red.bg} fg={pills.red.text} />
        </View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  card: { paddingVertical: 14, paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.l, height: 70 },
  lbl: { minWidth: 86, maxWidth: 110 },
  conn: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', minWidth: 0 },
  dash: { position: 'absolute', start: 0, end: 0, top: '50%', borderTopWidth: 2, borderStyle: 'dashed', borderColor: colors.gray300 },
  chip: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 1 },
  plus: { height: 24, width: 24, marginVertical: 2, marginStart: 23, borderRadius: 12, backgroundColor: colors.gray100, justifyContent: 'center', alignItems: 'center' },
  join: { height: 46, alignItems: 'center', justifyContent: 'center' },
  vdash: { position: 'absolute', top: 0, bottom: 0, borderStartWidth: 2, borderStyle: 'dashed', borderColor: colors.gray300 },
  sign: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.gray100, alignItems: 'center', justifyContent: 'center' },
  result: { alignItems: 'center', gap: 2 },
  foot: { marginTop: space.l, paddingTop: space.l, borderTopWidth: 1, borderTopColor: colors.border, gap: space.m },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: 'transparent' },
});

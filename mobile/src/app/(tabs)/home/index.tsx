// Dashboard (web: pages/Dashboard.jsx): ERP module wheel with the overall %, the active modules, the number cards,
// the departments, the five lowest applications and the test status distribution. GET /api/tracker/summary
// (already limited to the reader's scope). Pull to refresh; reloads every minute while open.
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/useLoad';
import type { Summary } from '@/lib/types';
import { STANDARD_MODULES, TEST_COLORS, pc, wheelSegments, type Segment } from '@/shared/web';
import { colors, fontSize, radius, space, stackSeg } from '@/theme';
import { toneOf } from '@/theme/tone';
import { ErpWheel } from '@/components/ErpWheel';
import { Icon } from '@/components/Icon';
import { ToneLegend } from '@/components/ToneLegend';
import { TopBar } from '@/components/TopBar';
import { Card, ErrorBox, Loading, NumberCard, Pill, ProgressBar, Screen, Txt, ltr, pctText, s as ui } from '@/components/ui';

const openDept = (id: string) => router.push(`/home/department/${encodeURIComponent(id)}`);
const openApp = (id: string) => router.push(`/home/app/${encodeURIComponent(id)}`);

function ModuleRow({ m }: { m: Segment }) {
  const { nm } = useI18n();
  const tone = toneOf(m.pct);
  return (
    <Pressable onPress={() => m.dept && openDept(m.dept.id)} style={({ pressed }) => [st.modRow, pressed && st.pressed]}
      accessibilityRole="link" accessibilityLabel={`${nm(m)} — ${nm(m.dept)}: ${pctText(m.pct)}`}>
      <View style={st.modIcon}><Icon name={m.icon} size={16} color={colors.white} /></View>
      <View style={ui.flex}>
        <Txt w={700} size={fontSize.m} numberOfLines={1}>{nm(m)}</Txt>
        <Txt size={fontSize.s} color={colors.textMuted} numberOfLines={1}>{nm(m.dept)}</Txt>
      </View>
      <View style={st.modBar}><ProgressBar value={m.pct ?? 0} color={tone.stroke} /></View>
      <Txt w={700} size={fontSize.m} color={tone.text} style={st.modPct}>{pctText(m.pct)}</Txt>
    </Pressable>
  );
}

function Legend({ segments }: { segments: Segment[] }) {
  const { t } = useI18n();
  const scoped = segments.some(x => x.state === 'out_of_scope');
  return (
    <View style={st.legend}>
      <View style={st.keys}>
        <View style={st.key}><View style={[st.sw, { backgroundColor: colors.erpSwatchOn }]} /><Txt size={12.5} color={colors.gray700}>{t('erp_active')}</Txt></View>
        <View style={st.key}><View style={[st.sw, st.swOff]} /><Txt size={12.5} color={colors.gray700}>{t('erp_not_activated')}</Txt></View>
        {scoped && <View style={st.key}><View style={[st.sw, st.swOff, { backgroundColor: colors.erpScope }]} /><Txt size={12.5} color={colors.gray700}>{t('erp_out_of_scope')}</Txt></View>}
      </View>
      <Txt size={fontSize.s} color={colors.textMuted}>{t('erp_scale')}</Txt>
      <ToneLegend low={t('erp_scale_low')} high={t('erp_scale_high')} />
    </View>
  );
}

export default function Dashboard() {
  const { t, nm } = useI18n();
  const { api, user, info } = useSession();
  const { width } = useWindowDimensions();
  const { data, error, loading, refreshing, refresh, reload } = useLoad(o => api.get<Summary>('/tracker/summary', o), []);
  const org = info?.org_name_ar ? nm({ name_ar: info.org_name_ar, name_en: info.org_name_en }) : undefined;

  let body;
  if (loading && !data) body = <Loading />;
  else if (error || !data) body = <ErrorBox error={error} onRetry={reload} />;
  else {
    const { total, departments, applications, counts, settings } = data;
    const segments = wheelSegments(departments, { fullScope: !!user?.fullScope });
    const active = segments.filter(x => x.state === 'active');
    const activeStd = active.filter(x => STANDARD_MODULES.some(m => m.key === x.key)).length;
    const lowest = [...applications].sort((a, b) => a.calc.pct - b.calc.pct).slice(0, 5);
    const tests = total.tests;
    const testedTotal = tests.reduce((a, b) => a + b, 0) || 1;
    const wheelSize = Math.min(width - 2 * space.xl - 2 * space.m - 2, 440);
    body = (
      <>
        <Txt size={fontSize.s} color={colors.textMuted} style={st.mode}>
          {settings.weight_mode === 'auto' ? t('weight_mode_auto') : t('weight_mode_fixed')}
        </Txt>
        <Card title={t('erp_wheel_title')} padded={false}>
          <View style={st.wheelBody}>
            <ErpWheel segments={segments} total={total.pct} size={wheelSize} onOpen={openDept} />
            <View style={st.overall}>
              <Txt size={fontSize.s} color={colors.textMuted}>{t('overall_progress')}</Txt>
              <View style={st.overallRow}>
                <Txt w={800} size={fontSize.huge} color={toneOf(total.pct).text} style={{ lineHeight: 40 }}>{pctText(total.pct)}</Txt>
                <Txt size={fontSize.s} color={colors.textMuted}>{pctText(total.fnPct)} {t('functions_only')}</Txt>
              </View>
            </View>
            <Txt size={fontSize.s} color={colors.textMuted} style={st.count}>{t('erp_active_count', { n: activeStd, of: STANDARD_MODULES.length })}</Txt>
            <View>{active.map(m => <ModuleRow key={m.key} m={m} />)}</View>
            <Legend segments={segments} />
          </View>
        </Card>

        <View style={st.grid}>
          <NumberCard label={t('functions_counted')} value={ltr(counts.functions)}
            sub={counts.report_items > 0 ? t('plus_report_items', { n: counts.report_items }) : undefined} />
          <NumberCard label={t('completed_functions')} value={ltr(counts.done)} color="green" />
          <NumberCard label={t('tested_ok')} value={ltr(tests[2])} sub={`${tests[1]} ${t('ts_1')} · ${tests[3]} ${t('ts_3')}`} color="blue" />
          <NumberCard label={t('with_notes')} value={ltr(counts.notes)} color="orange" />
        </View>

        <Txt w={700} size={fontSize.l} style={st.section} accessibilityRole="header">{t('departments')}</Txt>
        {departments.map(d => (
          <Pressable key={d.id} onPress={() => openDept(d.id)} style={({ pressed }) => [ui.card, st.dept, pressed && st.pressed]}
            accessibilityRole="link" accessibilityLabel={`${nm(d)}: ${pctText(d.pct)}`}>
            <View style={st.deptTop}>
              <View style={[st.deptIcon, { backgroundColor: d.color + '1a' }]}><Icon name={d.emblem} size={22} color={d.color} /></View>
              <View style={ui.flex}>
                <Txt w={700} size={fontSize.base} numberOfLines={2}>{nm(d)}</Txt>
                <Txt size={fontSize.s} color={colors.textMuted}>{t('apps_count', { n: d.apps })}{d.is_base ? ' · ' + t('base_dept') : ''}</Txt>
              </View>
              <Txt w={700} size={fontSize.l}>{pctText(d.pct)}</Txt>
            </View>
            <ProgressBar value={d.pct} />
            <View style={st.deptFoot}>
              <Txt size={fontSize.s} color={colors.textMuted}>{t('weight')}: <Txt w={700} size={fontSize.s}>{ltr(pc(d.weight))}</Txt></Txt>
              <Txt size={fontSize.s} color={colors.textMuted}>{t('dept_share')}: <Txt w={700} size={fontSize.s}>{pctText(total.weight ? (d.weight / total.weight) * 100 : 0)}</Txt></Txt>
            </View>
          </Pressable>
        ))}

        <Card title={t('lowest_apps')}>
          {lowest.map(a => (
            <Pressable key={a.id} onPress={() => openApp(a.id)} style={({ pressed }) => [st.lowRow, pressed && st.pressed]} accessibilityRole="link">
              <Icon name={a.icon} size={16} color={colors.gray700} />
              <Txt size={fontSize.m} numberOfLines={1} style={ui.flex}>{nm(a)}</Txt>
              <View style={st.lowBar}><ProgressBar value={a.calc.pct} /></View>
              <Txt w={600} size={fontSize.m} style={st.lowPct}>{pctText(a.calc.pct)}</Txt>
            </Pressable>
          ))}
        </Card>

        <Card title={t('test_status_dist')}>
          <View style={st.stack}>
            {tests.map((n, i) => n > 0 && (
              <View key={i} style={{ flex: n / testedTotal, backgroundColor: stackSeg[TEST_COLORS[i] as keyof typeof stackSeg] }} />
            ))}
          </View>
          <View style={st.testLegend}>
            {tests.map((n, i) => (
              <View key={i} style={st.testItem}><Pill color={TEST_COLORS[i]}>{t('ts_' + i)}</Pill><Txt w={700} size={fontSize.m}>{ltr(n)}</Txt></View>
            ))}
          </View>
        </Card>
      </>
    );
  }
  return (
    <View style={ui.flex}>
      <TopBar title={t('nav_home')} sub={org} />
      <Screen refreshing={refreshing} onRefresh={refresh}>{body}</Screen>
    </View>
  );
}

const st = StyleSheet.create({
  mode: { marginBottom: space.m },
  wheelBody: { padding: space.m, paddingBottom: space.xl },
  overall: { paddingHorizontal: space.m, paddingTop: space.l, paddingBottom: space.m, borderBottomWidth: 1, borderBottomColor: colors.border },
  overallRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: space.l },
  count: { marginTop: space.m, marginBottom: space.xs, paddingHorizontal: space.m },
  modRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 7, paddingHorizontal: 6, borderRadius: radius.md },
  pressed: { backgroundColor: colors.gray50 },
  modIcon: { width: 30, height: 30, borderRadius: radius.md, backgroundColor: colors.erpNavy, alignItems: 'center', justifyContent: 'center' },
  modBar: { width: 48 },
  modPct: { minWidth: 56, textAlign: 'end' },
  legend: { gap: space.s, marginTop: space.m, paddingTop: space.m, paddingHorizontal: space.m, borderTopWidth: 1, borderTopColor: colors.border },
  keys: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, columnGap: space.xl },
  key: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sw: { width: 14, height: 14, borderRadius: 4 },
  swOff: { backgroundColor: colors.erpOff, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.erpOffLine },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.l, marginBottom: space.xl },
  section: { marginBottom: space.m },
  dept: { padding: 14, gap: space.m, marginBottom: space.l },
  deptTop: { flexDirection: 'row', alignItems: 'center', gap: space.l },
  deptIcon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  deptFoot: { flexDirection: 'row', justifyContent: 'space-between' },
  lowRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.s, borderRadius: radius.sm },
  lowBar: { width: 70 },
  lowPct: { minWidth: 52, textAlign: 'end' },
  stack: { flexDirection: 'row', height: 12, borderRadius: radius.pill, overflow: 'hidden', backgroundColor: colors.gray200 },
  testLegend: { marginTop: space.l, gap: space.s },
  testItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});


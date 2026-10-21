// Department (web: pages/Department.jsx): its applications, each with a progress ring, item counts, test counters
// and weight. GET /api/tracker/departments/:id.
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/useLoad';
import { ApiError, path } from '@/lib/api';
import type { DepartmentData } from '@/lib/types';
import { pc } from '@/shared/web';
import { colors, fontSize, pills, radius, space } from '@/theme';
import { Icon } from '@/components/Icon';
import { Ring } from '@/components/Ring';
import { TopBar } from '@/components/TopBar';
import { ErrorBox, Loading, ProgressBar, Screen, Txt, ltr, pctText, s as ui } from '@/components/ui';
import { forwardIcon } from '@/lib/rtl';
import { AppTags } from '@/components/AppTags';

const ID = /^[A-Za-z0-9_-]{1,40}$/;

function MiniTests({ tests }: { tests: number[] }) {
  const { t } = useI18n();
  const cells: [number, keyof typeof pills][] = [[2, 'green'], [1, 'orange'], [3, 'red'], [0, 'gray']];
  return (
    <View style={st.mini}>
      {cells.map(([i, c]) => (
        <View key={i} style={[st.miniCell, { backgroundColor: pills[c].bg }]} accessible accessibilityLabel={`${t('ts_' + i)}: ${tests[i]}`}>
          <Txt w={700} size={11.5} color={pills[c].text} center>{ltr(tests[i])}</Txt>
        </View>
      ))}
    </View>
  );
}

export default function Department() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, nm, rtl } = useI18n();
  const { api } = useSession();
  const { data, error, loading, refreshing, refresh, reload } = useLoad(
    o => (ID.test(String(id)) ? api.get<DepartmentData>(path`/tracker/departments/${id}`, o) : Promise.reject(new ApiError(404, 'not_found'))),
    [id]);
  const d = data?.department;
  return (
    <View style={ui.flex}>
      <TopBar back title={d ? nm(d) : t('loading')} sub={d ? `${t('apps_count', { n: data!.applications.length })} · ${t('weight')} ${pc(d.weight)}` : undefined} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        {loading && !data ? <Loading /> : error || !data || !d ? <ErrorBox error={error} onRetry={reload} /> : (
          <>
            <View style={[ui.card, st.head]}>
              <View style={[st.deptIcon, { backgroundColor: d.color + '1a' }]}><Icon name={d.emblem} size={24} color={d.color} /></View>
              <View style={ui.flex}>
                <Txt w={700} size={fontSize.l}>{nm(d)}</Txt>
                <ProgressBar value={d.pct} />
              </View>
              <Ring value={d.pct} size={64} stroke={7} big />
            </View>
            {data.applications.map(a => {
              const n = a.calc.items || { function: a.calc.count, report: 0 };
              return (
                <Pressable key={a.id} onPress={() => router.push(`/home/app/${encodeURIComponent(a.id)}`)}
                  style={({ pressed }) => [ui.card, st.app, pressed && st.pressed]} accessibilityRole="link"
                  accessibilityLabel={`${nm(a)}: ${pctText(a.calc.pct)}`}>
                  <Ring value={a.calc.pct} size={58} stroke={6} />
                  <View style={[ui.flex, st.appBody]}>
                    <View style={st.appTitle}>
                      <Icon name={a.icon} size={16} color={colors.gray700} />
                      <Txt w={700} size={fontSize.base} numberOfLines={2} style={ui.flex}>{nm(a)}</Txt>
                    </View>
                    {a.sub_ar ? <Txt size={fontSize.s} color={colors.textMuted} numberOfLines={1}>{a.sub_ar}</Txt> : null}
                    <AppTags a={a} />
                    <View style={st.meta}>
                      <View style={st.count}>
                        <Icon name="item_function" size={13} color={colors.itFn} />
                        <Txt w={600} size={fontSize.s} color={colors.itFn}>{ltr(n.function)}</Txt>
                        {n.report > 0 ? <><Icon name="item_report" size={13} color={colors.itRep} /><Txt w={600} size={fontSize.s} color={colors.itRep}>{ltr(n.report)}</Txt></> : null}
                      </View>
                      <MiniTests tests={a.calc.tests} />
                      <Txt size={fontSize.s} color={colors.textMuted}>{t('weight')} <Txt w={700} size={fontSize.s}>{ltr(pc(a.calc.weight))}</Txt></Txt>
                    </View>
                  </View>
                  <Icon name={forwardIcon(rtl)} size={16} color={colors.gray500} />
                </Pressable>
              );
            })}
          </>
        )}
      </Screen>
    </View>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.l, padding: 14 },
  deptIcon: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  app: { flexDirection: 'row', alignItems: 'center', gap: space.l, padding: space.l, marginBottom: space.l },
  appBody: { gap: 4 },
  appTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pressed: { backgroundColor: colors.gray50 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.m },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mini: { flexDirection: 'row', gap: 4 },
  miniCell: { minWidth: 24, paddingHorizontal: 5, borderRadius: radius.sm },
});

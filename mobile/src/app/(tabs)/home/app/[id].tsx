// Application (web: pages/Application.jsx), read-only in phase 1: the weighted equation header (functions % +
// reports % = application %), the application's note, then its items as cards, 20 more each time the end of the list
// is reached. Search, test status / conflict chips and «show excluded» filter the list like the web's filters.
// GET /api/tracker/applications/:id.
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/useLoad';
import { ApiError, path } from '@/lib/api';
import type { ApplicationData } from '@/lib/types';
import { colors, font, fontSize, pills, radius, space } from '@/theme';
import { AppTags } from '@/components/AppTags';
import { Icon } from '@/components/Icon';
import { ItemCard } from '@/components/ItemCard';
import { passConflict, visibleItems, type TestFilter } from '@/lib/items';
import { PctEquation } from '@/components/PctEquation';
import { TopBar } from '@/components/TopBar';
import { Alert, Empty, ErrorBox, Loading, Txt, s as ui } from '@/components/ui';

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE = 20;
function Chip({ label, on, onPress, warn }: { label: string; on: boolean; onPress: () => void; warn?: boolean }) {
  const fg = on ? colors.white : warn ? pills.orange.text : colors.gray700;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={[st.chip, warn && !on && { backgroundColor: pills.orange.bg }, on && { backgroundColor: warn ? pills.orange.text : colors.gray900 }]}>
      {warn ? <Icon name="alert" size={13} color={fg} /> : null}
      <Txt w={600} size={fontSize.s} color={fg} style={{ lineHeight: 20 }}>{label}</Txt>
    </Pressable>
  );
}

export default function ApplicationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, nm } = useI18n();
  const { api } = useSession();
  const { data, error, loading, refreshing, refresh, reload } = useLoad(
    o => (ID.test(String(id)) ? api.get<ApplicationData>(path`/tracker/applications/${id}`, o) : Promise.reject(new ApiError(404, 'not_found'))),
    [id]);
  const [q, setQ] = useState('');
  const [test, setTest] = useState<TestFilter>('');
  const [showOff, setShowOff] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const fns = useMemo(() => data?.functions ?? [], [data]);
  const shown = useMemo(() => visibleItems(fns, { q, test, showOff }), [fns, q, test, showOff]);
  const conflicts = useMemo(() => fns.filter(passConflict).length, [fns]);
  const pendingIds = useMemo(() => new Set((data?.pending || []).filter(p => p.function_id && p.field !== 'create' && p.field !== 'removed')
    .map(p => p.function_id)), [data]);
  const setFilter = useCallback((fn: () => void) => { fn(); setLimit(PAGE); }, []);

  const a = data?.application;
  if (loading && !data) return <View style={ui.flex}><TopBar back title={t('loading')} /><Loading /></View>;
  if (error || !data || !a) return <View style={ui.flex}><TopBar back title={t('application')} /><View style={st.pad}><ErrorBox error={error} onRetry={reload} /></View></View>;

  const header = (
    <View>
      <Alert kind="gray" icon="info">{t('m_read_only')}</Alert>
      <PctEquation calc={a.calc} settings={data.settings} />
      {(a.note_ar || a.addendum || a.scope_cut || a.extra_module) ? (
        <Alert kind={a.scope_cut ? 'orange' : 'blue'}>
          <AppTags a={a} />
          {a.note_ar ? <Txt size={fontSize.m} color={colors.text} style={{ marginTop: 4 }}>{a.note_ar}</Txt> : null}
        </Alert>
      ) : null}
      <View style={st.search}>
        <Icon name="search" size={16} color={colors.gray600} />
        <TextInput value={q} onChangeText={v => setFilter(() => setQ(v))} placeholder={t('m_search_items')} placeholderTextColor={colors.gray500}
          style={[st.searchInput, font(400)]} accessibilityLabel={t('filter')} autoCorrect={false} clearButtonMode="while-editing" />
      </View>
      <View style={st.chips}>
        <Chip label={t('m_all')} on={test === ''} onPress={() => setFilter(() => setTest(''))} />
        {(['2', '1', '3', '0'] as const).map(k => <Chip key={k} label={t('ts_' + k)} on={test === k} onPress={() => setFilter(() => setTest(test === k ? '' : k))} />)}
        {conflicts > 0 ? <Chip warn label={t('pass_conflict_n', { n: conflicts })} on={test === 'conflict'} onPress={() => setFilter(() => setTest(test === 'conflict' ? '' : 'conflict'))} /> : null}
      </View>
      <View style={st.toggle}>
        <Txt size={fontSize.m} style={ui.flex}>{t('show_disabled')}</Txt>
        <Switch value={showOff} onValueChange={v => setFilter(() => setShowOff(v))} accessibilityLabel={t('show_disabled')}
          trackColor={{ true: colors.gray800, false: colors.gray300 }} thumbColor={colors.white} />
      </View>
      <Txt size={fontSize.s} color={colors.textMuted} style={st.count}>{t('m_items_count', { shown: shown.length, total: fns.filter(f => !f.removed_at).length })}</Txt>
    </View>
  );

  return (
    <View style={ui.flex}>
      <TopBar back title={nm(a)} sub={nm(data.department)} />
      <FlatList
        data={shown.slice(0, limit)}
        keyExtractor={f => String(f.id)}
        renderItem={({ item }) => <ItemCard f={item} appId={a.id} pending={pendingIds.has(item.id)} />}
        ListHeaderComponent={header}
        ListEmptyComponent={<Empty>{t('fn_no_matches')}</Empty>}
        ListFooterComponent={limit < shown.length ? <Loading /> : undefined}
        onEndReached={() => setLimit(l => (l < shown.length ? l + PAGE : l))}
        onEndReachedThreshold={0.6}
        contentContainerStyle={st.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary]} tintColor={colors.primary} />}
        initialNumToRender={8}
        windowSize={7}
      />
    </View>
  );
}

const st = StyleSheet.create({
  pad: { padding: space.xl },
  list: { padding: space.xl, paddingBottom: space.xxl * 2 },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: space.l, marginBottom: space.m,
  },
  searchInput: { flex: 1, minHeight: 44, fontSize: 15, color: colors.text, textAlign: 'auto' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, marginBottom: space.m },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, minHeight: 32, borderRadius: radius.pill, backgroundColor: colors.gray100 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.m, marginBottom: space.s },
  count: { marginBottom: space.m },
});

// Alerts (web: the bell + pages/Notifications.jsx): category tabs, unread only, pages of 30 (more at the end of the
// list), mark one read / unread, mark all read. Opening an alert marks it read and opens its screen when the phone
// has it (lib/links.ts: an application or one of its items, a department, the approvals). The list reloads when the
// unread count changes (live stream) and when events may have been missed. GET /api/notifications,
// POST /api/notifications/:id/read|unread, /read-all.
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Toggle } from '@/components/Toggle';
import { router, type Href } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useNotifCount } from '@/lib/notifCount';
import { path, qs } from '@/lib/api';
import { mobileRoute } from '@/lib/links';
import { useLiveUpdates } from '@/lib/liveContext';
import type { Notif, NotifList } from '@/lib/types';
import { SEV_COLOR, SEV_ICON, TABS, type NotifTab } from '@/shared/web';
import { colors, fontSize, pills, radius, space } from '@/theme';
import { Icon } from '@/components/Icon';
import { TopBar } from '@/components/TopBar';
import { Button, Empty, ErrorBox, Loading, Txt, ltr, s as ui } from '@/components/ui';

const PAGE = 30;

function Row({ n, onOpen, onToggle }: { n: Notif; onOpen: (n: Notif) => void; onToggle: (n: Notif) => void }) {
  const { t, timeAgo } = useI18n();
  const sev = pills[SEV_COLOR[n.severity] ?? 'blue'];
  return (
    <View style={[st.row, !n.read && st.unread]}>
      <Pressable style={st.main} onPress={() => onOpen(n)} accessibilityRole="button"
        accessibilityLabel={`${n.title}. ${n.read ? t('notif_read') : t('notif_unread')}`}>
        <View style={[st.sev, { backgroundColor: sev.bg }]}><Icon name={SEV_ICON[n.severity] ?? 'info'} size={14} color={sev.text} /></View>
        <View style={ui.flex}>
          <Txt w={n.read ? 600 : 700} size={fontSize.m}>{n.title}</Txt>
          {n.body ? <Txt size={fontSize.s} color={colors.gray700} numberOfLines={4}>{n.body}</Txt> : null}
          <Txt size={fontSize.xs} color={colors.textMuted}>
            {t('nt_' + n.type)} · {timeAgo(n.updated_at || n.created_at)}{n.count > 1 ? ' · ' + ltr(n.count) : ''}
          </Txt>
        </View>
      </Pressable>
      <Pressable onPress={() => onToggle(n)} style={st.dotBtn} hitSlop={6} accessibilityRole="button"
        accessibilityLabel={n.read ? t('mark_unread') : t('mark_read')}>
        <View style={[st.dot, !n.read && st.dotOn]} />
      </Pressable>
    </View>
  );
}

export default function Notifications() {
  const { t, lang } = useI18n();
  const { api } = useSession();
  const { count, reload: reloadCount } = useNotifCount();
  const [tab, setTab] = useState<NotifTab>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<Notif[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  // "security" groups the security and system categories (as on the web)
  const query = useCallback(async (before: number | null, live = false) => {
    const cat = tab === 'all' || tab === 'security' ? '' : tab;
    const d = await api.get<NotifList>('/notifications' + qs({ limit: PAGE, lang, unread: unreadOnly ? '1' : '', category: cat, before }), { live });
    return { ...d, items: tab === 'security' ? d.items.filter(n => n.category === 'security' || n.category === 'system') : d.items };
  }, [api, tab, lang, unreadOnly]);

  const load = useCallback(async (mode: 'pull' | 'live') => {
    const my = ++seq.current;
    if (mode === 'pull') setRefreshing(true);
    try {
      const d = await query(null, mode === 'live');
      if (my === seq.current) { setItems(d.items); setNext(d.next_before); setErr(null); }
    } catch (e) {
      if (my === seq.current && mode !== 'live') setErr(e);
    } finally {
      if (mode === 'pull') setRefreshing(false);
    }
  }, [query]);

  // first page, again whenever the tab or the unread filter changes
  useEffect(() => {
    const my = ++seq.current;
    query(null)
      .then(d => { if (my === seq.current) { setItems(d.items); setNext(d.next_before); setErr(null); } })
      .catch(e => { if (my === seq.current) { setErr(e); setItems([]); } });
  }, [query]);
  // reload when the unread count changes (another device, a new alert), and when events may have been missed
  // (reconnection, back in the foreground, fallback poll)
  useLiveUpdates(m => { if (m.reason !== 'change') load('live'); });
  const lastUnread = useRef(count.unread);
  useEffect(() => { if (count.unread !== lastUnread.current) { lastUnread.current = count.unread; load('live'); } }, [count.unread, load]);

  const loadMore = async () => {
    if (!next || more) return;
    setMore(true);
    try { const d = await query(next); setItems(x => [...(x || []), ...d.items]); setNext(d.next_before); } catch (e) { setErr(e); }
    setMore(false);
  };
  const toggle = async (n: Notif) => {
    setItems(x => x?.map(i => (i.id === n.id ? { ...i, read: !n.read } : i)) ?? x);
    try { await api.post(path`/notifications/${n.id}/${n.read ? 'unread' : 'read'}`); } catch (e) { setErr(e); }
    reloadCount(); load('live');
  };
  const open = (n: Notif) => {
    if (!n.read) toggle(n);
    const to = mobileRoute(n.link);
    if (to) router.navigate(to as Href);
  };
  const readAll = async () => {
    try { await api.post('/notifications/read-all'); } catch (e) { setErr(e); }
    reloadCount(); load('live');
  };

  const header = (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.tabs}>
        {TABS.map(k => (
          <Pressable key={k} onPress={() => { if (k !== tab) { setItems(null); setTab(k); } }} style={[st.tab, tab === k && st.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
            <Txt w={600} size={fontSize.s} color={tab === k ? colors.white : colors.textMuted} style={{ lineHeight: 20 }}>{t('ncat_' + k)}</Txt>
          </Pressable>
        ))}
      </ScrollView>
      <View style={st.tools}>
        <View style={st.switchRow}>
          <Toggle value={unreadOnly} onValueChange={v => { setItems(null); setUnreadOnly(v); }} accessibilityLabel={t('notif_unread_only')} />
          <Txt size={fontSize.m}>{t('notif_unread_only')}</Txt>
        </View>
        <Button kind="default" small icon="check" title={t('mark_all_read')} onPress={readAll} disabled={!count.unread} />
      </View>
      {err ? <ErrorBox error={err} /> : null}
    </View>
  );

  return (
    <View style={ui.flex}>
      <TopBar title={t('notifications')} sub={t('notif_page_sub')} bell={false} />
      {items === null ? <Loading /> : (
        <FlatList
          data={items}
          keyExtractor={n => String(n.id)}
          renderItem={({ item }) => <Row n={item} onOpen={open} onToggle={toggle} />}
          ListHeaderComponent={header}
          ListEmptyComponent={err ? undefined : <Empty>{t('notif_none')}</Empty>}
          ListFooterComponent={more ? <Loading /> : undefined}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          contentContainerStyle={st.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { reloadCount(); load('pull'); }} colors={[colors.primary]} tintColor={colors.primary} />}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  list: { padding: space.xl, paddingBottom: space.xxl * 2 },
  tabs: { gap: space.xs, paddingBottom: space.m },
  tab: { paddingHorizontal: 12, minHeight: 32, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.gray100 },
  tabOn: { backgroundColor: colors.gray900 },
  tools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m, marginBottom: space.l, flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, marginBottom: space.m,
  },
  unread: { backgroundColor: colors.unreadBg },
  main: { flex: 1, flexDirection: 'row', gap: space.m, padding: space.l },
  sev: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  dotBtn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: colors.gray400 },
  dotOn: { backgroundColor: colors.primaryBlue, borderColor: colors.primaryBlue },
});

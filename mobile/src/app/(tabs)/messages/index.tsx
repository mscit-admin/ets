// Messages (web: pages/Messages.jsx). Everyone has an Inbox of private 1:1 conversations; a user with the 'msg'
// permission also gets a «المُرسَلة» view and a «رسالة جديدة» compose button. A conversation is strictly between the
// sender and one recipient — the server enforces it, the UI mirrors it. Pull to refresh; the list also reloads when a
// message arrives (the unread count changes) and when live events may have been missed (reconnect, foreground, poll).
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useMsgCount } from '@/lib/msgCount';
import { useLoad } from '@/lib/useLoad';
import { forwardIcon } from '@/lib/rtl';
import type { InboxThread, SentBroadcast } from '@/lib/types';
import { colors, fontSize, radius, space } from '@/theme';
import { Icon } from '@/components/Icon';
import { TopBar } from '@/components/TopBar';
import { Button, Empty, ErrorBox, Loading, Txt, ltr, s as ui } from '@/components/ui';

type Tab = 'inbox' | 'sent';

function Row({ title, sub, time, unread, onOpen, label }: {
  title: string; sub?: string; time: string; unread: boolean; onOpen: () => void; label: string;
}) {
  const { t, timeAgo, rtl } = useI18n();
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [st.row, unread && st.unread, pressed && st.pressed]}
      accessibilityRole="button" accessibilityLabel={`${label}. ${unread ? t('msg_unread') : ''}`}>
      <View style={ui.flex}>
        <View style={st.titleRow}>
          <Txt w={unread ? 700 : 600} size={fontSize.m} numberOfLines={1} style={ui.flex}>{title}</Txt>
          {unread ? <View style={st.dot} /> : null}
        </View>
        {sub ? <Txt size={fontSize.s} color={colors.gray700} numberOfLines={2}>{sub}</Txt> : null}
        <Txt size={fontSize.xs} color={colors.textMuted}>{timeAgo(time)}</Txt>
      </View>
      <Icon name={forwardIcon(rtl)} size={16} color={colors.gray500} />
    </Pressable>
  );
}

function InboxList({ bump }: { bump: number }) {
  const { t } = useI18n();
  const { api } = useSession();
  const { data, error, loading, refreshing, refresh, reload, live } = useLoad(
    o => api.get<{ threads: InboxThread[] }>('/messages/inbox', o), []);
  // a newly arrived message changes the unread badge but not the tracker stream: reload when the badge or a send changes
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } live(); }, [bump, live]);

  if (loading && !data) return <Loading />;
  const threads = data?.threads ?? [];
  return (
    <FlatList
      data={threads}
      keyExtractor={x => String(x.id)}
      renderItem={({ item }) => (
        <Row label={`${item.from_name}${item.subject ? ' · ' + item.subject : ''}`}
          title={`${item.from_name}${item.subject ? ' · ' + item.subject : ''}`} sub={item.preview}
          time={item.last_post_at} unread={item.unread}
          onOpen={() => router.push(`/messages/thread/${item.id}`)} />
      )}
      ListHeaderComponent={error ? <ErrorBox error={error} onRetry={reload} /> : undefined}
      ListEmptyComponent={error ? undefined : <Empty>{t('msg_no_inbox')}</Empty>}
      contentContainerStyle={st.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary]} tintColor={colors.primary} />}
    />
  );
}

function SentList({ bump }: { bump: number }) {
  const { t } = useI18n();
  const { api } = useSession();
  const { data, error, loading, refreshing, refresh, reload, live } = useLoad(
    o => api.get<{ broadcasts: SentBroadcast[] }>('/messages/sent', o), []);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } live(); }, [bump, live]);

  if (loading && !data) return <Loading />;
  const broadcasts = data?.broadcasts ?? [];
  return (
    <FlatList
      data={broadcasts}
      keyExtractor={x => String(x.id)}
      renderItem={({ item }) => {
        const sub = `${t('msg_recipient_count', { n: item.recipient_count })} · ${t('msg_reply_count', { n: item.reply_count })}`
          + (item.unread_replies ? ' · ' + t('msg_unread_replies') : '');
        return (
          <Row label={item.subject || item.preview} title={item.subject || item.preview || ltr(item.id)} sub={sub}
            time={item.created_at} unread={item.unread_replies > 0}
            onOpen={() => router.push(`/messages/sent/${item.id}`)} />
        );
      }}
      ListHeaderComponent={error ? <ErrorBox error={error} onRetry={reload} /> : undefined}
      ListEmptyComponent={error ? undefined : <Empty>{t('msg_no_sent')}</Empty>}
      contentContainerStyle={st.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary]} tintColor={colors.primary} />}
    />
  );
}

export default function Messages() {
  const { t } = useI18n();
  const { can } = useSession();
  const { count } = useMsgCount();
  const msg = can('msg');
  const [tab, setTab] = useState<Tab>('inbox');

  return (
    <View style={ui.flex}>
      <TopBar title={t('messages_title')} sub={t('messages_sub')} />
      {msg ? (
        <View style={st.tools}>
          <View style={st.tabs}>
            {(['inbox', 'sent'] as Tab[]).map(k => (
              <Pressable key={k} onPress={() => setTab(k)} style={[st.tab, tab === k && st.tabOn]}
                accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
                <Icon name={k === 'inbox' ? 'inbox' : 'out'} size={15} color={tab === k ? colors.white : colors.textMuted} />
                <Txt w={600} size={fontSize.s} color={tab === k ? colors.white : colors.textMuted} style={st.tabText}>
                  {t(k === 'inbox' ? 'msg_inbox' : 'msg_sent')}
                </Txt>
              </Pressable>
            ))}
          </View>
          <Button small icon="plus" title={t('msg_compose')} onPress={() => router.push('/messages/compose')} />
        </View>
      ) : null}
      {tab === 'sent' && msg ? <SentList bump={count.replies} /> : <InboxList bump={count.inbox} />}
    </View>
  );
}

const st = StyleSheet.create({
  tools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m, padding: space.xl, paddingBottom: space.m, flexWrap: 'wrap' },
  tabs: { flexDirection: 'row', gap: space.xs },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 36, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.gray100 },
  tabOn: { backgroundColor: colors.gray900 },
  tabText: { lineHeight: 20 },
  list: { padding: space.xl, paddingTop: space.m, paddingBottom: space.xxl * 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: space.l, marginBottom: space.m,
  },
  unread: { backgroundColor: colors.unreadBg },
  pressed: { backgroundColor: colors.gray50 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primaryBlue },
});

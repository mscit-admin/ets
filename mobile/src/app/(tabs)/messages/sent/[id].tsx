// The per-recipient threads of one broadcast the caller authored (web: the Sent drill-down of pages/Messages.jsx).
// Author only — the server returns 404 otherwise. Each row opens that recipient's private thread. GET /messages/sent/:id.
import { useEffect, useRef } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useMsgCount } from '@/lib/msgCount';
import { useLoad } from '@/lib/useLoad';
import { forwardIcon } from '@/lib/rtl';
import { ApiError, path } from '@/lib/api';
import type { BroadcastThreads } from '@/lib/types';
import { colors, fontSize, radius, space } from '@/theme';
import { Icon } from '@/components/Icon';
import { TopBar } from '@/components/TopBar';
import { Empty, ErrorBox, Loading, Txt, s as ui } from '@/components/ui';

const numeric = (s: unknown) => /^[0-9]+$/.test(String(s));

export default function SentBroadcast() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, timeAgo, rtl } = useI18n();
  const { api } = useSession();
  const { count } = useMsgCount();
  const { data, error, loading, refreshing, refresh, reload, live } = useLoad(
    o => (numeric(id) ? api.get<BroadcastThreads>(path`/messages/sent/${id}`, o) : Promise.reject(new ApiError(404, 'not_found'))),
    [id]);
  // a reply from a recipient bumps the sent badge but not the tracker stream: reload when it changes
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } live(); }, [count.replies, live]);

  const b = data?.broadcast;
  return (
    <View style={ui.flex}>
      <TopBar back title={b ? (b.subject || b.preview || t('msg_sent')) : t('msg_sent')}
        sub={b ? t('msg_recipient_count', { n: b.recipient_count }) : undefined} />
      {loading && !data ? <Loading /> : error || !data ? (
        <View style={st.errWrap}><ErrorBox error={error} onRetry={reload} /></View>
      ) : (
        <FlatList
          data={data.threads}
          keyExtractor={x => String(x.id)}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/messages/thread/${item.id}`)}
              style={({ pressed }) => [st.row, item.unread && st.unread, pressed && st.pressed]}
              accessibilityRole="button" accessibilityLabel={`${item.recipient_name}. ${item.unread ? t('msg_unread_replies') : ''}`}>
              <View style={ui.flex}>
                <View style={st.titleRow}>
                  <Txt w={item.unread ? 700 : 600} size={fontSize.m} numberOfLines={1} style={ui.flex}>{item.recipient_name}</Txt>
                  {item.unread ? <View style={st.dot} /> : null}
                </View>
                {item.preview ? <Txt size={fontSize.s} color={colors.gray700} numberOfLines={2}>{item.preview}</Txt> : null}
                <Txt size={fontSize.xs} color={colors.textMuted}>{timeAgo(item.last_post_at)}</Txt>
              </View>
              <Icon name={forwardIcon(rtl)} size={16} color={colors.gray500} />
            </Pressable>
          )}
          ListEmptyComponent={<Empty>{t('msg_no_threads')}</Empty>}
          contentContainerStyle={st.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary]} tintColor={colors.primary} />}
        />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  errWrap: { padding: space.xl },
  list: { padding: space.xl, paddingBottom: space.xxl * 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: space.l, marginBottom: space.m,
  },
  unread: { backgroundColor: colors.unreadBg },
  pressed: { backgroundColor: colors.gray50 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primaryBlue },
});

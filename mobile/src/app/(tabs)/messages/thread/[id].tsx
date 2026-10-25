// A conversation thread (web: the Thread component of pages/Messages.jsx): the full post list, chat-style and RTL
// correct — the caller's own posts aligned to the end, the other party's to the start. Opening marks the caller's
// side read (the GET does it server-side), so the unread badge is refreshed afterwards. A reply box appends a post
// (POST /threads/:id/reply). A 403 (not a party) or 404 is shown as a plain error with a back button.
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useMsgCount } from '@/lib/msgCount';
import { useLoad } from '@/lib/useLoad';
import { ApiError, path } from '@/lib/api';
import type { MsgPost, ThreadData } from '@/lib/types';
import { toast } from '@/lib/toast';
import { colors, fontSize, radius, space } from '@/theme';
import { TextArea } from '@/components/form';
import { TopBar } from '@/components/TopBar';
import { Button, ErrorBox, Loading, Txt, s as ui } from '@/components/ui';

const BODY_MAX = 4000;
const numeric = (s: unknown) => /^[0-9]+$/.test(String(s));

function Bubble({ post }: { post: MsgPost }) {
  const { t, timeAgo } = useI18n();
  return (
    <View style={[st.bubbleRow, post.mine ? st.mineRow : st.theirsRow]}>
      <View style={[st.bubble, post.mine ? st.mine : st.theirs]}>
        <Txt w={600} size={fontSize.xs} color={post.mine ? colors.gray300 : colors.textMuted}>
          {post.mine ? t('msg_you') : post.author_name}
        </Txt>
        <Txt size={fontSize.m} color={post.mine ? colors.white : colors.text}>{post.body}</Txt>
        <Txt size={fontSize.xs} color={post.mine ? colors.gray400 : colors.textMuted} style={st.time}>{timeAgo(post.created_at)}</Txt>
      </View>
    </View>
  );
}

export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, errText } = useI18n();
  const { api } = useSession();
  const { reload: reloadCount } = useMsgCount();
  const listRef = useRef<FlatList<MsgPost>>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, error, loading, refreshing, refresh, reload, live } = useLoad(
    o => (numeric(id) ? api.get<ThreadData>(path`/messages/threads/${id}`, o) : Promise.reject(new ApiError(404, 'not_found'))),
    [id]);
  // opening (and every reload) marks the caller's side read server-side: refresh the badge
  useEffect(() => { if (data) reloadCount(); }, [data, reloadCount]);

  const send = useCallback(async () => {
    const body = reply.trim();
    if (!body || busy) return;
    setBusy(true);
    try { await api.post(path`/messages/threads/${id}/reply`, { body }); setReply(''); live(); }
    catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  }, [reply, busy, api, id, live, errText]);

  const thread = data?.thread;
  const other = thread ? (thread.side === 'author' ? thread.recipient : thread.author) : null;
  const closed = !!thread?.closed_at;

  return (
    <View style={ui.flex}>
      <TopBar back title={thread?.subject || t('msg_conversation')}
        sub={other ? `${t('msg_from')}: ${other.full_name} · ${other.username}` : undefined} />
      {loading && !data ? <Loading /> : error || !data ? (
        <View style={st.errWrap}><ErrorBox error={error} onRetry={reload} /></View>
      ) : (
        <View style={ui.flex}>
          <FlatList
            ref={listRef}
            data={data.posts}
            keyExtractor={p => String(p.id)}
            renderItem={({ item }) => <Bubble post={item} />}
            contentContainerStyle={st.posts}
            refreshing={refreshing}
            onRefresh={refresh}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />
          <View style={st.replyBar}>
            {closed ? (
              <Txt size={fontSize.s} color={colors.textMuted} center style={ui.flex}>{t('err_thread_closed')}</Txt>
            ) : (
              <>
                <View style={ui.flex}>
                  <TextArea label={t('msg_reply')} value={reply} onChangeText={setReply} maxLength={BODY_MAX}
                    placeholder={t('msg_reply_ph')} style={st.input} />
                </View>
                <Button small icon="in" title={busy ? t('msg_replying') : t('msg_send_reply')} onPress={send}
                  busy={busy} disabled={!reply.trim()} style={st.sendBtn} />
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  errWrap: { padding: space.xl },
  posts: { padding: space.xl, paddingBottom: space.l, gap: space.m },
  bubbleRow: { flexDirection: 'row' },
  mineRow: { justifyContent: 'flex-end' },
  theirsRow: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, paddingHorizontal: space.l, paddingVertical: space.m, gap: 3 },
  mine: { backgroundColor: colors.primary, borderTopEndRadius: radius.sm },
  theirs: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderTopStartRadius: radius.sm },
  time: { textAlign: 'end' },
  replyBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: space.m, padding: space.l, backgroundColor: colors.card,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  input: { minHeight: 44 },
  sendBtn: { marginBottom: 2 },
});

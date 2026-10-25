// Messaging API contract (1.12.26 web; mobile 0.3.0). The screens live in src/app/(tabs)/messages; these tests lock
// the request each screen makes against the mock fetch — the paths, the methods, and (the part the server cares
// about) the X-ETS convention: the unread-count badge is an AUTOMATIC reload (X-ETS-Live: 1, never activity for the
// idle timeout), while sending / replying / resolving are person-started actions (X-ETS-Activity: 1).
import { createApi, path } from '@/lib/api';
import { hasKey } from '@/lib/i18n';
import type { MsgUnread } from '@/lib/types';

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => body, text: async () => '' }) as unknown as Response;

function mock(body: unknown = {}) {
  const fetchImpl = jest.fn(async () => json(200, body));
  const api = createApi({ baseUrl: () => 'https://ets.example.ly', onUnauthorized: jest.fn(), fetchImpl });
  const last = () => fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { api, fetchImpl, last };
}

describe('messages API contract', () => {
  it('the unread-count badge is an automatic request (X-ETS-Live, not activity)', async () => {
    const { api, last } = mock({ inbox: 2, replies: 1, total: 3 } satisfies MsgUnread);
    const d = await api.get<MsgUnread>('/messages/unread-count', { live: true });
    expect(d.total).toBe(d.inbox + d.replies);
    const [url, init] = last();
    expect(url).toBe('https://ets.example.ly/api/messages/unread-count');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ 'X-ETS-Live': '1' });
    expect(init.headers).not.toHaveProperty('X-ETS-Activity');
  });

  it('opening a thread marks it read (GET, automatic) and encodes the id', async () => {
    const { api, last } = mock({ thread: {}, posts: [] });
    await api.get(path`/messages/threads/${42}`, { live: true });
    const [url, init] = last();
    expect(url).toBe('https://ets.example.ly/api/messages/threads/42');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ 'X-ETS-Live': '1' });
  });

  it('a reply is a person-started POST (X-ETS-Activity) with the body', async () => {
    const { api, last } = mock({ post_id: 7 });
    await api.post(path`/messages/threads/${5}/reply`, { body: 'مرحبا' });
    const [url, init] = last();
    expect(url).toBe('https://ets.example.ly/api/messages/threads/5/reply');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-ETS-Activity': '1', 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ body: 'مرحبا' }));
  });

  it('compose resolves an audience and sends with subject + audience', async () => {
    const { api, fetchImpl } = mock({ count: 4, recipients: [] });
    const audience = { all: false, users: [1, 2], depts: ['dept-a'], roles: ['tm'] };
    await api.post('/messages/resolve', { audience });
    await api.post('/messages', { subject: 'عنوان', body: 'النص', audience });
    const resolve = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const send = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(resolve[0]).toBe('https://ets.example.ly/api/messages/resolve');
    expect(JSON.parse(String(resolve[1].body))).toEqual({ audience });
    expect(send[0]).toBe('https://ets.example.ly/api/messages');
    expect(JSON.parse(String(send[1].body))).toEqual({ subject: 'عنوان', body: 'النص', audience });
    expect(send[1].headers).toMatchObject({ 'X-ETS-Activity': '1' });
  });

  it('the recipient search encodes the query', async () => {
    const { api, last } = mock({ recipients: [] });
    await api.get('/messages/recipients?q=' + encodeURIComponent('نجم /x'));
    expect(last()[0]).toBe('https://ets.example.ly/api/messages/recipients?q=%D9%86%D8%AC%D9%85%20%2Fx');
  });
});

describe('message translations', () => {
  it('every message string the screens use exists in both languages', () => {
    const keys = [
      'messages_title', 'messages_sub', 'msg_inbox', 'msg_sent', 'msg_compose', 'msg_new_title', 'msg_subject',
      'msg_subject_ph', 'msg_body', 'msg_body_ph', 'msg_to_people', 'msg_search_people', 'msg_everyone', 'msg_by_dept',
      'msg_by_role', 'msg_resolved_count', 'msg_resolved_zero', 'msg_send', 'msg_sending', 'msg_sent_ok', 'msg_reply',
      'msg_reply_ph', 'msg_send_reply', 'msg_replying', 'msg_from', 'msg_you', 'msg_no_inbox', 'msg_no_sent',
      'msg_no_threads', 'msg_recipient_count', 'msg_reply_count', 'msg_unread', 'msg_unread_replies', 'msg_conversation',
      'msg_select_hint', 'msg_badge_title',
    ];
    for (const k of keys) for (const lang of ['ar', 'en'] as const) expect([k, lang, hasKey(lang, k)]).toEqual([k, lang, true]);
  });
});

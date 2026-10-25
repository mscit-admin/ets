// Unread messages for the Messages tab badge: GET /api/messages/unread-count ({ inbox, replies, total }, like the
// web sidebar badge). A new message / reply arrives as a notification (services/messages.js fires message_received /
// message_reply), so the count is reloaded on every notif-stream event and whenever events may have been missed
// (reconnection, back in the foreground, fallback poll), and again after the app marks a thread read. Every reload is
// an automatic request (X-ETS-Live: 1) — never activity for the server's idle timeout.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSession } from './session';
import { useNotifStream } from './liveContext';
import type { MsgUnread } from './types';

type Ctx = { count: MsgUnread; reload: () => void };
const EMPTY: MsgUnread = { inbox: 0, replies: 0, total: 0 };
const C = createContext<Ctx>({ count: EMPTY, reload: () => {} });

export function MsgCountProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const [count, setCount] = useState<MsgUnread>(EMPTY);
  const reload = useCallback(() => { api.get<MsgUnread>('/messages/unread-count', { live: true }).then(setCount).catch(() => {}); }, [api]);
  useEffect(() => { reload(); }, [reload]);
  // a new message or reply bumps the bell (message_received / message_reply), so refresh on notif events and resyncs
  useNotifStream(() => reload(), () => reload());
  const value = useMemo(() => ({ count, reload }), [count, reload]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export const useMsgCount = () => useContext(C);

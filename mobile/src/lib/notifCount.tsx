// Unread alerts of the bell and the tab badge: GET /api/notifications/count once, then the live stream's
// "notif_changed" { unread, top_severity } (lib/liveContext.tsx, like the web's bell); the count is read again when
// events may have been missed (reconnection, back in the foreground, fallback poll) and after marking alerts read.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSession } from './session';
import { useNotifStream } from './liveContext';
import type { NotifCount } from './types';

type Ctx = { count: NotifCount; reload: () => void };
const EMPTY: NotifCount = { unread: 0, critical: 0, top_severity: null };
const C = createContext<Ctx>({ count: EMPTY, reload: () => {} });

export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

export function NotifCountProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const [count, setCount] = useState<NotifCount>(EMPTY);
  const reload = useCallback(() => { api.get<NotifCount>('/notifications/count', { live: true }).then(setCount).catch(() => {}); }, [api]);
  useEffect(() => { reload(); }, [reload]);
  useNotifStream(d => setCount(c => ({ ...c, unread: d.unread, top_severity: d.top_severity })), reload);
  const value = useMemo(() => ({ count, reload }), [count, reload]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export const useNotifCount = () => useContext(C);

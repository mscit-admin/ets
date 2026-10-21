// Unread alerts of the bell and the tab badge: GET /api/notifications/count, reloaded every POLL_MS while the
// app is in the foreground (phase 1 polling; the web uses the live stream), and after marking alerts read.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSession } from './session';
import { POLL_MS } from './useLoad';
import type { NotifCount } from './types';

type Ctx = { count: NotifCount; reload: () => void };
const EMPTY: NotifCount = { unread: 0, critical: 0, top_severity: null };
const C = createContext<Ctx>({ count: EMPTY, reload: () => {} });

export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

export function NotifCountProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const [count, setCount] = useState<NotifCount>(EMPTY);
  const reload = useCallback(() => { api.get<NotifCount>('/notifications/count', { live: true }).then(setCount).catch(() => {}); }, [api]);
  useEffect(() => {
    reload();
    let timer: ReturnType<typeof setInterval> | null = setInterval(reload, POLL_MS);
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') { reload(); if (!timer) timer = setInterval(reload, POLL_MS); }
      else if (timer) { clearInterval(timer); timer = null; }
    });
    return () => { if (timer) clearInterval(timer); sub.remove(); };
  }, [reload]);
  const value = useMemo(() => ({ count, reload }), [count, reload]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export const useNotifCount = () => useContext(C);

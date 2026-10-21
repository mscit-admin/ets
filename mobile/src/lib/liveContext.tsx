// The app's live-updates stream (lib/live.ts over lib/liveSse.ts) while signed in, and the hooks of the screens:
//   useLiveUpdates(onChange, { filter })  reload a screen when its data may have changed (web: useLiveUpdates)
//   useNotifStream(onCount, onResync)      the unread count of the bell and the alerts tab (web: useNotifStream)
//   useLiveStatus()                         'live' | 'connecting' | 'polling' | 'off'
// Mounted by app/(tabs)/_layout.tsx, so the stream exists only for a signed-in user and closes on sign-out.
import { createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSession } from './session';
import { LiveClient, type LiveStatus, type NotifSummary } from './live';
import { sseConnect } from './liveSse';
import type { LiveMsg } from '@/shared/web';

const Ctx = createContext<LiveClient | null>(null);

// the stream pauses only in the background (iOS "inactive" — control centre, a system dialog — keeps it)
const foreground = () => AppState.currentState !== 'background';

export function LiveProvider({ children }: { children: ReactNode }) {
  const { server, checkSession } = useSession();
  const client = useMemo(() => (server
    ? new LiveClient({ connect: sseConnect(server + '/api/events'), isActive: foreground, onSessionEnded: checkSession })
    : null), [server, checkSession]);
  useEffect(() => {
    if (!client) return undefined;
    client.revive();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'background') client.setActive(false);
      else if (s === 'active') client.setActive(true);
    });
    return () => { sub.remove(); client.destroy(); };
  }, [client]);
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export const useLiveClient = () => useContext(Ctx);

/**
 * onChange() (debounced) whenever the data may have changed: an event from the server, the app back in the
 * foreground, a reconnection, or the 30 s poll while the stream is unavailable. filter(msg) → false skips an event
 * about another department / application.
 */
export function useLiveUpdates(onChange: (m: LiveMsg) => void, { filter, enabled = true }: { filter?: (m: LiveMsg) => boolean; enabled?: boolean } = {}) {
  const client = useLiveClient();
  const changed = useEffectEvent((m: LiveMsg) => onChange(m));
  const currentFilter = useEffectEvent(() => filter);
  useEffect(() => {
    if (!client || !enabled) return undefined;
    return client.subscribeDebounced(m => changed(m), () => currentFilter());
  }, [client, enabled]);
}

export function useNotifStream(onCount: (d: NotifSummary) => void, onResync: () => void) {
  const client = useLiveClient();
  const counted = useEffectEvent((d: NotifSummary) => onCount(d));
  const resync = useEffectEvent(() => onResync());
  useEffect(() => {
    if (!client) return undefined;
    return client.subscribeNotif(d => counted(d), () => resync());
  }, [client]);
}

export function useLiveStatus(): LiveStatus {
  const client = useLiveClient();
  const subscribe = useCallback((f: () => void) => (client ? client.onStatus(f) : () => {}), [client]);
  return useSyncExternalStore(subscribe, () => client?.status ?? 'off', () => 'off');
}

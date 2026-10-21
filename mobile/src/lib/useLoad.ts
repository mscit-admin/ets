// Data loader of a screen, like the web's useLoad (frontend/src/components/ui.jsx) + useLiveUpdates:
//   data / error / loading;  refresh() for pull-to-refresh (keeps the data on screen);
//   live updates (lib/liveContext.tsx): when the server says this screen's data changed — or the app comes back to the
//   foreground, the stream reconnects, or the fallback poll fires — the screen reloads with X-ETS-Live: 1 (not user
//   activity for the idle timeout). A screen that is not focused (under another one in the stack) only notes it and
//   reloads when it is focused again. live.filter skips events about other departments / applications.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useLiveUpdates } from './liveContext';
import type { LiveMsg } from '@/shared/web';

type Loader<T> = (opts: { live?: boolean }) => Promise<T>;
type Opts = { live?: boolean; filter?: (m: LiveMsg) => boolean };

export function useLoad<T>(fn: Loader<T>, deps: unknown[], { live = true, filter }: Opts = {}) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [refreshing, setRefreshing] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const run = useCallback(async (mode: 'load' | 'pull' | 'live') => {
    const my = ++seq.current;
    if (mode === 'load') setState(s => ({ ...s, loading: true }));
    if (mode === 'pull') setRefreshing(true);
    try {
      const data = await fnRef.current({ live: mode === 'live' });
      if (my === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      // a failed automatic reload keeps what is on screen; a load or a pull shows the error
      if (my === seq.current && mode !== 'live') setState(s => ({ data: mode === 'pull' ? s.data : null, error, loading: false }));
    } finally {
      if (mode === 'pull') setRefreshing(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run('load'); }, deps);

  const focused = useRef(true);
  const stale = useRef(false);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (stale.current) { stale.current = false; run('live'); }
    return () => { focused.current = false; };
  }, [run]));
  useLiveUpdates(() => {
    if (focused.current) run('live'); else stale.current = true;
  }, { filter, enabled: live });

  return {
    ...state,
    refreshing,
    refresh: useCallback(() => run('pull'), [run]),
    reload: useCallback(() => run('load'), [run]),
    live: useCallback(() => run('live'), [run]),
  };
}

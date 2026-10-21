// Data loader of a screen, like the web's useLoad (frontend/src/components/ui.jsx):
//   data / error / loading;  refresh() for pull-to-refresh (keeps the data on screen);
//   while the screen is focused and the app is in the foreground it reloads every POLL_MS (live updates of
//   phase 1: polling instead of the web's Server-Sent Events, see mobile/README.md). Those automatic reloads send
//   X-ETS-Live: 1, so they do not keep an idle session alive (same rule as the web).
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

export const POLL_MS = 60_000;

type Loader<T> = (opts: { live?: boolean }) => Promise<T>;

export function useLoad<T>(fn: Loader<T>, deps: unknown[], { poll = true }: { poll?: boolean } = {}) {
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

  useFocusEffect(useCallback(() => {
    if (!poll) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => run('live'), POLL_MS); };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') { run('live'); start(); } else stop();
    });
    return () => { stop(); sub.remove(); };
  }, [poll, run]));

  return {
    ...state,
    refreshing,
    refresh: useCallback(() => run('pull'), [run]),
    reload: useCallback(() => run('load'), [run]),
    live: useCallback(() => run('live'), [run]),
  };
}

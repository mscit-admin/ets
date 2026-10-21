// Mounts the presence reporter (lib/presence.ts) for a signed-in user: the current expo-router path, the app's
// foreground / background state, and POST /api/presence through the app's API client.
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { usePathname } from 'expo-router';
import { useSession } from './session';
import { PresenceReporter, screenOf, type Presence } from './presence';

export function usePresence() {
  const { api } = useSession();
  const pathname = usePathname();
  const [reporter] = useState(() => new PresenceReporter((p: Presence) => api.post('/presence', p, {
    live: true, headers: { 'X-ETS-Client': 'mobile' } }), AppState.currentState !== 'background'));
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'background') reporter.setActive(false);
      else if (s === 'active') reporter.setActive(true);
    });
    return () => { sub.remove(); reporter.stop(); };
  }, [reporter]);
  useEffect(() => { reporter.screen(screenOf(pathname)); }, [reporter, pathname]);
}

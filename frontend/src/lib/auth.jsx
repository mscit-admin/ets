import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { startActivityTracker } from './activity.js';
import { useI18n } from '../i18n/index.jsx';

const Auth = createContext(null);

export function AuthProvider({ children }) {
  const { setLang } = useI18n();
  const [me, setMe] = useState(null); // null = loading; {authenticated:false, ended?} = signed out
  const seq = useRef(0);
  const meRef = useRef(null);
  meRef.current = me;
  // Several checks may run at once (a 401 from each screen, the live stream's session_ended, sign-in): only the
  // answer of the latest one is applied, so an older answer can never undo a newer one (1.12.2).
  // A check that could not reach the server (network, 5xx, 429) keeps a signed-in state instead of showing the
  // sign-in page while the session may still be valid; the server refuses an ended session on the next request anyway.
  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      const m = await api.get('/auth/me', { live: true });   // a check, never user activity
      if (my !== seq.current) return m;
      setMe(m);
      if (m.authenticated && m.stage === 'done' && m.user?.language) setLang(m.user.language);
      return m;
    } catch (e) {
      const cur = meRef.current;
      if (my !== seq.current) return cur || { authenticated: false };
      if (cur?.authenticated && e?.status !== 401) return cur;
      const m = { authenticated: false };
      setMe(m);
      return m;
    }
  }, [setLang]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setUnauthorizedHandler(() => { refresh(); }); }, [refresh]);

  // Idle timeout: only real input extends the session; after the idle limit without input the session is ended on
  // the server and the sign-in page says why (lib/activity.js).
  const session = me?.authenticated ? me.session : null;
  const sessionKey = session ? `${me.stage}|${session.expires_at}` : '';
  useEffect(() => {
    if (!session) return undefined;
    return startActivityTracker(session, {
      onEnded: reason => { ++seq.current; setMe({ authenticated: false, ended: reason }); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const value = useMemo(() => {
    const user = me?.user;
    const can = p => !!user?.permissions?.includes(p);
    const logout = async () => { try { await api.post('/auth/logout'); } finally { await refresh(); } };
    return { me, user, can, refresh, logout, ready: me !== null };
  }, [me, refresh]);

  return <Auth.Provider value={value}>{children}</Auth.Provider>;
}

export const useAuth = () => useContext(Auth);

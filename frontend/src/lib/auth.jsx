import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { useI18n } from '../i18n/index.jsx';

const Auth = createContext(null);

export function AuthProvider({ children }) {
  const { setLang } = useI18n();
  const [me, setMe] = useState(null); // null = loading; {authenticated:false} = signed out
  const refresh = useCallback(async () => {
    try {
      const m = await api.get('/auth/me');
      setMe(m);
      if (m.authenticated && m.stage === 'done' && m.user?.language) setLang(m.user.language);
      return m;
    } catch {
      const m = { authenticated: false };
      setMe(m);
      return m;
    }
  }, [setLang]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setUnauthorizedHandler(() => { refresh(); }); }, [refresh]);

  const value = useMemo(() => {
    const user = me?.user;
    const can = p => !!user?.permissions?.includes(p);
    const logout = async () => { try { await api.post('/auth/logout'); } finally { await refresh(); } };
    return { me, user, can, refresh, logout, ready: me !== null };
  }, [me, refresh]);

  return <Auth.Provider value={value}>{children}</Auth.Provider>;
}

export const useAuth = () => useContext(Auth);

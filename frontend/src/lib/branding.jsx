import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

// Branding uploaded in Settings → Branding. Falls back to the built-in icon when nothing is uploaded.
const Ctx = createContext(null);
const DEFAULT_ICON = '/favicon.svg';

export function BrandingProvider({ children }) {
  const [info, setInfo] = useState(null);
  const reload = useCallback(() => api.get('/auth/public-info').then(setInfo).catch(() => setInfo({})), []);
  useEffect(() => { reload(); }, [reload]);

  const value = useMemo(() => {
    const v = info?.branding || {};
    const url = k => (v[k] ? `/api/branding/${k}?v=${v[k]}` : null);
    const logo = url('logo') || DEFAULT_ICON;
    return { info, reload, versions: v, logo, favicon: url('favicon') || url('logo') || DEFAULT_ICON, loginBg: url('login_bg'),
      custom: { logo: !!v.logo, favicon: !!v.favicon, login_bg: !!v.login_bg } };
  }, [info, reload]);

  // browser tab icon
  useEffect(() => {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = value.favicon;
    link.type = value.favicon.endsWith('.svg') ? 'image/svg+xml' : '';
  }, [value.favicon]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useBranding = () => useContext(Ctx);

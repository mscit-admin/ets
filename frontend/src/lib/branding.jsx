import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useI18n } from '../i18n/index.jsx';

// Branding uploaded in Settings → Branding. Falls back to the built-in icon when nothing is uploaded.
const Ctx = createContext(null);
const DEFAULT_ICON = '/favicon.svg';

export function BrandingProvider({ children }) {
  const [info, setInfo] = useState(null);
  const reload = useCallback(() => api.get('/auth/public-info').then(setInfo).catch(() => setInfo({})), []);
  useEffect(() => { reload(); }, [reload]);

  // the organisation's default language applies until the visitor picks one
  const { setDefaultLang } = useI18n();
  useEffect(() => { if (info?.default_language) setDefaultLang(info.default_language); }, [info?.default_language, setDefaultLang]);

  const value = useMemo(() => {
    const v = info?.branding || {};
    const url = k => (v[k] ? `/api/branding/${k}?v=${v[k]}` : null);
    const logo = url('logo') || DEFAULT_ICON;
    return { info, reload, versions: v, logo,
      logoHeight: info?.logo_height || 28, loginLogoHeight: info?.login_logo_height || 64, favicon: url('favicon') || url('logo') || DEFAULT_ICON, loginBg: url('login_bg'),
      custom: { logo: !!v.logo, favicon: !!v.favicon, login_bg: !!v.login_bg } };
  }, [info, reload]);

  // top bar height follows the logo size (CSS variable used by the navbar and sidebar)
  useEffect(() => {
    document.documentElement.style.setProperty('--logo-h', value.logoHeight + 'px');
    document.documentElement.style.setProperty('--navbar-h', Math.max(52, value.logoHeight + 20) + 'px');
  }, [value.logoHeight]);

  // browser tab icon: only swap the existing <link rel="icon"> (from index.html) when a custom
  // favicon/logo is uploaded. Leaving the default untouched avoids a second /favicon.svg request
  // that would abort the one the browser already made from index.html (NS_BINDING_ABORTED).
  useEffect(() => {
    if (value.favicon === DEFAULT_ICON) return;
    const link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    if (value.favicon.endsWith('.svg')) link.type = 'image/svg+xml';
    else link.removeAttribute('type');
    link.href = value.favicon;
  }, [value.favicon]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useBranding = () => useContext(Ctx);

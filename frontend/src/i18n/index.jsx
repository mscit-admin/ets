import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { messages } from './messages.js';

const I18n = createContext(null);
const STORE = 'ets.lang';

const readStored = () => { try { return localStorage.getItem(STORE); } catch { return null; } };

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => (readStored() === 'en' ? 'en' : 'ar'));
  const chosen = useRef(!!readStored());

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  // An explicit choice (language button, profile, the account's language after login) is remembered in this browser.
  const setLang = useCallback(l => {
    const v = l === 'en' ? 'en' : 'ar';
    chosen.current = true;
    try { localStorage.setItem(STORE, v); } catch { /* storage unavailable */ }
    setLangState(v);
  }, []);
  // Settings → default language: used only while this browser has no choice of its own.
  const setDefaultLang = useCallback(l => { if (!chosen.current && !readStored()) setLangState(l === 'en' ? 'en' : 'ar'); }, []);

  const value = useMemo(() => {
    const dict = messages[lang];
    const t = (key, vars) => {
      let s = dict[key] ?? messages.ar[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
      return s;
    };
    // bilingual record → the field for the current language (falls back to Arabic)
    const nm = (o, field = 'name') => (o ? o[`${field}_${lang}`] || o[`${field}_ar`] || '' : '');
    const errText = e => {
      const code = e?.code || 'generic';
      return dict['err_' + code] ? t('err_' + code, e?.data && typeof e.data === 'object' ? e.data : undefined) : t('err_generic', { code });
    };
    const fmtDate = d => (d ? new Date(d).toLocaleString(lang === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
    const fmtDay = d => (d ? new Date(d).toLocaleDateString(lang === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB', { dateStyle: 'medium' }) : '—');
    return { lang, setLang, setDefaultLang, t, nm, errText, fmtDate, fmtDay, dir: lang === 'ar' ? 'rtl' : 'ltr' };
  }, [lang, setLang, setDefaultLang]);

  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useI18n = () => useContext(I18n);

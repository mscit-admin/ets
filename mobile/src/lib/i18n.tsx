// Language of the app: the shared web translations (frontend/src/i18n/messages.js) plus the app's own strings,
// t() / nm() / errText() like the web (frontend/src/i18n/index.jsx), and the layout direction (lib/rtl.ts).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DevSettings, I18nManager, Platform } from 'react-native';
import { getLocales } from 'expo-localization';
import * as Updates from 'expo-updates';
import { messages, type Dict, type Lang } from '@/shared/web';
import { mobileMessages } from '@/i18n/mobileMessages';
import { errorMessage } from './api';
import { KEYS, getItem, setItem } from './storage';
import { deviceLang, directionFor, initialLang, isRtlLang, mayReload, needsDirectionChange, pickLang, type LangState } from './rtl';

type Vars = Record<string, unknown>;
export type I18n = {
  lang: Lang;
  rtl: boolean;                 // the layout direction actually in use
  t: (key: string, vars?: Vars) => string;
  has: (key: string) => boolean;
  nm: (o: Record<string, unknown> | null | undefined, field?: string) => string;
  errText: (e: unknown) => string;
  fmtDate: (d: string | number | Date | null | undefined) => string;
  fmtDay: (d: string | number | Date | null | undefined) => string;
  timeAgo: (d: string | number | Date) => string;
  setLang: (l: Lang) => void;                                   // chosen in the app (stored)
  offerLang: (l: string | null | undefined, from: 'account' | 'org') => void;  // applies unless a stronger source set one
  restartNeeded: boolean;
};

const DICTS: Record<Lang, Dict> = {
  ar: { ...messages.ar, ...mobileMessages.ar },
  en: { ...messages.en, ...mobileMessages.en },
};

/** t() of one language, as the web's: placeholders {name}, Arabic when a key is missing in English, else the key. */
export function translator(lang: Lang) {
  const dict = DICTS[lang];
  return (key: string, vars?: Vars) => {
    let s = dict[key] ?? DICTS.ar[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
    return s;
  };
}
export const hasKey = (lang: Lang, key: string) => Object.hasOwn(DICTS[lang], key);

const locale = (lang: Lang) => (lang === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB');
function fmt(lang: Lang, d: string | number | Date | null | undefined, opts: Intl.DateTimeFormatOptions) {
  if (d === null || d === undefined || d === '') return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  try { return date.toLocaleString(locale(lang), opts); } catch { return date.toISOString().slice(0, 16).replace('T', ' '); }
}

/** "5 min ago" — Intl.RelativeTimeFormat when the JavaScript engine has it (Hermes may not), else the date. */
export function timeAgo(lang: Lang, d: string | number | Date, now = Date.now()) {
  const s = Math.round((new Date(d).getTime() - now) / 1000);
  const RTF = (Intl as unknown as { RelativeTimeFormat?: typeof Intl.RelativeTimeFormat }).RelativeTimeFormat;
  if (!RTF) return fmt(lang, d, { dateStyle: 'medium', timeStyle: 'short' });
  try {
    const rtf = new RTF(locale(lang), { numeric: 'auto', style: 'short' });
    const a = Math.abs(s);
    if (a < 60) return rtf.format(0, 'second');
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  } catch {
    return fmt(lang, d, { dateStyle: 'medium', timeStyle: 'short' });
  }
}

// Native: make I18nManager match the language, reloading the bundle once when the direction changes.
async function applyNativeDirection(lang: Lang): Promise<boolean> {
  if (!needsDirectionChange(lang, I18nManager.isRTL)) return false;
  const d = directionFor(lang);
  I18nManager.allowRTL(d.allowRTL);
  I18nManager.forceRTL(d.forceRTL);
  const now = Date.now();
  if (!mayReload(Number(await getItem(KEYS.rtlReload)) || null, now)) return true;
  await setItem(KEYS.rtlReload, String(now)).catch(() => {});
  try {
    await Updates.reloadAsync();         // also works with expo-updates disabled (release builds)
  } catch {
    if (__DEV__) DevSettings.reload();   // development builds: Metro reload
    else return true;
  }
  return false;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LangState | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const lang = state?.lang ?? null;

  useEffect(() => {
    getItem(KEYS.lang).then(stored => setState(initialLang(stored, deviceLang(getLocales()))));
  }, []);

  useEffect(() => {
    if (!lang) return;
    if (Platform.OS === 'web') {
      const el = globalThis.document?.documentElement;
      if (el) { el.lang = lang; el.dir = isRtlLang(lang) ? 'rtl' : 'ltr'; }
      return;
    }
    applyNativeDirection(lang).then(setRestartNeeded).catch(() => setRestartNeeded(true));
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setItem(KEYS.lang, l).catch(() => {});
    setState(cur => pickLang(cur ?? { lang: l, source: 'chosen' }, l, 'chosen'));
  }, []);
  const offerLang = useCallback((l: string | null | undefined, from: 'account' | 'org') => {
    setState(cur => (cur ? pickLang(cur, l, from) : cur));
  }, []);

  const value = useMemo<I18n | null>(() => {
    if (!lang) return null;
    const t = translator(lang);
    const has = (k: string) => hasKey(lang, k);
    return {
      lang,
      rtl: Platform.OS === 'web' ? isRtlLang(lang) : I18nManager.isRTL,
      t,
      has,
      nm: (o, field = 'name') => (o ? String(o[`${field}_${lang}`] || o[`${field}_ar`] || '') : ''),
      errText: e => errorMessage(e, t, has),
      fmtDate: d => fmt(lang, d, { dateStyle: 'medium', timeStyle: 'short' }),
      fmtDay: d => fmt(lang, d, { dateStyle: 'medium' }),
      timeAgo: d => timeAgo(lang, d),
      setLang,
      offerLang,
      restartNeeded,
    };
  }, [lang, setLang, offerLang, restartNeeded]);

  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

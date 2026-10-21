// Text direction on the phone. React Native lays out right-to-left only after I18nManager.forceRTL(true) and a
// restart of the JavaScript bundle; start / end styles (marginStart, paddingEnd, textAlign 'start'…) then flip by
// themselves. The app calls applyDirection() when the language is known (stored choice, account language, device
// language) and reloads once when the direction has to change. A reload that did not change the direction (e.g. a
// development build without expo-updates) is not repeated: the app asks to be reopened instead.
// The web preview has no I18nManager direction: the page's dir attribute is set instead (no reload).
import type { Lang } from '@/shared/web';

export const isRtlLang = (lang: Lang) => lang === 'ar';

/** What to pass to I18nManager for a language: Arabic forces RTL; English disallows it (an Arabic phone would
 * otherwise still lay the app out right-to-left). */
export const directionFor = (lang: Lang) => ({ allowRTL: isRtlLang(lang), forceRTL: isRtlLang(lang) });

/** Does the running layout direction differ from the language's? */
export const needsDirectionChange = (lang: Lang, isRTL: boolean) => isRtlLang(lang) !== isRTL;

// A reload attempted within this window that did not take effect is not tried again.
export const RELOAD_GUARD_MS = 15_000;
export const mayReload = (lastAttempt: number | null, now: number) => !lastAttempt || now - lastAttempt > RELOAD_GUARD_MS;

/** Mirrors an x coordinate / chevron for the reading direction (icons that point "forward"). */
export const forwardIcon = (rtl: boolean) => (rtl ? 'chevron_back' : 'chevron');
export const backIcon = (rtl: boolean) => (rtl ? 'chevron' : 'chevron_back');

/** Language of the device when it is Arabic or English (the first of the phone's languages), else null. */
export function deviceLang(locales: { languageCode?: string | null }[]): Lang | null {
  const first = (locales[0]?.languageCode || '').toLowerCase();
  return first === 'en' || first === 'ar' ? first : null;
}

// Where the language in use came from; a source replaces the current language only when it ranks at least as high:
//   chosen in this app (stored) > the account's language (after sign-in) > the phone's language > the organisation's
//   default (sign-in screen info) > Arabic.
export const LANG_RANK = { fallback: 0, org: 1, device: 2, account: 3, chosen: 4 } as const;
export type LangSource = keyof typeof LANG_RANK;
export type LangState = { lang: Lang; source: LangSource };

export function pickLang(cur: LangState, lang: string | null | undefined, source: LangSource): LangState {
  if (lang !== 'ar' && lang !== 'en') return cur;
  return LANG_RANK[source] >= LANG_RANK[cur.source] ? { lang, source } : cur;
}

/** The language to start with, from what is stored on the phone and the phone's own language. */
export function initialLang(stored: string | null, device: Lang | null): LangState {
  if (stored === 'ar' || stored === 'en') return { lang: stored, source: 'chosen' };
  if (device) return { lang: device, source: 'device' };
  return { lang: 'ar', source: 'fallback' };
}

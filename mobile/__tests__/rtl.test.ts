import { LANG_RANK, backIcon, deviceLang, directionFor, forwardIcon, initialLang, isRtlLang, mayReload, needsDirectionChange, pickLang, RELOAD_GUARD_MS } from '@/lib/rtl';

describe('direction', () => {
  it('Arabic forces RTL; English disallows it (an Arabic phone would otherwise flip the app)', () => {
    expect(isRtlLang('ar')).toBe(true);
    expect(directionFor('ar')).toEqual({ allowRTL: true, forceRTL: true });
    expect(directionFor('en')).toEqual({ allowRTL: false, forceRTL: false });
  });
  it('needs a reload only when the running direction differs', () => {
    expect(needsDirectionChange('ar', true)).toBe(false);
    expect(needsDirectionChange('ar', false)).toBe(true);
    expect(needsDirectionChange('en', true)).toBe(true);
    expect(needsDirectionChange('en', false)).toBe(false);
  });
  it('does not reload in a loop', () => {
    const now = 1_000_000;
    expect(mayReload(null, now)).toBe(true);
    expect(mayReload(now - 1000, now)).toBe(false);
    expect(mayReload(now - RELOAD_GUARD_MS - 1, now)).toBe(true);
  });
  it('chevrons point along the reading direction', () => {
    expect(forwardIcon(false)).toBe('chevron');
    expect(forwardIcon(true)).toBe('chevron_back');
    expect(backIcon(false)).toBe('chevron_back');
    expect(backIcon(true)).toBe('chevron');
  });
});

describe('language choice', () => {
  it('device language when Arabic or English', () => {
    expect(deviceLang([{ languageCode: 'en' }, { languageCode: 'ar' }])).toBe('en');
    expect(deviceLang([{ languageCode: 'AR' }])).toBe('ar');
    expect(deviceLang([{ languageCode: 'fr' }])).toBeNull();
    expect(deviceLang([])).toBeNull();
  });
  it('starts with the stored choice, else the device, else Arabic', () => {
    expect(initialLang('en', 'ar')).toEqual({ lang: 'en', source: 'chosen' });
    expect(initialLang(null, 'en')).toEqual({ lang: 'en', source: 'device' });
    expect(initialLang('xx', null)).toEqual({ lang: 'ar', source: 'fallback' });
  });
  it('a source replaces the language only when it ranks at least as high', () => {
    expect(LANG_RANK.chosen).toBeGreaterThan(LANG_RANK.account);
    const device = { lang: 'en' as const, source: 'device' as const };
    expect(pickLang(device, 'ar', 'org')).toBe(device);                                // org default < phone language
    expect(pickLang(device, 'ar', 'account')).toEqual({ lang: 'ar', source: 'account' });
    expect(pickLang({ lang: 'en', source: 'chosen' }, 'ar', 'account')).toEqual({ lang: 'en', source: 'chosen' });
    expect(pickLang({ lang: 'ar', source: 'fallback' }, 'en', 'org')).toEqual({ lang: 'en', source: 'org' });
    expect(pickLang(device, 'de', 'chosen')).toBe(device);                              // not a language of the app
  });
});

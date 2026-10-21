import fs from 'node:fs';
import path from 'node:path';
import { iconElements, parseIcon } from '@/lib/iconElements';
import { passConflict, visibleItems, dupCode, typeOf } from '@/lib/items';
import { mobileRoute } from '@/lib/links';
import { badgeText } from '@/lib/notifCount';
import { ICON_PATHS, equation, inTab, repParts, share, type Calc } from '@/shared/web';
import type { Item } from '@/lib/types';

const WEB = path.resolve(__dirname, '../../frontend/src');
// the files the app imports from the web frontend (src/shared/web.ts; also the CI path filter of mobile.yml)
const SHARED = ['lib/format.js', 'lib/erpModules.js', 'lib/wheelGeometry.js', 'lib/equation.js', 'lib/notifyTabs.js', 'lib/iconPaths.js',
  'lib/itemRules.js', 'lib/approvalRules.js', 'lib/liveRules.js', 'i18n/messages.js'];

describe('modules shared with the web frontend', () => {
  it.each(SHARED)('%s imports nothing (no frontend dependency reaches the app)', f => {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
  });
  it('web.ts imports exactly these files', () => {
    const web = fs.readFileSync(path.resolve(__dirname, '../src/shared/web.ts'), 'utf8');
    const used = [...web.matchAll(/from '@web\/([^']+)'/g)].map(m => m[1]).sort();
    expect(used).toEqual([...SHARED].sort());
  });
  it('the CI workflow watches them', () => {
    const wf = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/mobile.yml'), 'utf8');
    for (const f of SHARED) expect(wf).toContain(`frontend/src/${f}`);
  });
});

describe('icons', () => {
  it('every web icon parses into react-native-svg shapes', () => {
    for (const name of Object.keys(ICON_PATHS)) {
      const els = iconElements(name);
      expect(els.length).toBeGreaterThan(0);
      expect(els.length).toBe((ICON_PATHS[name].match(/</g) || []).length);
    }
  });
  it('camel-cases attributes and refuses other markup', () => {
    expect(parseIcon('<path d="M1 2" stroke-width="2"/>')).toEqual([{ tag: 'path', attrs: { d: 'M1 2', strokeWidth: '2' } }]);
    expect(() => parseIcon('<script>alert(1)</script>')).toThrow();
    expect(iconElements('no-such-icon')).toEqual([]);
  });
});

describe('application equation (shared equation.js)', () => {
  const calc = { id: 'per', weight: 7, pct: 48.33, fnPct: 54.33, reportPct: 14.33, fnShare: 0.85, reportShare: 0.15, count: 33,
    tests: [27, 1, 3, 1], items: { function: 31, report: 2 }, reportItems: 2, reportTrack: true } as Calc;
  it('functions × share + reports × share = application', () => {
    const e = equation(calc, { reports_share: 0.15 });
    expect(e.both).toBe(true);
    expect(e.fnPart + e.repPart).toBeCloseTo(54.33 * 0.85 + 14.33 * 0.15);
    expect(share(e.fw)).toBe('85%');
    expect(repParts(k => k, calc)).toBe('eq_rep_items_track');
  });
  it('without reports: functions × 100 %', () => {
    const e = equation({ ...calc, reportPct: null, reportShare: 0, fnShare: 1 }, {});
    expect(e).toMatchObject({ withReports: false, withFunctions: true, both: false, rep: null });
  });
});

describe('items list rules', () => {
  const base = { id: 1, app_id: 'per', code: 'D1', source: 'design', name_ar: 'بند', vendor_status: 0, weight: 1, progress: 50, enabled: true,
    test_status: 0, notif_status: 0, review_status: 0, note: '' } as Item;
  const items: Item[] = [
    base,
    { ...base, id: 2, code: 'D2', test_status: 2, progress: 60 },                       // conflict
    { ...base, id: 3, code: 'D3', test_status: 2, progress: 100 },
    { ...base, id: 4, code: 'X1', source: 'experience', enabled: false },               // hidden by default
    { ...base, id: 5, code: 'D5', removed_at: '2026-01-01' },                            // removed: never listed
    { ...base, id: 6, code: 'D6', enabled: false, disabled_reason: 'other', note: 'مكرر' },
  ];
  it('flags «نجح» below 100 %', () => {
    expect(items.filter(passConflict).map(i => i.code)).toEqual(['D2']);
    expect(passConflict({ ...items[1], removed_at: '2026-01-01' })).toBe(false);
  });
  it('default list, conflict filter, excluded, search', () => {
    expect(visibleItems(items, { q: '', test: '', showOff: false }).map(i => i.id)).toEqual([1, 2, 3, 6]);
    expect(visibleItems(items, { q: '', test: '', showOff: true }).map(i => i.id)).toEqual([1, 2, 3, 4, 6]);
    expect(visibleItems(items, { q: '', test: 'conflict', showOff: false }).map(i => i.id)).toEqual([2]);
    expect(visibleItems(items, { q: '', test: '2', showOff: false }).map(i => i.id)).toEqual([2, 3]);
    expect(visibleItems(items, { q: 'مكرر', test: '', showOff: false }).map(i => i.id)).toEqual([6]);
    expect(visibleItems(items, { q: 'd3', test: '', showOff: false }).map(i => i.id)).toEqual([3]);
  });
  it('type and duplicate codes', () => {
    expect(typeOf({ item_type: 'report' })).toBe('report');
    expect(typeOf({})).toBe('function');
    expect(dupCode({ app_id: 'per', code: 'D3' }, 'per')).toBe('D3');
    expect(dupCode({ app_id: 'att', code: 'D3' }, 'per')).toBe('att/D3');
  });
});

describe('alerts', () => {
  it('opens the screens the phone has', () => {
    expect(mobileRoute('/app/per')).toBe('/home/app/per');
    expect(mobileRoute('/app/per?x=1#fn-3')).toBe('/home/app/per?fn=3');
    expect(mobileRoute('/department/hr')).toBe('/home/department/hr');
    expect(mobileRoute('/')).toBe('/home');
    expect(mobileRoute('/approvals')).toBe('/approvals');
    expect(mobileRoute('/approvals?mine=1')).toBe('/approvals?mine=1');
    expect(mobileRoute('/app/per#fn-12')).toBe('/home/app/per?fn=12');
    expect(mobileRoute('/app/per?filter=conflict')).toBe('/home/app/per?filter=conflict');
    expect(mobileRoute('/app/per?filter=<x>')).toBe('/home/app/per');
    expect(mobileRoute('/notifications')).toBe('/notifications');
    expect(mobileRoute('/logs?tab=auth')).toBeNull();
    expect(mobileRoute('/imports/4')).toBeNull();
    expect(mobileRoute('//evil.example/app/x')).toBeNull();
    expect(mobileRoute('https://evil.example/app/x')).toBeNull();
    expect(mobileRoute('/app/../../x')).toBeNull();
    expect(mobileRoute(null)).toBeNull();
  });
  it('tabs and badge', () => {
    expect(inTab('security', { category: 'system' })).toBe(true);
    expect(inTab('plan', { category: 'tracking' })).toBe(false);
    expect(badgeText(7)).toBe('7');
    expect(badgeText(120)).toBe('99+');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { bars, colors, pills, radius, shadows } from '@/theme';
import { barColor, pctColor, pctHue, pctTone, toneOf, toneStops } from '@/theme/tone';
// the web helper itself, to compare with
import { pctGradient } from '@web/lib/format.js';

const css = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/styles/app.css'), 'utf8');
const cssVar = (name: string) => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error('no --' + name);
  return m[1].trim();
};

describe('tokens match the web stylesheet (app.css :root)', () => {
  it.each([
    ['gray-50', colors.gray50], ['gray-100', colors.gray100], ['gray-200', colors.gray200], ['gray-300', colors.gray300],
    ['gray-400', colors.gray400], ['gray-500', colors.gray500], ['gray-600', colors.gray600], ['gray-700', colors.gray700],
    ['gray-800', colors.gray800], ['gray-900', colors.gray900], ['text', colors.text], ['text-muted', colors.textMuted],
    ['border', colors.border], ['border-strong', colors.borderStrong], ['bg', colors.bg], ['card', colors.card],
    ['primary', colors.primary], ['primary-hover', colors.primaryHover], ['primary-blue', colors.primaryBlue],
    ['it-fn', colors.itFn], ['it-fn-bg', colors.itFnBg], ['it-fn-line', colors.itFnLine], ['it-rep', colors.itRep],
    ['it-rep-bg', colors.itRepBg], ['it-rep-line', colors.itRepLine], ['it-rep-strong', colors.itRepStrong],
    ['erp-navy', colors.erpNavy], ['erp-off', colors.erpOff], ['erp-off-line', colors.erpOffLine], ['erp-off-text', colors.erpOffText],
    ['erp-track', colors.erpTrack],
  ])('--%s', (name, value) => expect(cssVar(name).toLowerCase()).toBe(value.toLowerCase()));

  it.each(Object.entries(pills).filter(([k]) => k !== 'gray'))('pill %s', (name, p) => {
    expect(cssVar(`${name}-bg`).toLowerCase()).toBe(p.bg);
    expect(cssVar(`${name}-text`).toLowerCase()).toBe(p.text);
  });
  it('radii and shadow', () => {
    expect(cssVar('radius')).toBe(radius.md + 'px');
    expect(cssVar('radius-lg')).toBe(radius.lg + 'px');
    expect(cssVar('shadow-sm')).toContain('0 1px 2px');
    expect(shadows.sm).toContain('0px 1px 2px');
  });
  it('progress bar colours (.progress-bar.<colour>)', () => {
    expect(css).toContain(`.progress-bar.green { background: ${bars.green}; }`);
    expect(css).toContain(`.progress-bar.orange { background: ${bars.orange}; }`);
    expect(css).toContain(`.progress-bar.red { background: ${bars.red}; }`);
  });
});

describe('tone scale (shared pctTone / pctHue)', () => {
  it('runs red → green with fixed ends', () => {
    expect(pctHue(0)).toBe(25);
    expect(pctHue(20)).toBe(25);
    expect(pctHue(40)).toBe(55);
    expect(pctHue(60)).toBe(85);
    expect(pctHue(100)).toBe(145);
    expect(pctHue(50)).toBeCloseTo(70);
  });
  it('gives #rrggbb colours per role', () => {
    const t = pctTone(50);
    for (const v of [t.stroke, t.text, t.bg]) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    expect(pctTone(10)).toEqual(pctTone(0));
  });
  it('toneStops are the same 11 colours as the web gradient', () => {
    const stops = toneStops();
    expect(stops).toHaveLength(11);
    expect(stops[0]).toEqual({ offset: 0, color: pctTone(0).stroke });
    expect(stops[10]).toEqual({ offset: 1, color: pctTone(100).stroke });
    const web = (pctGradient('right') as string).match(/#[0-9a-f]{6}/g);
    expect(stops.map(s => s.color)).toEqual(web);
  });
  it('toneOf clamps, barColor follows pctColor', () => {
    expect(toneOf(-5)).toEqual(pctTone(0));
    expect(toneOf(250)).toEqual(pctTone(100));
    expect(toneOf('abc')).toEqual(pctTone(0));
    expect(pctColor(95)).toBe('green');
    expect(barColor(95)).toBe(bars.green);
    expect(barColor(65)).toBe(bars.blue);
    expect(barColor(35)).toBe(bars.orange);
    expect(barColor(5)).toBe(bars.red);
    expect(barColor(0)).toBe(bars.gray);
  });
});

import { W, geo, linesOf, rimAngles, segmentAngles, wheelSegments, STANDARD_MODULES, type Department } from '@/shared/web';
import { labelCenter } from '@/components/ErpWheel';
import { ringDash } from '@/components/Ring';

const dept = (id: string, pct: number, weight = 10): Department =>
  ({ id, name_ar: id, name_en: id, color: '#000', emblem: 'layers', weight, pct, apps: 1 });

describe('wheel geometry (shared with the web)', () => {
  it('keeps the web figure: 560 viewBox, radii, fills', () => {
    expect(W.SIZE).toBe(560);
    expect(W.C).toBe(280);
    expect([W.R_HUB, W.R_HUB_RING, W.R_IN, W.R_OUT, W.R_RIM, W.R_TEXT, W.GAP]).toEqual([86, 95, 108, 236, 248, 171, 6]);
    expect(W.FILLS).toEqual(['#1b3a66', '#24508a', '#2c62a6']);
  });
  it('segments split the circle evenly, starting at the top', () => {
    expect(segmentAngles(0, 9)).toEqual([-20, 20]);
    expect(segmentAngles(8, 9)).toEqual([300, 340]);
    const n = 7;
    let total = 0;
    for (let i = 0; i < n; i++) { const [a0, a1] = segmentAngles(i, n); total += a1 - a0; }
    expect(total).toBeCloseTo(360);
  });
  it('points are at the right radius; Arabic mirrors the figure', () => {
    const ltr = geo(false), rtl = geo(true);
    const [x, y] = ltr.pt(W.R_TEXT, 60);
    expect(Math.hypot(x - W.C, y - W.C)).toBeCloseTo(W.R_TEXT);
    expect(ltr.pt(100, 0)).toEqual([280, 180]);                  // top
    expect(ltr.pt(100, 90)[0]).toBeCloseTo(380);                 // clockwise: right
    const [xm, ym] = rtl.pt(W.R_TEXT, 60);
    expect(xm).toBeCloseTo(2 * W.C - x);
    expect(ym).toBeCloseTo(y);
    expect(labelCenter(2, 9, true)[0]).toBeCloseTo(2 * W.C - labelCenter(2, 9, false)[0]);
  });
  it('wedge and arc paths are well formed and sweep the other way when mirrored', () => {
    const w = geo(false).wedge(-20, 20);
    expect(w).toMatch(/^M[\d.]+ [\d.]+A236 236 0 0 1 [\d.]+ [\d.]+L[\d.]+ [\d.]+A108 108 0 0 0 [\d.]+ [\d.]+Z$/);
    expect(geo(true).wedge(-20, 20)).toContain('A236 236 0 0 0');
    expect(geo(false).arc(248, 0, 200)).toContain('A248 248 0 1 1');
  });
  it('rim arc stays inside the segment and follows the percentage', () => {
    const r0 = rimAngles(0, 40, 0), r100 = rimAngles(0, 40, 100), r50 = rimAngles(0, 40, 50), over = rimAngles(0, 40, 150);
    expect(r0.rimStart).toBeGreaterThan(0);
    expect(r0.rimEnd).toBeLessThan(40);
    expect(r0.rimTo).toBe(r0.rimStart);
    expect(r100.rimTo).toBeCloseTo(r100.rimEnd);
    expect(r50.rimTo).toBeCloseTo((r50.rimStart + r50.rimEnd) / 2);
    expect(over.rimTo).toBeCloseTo(over.rimEnd);
  });
  it('hub ring dash: value share of the circumference', () => {
    const [dash, gap] = ringDash(25, W.R_HUB_RING);
    expect(gap).toBeCloseTo(2 * Math.PI * W.R_HUB_RING);
    expect(dash).toBeCloseTo(gap / 4);
    expect(ringDash(-3, 10)[0]).toBe(0);
    expect(ringDash(130, 10)[0]).toBeCloseTo(2 * Math.PI * 10);
  });
});

describe('module mapping (shared erpModules.js)', () => {
  const depts = [dept('hr', 40, 30), dept('fin', 60, 10), dept('com', 0), dept('inf', 10), dept('lab', 70)];
  it('full scope: tracked modules active, the others not activated, unknown departments appended', () => {
    const segs = wheelSegments(depts, { fullScope: true });
    expect(segs.slice(0, STANDARD_MODULES.length).map(s => s.key)).toEqual(STANDARD_MODULES.map(m => m.key));
    expect(segs.find(s => s.key === 'hr')).toMatchObject({ state: 'active', pct: 40 });
    expect(segs.find(s => s.key === 'production')).toMatchObject({ state: 'inactive' });
    expect(segs.find(s => s.key === 'infrastructure')).toMatchObject({ state: 'active', pct: 10 });
    expect(segs[segs.length - 1]).toMatchObject({ key: 'dept:lab', state: 'active', pct: 70 });
  });
  it('limited scope: a mapped department outside it is out_of_scope, never a %', () => {
    const segs = wheelSegments([dept('hr', 40)], { fullScope: false });
    expect(segs.find(s => s.key === 'finance')).toMatchObject({ state: 'out_of_scope' });
    expect(segs.find(s => s.key === 'finance')?.pct).toBeUndefined();
  });
  it('label lines per language', () => {
    const sales = STANDARD_MODULES.find(m => m.key === 'sales')!;
    expect(linesOf(sales, 'ar')).toEqual(['المبيعات', 'والتسويق']);
    expect(linesOf(STANDARD_MODULES[0], 'en')).toEqual(['Production']);
  });
});

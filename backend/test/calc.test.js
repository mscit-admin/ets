import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveProgress, appCalc, summarize, sCurve } from '../src/services/calc.js';

const fn = (o = {}) => ({ app_id: 'a', source: 'design', weight: 1, progress: 0, enabled: true, test_status: 0, notif_status: 0, ...o });

test('notification blending', () => {
  assert.equal(effectiveProgress(fn({ progress: 80 }), 0.1), 80);               // not set → no blend
  assert.equal(effectiveProgress(fn({ progress: 80, notif_status: 1 }), 0.1), 82); // 80·0.9 + 100·0.1
  assert.equal(effectiveProgress(fn({ progress: 80, notif_status: 3 }), 0.1), 72); // 80·0.9 + 0
});

test('application average ignores disabled items', () => {
  const c = appCalc([fn({ progress: 100 }), fn({ progress: 0, weight: 3 }), fn({ progress: 100, enabled: false, source: 'experience' })], 0);
  assert.equal(c.pct, 25);
  assert.equal(c.weight, 4);
  assert.equal(c.experience, 1);
  assert.equal(c.experienceOn, 0);
});

test('summary blends reports for non-base departments and weights apps', () => {
  const r = summarize({
    departments: [{ id: 'hr', is_base: false }, { id: 'inf', is_base: true }],
    applications: [{ id: 'a', department_id: 'hr', weight: 3 }, { id: 'b', department_id: 'inf', weight: 1 }],
    functions: [fn({ app_id: 'a', progress: 100 }), fn({ app_id: 'b', progress: 40 })],
    reports: [{ app_id: 'a', progress: 0 }, { app_id: 'b', progress: 100 }],
    settings: { 'calc.notif_share': 0.1, 'calc.reports_share': 0.2, 'calc.weight_mode': 'fixed' },
  });
  const a = r.applications.find(x => x.id === 'a'), b = r.applications.find(x => x.id === 'b');
  assert.equal(a.pct, 80);   // 100·0.8 + 0·0.2
  assert.equal(b.pct, 40);   // base department: reports not blended
  assert.equal(r.total.pct, (3 * 80 + 1 * 40) / 4);
});

test('auto weight mode uses the sum of function weights', () => {
  const r = summarize({
    departments: [{ id: 'd', is_base: true }],
    applications: [{ id: 'a', department_id: 'd', weight: 99 }],
    functions: [fn({ weight: 2 }), fn({ weight: 3 })],
    reports: [], settings: { 'calc.weight_mode': 'auto' },
  });
  assert.equal(r.applications[0].weight, 5);
});

test('S-curve ends at 100 and is increasing', () => {
  const c = sCurve(11);
  assert.equal(c.length, 11);
  assert.equal(c[10], 100);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] > c[i - 1]);
});

// ---- item types (1.8.0) ----
const S = { 'calc.notif_share': 0.1, 'calc.reports_share': 0.2, 'calc.weight_mode': 'fixed' };
const close = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} ≠ ${b}`);

test('report items move from the functions % to the reports % (with the reports track as weight 1)', () => {
  const data = (type) => ({
    departments: [{ id: 'hr', is_base: false }],
    applications: [{ id: 'a', department_id: 'hr', weight: 1 }],
    functions: [fn({ progress: 100 }), fn({ progress: 0 }), fn({ progress: 80, weight: 2, item_type: type })],
    reports: [{ app_id: 'a', progress: 80 }], settings: S,
  });
  const b = summarize(data('function')).applications[0];
  close(b.fnPct, (100 + 0 + 160) / 4, 'before: functions 65');
  close(b.pct, 65 * 0.8 + 80 * 0.2, 'before: 68');
  const a = summarize(data('report')).applications[0];
  close(a.fnPct, 50, 'after: functions 50');
  close(a.reportPct, (160 + 80) / 3, 'after: reports (2·80 + 80) / 3 = 80');
  close(a.pct, 50 * 0.8 + 80 * 0.2, 'after: 56');
  assert.deepEqual([a.items, a.reportItems, a.reportTrack, a.reportWeight, a.fnShare, a.reportShare],
    [{ function: 2, report: 1 }, 1, true, 3, 0.8, 0.2]);
  assert.equal(a.fnWeight, 4);               // auto weight / Weights screen: every enabled item, as before
});

test('an application without report items gives the 1.7.0 figures', () => {
  const r = summarize({
    departments: [{ id: 'hr', is_base: false }, { id: 'inf', is_base: true }],
    applications: [{ id: 'a', department_id: 'hr', weight: 3 }, { id: 'b', department_id: 'inf', weight: 1 }, { id: 'c', department_id: 'hr', weight: 2 }],
    functions: [fn({ app_id: 'a', progress: 70, notif_status: 2 }), fn({ app_id: 'a', progress: 20, weight: 2 }),
      fn({ app_id: 'b', progress: 40, item_type: 'function' }), fn({ app_id: 'c', progress: 90, enabled: false })],
    reports: [{ app_id: 'a', progress: 30 }, { app_id: 'c', progress: 60 }], settings: S,
  });
  const [a, b, c] = r.applications;
  const fa = ((70 * 0.9 + 50 * 0.1) + 2 * 20) / 3;
  close(a.pct, fa * 0.8 + 30 * 0.2, 'a: 1.7.0 blend');
  close(b.pct, 40, 'b: base department, no reports');
  assert.equal(b.reportPct, null);
  close(c.pct, 0 * 0.8 + 60 * 0.2, 'c: no counted function, track blended as before');
  close(r.departments[0].fnPct, (3 * fa + 2 * 0) / 5, 'department functions-only: as before');
});

test('base department: report items alone make the reports %; all-report application = its reports %', () => {
  const r = summarize({
    departments: [{ id: 'inf', is_base: true }],
    applications: [{ id: 'b', department_id: 'inf', weight: 1 }, { id: 'x', department_id: 'inf', weight: 1 }],
    functions: [fn({ app_id: 'b', progress: 40 }), fn({ app_id: 'b', progress: 100, item_type: 'report' }),
      fn({ app_id: 'x', progress: 30, item_type: 'report' }), fn({ app_id: 'x', progress: 90, enabled: false })],
    reports: [{ app_id: 'b', progress: 0 }],     // ignored: base departments have no reports track
    settings: S,
  });
  const [b, x] = r.applications;
  close(b.reportPct, 100, 'b reports');
  close(b.pct, 40 * 0.8 + 100 * 0.2, 'b = 52');
  assert.equal(b.reportTrack, false);
  close(x.pct, 30, 'x: every counted item is a report');
  assert.deepEqual([x.fnShare, x.reportShare], [0, 1]);
  close(r.departments[0].fnPct, 40, 'functions-only leaves out the all-report application');
});

test('excluded report items do not count; notification blending applies to report items', () => {
  const r = summarize({
    departments: [{ id: 'inf', is_base: true }],
    applications: [{ id: 'b', department_id: 'inf', weight: 1 }],
    functions: [fn({ app_id: 'b', progress: 60 }), fn({ app_id: 'b', progress: 100, item_type: 'report', enabled: false })],
    reports: [], settings: S,
  }).applications[0];
  assert.equal(r.reportPct, null);
  close(r.pct, 60, 'only the function counts');
  const n = summarize({
    departments: [{ id: 'inf', is_base: true }],
    applications: [{ id: 'b', department_id: 'inf', weight: 1 }],
    functions: [fn({ app_id: 'b', progress: 60 }), fn({ app_id: 'b', progress: 80, item_type: 'report', notif_status: 3 })],
    reports: [], settings: S,
  }).applications[0];
  close(n.reportPct, 80 * 0.9, 'report item blended with its notification status');
});

test('item counts and the reports overview', async () => {
  const { itemCounts, reportsOverview } = await import('../src/services/calc.js');
  const list = [fn({ progress: 100 }), fn({ progress: 50 }), fn({ progress: 0, enabled: false }),
    fn({ progress: 100, item_type: 'report', has_note: true }), fn({ progress: 20, item_type: 'report', weight: 3 })];
  assert.deepEqual(itemCounts(list), { functions: 2, done: 1, in_progress: 1, not_started: 0, report_items: 2, report_items_done: 1, notes: 1 });
  const o = reportsOverview(list, [{ progress: 40 }], 0);
  assert.deepEqual([o.reports, o.reports_done, o.report_items, o.report_tracks], [3, 1, 2, 1]);
  close(o.reports_pct, (100 + 60 + 40) / 5, 'pooled: items by weight, the track as weight 1');
  assert.equal(reportsOverview([fn()], [], 0).reports_pct, null);
});

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

// Before → after impact / delta computation for tracker changes (extracted from routes/tracker.js, BE-1): adding /
// removing / restoring items, moving items to another application, and moving an application to another department.
// Each recomputes the roll-up from loadVisible with the proposed change applied and reports the before/after figures.
import { query } from '../db/pool.js';
import { summarize } from './calc.js';
import { weightTransfer, destinationWeight } from './move.js';
import { loadVisible } from './tracker-data.js';

// ---- add / remove / restore functions (migration 006) ----
// Before → after % of the application, its department and the project (user's scope) for a proposed change:
// { add: {weight, progress, enabled} } or { set: [{function_id, enabled}] }.
export async function impactOf(user, appId, { add = null, set = [], drop = [] }) {
  const v = await loadVisible(user);
  const app = v.apps.find(x => x.id === appId);
  const byId = new Map(set.map(x => [x.function_id, x]));
  const functions = v.functions.filter(f => !drop.includes(f.id)).map(f => (byId.has(f.id) ? { ...f, enabled: byId.get(f.id).enabled } : f));
  for (const x of set) if (!v.functions.some(f => f.id === x.function_id) && x.enabled) {
    const f = (await query('SELECT * FROM functions WHERE id=$1', [x.function_id])).rows[0];      // restoring a removed one
    if (f) functions.push({ ...f, enabled: true, has_note: !!f.note });   // SELECT * carries item_type
  }
  if (add) functions.push({ id: -1, app_id: appId, source: 'custom', item_type: add.item_type || 'function', weight: add.weight,
    progress: add.progress, enabled: add.enabled, test_status: 0, notif_status: 0, review_status: 0 });
  const after = summarize({ departments: v.departments, applications: v.apps, functions, reports: v.reports, settings: v.settings });
  const pick = (c) => ({ app: c.applications.find(x => x.id === appId), dept: c.departments.find(x => x.id === app.department_id), total: c.total });
  const b = pick(v.calc), a = pick(after);
  const row = (x, y, k = 'pct') => ({ before: x?.[k] ?? 0, after: y?.[k] ?? 0 });
  const included = list => list.filter(f => f.app_id === appId && f.enabled).length;
  return { app: row(b.app, a.app), dept: row(b.dept, a.dept), total: row(b.total, a.total),
    count: row(b.app, a.app, 'count'), included: { before: included(v.functions), after: included(functions) },
    app_weight: row(b.app, a.app, 'fnWeight') };
}

// Before → after of the source and destination applications, their department(s) and the project (reader's scope),
// with the application weight that goes with the items (same calculation as the move itself, services/move.js).
export async function moveImpact(user, src, dst, ids) {
  const v = await loadVisible(user);
  const mode = v.settings['calc.weight_mode'] === 'auto' ? 'auto' : 'fixed';
  const srcApp = v.apps.find(x => x.id === src.id), dstApp = v.apps.find(x => x.id === dst.id);
  const tr = weightTransfer({ mode, srcWeight: srcApp.weight, srcFunctions: v.functions.filter(f => f.app_id === src.id), ids });
  let dstAfter = +dstApp.weight, overflow = false;
  try { if (tr.share > 0) dstAfter = destinationWeight(dstApp.weight, tr.share); } catch { overflow = true; }
  const set = new Set(ids);
  const functions = v.functions.map(f => (set.has(f.id) ? { ...f, app_id: dst.id } : f));
  const applications = v.apps.map(a => (a.id === src.id ? { ...a, weight: tr.src_after } : a.id === dst.id ? { ...a, weight: dstAfter } : a));
  const after = summarize({ departments: v.departments, applications, functions, reports: v.reports, settings: v.settings });
  const pair = (b, x, k) => ({ before: b?.[k] ?? 0, after: x?.[k] ?? 0 });
  const appRow = (a, role) => {
    const b = v.calc.applications.find(x => x.id === a.id), x = after.applications.find(y => y.id === a.id);
    return { id: a.id, role, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en,
      pct: pair(b, x, 'pct'), weight: pair(b, x, 'weight'), count: pair(b, x, 'count') };
  };
  const deptRow = id => {
    const d = v.departments.find(x => x.id === id);
    const b = v.calc.departments.find(x => x.id === id), x = after.departments.find(y => y.id === id);
    return { id, name_ar: d.name_ar, name_en: d.name_en, is_base: d.is_base, pct: pair(b, x, 'pct'), weight: pair(b, x, 'weight') };
  };
  const moved = v.functions.filter(f => set.has(f.id));
  return { mode, items: ids.length, counted: moved.filter(f => f.enabled).length,
    weight: { share: tr.share, moved_weight: tr.moved_weight, src_items_weight: tr.denominator, overflow,
      src: { before: +srcApp.weight, after: tr.src_after }, dst: { before: +dstApp.weight, after: dstAfter } },
    apps: [appRow(srcApp, 'source'), appRow(dstApp, 'destination')],
    departments: [...new Set([src.department_id, dst.department_id])].map(deptRow),
    total: pair(v.calc.total, after.total, 'pct') };
}

// Before → after of the two departments and the project (reader's scope) of moving the application to dstDept.
export async function appMoveImpact(user, app, dst) {
  const v = await loadVisible(user);
  const mode = v.settings['calc.weight_mode'] === 'auto' ? 'auto' : 'fixed';
  const applications = v.apps.map(a => (a.id === app.id ? { ...a, department_id: dst.id } : a));
  const after = summarize({ departments: v.departments, applications, functions: v.functions, reports: v.reports, settings: v.settings });
  const pair = (b, x, k) => ({ before: b?.[k] ?? 0, after: x?.[k] ?? 0 });
  const deptRow = (id, role) => {
    const d = v.departments.find(x => x.id === id) || (id === dst.id ? dst : null);
    const b = v.calc.departments.find(x => x.id === id), x = after.departments.find(y => y.id === id);
    return { id, role, name_ar: d?.name_ar, name_en: d?.name_en, is_base: d?.is_base, pct: pair(b, x, 'pct'), weight: pair(b, x, 'weight') };
  };
  const appCalcRow = v.calc.applications.find(x => x.id === app.id);
  return { mode, app_weight: mode === 'auto' ? (appCalcRow?.weight ?? 0) : +app.weight,
    departments: [deptRow(app.department_id, 'source'), deptRow(dst.id, 'destination')],
    total: pair(v.calc.total, after.total, 'pct') };
}

// Progress calculation — same rules as the original tracker page, plus item types (1.8.0, migration 016):
//
//  item %      = progress, blended with its notification status:
//                p·(1−nw) + N·nw, where N = 100 working / 50 with notes / 0 not working
//                (no blending when the notification status is "not set").
//  Each item of an application is a function ('function') or a report ('report'):
//  functions % = weighted average of its *enabled* function items (item weights).
//  reports %   = weighted average of its *enabled* report items (same rules) together with the application's reports
//                track (app_reports, non-base departments only) counted as one more item of weight 1;
//                null when the application has neither.
//  application = functions %·(1−rw) + reports %·rw   when it has both,
//                functions %                          when it has no reports (as before 1.8.0),
//                reports %                            when every counted item is a report.
//  department  = weighted average of its applications by application weight
//                (fixed weight, or the sum of enabled item weights — functions and reports — in 'auto' mode).
//  project     = weighted average of departments by their total weight.
// An application with no report items gives exactly the figures of 1.7.0.
//
// All inputs are plain rows so the same code runs for any user scope.

// Function rows every calculation reads (tracker screens, snapshots, import impact) — one list of columns.
export const CALC_FUNCTIONS_SQL = `SELECT id, app_id, code, source, item_type, weight, progress, enabled, test_status, notif_status,
  review_status, (note <> '') AS has_note FROM functions WHERE removed_at IS NULL`;

export const ITEM_TYPES = ['function', 'report'];
export const isReport = f => f.item_type === 'report';

const NOTIF_SCORE = [null, 100, 50, 0];

export function effectiveProgress(f, nw) {
  const n = f.notif_status | 0;
  if (!n || !nw) return +f.progress;
  return +f.progress * (1 - nw) + NOTIF_SCORE[n] * nw;
}

export function appCalc(functions, nw) {
  let sw = 0, nD = 0, nX = 0, onX = 0;
  // one slot per test_status: 0 not tested, 1 passed with note, 2 passed, 3 failed, 4 needs re-testing (1.12.25),
  // 5 not available for testing (migration 029), 6 not presented, 7 not trained (migration 030)
  const tests = [0, 0, 0, 0, 0, 0, 0, 0];
  // per type: weight and weighted progress of the enabled items, enabled items, items counted in "count"
  const part = { function: { weight: 0, sum: 0, on: 0, count: 0 }, report: { weight: 0, sum: 0, on: 0, count: 0 } };
  for (const f of functions) {
    const p = part[isReport(f) ? 'report' : 'function'];
    if (f.source === 'experience') { nX++; if (f.enabled) { onX++; p.count++; } } else { nD++; p.count++; }
    if (!f.enabled) continue;
    tests[f.test_status | 0]++;
    sw += +f.weight;
    p.weight += +f.weight; p.sum += +f.weight * effectiveProgress(f, nw); p.on++;
  }
  const fp = part.function;
  return { weight: sw, pct: fp.weight > 0 ? fp.sum / fp.weight : 0, base: nD, experience: nX, experienceOn: onX, count: nD + onX, tests,
    functions: fp, reports: part.report };
}

// Reports % and the shares of the application % (see the header). track: the app_reports row, or null.
export function appBlend(c, track, rw) {
  const r = c.reports;
  const hasRep = r.on > 0 || !!track;
  const repW = r.weight + (track ? 1 : 0);
  const reportPct = hasRep ? (repW > 0 ? (r.sum + (track ? +track.progress : 0)) / repW : 0) : null;
  const onlyReports = r.on > 0 && c.functions.on === 0;
  const [fnShare, reportShare] = !hasRep ? [1, 0] : onlyReports ? [0, 1] : rw ? [1 - rw, rw] : [1, 0];
  return { reportPct, fnShare, reportShare, pct: c.pct * fnShare + (reportShare ? reportPct * reportShare : 0), reportWeight: repW };
}

/**
 * @param {object} p
 * @param {Array} p.departments  rows of departments (visible ones)
 * @param {Array} p.applications rows of applications (visible ones)
 * @param {Array} p.functions    rows of functions of those applications
 * @param {Array} p.reports      rows of app_reports
 * @param {object} p.settings    settings map
 */
export function summarize({ departments, applications, functions, reports, settings }) {
  const nw = +settings['calc.notif_share'] || 0;
  const rw = +settings['calc.reports_share'] || 0;
  const mode = settings['calc.weight_mode'];
  const byApp = new Map(applications.map(a => [a.id, []]));
  for (const f of functions) byApp.get(f.app_id)?.push(f);
  const rep = new Map(reports.map(r => [r.app_id, r]));
  const deptBase = new Map(departments.map(d => [d.id, d.is_base]));

  const apps = applications.map(a => {
    const c = appCalc(byApp.get(a.id) || [], nw);
    const track = (!deptBase.get(a.department_id) && rep.get(a.id)) || null;   // base departments have no reports track
    const b = appBlend(c, track, rw);
    const weight = mode === 'auto' ? c.weight : +a.weight;
    return { id: a.id, department_id: a.department_id, weight, fnPct: c.pct, reportPct: b.reportPct,
      pct: b.pct, fnShare: b.fnShare, reportShare: b.reportShare, count: c.count, base: c.base, experience: c.experience,
      experienceOn: c.experienceOn, tests: c.tests, fnWeight: c.weight,
      // items by type (1.8.0): counted items as in "count", the weights that make each part, the reports track
      items: { function: c.functions.count, report: c.reports.count },
      typeWeight: { function: c.functions.weight, report: c.reports.weight },
      reportItems: c.reports.on, reportTrack: !!track, reportWeight: b.reportWeight };
  });

  // "functions only": the functions % of the applications that have functions in their %
  const depts = departments.map(d => {
    const L = apps.filter(a => a.department_id === d.id);
    let sw = 0, sp = 0, fw = 0, sf = 0;
    for (const a of L) {
      sw += a.weight; sp += a.weight * a.pct;
      if (a.fnShare > 0) { fw += a.weight; sf += a.weight * a.fnPct; }
    }
    return { id: d.id, weight: sw, pct: sw > 0 ? sp / sw : 0, fnPct: fw > 0 ? sf / fw : 0, _fnW: fw, apps: L.length };
  });

  let sw = 0, sp = 0, fw = 0, sf = 0;
  for (const d of depts) { sw += d.weight; sp += d.weight * d.pct; if (d._fnW > 0) { fw += d.weight; sf += d.weight * d.fnPct; } }
  // eight slots, one per test_status (0..7); see appCalc (5 migration 029, 6/7 migration 030)
  const tests = [0, 0, 0, 0, 0, 0, 0, 0];
  apps.forEach(a => a.tests.forEach((v, i) => { tests[i] += v; }));
  return { total: { weight: sw, pct: sw > 0 ? sp / sw : 0, fnPct: fw > 0 ? sf / fw : 0, tests }, departments: depts.map(({ _fnW: _drop, ...d }) => d), applications: apps };
}

// Counts of the enabled items by type (dashboard, project status, snapshots). functions: rows as CALC_FUNCTIONS_SQL.
export function itemCounts(functions) {
  const on = functions.filter(f => f.enabled);
  const fn = on.filter(f => !isReport(f)), rp = on.filter(isReport);
  const done = l => l.filter(f => +f.progress >= 100).length;
  return { functions: fn.length, done: done(fn), in_progress: fn.filter(f => +f.progress > 0 && +f.progress < 100).length,
    not_started: fn.filter(f => !(+f.progress > 0)).length, report_items: rp.length, report_items_done: done(rp),
    notes: on.filter(f => f.has_note).length };
}

// The reports part of a set of applications (project status): report items (weight, notification blending) and the
// reports tracks (weight 1 each) pooled, as in an application's reports %. tracks: app_reports rows of non-base departments.
export function reportsOverview(functions, tracks, nw) {
  const on = functions.filter(f => f.enabled && isReport(f));
  let w = 0, s = 0;
  for (const f of on) { w += +f.weight; s += +f.weight * effectiveProgress(f, nw); }
  for (const t of tracks) { w += 1; s += +t.progress; }
  const n = on.length + tracks.length;
  return { reports: n, reports_done: on.filter(f => +f.progress >= 100).length + tracks.filter(t => +t.progress >= 100).length,
    reports_pct: n ? (w > 0 ? s / w : 0) : null, report_items: on.length, report_tracks: tracks.length };
}

// Default planned curve: smoothstep S-curve, cumulative %, one value per period.
export function sCurve(n) {
  const a = [];
  for (let i = 1; i <= n; i++) { const t = i / n; a.push(+(100 * t * t * (3 - 2 * t)).toFixed(1)); }
  return a;
}

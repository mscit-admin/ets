// Progress calculation — same rules as the original tracker page:
//
//  function %  = progress, blended with its notification status:
//                p·(1−nw) + N·nw, where N = 100 working / 50 with notes / 0 not working
//                (no blending when the notification status is "not set").
//  application = weighted average of its *enabled* functions (function weights).
//  app blended = app·(1−rw) + reports%·rw  (only for non-base departments)
//  department  = weighted average of its applications by application weight
//                (fixed weight, or the sum of enabled function weights in 'auto' mode).
//  project     = weighted average of departments by their total weight.
//
// All inputs are plain rows so the same code runs for any user scope.

const NOTIF_SCORE = [null, 100, 50, 0];

export function effectiveProgress(f, nw) {
  const n = f.notif_status | 0;
  if (!n || !nw) return +f.progress;
  return +f.progress * (1 - nw) + NOTIF_SCORE[n] * nw;
}

export function appCalc(functions, nw) {
  let sw = 0, sp = 0, nD = 0, nX = 0, onX = 0;
  const tests = [0, 0, 0, 0];
  for (const f of functions) {
    if (f.source === 'experience') { nX++; if (f.enabled) onX++; } else nD++;
    if (!f.enabled) continue;
    tests[f.test_status | 0]++;
    sw += +f.weight; sp += +f.weight * effectiveProgress(f, nw);
  }
  return { weight: sw, pct: sw > 0 ? sp / sw : 0, base: nD, experience: nX, experienceOn: onX, count: nD + onX, tests };
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
    const r = rep.get(a.id);
    const hasRep = !deptBase.get(a.department_id) && !!r;
    const repPct = hasRep ? +r.progress : null;
    const blended = hasRep && rw ? c.pct * (1 - rw) + repPct * rw : c.pct;
    const weight = mode === 'auto' ? c.weight : +a.weight;
    return { id: a.id, department_id: a.department_id, weight, fnPct: c.pct, reportPct: repPct,
      pct: blended, count: c.count, base: c.base, experience: c.experience, experienceOn: c.experienceOn,
      tests: c.tests, fnWeight: c.weight };
  });

  const depts = departments.map(d => {
    const L = apps.filter(a => a.department_id === d.id);
    let sw = 0, sp = 0, sf = 0;
    for (const a of L) { sw += a.weight; sp += a.weight * a.pct; sf += a.weight * a.fnPct; }
    return { id: d.id, weight: sw, pct: sw > 0 ? sp / sw : 0, fnPct: sw > 0 ? sf / sw : 0, apps: L.length };
  });

  let sw = 0, sp = 0, sf = 0;
  for (const d of depts) { sw += d.weight; sp += d.weight * d.pct; sf += d.weight * d.fnPct; }
  const tests = [0, 0, 0, 0];
  apps.forEach(a => a.tests.forEach((v, i) => { tests[i] += v; }));
  return { total: { weight: sw, pct: sw > 0 ? sp / sw : 0, fnPct: sw > 0 ? sf / sw : 0, tests }, departments: depts, applications: apps };
}

// Default planned curve: smoothstep S-curve, cumulative %, one value per period.
export function sCurve(n) {
  const a = [];
  for (let i = 1; i <= n; i++) { const t = i / n; a.push(+(100 * t * t * (3 - 2 * t)).toFixed(1)); }
  return a;
}

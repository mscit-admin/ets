// Per-reader data assembly for the tracker screens (extracted from routes/tracker.js, BE-1). loadVisible loads
// everything the reader may see and the computed roll-up; the exported *Data functions shape each screen. The
// screen's route and its Excel export (routes/export.js) call the SAME function, so an export never shows more than
// the screen (export policy).
//
// NOTE (BE-2): loadVisible loads the whole visible project and is still used by the assemblers whose output spans the
// project (summary, weights, reports, schedule, project-status). The two single-scope readers — applicationData and
// departmentData — no longer call it: they run summarize() over just their own scope (loadScopedCalc), which is
// byte-identical for their outputs because every per-application and per-department figure is local (see the
// equivalence note on loadScopedCalc).
import { query } from '../db/pool.js';
import { summarize, CALC_FUNCTIONS_SQL, itemCounts, reportsOverview } from './calc.js';
import { allSettings } from './settings.js';
import { canSeeApp, canSeeDept, hasPerm } from '../middleware/auth.js';
import { needsLeadApproval } from './edits.js';
import { canDecideNote } from './notes.js';
import { duplicatesOf } from './disable.js';
import { movesOf } from './move.js';
import { appMovesOf } from './app-move.js';
import { recentSnapshots } from './snapshots.js';
import { scheduleJson } from './schedule.js';
import { HttpError, notFound } from '../utils/http.js';

// Everything the user may see, plus the computed percentages.
export async function loadVisible(user) {
  const [d, a, f, rep, settings] = await Promise.all([
    query('SELECT * FROM departments ORDER BY sort'),
    query('SELECT * FROM applications ORDER BY sort'),
    query(CALC_FUNCTIONS_SQL),
    query('SELECT * FROM app_reports'),
    allSettings(),
  ]);
  const apps = a.rows.filter(x => canSeeApp(user, x));
  const appIds = new Set(apps.map(x => x.id));
  const departments = d.rows.filter(x => canSeeDept(user, x.id, apps));
  const functions = f.rows.filter(x => appIds.has(x.app_id));
  const reports = rep.rows.filter(x => appIds.has(x.app_id));
  const calc = summarize({ departments, applications: apps, functions, reports, settings });
  return { departments, apps, functions, reports, settings, calc };
}

// BE-2 — scoped roll-up. summarize() computes every application's calc from ONLY its own function/report rows and the
// settings (appCalc + appBlend in services/calc.js are purely local: the «auto» weight is the application's own sum of
// enabled item weights, «fixed» is its stored weight), and each department line is just the weighted average of ITS
// applications. Nothing an application or a department result reads depends on a sibling or on the project total.
// So feeding summarize() a narrowed scope ({ these departments, these applications, their functions, their reports })
// yields application/department entries byte-identical to the full-project run — the only field that differs is
// `total`, which applicationData/departmentData never read. This reuses summarize() verbatim (no duplicated maths),
// so the two paths cannot drift. The whole-project loadVisible() is kept for the assemblers whose output genuinely
// spans the project (summary, weights, reports, schedule, project-status).
async function loadScopedCalc(departments, applications) {
  const ids = applications.map(a => a.id);
  const [f, rep, settings] = await Promise.all([
    ids.length ? query(CALC_FUNCTIONS_SQL + ' AND app_id = ANY($1)', [ids]) : Promise.resolve({ rows: [] }),
    ids.length ? query('SELECT * FROM app_reports WHERE app_id = ANY($1)', [ids]) : Promise.resolve({ rows: [] }),
    allSettings(),
  ]);
  const calc = summarize({ departments, applications, functions: f.rows, reports: rep.rows, settings });
  return { calc, settings };
}

export async function getApp(user, id) {
  const a = (await query('SELECT * FROM applications WHERE id=$1', [id])).rows[0];
  if (!a) throw notFound();
  if (!canSeeApp(user, a)) throw new HttpError(403, 'out_of_scope', { application: id });
  return a;
}

// Pending (not yet approved) edits of an application, for the "awaiting approval" badges.
async function pendingFor(appId) {
  return (await query(`SELECT i.kind, i.function_id, i.field, i.new_value, i.meta, r.id AS request_id, r.requested_at,
      u.full_name AS requested_by_name
    FROM edit_request_items i JOIN edit_requests r ON r.id=i.request_id LEFT JOIN users u ON u.id=r.requested_by
    WHERE r.status='pending' AND i.app_id=$1 ORDER BY r.requested_at`, [appId])).rows;
}

const calcSettings = s => ({ weight_mode: s['calc.weight_mode'], notif_share: s['calc.notif_share'], reports_share: s['calc.reports_share'] });

// The data behind each screen, as functions of the reader: the screen's route and its Excel export
// (routes/export.js) use the same ones, so an export never shows more than the screen (export policy).
export async function summaryData(user) {
  const v = await loadVisible(user);
  const n = itemCounts(v.functions);
  return {
    total: v.calc.total,
    departments: v.departments.map(d => ({ ...d, ...v.calc.departments.find(x => x.id === d.id) })),
    applications: v.apps.map(a => ({ ...a, calc: v.calc.applications.find(x => x.id === a.id) })),
    // functions / done: function items only; report_items: the items marked as reports (1.8.0); notes: every item
    counts: {
      functions: n.functions,
      done: n.done,
      report_items: n.report_items,
      notes: n.notes,
      experienceOff: v.functions.filter(f => !f.enabled && f.source === 'experience').length,
    },
    settings: calcSettings(v.settings),
  };
}

// BE-2: one department only. Its output is provably local to the department — the department line is the weighted
// average of ITS visible applications, and each application's calc reads only its own items + settings (see
// loadScopedCalc / the equivalence note there). So this loads one department's rows and runs summarize() over just
// that scope instead of the whole project; the numbers are byte-identical to the full-load path.
export async function departmentData(user, id) {
  if (typeof id !== 'string') throw notFound();           // non-string id never matched a department (was: find + exists guard)
  const d = (await query('SELECT * FROM departments WHERE id=$1', [id])).rows[0];
  if (!d) throw notFound();
  // this department's applications in the reader's scope — the same set the full load would keep for this department
  const deptApps = (await query('SELECT * FROM applications WHERE department_id=$1 ORDER BY sort', [id])).rows;
  const apps = deptApps.filter(a => canSeeApp(user, a));
  // canSeeDept only inspects applications of THIS department, so its own visible apps decide visibility (full scope aside)
  if (!canSeeDept(user, id, apps)) throw new HttpError(403, 'out_of_scope', { department: id });
  const { calc, settings } = await loadScopedCalc([d], apps);
  return {
    department: { ...d, ...calc.departments.find(x => x.id === d.id) },
    applications: apps.map(a => ({ ...a, calc: calc.applications.find(x => x.id === a.id) })),
    settings: calcSettings(settings),
  };
}

export async function applicationData(user, id) {
  if (typeof id !== 'string') throw notFound();
  const a = await getApp(user, id);
  // BE-2: one application only. Its calc (appCalc + appBlend) reads only this application's own items + settings, so
  // the project-wide loadVisible() is replaced by a scoped roll-up over just this application (see loadScopedCalc).
  // The department row is still loaded (its is_base flag drives the reports-track rule inside summarize()).
  const [fns, rep, dept] = await Promise.all([
    query(`SELECT f.*, u.full_name AS updated_by_name, rb.full_name AS removed_by_name, db.full_name AS disabled_by_name,
        cb.full_name AS closed_by_name FROM functions f
      LEFT JOIN users u ON u.id=f.updated_by LEFT JOIN users rb ON rb.id=f.removed_by LEFT JOIN users db ON db.id=f.disabled_by
      LEFT JOIN users cb ON cb.id=f.closed_by
      WHERE f.app_id=$1 ORDER BY f.sort, f.id`, [a.id]),
    query('SELECT * FROM app_reports WHERE app_id=$1', [a.id]),
    query('SELECT * FROM departments WHERE id=$1', [a.department_id]),
  ]);
  const { calc, settings } = await loadScopedCalc(dept.rows, [a]);
  const appCalc = calc.applications.find(x => x.id === a.id);
  // the most recent reopening of each function (its attached document + reason), shown under a reopened item
  const reopenings = new Map((await query(`SELECT DISTINCT ON (function_id) function_id, id, reason, reopened_at, doc_name,
      (SELECT full_name FROM users WHERE id=reopened_by) AS reopened_by_name
    FROM function_reopenings WHERE function_id = ANY($1) ORDER BY function_id, reopened_at DESC`,
  [fns.rows.map(f => f.id)])).rows.map(x => [x.function_id, x]));
  const u = user;
  // the functions each excluded duplicate points at (names only within the reader's scope)
  const dups = await duplicatesOf(query, user, fns.rows.filter(f => !f.enabled).map(f => f.id));
  // items moved here from another application (1.10.0): their moves, oldest first; moved_from = the move that brought
  // the item here (the badge «منقول من …»)
  const moves = await movesOf({ query }, user, fns.rows.map(f => f.id));
  const movedFrom = f => [...(moves.get(f.id) || [])].reverse().find(m => m.to_app_id === a.id) || null;
  // the application itself moved here from another department (1.12.16): its moves, oldest first; app_moved_from = the
  // most recent one that brought it into its current department (the header badge «منقول من …»)
  const appMoves = (await appMovesOf({ query }, user, [a.id])).get(a.id) || [];
  const appMovedFrom = [...appMoves].reverse().find(m => m.to_department_id === a.department_id) || null;
  return {
    application: { ...a, calc: appCalc,
      ...(appMoves.length ? { moves: appMoves, moved_from: appMovedFrom } : {}) },
    department: dept.rows[0],
    functions: fns.rows.map(f => ({ ...f, duplicate_of: dups.get(f.id) || [],
      ...(moves.has(f.id) ? { moves: moves.get(f.id), moved_from: movedFrom(f) } : {}),
      ...(reopenings.has(f.id) ? { last_reopening: reopenings.get(f.id) } : {}) })),
    report: rep.rows[0] || null,
    pending: await pendingFor(a.id),
    needs_approval: await needsLeadApproval(u, a),
    settings: calcSettings(settings),
    // lead: may decide notes (approve / reject) and approve their deletion (services/notes.js); cls: may close / reopen a function (apv_final)
    can: { pct: hasPerm(u, 'pct'), wgt: hasPerm(u, 'wgt'), tst: hasPerm(u, 'tst'), tog: hasPerm(u, 'tog'), ren: hasPerm(u, 'ren'), mov: hasPerm(u, 'mov'), rep: hasPerm(u, 'rep'),
      lead: canDecideNote(u, a), cls: hasPerm(u, 'apv_final') },
  };
}

// ---- weights & calculation parameters ----
export async function weightsData(user) {
  const v = await loadVisible(user);
  return {
    departments: v.departments,
    applications: v.apps.map(a => ({ id: a.id, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en,
      weight: a.weight, default_weight: a.default_weight, fnWeight: v.calc.applications.find(x => x.id === a.id).fnWeight })),
    settings: calcSettings(v.settings),
  };
}

// ---- reports track ----
export async function reportsData(user) {
  const v = await loadVisible(user);
  const reports = await query(`SELECT r.*, u.full_name AS updated_by_name FROM app_reports r LEFT JOIN users u ON u.id=r.updated_by`);
  const byApp = new Map(reports.rows.map(x => [x.app_id, x]));
  const base = new Set(v.departments.filter(d => d.is_base).map(d => d.id));
  const pend = (await query(`SELECT i.app_id, i.field, i.new_value, u.full_name AS requested_by_name
    FROM edit_request_items i JOIN edit_requests r ON r.id=i.request_id LEFT JOIN users u ON u.id=r.requested_by
    WHERE r.status='pending' AND i.kind='report'`)).rows;
  return {
    departments: v.departments.filter(d => !d.is_base),
    applications: v.apps.filter(a => !base.has(a.department_id)).map(a => {
      const c = v.calc.applications.find(x => x.id === a.id);
      // reportPct: the application's reports % — its report items (1.8.0) with this track — as used in its progress
      return { id: a.id, department_id: a.department_id, name_ar: a.name_ar, name_en: a.name_en, icon: a.icon,
        weight: c.weight, report: byApp.get(a.id) || null, report_pct: c.reportPct, report_items: c.reportItems,
        pending: pend.filter(p => p.app_id === a.id) };
    }),
    settings: calcSettings(v.settings),
    can: { rep: hasPerm(user, 'rep') },
  };
}

export async function scheduleData(user) {
  const s = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const v = await loadVisible(user);
  return { ...scheduleJson(s), current_pct: v.calc.total.pct,
    can: { sch: hasPerm(user, 'sch') && !!user.fullScope, timeline: hasPerm(user, 'cfg') && !!user.fullScope } };
}

// Everything the project status page needs, for the user's scope.
export async function projectStatusData(user) {
  const s = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  const v = await loadVisible(user);
  const on = v.functions.filter(f => f.enabled);
  const n = itemCounts(v.functions);
  const [snaps, edits, imports] = await Promise.all([
    recentSnapshots(),
    query(`SELECT app_id, count(*)::int AS n FROM edit_requests WHERE status='pending' GROUP BY 1`),
    // per batch: the applications it changes (a scoped reader counts a batch when one of them is theirs)
    query(`SELECT coalesce(array_agg(DISTINCT ch.app_id) FILTER (WHERE ch.app_id IS NOT NULL), '{}') AS apps, 1 AS n
      FROM import_batches b LEFT JOIN import_changes ch ON ch.batch_id=b.id WHERE b.status='pending' GROUP BY b.id`),
  ]);
  // Scoped users: the project line of a snapshot is the weighted average of the departments they can see.
  const depts = v.departments.map(d => ({ ...d, ...v.calc.departments.find(x => x.id === d.id) }));
  const tw = depts.reduce((a, d) => a + d.weight, 0);
  const trend = snaps.map(x => {
    if (user.fullScope) return { day: x.day, pct: x.pct };
    const p = tw ? depts.reduce((a, d) => a + d.weight * (+x.departments?.[d.id] || 0), 0) / tw : 0;
    return { day: x.day, pct: Math.round(p * 100) / 100 };
  });
  const deptTrend = Object.fromEntries(depts.map(d => [d.id, snaps.map(x => ({ day: x.day, pct: +x.departments?.[d.id] || 0 }))]));
  // pending work: full scope counts everything; a scoped reader only requests / batches of applications in scope (V2-N3)
  const visibleApps = new Set(v.apps.map(a => a.id));
  const mine = id => visibleApps.has(id);
  const pend = (rows, ok) => rows.filter(x => user.fullScope || ok(x)).reduce((a, x) => a + x.n, 0);
  const tracks = v.reports.filter(x => !v.departments.find(d => d.id === v.apps.find(a => a.id === x.app_id)?.department_id)?.is_base);
  return {
    schedule: scheduleJson(s),
    today: new Date().toISOString().slice(0, 10),
    total: v.calc.total,
    departments: depts.map(d => ({ id: d.id, name_ar: d.name_ar, name_en: d.name_en, color: d.color, emblem: d.emblem,
      pct: d.pct, weight: d.weight, apps: d.apps })),
    // functions / done / in_progress / not_started: function items; notes, tests and the flags: every counted item;
    // reports*: the report items and the reports tracks pooled as in an application's reports % (1.8.0)
    counts: {
      functions: n.functions,
      done: n.done,
      in_progress: n.in_progress,
      not_started: n.not_started,
      notes: n.notes,
      tests: v.calc.total.tests,
      notif_bad: on.filter(f => (f.notif_status | 0) === 3).length,
      review_missing: on.filter(f => (f.review_status | 0) === 2).length,
      ...reportsOverview(v.functions, tracks, +v.settings['calc.notif_share'] || 0),
    },
    pending: { edits: pend(edits.rows, x => mine(x.app_id)), imports: pend(imports.rows, x => x.apps.some(mine)) },
    trend, dept_trend: deptTrend,
    // department status thresholds (Settings → Notifications), used by the status page and the plan alerts alike
    health_gaps: { riskGap: +v.settings['notify.dept_risk_gap'] || 5, delayGap: +v.settings['notify.dept_delay_gap'] || 15 },
    can: { timeline: hasPerm(user, 'cfg') && !!user.fullScope, sch: hasPerm(user, 'sch') && !!user.fullScope },
  };
}

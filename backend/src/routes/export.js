// Excel exports of the screens: GET /api/export/<report>.xlsx?<the screen's filters>&lang=ar|en
//
// Export policy (docs/handover/06-Security.md → "4a. Export policy"):
//   - every export needs the 'exp' permission (checked here, on the server, for every report);
//   - each report reads its rows through the same function as the screen it mirrors, so it never shows more than
//     the reader's scope (and the screen's own extra rules: users = administrators only, logs = 'log' with the
//     security logs for administrators and no IP / device for others);
//   - every export writes a strict audit row (action 'export', entity = report key, rows and filters); when that
//     row cannot be written the file is not sent (ETS-SEC-049);
//   - strings are never written as formulas and are neutralised like the CSV exports (ETS-SEC-059).
import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requirePerm, requireAdmin, canSeeApp } from '../middleware/auth.js';
import { logAudit } from '../services/logs.js';
import { buildWorkbook, contentDisposition, XLSX_TYPE } from '../services/xlsx.js';
import { labels } from '../services/export-labels.js';
import { passConflict } from '../services/passRule.js';
import { notFound, own, str, isDate } from '../utils/http.js';
import { summaryData, projectStatusData, departmentData, applicationData, weightsData, reportsData, scheduleData, addPeriods }
  from './tracker.js';
import { listRequests, RQ_FILTERS } from './approvals.js';
import { listBatches, batchDetail } from './imports.js';
import { listUsers, listDeletedUsers } from './users.js';
import { exportRows, logFilters, EXPORT_CAP } from './logs.js';

const r = Router();
r.use(requireAuth, requirePerm('exp'));

const pctOf = (a, b) => (b ? (a / b) * 100 : 0);
const yesNo = (t, v) => (v ? t('yes') : t('no'));
// Query-string value of a filter: a short string, or undefined.
const q1 = (qs, k, n = 200) => (typeof qs[k] === 'string' && qs[k] !== '' ? str(qs[k], n) : undefined);
const pick = (qs, keys) => Object.fromEntries(keys.map(k => [k, q1(qs, k)]).filter(([, v]) => v !== undefined));

// A changed value (edit request item / import change) as the screens show it. Exported so the consolidated
// function-changes report renders before / after with the very same formatter as the Approvals / Import exports.
export function fmtValue(L, kind, field, v) {
  const { t } = L;
  if (v === null || v === undefined || v === '') return '';
  if (field === 'create') return [v.name_ar, `${t('weight')} ${v.weight}`, `${t('progress')} ${v.progress}%`, v.enabled ? t('yes') : t('no'),
    v.item_type === 'report' ? t('it_report') : null].filter(Boolean).join(' · ');
  if (field === 'removed') return v.removed ? t('fn_removed') + (v.reason ? ' — ' + v.reason : '') : t('fn_present');
  // a move (1.10.0): before = application / code of origin, after = the destination application
  if (field === 'move') return v.code ? `${v.app_id}/${v.code}` : [L.nm(v), v.app_id].filter(Boolean).join(' — ');
  const P = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_' };
  if (P[field]) return t(P[field] + v);
  if (kind === 'report' && field === 'status') return t('rs_' + v);
  if (field === 'progress') return `${+v}%`;
  if (field === 'enabled') return yesNo(t, v);
  if (field === 'item_type') return t('it_' + v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
// Reason of an exclusion: «مكررة مع: D3، D5», «خارج النطاق — note» …; '' for a counted function.
const dupCodes = (list, appId, lang) => (list || []).map(d => (d.app_id && d.app_id !== appId ? `${d.app_id}/${d.code}` : d.code)).join(lang === 'ar' ? '، ' : ', ');
function reasonText(L, m, appId) {
  if (!m) return '';
  const { t } = L;
  const r = m.disabled_reason ? t('dr_' + m.disabled_reason) : t('dr_none');
  const dup = dupCodes(m.duplicate_of, appId, L.lang);
  return [dup ? `${r}: ${dup}` : r, m.disabled_note].filter(Boolean).join(' — ');
}
const FIELD_KEY = { status: 'report_status', create: 'fn_add', removed: 'removed', name_en: 'name_en', item_type: 'item_type', move: 'move' };
const fieldLabel = (t, f) => t(FIELD_KEY[f] || f);
const itemLabel = (L, x) => (x.kind === 'report' ? L.t('kind_report') : x.kind === 'weight' ? L.t('kind_weight')
  : x.kind === 'application' ? (x.app_id || L.t('application')) : x.field === 'create' ? L.t('fn_add') : [x.code, x.fn_name_ar].filter(Boolean).join(' '));

// The Approvals filters (1.12.1) as a reader says them, for the sheet's second row (the audit row keeps the raw values).
async function approvalFilterView(L, f) {
  const { t } = L;
  const name = async (sql, v) => { const x = (await query(sql, [v])).rows[0]; return x ? (x.full_name ?? L.nm(x)) : v; };
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] = k === 'status' ? t('rq_' + v) : k === 'kind' ? t('rk_' + v) : k === 'mine' || k === 'awaiting' ? t('yes')
      : k === 'field' ? (v === 'name' ? t('rename') : fieldLabel(t, v))
      : k === 'dept' ? await name('SELECT name_ar, name_en FROM departments WHERE id=$1', v)
      : k === 'app' ? await name('SELECT name_ar, name_en FROM applications WHERE id=$1', v)
      : (k === 'requester' || k === 'decided_by') && /^[0-9]{1,10}$/.test(v) ? await name('SELECT full_name FROM users WHERE id=$1', +v) : v;
  }
  return out;
}

// ---- consolidated function / report item changes (function_changes) ----
// A change to an item reaches the database through exactly one of three channels that never overlap, so the union
// below double-counts nothing (docs/handover/07-Logging-and-Audit.md): a direct edit (audit_log, entity='function'),
// an approved edit request (edit_request_items, applied), or an applied import (import_changes, applied).
const CHG_SOURCE = { direct: 'chg_src_direct', approval: 'chg_src_approval', import: 'chg_src_import' };
// Meta kept on the audit row's new_value but shown as a note on the relevant field, not as its own change row.
const CHG_META = new Set(['rename_reason', 'disabled_reason', 'duplicate_of', 'disabled_note']);

// The applications the reader may see, narrowed by the optional department / application filters. Mirrors the
// audit-log export's scope (routes/logs.js): a scoped user never sees another department's items. Unknown filter
// values are ignored (an in-scope but unknown id simply matches nothing). Returns { apps: [{id, department_id}], f }.
async function changeScope(req, qs) {
  const f = pick(qs, ['dept', 'app', 'from', 'to']);
  if (f.from !== undefined && !isDate(f.from)) delete f.from;
  if (f.to !== undefined && !isDate(f.to)) delete f.to;
  const all = (await query('SELECT id, department_id FROM applications')).rows;
  const depts = new Set(all.map(a => a.department_id));
  const byId = new Map(all.map(a => [a.id, a]));
  if (f.dept !== undefined && !depts.has(f.dept)) delete f.dept;       // ignore an unknown department
  if (f.app !== undefined && !byId.has(f.app)) delete f.app;           // ignore an unknown application
  let apps = req.user.fullScope ? all : all.filter(a => canSeeApp(req.user, a));
  if (f.dept) apps = apps.filter(a => a.department_id === f.dept);
  if (f.app) apps = apps.filter(a => a.id === f.app);                  // narrows within the department
  return { apps, f };
}

// The three change sources as one list of field-change rows, newest first. `L` fixes the language of item names and
// values; `appIds` is the in-scope set from changeScope; `dates` carries the optional from / to.
async function functionChangeRows(L, appIds, dates) {
  const { t } = L;
  const nameCol = L.lang === 'en' ? 'COALESCE(f.name_en, f.name_ar)' : 'f.name_ar';
  const p = [appIds];
  const when = col => {                                                // optional date window on the change time
    let s = '';
    if (dates.from) { p.push(dates.from); s += ` AND ${col} >= $${p.length}::date`; }
    if (dates.to) { p.push(dates.to); s += ` AND ${col} < ($${p.length}::date + 1)`; }
    return s;
  };
  const CAP = EXPORT_CAP;
  // 1) direct edits — audit_log, entity='function'. An item moved out of a scoped application after the row stays
  //    readable there up to the move, with the application / code it had then (function_moves), exactly like the log.
  const audit = (await query(`SELECT l.id, l.ts, l.username, l.action, l.old_value, l.new_value,
      COALESCE(mv.from_code, f.code) AS code, ${nameCol} AS fn_name_ar,
      a.name_ar AS app_name_ar, a.name_en AS app_name_en, d.name_ar AS dept_name_ar, d.name_en AS dept_name_en
    FROM audit_log l
    LEFT JOIN functions f ON f.id::text = l.entity_id
    LEFT JOIN LATERAL (SELECT m.from_app_id, m.from_code FROM function_moves m
      WHERE f.id IS NOT NULL AND m.function_id=f.id AND m.moved_at > l.ts ORDER BY m.moved_at, m.id LIMIT 1) mv ON true
    LEFT JOIN applications a ON a.id = COALESCE(mv.from_app_id, f.app_id)
    LEFT JOIN departments d ON d.id = a.department_id
    WHERE l.entity='function' AND l.action IN ('update','create','remove','restore')
      AND ((l.entity_id ~ '^[0-9]+$' AND l.entity_id::int IN (SELECT id FROM functions WHERE app_id = ANY($1)))
        OR EXISTS (SELECT 1 FROM function_moves m
          WHERE m.function_id = CASE WHEN l.entity_id ~ '^[0-9]{1,9}$' THEN l.entity_id::int END
            AND m.from_app_id = ANY($1) AND m.moved_at >= l.ts))${when('l.ts')}
    ORDER BY l.ts DESC, l.id DESC LIMIT ${CAP}`, p)).rows;
  const direct = audit.flatMap(x => {
    const base = { when: x.ts, source: t(CHG_SOURCE.direct), dept_name_ar: x.dept_name_ar, dept_name_en: x.dept_name_en,
      app_name_ar: x.app_name_ar, app_name_en: x.app_name_en, by: x.username || '', requested_by: '', ref: 'A' + x.id };
    const row = (field, before, after) => ({ ...base, item: itemLabel(L, { kind: 'function', field, code: x.code, fn_name_ar: x.fn_name_ar }),
      field: fieldLabel(t, field), before, after });
    if (x.action === 'create') return [row('create', '', fmtValue(L, 'function', 'create', x.new_value))];
    if (x.action === 'remove') return [row('removed', fmtValue(L, 'function', 'removed', { removed: false }),
      fmtValue(L, 'function', 'removed', { removed: true, reason: x.new_value?.reason }))];
    if (x.action === 'restore') return [row('removed', fmtValue(L, 'function', 'removed', { removed: true }),
      fmtValue(L, 'function', 'removed', { removed: false }))];
    const nv = x.new_value || {}, ov = x.old_value || {};             // update: one row per real field of new_value
    return Object.keys(nv).filter(k => !CHG_META.has(k)).map(k => {
      let after = fmtValue(L, 'function', k, nv[k]);
      if (k === 'enabled' && nv[k] === false) after += ' — ' + reasonText(L, { disabled_reason: nv.disabled_reason, duplicate_of: nv.duplicate_of, disabled_note: nv.disabled_note });
      if ((k === 'name_ar' || k === 'name_en') && nv.rename_reason) after += ' — ' + t('rename_reason') + ': ' + nv.rename_reason;
      return row(k, fmtValue(L, 'function', k, ov[k]), after);
    });
  });
  // 2) approved edit requests — one row per applied item (the direct edits above never duplicate them).
  const appr = (await query(`SELECT i.id, i.kind, i.field, i.old_value, i.new_value, i.meta, i.app_id,
      r.id AS request_id, r.decided_at, f.code, ${nameCol} AS fn_name_ar,
      a.name_ar AS app_name_ar, a.name_en AS app_name_en, d.name_ar AS dept_name_ar, d.name_en AS dept_name_en,
      db.full_name AS decided_by_name, db.username AS decided_by_username,
      rb.full_name AS requested_by_name, rb.username AS requested_by_username
    FROM edit_request_items i JOIN edit_requests r ON r.id = i.request_id
    LEFT JOIN functions f ON f.id = i.function_id
    LEFT JOIN applications a ON a.id = i.app_id LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN users db ON db.id = r.decided_by LEFT JOIN users rb ON rb.id = r.requested_by
    WHERE i.applied = true AND i.kind IN ('function','report') AND i.app_id = ANY($1)${when('r.decided_at')}
    ORDER BY r.decided_at DESC, i.id DESC LIMIT ${CAP}`, p)).rows;
  const approval = appr.map(i => {
    let after = fmtValue(L, i.kind, i.field, i.new_value);
    if (i.field === 'enabled' && i.new_value === false) after += ' — ' + reasonText(L, i.meta || {}, i.app_id);
    if (i.meta?.rename_reason) after += ' — ' + t('rename_reason') + ': ' + i.meta.rename_reason;
    if (i.field === 'move') after += ' — ' + t('move_share') + ': ' + (i.meta?.weight_share ?? 0) + (i.meta?.reason ? ' — ' + t('move_reason') + ': ' + i.meta.reason : '');
    return { when: i.decided_at, source: t(CHG_SOURCE.approval), dept_name_ar: i.dept_name_ar, dept_name_en: i.dept_name_en,
      app_name_ar: i.app_name_ar, app_name_en: i.app_name_en, item: itemLabel(L, i), field: fieldLabel(t, i.field),
      before: fmtValue(L, i.kind, i.field, i.old_value), after,
      by: i.decided_by_name || i.decided_by_username || '', requested_by: i.requested_by_name || i.requested_by_username || '', ref: 'R' + i.request_id };
  });
  // 3) applied imports — one row per applied change (import_changes carries its own code column).
  const imp = (await query(`SELECT c.id, c.kind, c.field, c.old_value, c.new_value, COALESCE(f.code, c.code) AS code, c.app_id,
      b.id AS batch_id, b.applied_at, ${nameCol} AS fn_name_ar,
      a.name_ar AS app_name_ar, a.name_en AS app_name_en, d.name_ar AS dept_name_ar, d.name_en AS dept_name_en,
      ub.full_name AS uploaded_by_name, ub.username AS uploaded_by_username
    FROM import_changes c JOIN import_batches b ON b.id = c.batch_id
    LEFT JOIN functions f ON f.id = c.function_id
    LEFT JOIN applications a ON a.id = c.app_id LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN users ub ON ub.id = b.uploaded_by
    WHERE c.applied = true AND c.kind IN ('function','report') AND c.app_id = ANY($1)${when('b.applied_at')}
    ORDER BY b.applied_at DESC, c.id DESC LIMIT ${CAP}`, p)).rows;
  const imports = imp.map(c => ({ when: c.applied_at, source: t(CHG_SOURCE.import), dept_name_ar: c.dept_name_ar, dept_name_en: c.dept_name_en,
    app_name_ar: c.app_name_ar, app_name_en: c.app_name_en, item: itemLabel(L, c), field: fieldLabel(t, c.field),
    before: fmtValue(L, c.kind, c.field, c.old_value), after: fmtValue(L, c.kind, c.field, c.new_value),
    by: c.uploaded_by_name || c.uploaded_by_username || '', requested_by: '', ref: 'I' + c.batch_id }));
  return [...direct, ...approval, ...imports]
    .map(x => ({ ...x, department: L.nm(x, 'dept_name'), application: L.nm(x, 'app_name') }))
    .sort((a, b) => (b.when?.getTime?.() || 0) - (a.when?.getTime?.() || 0));
}

// The per-function filters the functions screen (and its export) accepts (q, source, test, show_off, show_removed,
// reason, item_type = function | report; test = 0…3, or 'conflict': «نجح» below 100 %, 1.8.1). Shared by the
// single-application functions export and the aggregated functions_all export so both narrow the same way.
const FUNCTION_FILTERS = ['q', 'source', 'test', 'show_off', 'show_removed', 'reason', 'item_type'];

// One application's per-function rows and the columns for them, from an applicationData result `d` and the
// per-function `filters`. The single-application `functions` export and the aggregated `functions_all` export share
// this so their rows and column order never diverge; functions_all only prepends a department / application column.
function functionDetailRows(d, L, filters = {}) {
  const { t } = L;
  const f = filters;
  const on = k => f[k] === '1' || f[k] === 'true';
  const q = (f.q || '').toLowerCase();
  const shown = d.functions.filter(x =>
    (x.removed_at ? on('show_removed') : (on('show_off') || x.enabled || x.source !== 'experience')) &&
    (!f.source || x.source === f.source) &&
    (f.test === undefined || (f.test === 'conflict' ? passConflict(x) : x.test_status === +f.test)) &&
    (f.reason === undefined || (!x.enabled && !x.removed_at && (x.disabled_reason || 'none') === f.reason)) &&
    (f.item_type === undefined || x.item_type === f.item_type) &&
    (!q || (x.name_ar + ' ' + (x.reference || '') + ' ' + (x.note || '')).toLowerCase().includes(q)));
  // share of an item in its part of the application %: functions among function items, reports among the reports
  // (with the reports track as weight 1) — as on the screen
  const tw = d.application.calc?.typeWeight || {};
  const partW = x => (x.item_type === 'report' ? d.application.calc?.reportWeight || 0 : tw.function || 0);
  const a0 = d.application;
  const rows = shown.map(x => ({ code: x.code, name_ar: x.name_ar, name_en: x.name_en, source: t('src_' + x.source), reference: x.reference,
    enabled: yesNo(t, x.enabled), weight: +x.weight, share: x.enabled && partW(x) > 0 && !x.removed_at ? pctOf(+x.weight, partW(x)) : null,
    progress: +x.progress, test: t('ts_' + (x.test_status | 0)), notif: t('ns_' + (x.notif_status | 0)), review: t('rv_' + (x.review_status | 0)),
    vendor: x.vendor_status > 0 ? t('vs_' + x.vendor_status) : '', note: x.note, by: x.updated_by_name, at: x.updated_at,
    removed: x.removed_at ? yesNo(t, true) : '', reason: x.removed_reason,
    // why it is excluded (migration 013); excluded before 1.5.0 → "no reason recorded"
    dreason: !x.enabled && !x.removed_at ? (x.disabled_reason ? t('dr_' + x.disabled_reason) : t('dr_none')) : '',
    dups: !x.enabled && !x.removed_at ? dupCodes(x.duplicate_of, a0.id, L.lang) : '',
    dnote: !x.enabled && !x.removed_at ? x.disabled_note || '' : '', type: t('it_' + (x.item_type || 'function')),
    // moved here from another application (1.10.0): «application / old code» (the name only within the reader's scope)
    moved: x.moved_from ? `${L.nm(x.moved_from, 'from_app_name') || x.moved_from.from_app_id}/${x.moved_from.from_code}` : '' }));
  const columns = [['code', 'code'], ['name_ar', 'name_ar'], ['name_en', 'name_en'], ['source', 'source'], ['reference', 'reference'],
    ['enabled', 'enabled'], ['weight', 'weight', 'number'], ['share', 'share', 'pct'], ['progress', 'progress', 'pct'],
    ['test', 'test_status'], ['notif', 'notif_status'], ['review', 'review_status'], ['vendor', 'vendor_status'], ['note', 'note'],
    ['by', 'updated_by'], ['at', 'updated_at', 'datetime'],
    // after the existing columns, so their positions stay as before 1.5.0
    ['dreason', 'disabled_reason'], ['dups', 'duplicate_of'], ['dnote', 'disabled_note'],
    ['type', 'item_type'],                                          // 1.8.0
    ['moved', 'moved_from']];                                       // 1.10.0
  if (on('show_removed')) columns.push(['removed', 'removed'], ['reason', 'removed_reason']);
  return { rows, columns };
}

// Each report: build(req, L) → { rows, columns, filters?, id?, target?, name? }.
// columns: [key, header label key, type?] — types: text (default), int, number, pct (0–100), date, datetime.
const REPORTS = {
  summary: {
    async build(req, L) {
      const d = await summaryData(req.user);
      const tw = d.total.weight;
      const rows = d.departments.map(x => ({ dept: L.nm(x), apps: x.apps, weight: x.weight, share: pctOf(x.weight, tw), pct: x.pct, fn: x.fnPct }));
      rows.push({ dept: L.t('total'), apps: d.departments.reduce((a, x) => a + (x.apps || 0), 0), weight: tw, share: tw ? 100 : 0, pct: d.total.pct, fn: d.total.fnPct });
      return { rows, columns: [['dept', 'department'], ['apps', 'applications', 'int'], ['weight', 'weight', 'number'], ['share', 'share', 'pct'],
        ['pct', 'progress', 'pct'], ['fn', 'fn_progress', 'pct']] };
    },
  },

  project_status: {
    async build(req, L) {
      const { t } = L;
      const d = await projectStatusData(req.user);
      const c = d.counts;
      const kv = (k, value, type = 'number') => ({ k: t(k), [type]: value });
      const rows = [
        kv('k_overall', d.total.pct, 'pct'), kv('k_fn_only', d.total.fnPct, 'pct'),
        kv('k_start', d.schedule.start_date, 'text'), kv('k_end', d.schedule.end_date, 'text'), kv('k_periods', d.schedule.periods),
        kv('k_functions', c.functions), kv('k_done', c.done), kv('k_in_progress', c.in_progress), kv('k_not_started', c.not_started),
        kv('k_notes', c.notes), kv('ts_2', c.tests[2]), kv('ts_1', c.tests[1]), kv('ts_3', c.tests[3]), kv('ts_4', c.tests[4]),
        kv('ts_5', c.tests[5]), kv('ts_6', c.tests[6]), kv('ts_7', c.tests[7]), kv('ts_0', c.tests[0]),
        kv('k_notif_bad', c.notif_bad), kv('k_review_missing', c.review_missing), kv('k_reports', c.reports), kv('k_report_items', c.report_items),
        kv('k_reports_done', c.reports_done), kv('k_reports_pct', c.reports_pct, 'pct'),
        kv('k_pending_edits', d.pending.edits), kv('k_pending_imports', d.pending.imports),
        ...d.departments.map(x => kv(t('k_dept', { name: L.nm(x) }), x.pct, 'pct')),
      ];
      // one value column per type keeps numbers numeric and percentages formatted
      return { rows: rows.map(x => ({ k: x.k, v: x.pct ?? x.number ?? x.text ?? null, type: x.pct !== undefined ? 'pct' : x.number !== undefined ? 'number' : 'text' })),
        columns: [['k', 'indicator'], ['v', 'value', 'mixed']] };
    },
  },

  department: {
    async build(req, L) {
      const id = q1(req.query, 'id', 40);
      if (!id) throw notFound();
      const d = await departmentData(req.user, id);
      // count: function items; reports / rep: the report items and the reports % (1.8.0), after the earlier columns
      const rows = d.applications.map(a => ({ app: L.nm(a), count: a.calc.items.function, ok: a.calc.tests[2], note: a.calc.tests[1], fail: a.calc.tests[3],
        none: a.calc.tests[0], weight: a.calc.weight, pct: a.calc.pct, fn: a.calc.fnPct, reports: a.calc.items.report, rep: a.calc.reportPct }));
      return { rows, id: d.department.id, target: { id: d.department.id, name_ar: d.department.name_ar, name_en: d.department.name_en },
        name: L.nm(d.department),
        columns: [['app', 'application'], ['count', 'functions', 'int'], ['ok', 'tests_ok', 'int'], ['note', 'tests_note', 'int'],
          ['fail', 'tests_failed', 'int'], ['none', 'tests_none', 'int'], ['weight', 'weight', 'number'], ['pct', 'progress', 'pct'], ['fn', 'fn_progress', 'pct'],
          ['reports', 'report_items', 'int'], ['rep', 'report_pct', 'pct']] };
    },
  },

  // The functions table of an application, with the screen's filters (q, source, test, show_off, show_removed, reason,
  // item_type = function | report; test = 0…3, or 'conflict': «نجح» below 100 %, 1.8.1).
  functions: {
    async build(req, L) {
      const id = q1(req.query, 'id', 40);
      if (!id) throw notFound();
      const d = await applicationData(req.user, id);
      const f = pick(req.query, FUNCTION_FILTERS);
      const { rows, columns } = functionDetailRows(d, L, f);
      const a = d.application;
      return { rows, columns, filters: f, id: a.id, name: L.nm(a), target: { id: a.id, name_ar: a.name_ar, name_en: a.name_en }, context: { app_id: a.id } };
    },
  },

  // The per-function detail of EVERY application under a department (?dept=…), or of one application (?app=…), or of
  // ALL applications in the reader's scope across every department (no filter). The columns are exactly those of the
  // single-application functions export, with a department / application column prepended so rows from different apps
  // stay distinguishable; the same per-function filters narrow it. Scope-limited like function_changes: a scoped
  // reader never gets another department's functions (ETS-SEC-007); applicationData enforces per-app scope again.
  functions_all: {
    async build(req, L) {
      const f = pick(req.query, ['dept', 'app', ...FUNCTION_FILTERS]);
      // the application set, scope-limited; validate/ignore an unknown dept / app (an in-scope but unknown id matches
      // nothing). Ordered by department, then the application's own order, so rows come out grouped and predictable.
      const all = (await query('SELECT id, department_id FROM applications ORDER BY department_id, sort, id')).rows;
      const depts = new Set(all.map(a => a.department_id));
      const byId = new Map(all.map(a => [a.id, a]));
      if (f.dept !== undefined && !depts.has(f.dept)) delete f.dept;
      if (f.app !== undefined && !byId.has(f.app)) delete f.app;
      let apps = req.user.fullScope ? all : all.filter(a => canSeeApp(req.user, a));
      if (f.app) apps = apps.filter(a => a.id === f.app);               // one application
      else if (f.dept) apps = apps.filter(a => a.department_id === f.dept); // the department's applications
      // the per-function filters only — dept / app are resolved above
      const ff = Object.fromEntries(Object.entries(f).filter(([k]) => FUNCTION_FILTERS.includes(k)));
      // department / application names come from the application's own data (scope already enforced)
      const base = [['department', 'department'], ['application', 'application']];
      let columns = null;
      const rows = [];
      for (const app of apps) {
        if (rows.length >= EXPORT_CAP) break;                           // the router caps anyway; stop building early
        const d = await applicationData(req.user, app.id);
        const r = functionDetailRows(d, L, ff);
        if (!columns) columns = [...base, ...r.columns];                // first application fixes the column set
        const dept = L.nm(d.department), application = L.nm(d.application);
        for (const row of r.rows) {
          rows.push({ department: dept, application, ...row });
          if (rows.length >= EXPORT_CAP) break;
        }
      }
      // show_removed widens the columns of the single-app export; keep them consistent even when the first application
      // yielded no rows by building the column list from a show_removed-aware empty call
      if (!columns) columns = [...base, ...functionDetailRows({ application: { calc: {} }, functions: [] }, L, ff).columns];
      // name the file after the department (or the application), like function_changes
      let name;
      if (f.app) { const a = byId.get(f.app); name = a && L.nm((await query('SELECT name_ar, name_en FROM applications WHERE id=$1', [f.app])).rows[0]); }
      else if (f.dept) { const d = (await query('SELECT name_ar, name_en FROM departments WHERE id=$1', [f.dept])).rows[0]; name = d && L.nm(d); }
      return { rows, columns, filters: f, name, id: f.app || f.dept || null };
    },
  },

  weights: {
    async build(req, L) {
      const d = await weightsData(req.user);
      const auto = d.settings.weight_mode === 'auto';
      const val = a => (auto ? a.fnWeight : +a.weight || 0);
      const total = d.applications.reduce((s, a) => s + val(a), 0);
      const dept = new Map(d.departments.map(x => [x.id, x]));
      const rows = d.departments.flatMap(x => d.applications.filter(a => a.department_id === x.id)).map(a => ({
        dept: L.nm(dept.get(a.department_id)), app: L.nm(a), def: +a.default_weight, fnw: a.fnWeight, weight: +a.weight, share: pctOf(val(a), total) }));
      return { rows, columns: [['dept', 'department'], ['app', 'application'], ['def', 'default_weight', 'number'], ['fnw', 'fn_weight_sum', 'number'],
        ['weight', 'weight', 'number'], ['share', 'share', 'pct']] };
    },
  },

  reports: {
    async build(req, L) {
      const { t } = L;
      const d = await reportsData(req.user);
      const f = pick(req.query, ['dept']);
      const depts = f.dept ? d.departments.filter(x => x.id === f.dept) : d.departments;
      const rows = depts.flatMap(x => d.applications.filter(a => a.department_id === x.id).map(a => {
        const rp = a.report || { progress: 0, status: 0, note: '' };
        return { dept: L.nm(x), app: L.nm(a), weight: a.weight, status: t('rs_' + (rp.status | 0)), pct: +rp.progress, note: rp.note,
          by: rp.updated_by_name, at: rp.updated_at, items: a.report_items, rpct: a.report_pct };
      }));
      // items / rpct (1.8.0): the application's report items and its reports % (items + this track)
      return { rows, filters: f, columns: [['dept', 'department'], ['app', 'application'], ['weight', 'weight', 'number'], ['status', 'report_status'],
        ['pct', 'progress', 'pct'], ['note', 'note'], ['by', 'updated_by'], ['at', 'updated_at', 'datetime'],
        ['items', 'report_items', 'int'], ['rpct', 'report_pct', 'pct']] };
    },
  },

  // The schedule table of the curve screen: period, planned, actual, deviation.
  schedule: {
    async build(req, L) {
      const s = await scheduleData(req.user);
      const rows = s.plan.map((p, i) => {
        const a = s.actual[i];
        return { n: i + 1, label: s.start_date ? addPeriods(s.start_date, s.unit, i + 1) : L.t('period_n', { n: i + 1 }),
          plan: +p, actual: a === null || a === undefined ? null : +a, dev: a === null || a === undefined ? null : +a - +p };
      });
      return { rows, columns: [['n', 'period', 'int'], ['label', 'period_end'], ['plan', 'planned', 'pct'], ['actual', 'actual', 'pct'], ['dev', 'deviation', 'pct']] };
    },
  },

  // Edit requests with their items: one row per item.
  approvals: {
    async build(req, L) {
      const { t } = L;
      const f = pick(req.query, RQ_FILTERS);
      const list = await listRequests(req.user, f, { limit: EXPORT_CAP });
      const rows = list.flatMap(rq => {
        const base = { id: rq.id, status: t('rq_' + rq.status), dept: L.nm(rq, 'dept_name'), app: L.nm(rq, 'app_name'), kind: t('rk_' + rq.kind),
          summary: rq.summary, by: rq.requested_by_name, at: rq.requested_at, dby: rq.decided_by_name, dat: rq.decided_at, reason: rq.reason,
          to: rq.target_app_id ? `${L.nm(rq, 'target_app_name')} — ${L.nm(rq, 'target_dept_name')}`
            : rq.kind === 'move_application' ? L.nm(rq, 'target_dept_name') : '' };
        if (!rq.items.length) return [base];
        return rq.items.map(i => ({ ...base, item: itemLabel(L, i), field: fieldLabel(t, i.field), before: fmtValue(L, i.kind, i.field, i.old_value),
          after: fmtValue(L, i.kind, i.field, i.new_value) + (i.field === 'enabled' && i.new_value === false ? ' — ' + reasonText(L, i.meta || {}, rq.app_id) : '')
            + (i.meta?.rename_reason ? ' — ' + t('rename_reason') + ': ' + i.meta.rename_reason : '')
            + (i.field === 'move' ? ' — ' + t('move_share') + ': ' + (i.meta?.weight_share ?? 0) + (i.meta?.reason ? ' — ' + t('move_reason') + ': ' + i.meta.reason : '') : ''),
          applied: i.applied === undefined || i.applied === null ? '' : yesNo(t, i.applied) }));
      });
      return { rows, filters: f, filterView: await approvalFilterView(L, f), columns: [['id', 'request', 'int'], ['status', 'status'], ['dept', 'department'], ['app', 'application'],
        ['kind', 'kind'], ['by', 'requested_by'], ['at', 'requested_at', 'datetime'], ['dby', 'decided_by'], ['dat', 'decided_at', 'datetime'],
        ['reason', 'reason'], ['item', 'item'], ['field', 'field'], ['before', 'before'], ['after', 'after'], ['applied', 'applied_col'],
        ['to', 'move_to_app']] };                                       // 1.10.0: the destination of a move
    },
  },

  imports: {
    async build(req, L) {
      const { t } = L;
      const f = pick(req.query, ['status']);
      const list = await listBatches(req.user, f, { limit: EXPORT_CAP });
      const rows = list.map(b => ({ id: b.id, target: b.target === 'reports' ? t('target_reports') : L.nm(b, 'dept_name'), file: b.filename,
        status: t('st_' + b.status), by: b.uploaded_by_name, at: b.uploaded_at, n: b.change_count, lead: b.lead_by_name, lat: b.lead_at,
        fin: b.final_by_name, fat: b.final_at, rej: b.rejected_by_name, reason: b.reject_reason }));
      return { rows, filters: f, columns: [['id', 'batch', 'int'], ['target', 'target'], ['file', 'filename'], ['status', 'status'],
        ['by', 'uploaded_by'], ['at', 'uploaded_at', 'datetime'], ['n', 'changes', 'int'], ['lead', 'lead_by'], ['lat', 'lead_at', 'datetime'],
        ['fin', 'final_by'], ['fat', 'final_at', 'datetime'], ['rej', 'rejected_by'], ['reason', 'reject_reason']] };
    },
  },

  import_detail: {
    async build(req, L) {
      const { t } = L;
      const d = await batchDetail(req.user, req.query.id);
      const applied = d.batch.status === 'applied';
      const rows = d.changes.map(ch => ({ app: L.nm(ch, 'app_name'), item: itemLabel(L, ch), field: fieldLabel(t, ch.field),
        before: fmtValue(L, ch.kind, ch.field, ch.old_value), after: fmtValue(L, ch.kind, ch.field, ch.new_value),
        applied: applied ? yesNo(t, ch.applied) : '' }));
      const columns = [['app', 'application'], ['item', 'item'], ['field', 'field'], ['before', 'before'], ['after', 'after']];
      if (applied) columns.push(['applied', 'applied_col']);
      return { rows, columns, id: d.batch.id, name: `#${d.batch.id}`, target: { id: d.batch.id, filename: d.batch.filename } };
    },
  },

  // All changes made to function / report items, across every department and application, filterable by one
  // department and / or one application. The union of the three change channels (direct edit, approved edit request,
  // applied import), one row per field-change, within the reader's scope (ETS-SEC-007, mirroring the audit log).
  function_changes: {
    async build(req, L) {
      const { apps, f } = await changeScope(req, req.query);
      const rows = await functionChangeRows(L, apps.map(a => a.id), f);
      // a single-department / single-application filter names the file
      let name;
      if (f.app) { const a = (await query('SELECT name_ar, name_en FROM applications WHERE id=$1', [f.app])).rows[0]; name = a && L.nm(a); }
      else if (f.dept) { const d = (await query('SELECT name_ar, name_en FROM departments WHERE id=$1', [f.dept])).rows[0]; name = d && L.nm(d); }
      return { rows, filters: f, name, id: f.app || f.dept || null, context: f.app ? { app_id: f.app } : null,
        columns: [['when', 'chg_when', 'datetime'], ['source', 'chg_source'], ['department', 'department'], ['application', 'application'],
          ['item', 'item'], ['field', 'field'], ['before', 'before'], ['after', 'after'], ['by', 'chg_by'], ['requested_by', 'requested_by'],
          ['ref', 'chg_ref']] };
    },
  },

  // Administrators only. Never: passwords / hashes, recovery codes, sessions, IP addresses, user agents,
  // failed attempts, lock times — the columns below are the whole list. Deleted users (1.7.0) are left out; with
  // ?deleted=1 the file lists only them, with who deleted each one, when and why.
  users: {
    guard: [requirePerm('usr'), requireAdmin],
    async build(req, L) {
      const { t } = L;
      if (req.query.deleted === '1') {
        const rows = (await listDeletedUsers()).map(u => ({ full_name: u.full_name, username: u.username, role: L.nm(u, 'role_name'),
          deleted_at: u.deleted_at, deleted_by: u.deleted_by_name || u.deleted_by_username || '', delete_reason: u.delete_reason, email: u.email }));
        return { rows, filters: { deleted: t('yes') }, columns: [['full_name', 'full_name'], ['username', 'username'], ['role', 'role'],
          ['deleted_at', 'deleted_at', 'datetime'], ['deleted_by', 'deleted_by'], ['delete_reason', 'delete_reason'], ['email', 'email']] };
      }
      const [users, scopes] = await Promise.all([listUsers(), query(`SELECT s.user_id, s.kind,
          coalesce(d.name_ar, a.name_ar, s.ref_id) AS name_ar, coalesce(d.name_en, a.name_en, s.ref_id) AS name_en
        FROM user_scopes s LEFT JOIN departments d ON s.kind='department' AND d.id=s.ref_id
        LEFT JOIN applications a ON s.kind='application' AND a.id=s.ref_id ORDER BY s.kind, s.ref_id`)]);
      const scopeOf = u => (u.role_full_scope ? t('full_scope')
        : scopes.rows.filter(s => s.user_id === u.id).map(s => L.nm(s)).join(L.lang === 'ar' ? '، ' : ', ') || t('no_scope'));
      const rows = users.map(u => ({ full_name: u.full_name, username: u.username, role: L.nm(u, 'role_name'),
        status: u.is_active ? t('active') : t('inactive'), twofa: u.totp_enabled ? t('on') : t('off'), scope: scopeOf(u),
        last_login: u.last_login_at, email: u.email }));
      return { rows, columns: [['full_name', 'full_name'], ['username', 'username'], ['role', 'role'], ['status', 'user_status'],
        ['twofa', 'twofa'], ['scope', 'scope'], ['last_login', 'last_login', 'datetime'], ['email', 'email']] };
    },
  },

  // A log, with the Logs screen's filters and rules (routes/logs.js → exportRows).
  log: {
    async build(req, L) {
      const type = q1(req.query, 'type', 20);
      const { rows, fields } = await exportRows(req, type);
      const TYPE = { ts: 'datetime', id: 'int', user_id: 'int', status: 'int', duration_ms: 'int' };
      const out = rows.map(x => Object.fromEntries(fields.map(k => [k, typeof x[k] === 'boolean' ? yesNo(L.t, x[k]) : x[k]])));
      return { rows: out, id: type, name: L.t('log_' + type), filters: { type, ...logFilters(req.query) },
        columns: fields.map(k => [k, 'lc_' + k, TYPE[k]]), header: k => (L.t('lc_' + k) === 'lc_' + k ? k : L.t('lc_' + k)) };
    },
  },
};

const runGuards = async (guards, req, res) => {
  for (const g of guards || []) await new Promise((ok, fail) => { try { g(req, res, e => (e ? fail(e) : ok())); } catch (e) { fail(e); } });
};

// Readable list of the filters for the sheet's second row.
const filterText = (L, f) => Object.entries(f || {}).map(([k, v]) => `${L.t('f_' + k)}: ${k === 'type' ? L.t('log_' + v) : k === 'reason' ? L.t('dr_' + v)
  : k === 'item_type' ? L.t('it_' + v) : k === 'test' && v === 'conflict' ? L.t('pass_conflict') : v}`).join(' · ');

r.get('/:file', async (req, res) => {
  const m = /^([a-z_]+)\.xlsx$/.exec(req.params.file);
  const key = m?.[1];
  const rep = own(REPORTS, key);
  if (!rep) throw notFound();
  await runGuards(rep.guard, req, res);
  const lang = req.query.lang === 'en' || req.query.lang === 'ar' ? req.query.lang : req.user.language === 'en' ? 'en' : 'ar';
  const L = labels(lang);
  const out = await rep.build(req, L);
  const truncated = out.rows.length > EXPORT_CAP;
  const rows = truncated ? out.rows.slice(0, EXPORT_CAP) : out.rows;

  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const report = L.t('r_' + key);
  const title = out.name ? `${report} — ${out.name}` : report;
  const who = req.user.full_name || req.user.username;
  const ft = out.filterView ? Object.entries(out.filterView).map(([k, v]) => `${L.t('f_' + k)}: ${v}`).join(' · ') : filterText(L, out.filters);
  const subtitle = [`${L.t('exported_by')}: ${who}`, stamp, ft && `${L.t('filters')}: ${ft}`].filter(Boolean).join(' · ');
  // a column of type 'mixed' takes each row's own type from row.type (project status: one "value" column)
  const columns = out.columns.map(([k, h, type]) => ({ key: k, header: out.header ? out.header(k) : L.t(h),
    ...(type === 'mixed' ? { typeKey: 'type' } : { type }) }));
  const file = await buildWorkbook({ title, subtitle, lang, columns, rows });

  // strict: no file leaves without its audit row (ETS-SEC-049)
  const filters = out.filters || {};
  const fs = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(', ');
  await logAudit(req, { action: 'export', entity: key, entityId: out.id ?? null,
    summary: `xlsx: ${rows.length} rows${truncated ? ' (truncated)' : ''}${fs ? ` [${fs}]` : ''}`,
    newValue: { format: 'xlsx', rows: rows.length, truncated, filters, lang, ...(out.target ? { target: out.target } : {}) },
    context: out.context || null });

  const day = now.toISOString().slice(0, 10);
  const idPart = out.id !== undefined && out.id !== null ? '-' + out.id : '';
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', contentDisposition(`ets-${key.replace(/_/g, '-')}${idPart}-${day}.xlsx`, `${title} ${day}.xlsx`));
  res.send(file);
});

export const EXPORT_REPORTS = Object.keys(REPORTS);
export default r;

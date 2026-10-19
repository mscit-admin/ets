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
import { requireAuth, requirePerm, requireAdmin } from '../middleware/auth.js';
import { logAudit } from '../services/logs.js';
import { buildWorkbook, contentDisposition, XLSX_TYPE } from '../services/xlsx.js';
import { labels } from '../services/export-labels.js';
import { notFound, own, str } from '../utils/http.js';
import { summaryData, projectStatusData, departmentData, applicationData, weightsData, reportsData, scheduleData, addPeriods }
  from './tracker.js';
import { listRequests } from './approvals.js';
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

// A changed value (edit request item / import change) as the screens show it.
function fmtValue(L, kind, field, v) {
  const { t } = L;
  if (v === null || v === undefined || v === '') return '';
  if (field === 'create') return [v.name_ar, `${t('weight')} ${v.weight}`, `${t('progress')} ${v.progress}%`, v.enabled ? t('yes') : t('no')].join(' · ');
  if (field === 'removed') return v.removed ? t('fn_removed') + (v.reason ? ' — ' + v.reason : '') : t('fn_present');
  const P = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_' };
  if (P[field]) return t(P[field] + v);
  if (kind === 'report' && field === 'status') return t('rs_' + v);
  if (field === 'progress') return `${+v}%`;
  if (field === 'enabled') return yesNo(t, v);
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
const FIELD_KEY = { status: 'report_status', create: 'fn_add', removed: 'removed', name_en: 'name_en' };
const fieldLabel = (t, f) => t(FIELD_KEY[f] || f);
const itemLabel = (L, x) => (x.kind === 'report' ? L.t('kind_report') : x.kind === 'weight' ? L.t('kind_weight')
  : x.field === 'create' ? L.t('fn_add') : [x.code, x.fn_name_ar].filter(Boolean).join(' '));

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
        kv('k_notes', c.notes), kv('ts_2', c.tests[2]), kv('ts_1', c.tests[1]), kv('ts_3', c.tests[3]), kv('ts_0', c.tests[0]),
        kv('k_notif_bad', c.notif_bad), kv('k_review_missing', c.review_missing), kv('k_reports', c.reports),
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
      const rows = d.applications.map(a => ({ app: L.nm(a), count: a.calc.count, ok: a.calc.tests[2], note: a.calc.tests[1], fail: a.calc.tests[3],
        none: a.calc.tests[0], weight: a.calc.weight, pct: a.calc.pct, fn: a.calc.fnPct }));
      return { rows, id: d.department.id, target: { id: d.department.id, name_ar: d.department.name_ar, name_en: d.department.name_en },
        name: L.nm(d.department),
        columns: [['app', 'application'], ['count', 'functions', 'int'], ['ok', 'tests_ok', 'int'], ['note', 'tests_note', 'int'],
          ['fail', 'tests_failed', 'int'], ['none', 'tests_none', 'int'], ['weight', 'weight', 'number'], ['pct', 'progress', 'pct'], ['fn', 'fn_progress', 'pct']] };
    },
  },

  // The functions table of an application, with the screen's filters (q, source, test, show_off, show_removed, reason).
  functions: {
    async build(req, L) {
      const { t } = L;
      const id = q1(req.query, 'id', 40);
      if (!id) throw notFound();
      const d = await applicationData(req.user, id);
      const f = pick(req.query, ['q', 'source', 'test', 'show_off', 'show_removed', 'reason']);
      const on = k => f[k] === '1' || f[k] === 'true';
      const q = (f.q || '').toLowerCase();
      const shown = d.functions.filter(x =>
        (x.removed_at ? on('show_removed') : (on('show_off') || x.enabled || x.source !== 'experience')) &&
        (!f.source || x.source === f.source) &&
        (f.test === undefined || x.test_status === +f.test) &&
        (f.reason === undefined || (!x.enabled && !x.removed_at && (x.disabled_reason || 'none') === f.reason)) &&
        (!q || (x.name_ar + ' ' + (x.reference || '') + ' ' + (x.note || '')).toLowerCase().includes(q)));
      const totalW = d.application.calc?.fnWeight || 0;
      const a0 = d.application;
      const rows = shown.map(x => ({ code: x.code, name_ar: x.name_ar, name_en: x.name_en, source: t('src_' + x.source), reference: x.reference,
        enabled: yesNo(t, x.enabled), weight: +x.weight, share: x.enabled && totalW > 0 && !x.removed_at ? pctOf(+x.weight, totalW) : null,
        progress: +x.progress, test: t('ts_' + (x.test_status | 0)), notif: t('ns_' + (x.notif_status | 0)), review: t('rv_' + (x.review_status | 0)),
        vendor: x.vendor_status > 0 ? t('vs_' + x.vendor_status) : '', note: x.note, by: x.updated_by_name, at: x.updated_at,
        removed: x.removed_at ? yesNo(t, true) : '', reason: x.removed_reason,
        // why it is excluded (migration 013); excluded before 1.5.0 → "no reason recorded"
        dreason: !x.enabled && !x.removed_at ? (x.disabled_reason ? t('dr_' + x.disabled_reason) : t('dr_none')) : '',
        dups: !x.enabled && !x.removed_at ? dupCodes(x.duplicate_of, a0.id, L.lang) : '',
        dnote: !x.enabled && !x.removed_at ? x.disabled_note || '' : '' }));
      const columns = [['code', 'code'], ['name_ar', 'name_ar'], ['name_en', 'name_en'], ['source', 'source'], ['reference', 'reference'],
        ['enabled', 'enabled'], ['weight', 'weight', 'number'], ['share', 'share', 'pct'], ['progress', 'progress', 'pct'],
        ['test', 'test_status'], ['notif', 'notif_status'], ['review', 'review_status'], ['vendor', 'vendor_status'], ['note', 'note'],
        ['by', 'updated_by'], ['at', 'updated_at', 'datetime'],
        // after the existing columns, so their positions stay as before 1.5.0
        ['dreason', 'disabled_reason'], ['dups', 'duplicate_of'], ['dnote', 'disabled_note']];
      if (on('show_removed')) columns.push(['removed', 'removed'], ['reason', 'removed_reason']);
      const a = d.application;
      return { rows, columns, filters: f, id: a.id, name: L.nm(a), target: { id: a.id, name_ar: a.name_ar, name_en: a.name_en }, context: { app_id: a.id } };
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
          by: rp.updated_by_name, at: rp.updated_at };
      }));
      return { rows, filters: f, columns: [['dept', 'department'], ['app', 'application'], ['weight', 'weight', 'number'], ['status', 'report_status'],
        ['pct', 'progress', 'pct'], ['note', 'note'], ['by', 'updated_by'], ['at', 'updated_at', 'datetime']] };
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
      const f = pick(req.query, ['status', 'mine']);
      const list = await listRequests(req.user, f, { limit: EXPORT_CAP });
      const rows = list.flatMap(rq => {
        const base = { id: rq.id, status: t('rq_' + rq.status), dept: L.nm(rq, 'dept_name'), app: L.nm(rq, 'app_name'), kind: t('rk_' + rq.kind),
          summary: rq.summary, by: rq.requested_by_name, at: rq.requested_at, dby: rq.decided_by_name, dat: rq.decided_at, reason: rq.reason };
        if (!rq.items.length) return [base];
        return rq.items.map(i => ({ ...base, item: itemLabel(L, i), field: fieldLabel(t, i.field), before: fmtValue(L, i.kind, i.field, i.old_value),
          after: fmtValue(L, i.kind, i.field, i.new_value) + (i.field === 'enabled' && i.new_value === false ? ' — ' + reasonText(L, i.meta || {}, rq.app_id) : ''),
          applied: i.applied === undefined || i.applied === null ? '' : yesNo(t, i.applied) }));
      });
      return { rows, filters: f, columns: [['id', 'request', 'int'], ['status', 'status'], ['dept', 'department'], ['app', 'application'],
        ['kind', 'kind'], ['by', 'requested_by'], ['at', 'requested_at', 'datetime'], ['dby', 'decided_by'], ['dat', 'decided_at', 'datetime'],
        ['reason', 'reason'], ['item', 'item'], ['field', 'field'], ['before', 'before'], ['after', 'after'], ['applied', 'applied_col']] };
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
const filterText = (L, f) => Object.entries(f || {}).map(([k, v]) => `${L.t('f_' + k)}: ${k === 'type' ? L.t('log_' + v) : k === 'reason' ? L.t('dr_' + v) : v}`).join(' · ');

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
  const ft = filterText(L, out.filters);
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

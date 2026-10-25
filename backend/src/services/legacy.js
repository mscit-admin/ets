// Import/export compatible with the original single-file tracker
// (reference/erp-tracker-original.html): its JSON export, or a standalone HTML
// copy with the state embedded in window.__SAVED.
import { isDate, jsonDepth, MAX_JSON_DEPTH, bad } from '../utils/http.js';
import { passRuleErrors, itemList } from './passRule.js';

import { canSeeApp } from '../middleware/auth.js';

const KEY = 'window.__SAVED=';

export function parseLegacy(text) {
  const t = String(text || '');
  if (/^\s*\{/.test(t)) return parseShallow(t);
  const i = t.indexOf(KEY);
  if (i < 0) throw new Error('no_legacy_state');
  const seg = t.slice(i + KEY.length);
  const end = seg.indexOf(';</' + 'script>');
  return parseShallow(end > 0 ? seg.slice(0, end) : seg);
}

// The file is a few levels deep; a deeply nested one is refused before JSON.parse spends seconds on it (ETS-SEC-008).
function parseShallow(json) {
  if (jsonDepth(json) > MAX_JSON_DEPTH) throw new Error('too_deep');
  return JSON.parse(json);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, +v || 0));

// Items the file would leave «نجح» below 100 % by changing their test status or progress (1.8.1): the import's row
// errors. An item already passed below 100 % that the file leaves as it is, is not one.
export async function legacyPassErrors(c, p) {
  const rows = (await c.query('SELECT id, app_id, code, name_ar, name_en, item_type, progress, test_status FROM functions WHERE removed_at IS NULL')).rows;
  const list = [];
  for (const r of rows) {
    const v = p.f?.[r.app_id]?.[r.code];
    if (!v || typeof v !== 'object') continue;
    list.push({ cur: r, changes: { progress: clamp(v.p, 0, 100), test_status: clamp(v.t, 0, 4) | 0 },
      app_id: r.app_id, function_id: r.id, code: r.code, name_ar: r.name_ar, name_en: r.name_en, item_type: r.item_type });
  }
  return passRuleErrors(list);
}

// Applies a legacy payload inside a transaction (client c). Returns counts. Refused as a whole (400
// import_has_row_errors, nothing written) when a row breaks «نجح» needs 100 % (1.8.1).
export async function applyLegacy(c, p, userId) {
  if (!p || typeof p !== 'object' || !p.f) throw new Error('no_legacy_state');
  const errors = await legacyPassErrors(c, p);
  if (errors.length) throw bad('import_has_row_errors', { count: errors.length, errors: errors.slice(0, 200), list: itemList(errors) });
  const counts = { functions: 0, weights: 0, reports: 0, settings: 0, schedule: 0 };
  for (const [appId, items] of Object.entries(p.f)) {
    if (!items || typeof items !== 'object') continue;
    for (const [code, v] of Object.entries(items)) {
      if (!v || typeof v !== 'object') continue;
      // a function the file turns off gets the reason 'import'; one it turns on loses its reason (migration 013)
      const r = await c.query(`UPDATE functions SET weight=$3, progress=$4, enabled=$5, test_status=$6, note=$7,
          notif_status=$8, review_status=$9, updated_at=now(), updated_by=$10,
          disabled_reason = CASE WHEN $5::boolean THEN NULL WHEN enabled THEN 'import' ELSE disabled_reason END,
          disabled_note   = CASE WHEN $5::boolean THEN NULL WHEN enabled THEN NULL ELSE disabled_note END,
          disabled_by     = CASE WHEN $5::boolean THEN NULL WHEN enabled THEN $10 ELSE disabled_by END,
          disabled_at     = CASE WHEN $5::boolean THEN NULL WHEN enabled THEN now() ELSE disabled_at END
        WHERE app_id=$1 AND code=$2 AND removed_at IS NULL`,
        [appId, code, clamp(v.w, 0, 1000), clamp(v.p, 0, 100), !!v.on, clamp(v.t, 0, 4) | 0,
          typeof v.nt === 'string' ? v.nt.slice(0, 2000) : '', clamp(v.n, 0, 3) | 0, clamp(v.rv, 0, 5) | 0, userId]);
      counts.functions += r.rowCount;
    }
  }
  // duplicate links belong to excluded functions only
  await c.query('DELETE FROM function_duplicates d USING functions f WHERE f.id=d.function_id AND f.enabled');
  if (p.appW && typeof p.appW === 'object') for (const [id, w] of Object.entries(p.appW)) {
    counts.weights += (await c.query('UPDATE applications SET weight=$2, updated_at=now(), updated_by=$3 WHERE id=$1',
      [id, clamp(w, 0, 1000), userId])).rowCount;
  }
  if (p.rep && typeof p.rep === 'object') for (const [id, v] of Object.entries(p.rep)) {
    if (!v || typeof v !== 'object') continue;
    counts.reports += (await c.query('UPDATE app_reports SET progress=$2, status=$3, note=$4, updated_at=now(), updated_by=$5 WHERE app_id=$1',
      [id, clamp(v.p, 0, 100), clamp(v.rs, 0, 3) | 0, typeof v.nt === 'string' ? v.nt.slice(0, 2000) : '', userId])).rowCount;
  }
  const setS = async (k, v) => {
    await c.query(`INSERT INTO settings(key,value,updated_by) VALUES ($1,$2,$3)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`, [k, JSON.stringify(v), userId]);
    counts.settings++;
  };
  if (p.mode === 'fixed' || p.mode === 'auto') await setS('calc.weight_mode', p.mode);
  if (typeof p.nw === 'number') await setS('calc.notif_share', clamp(p.nw, 0, 0.5));
  if (typeof p.repW === 'number') await setS('calc.reports_share', clamp(p.repW, 0, 0.5));
  if (p.sch && typeof p.sch === 'object') {
    const n = Math.min(60, Math.max(1, parseInt(p.sch.n, 10) || 11));
    const plan = Array.isArray(p.sch.plan) && p.sch.plan.length === n ? p.sch.plan.map(v => clamp(v, 0, 100)) : null;
    const act = Array.isArray(p.sch.act) ? p.sch.act.slice(0, n).map(v => (v === null || v === undefined || v === '' ? null : clamp(v, 0, 100))) : null;
    await c.query(`UPDATE schedule SET start_date=$1, periods=$2, unit=$3, plan=$4, actual=$5, updated_at=now(), updated_by=$6 WHERE id=1`,
      [isDate(p.sch.start) ? p.sch.start : null, n, p.sch.unit === 'fortnight' ? 'fortnight' : 'month', plan, act, userId]);
    counts.schedule = 1;
  }
  return counts;
}

// Builds a payload in the original format (v3) so the old page can also read it.
// user: whose scope limits the content (ETS-SEC-006) — applications outside it are left out, and the
// project-wide schedule is included for full-scope users only.
export async function buildLegacy(c, { user }) {
  const visible = new Set((await c.query('SELECT id, department_id FROM applications')).rows.filter(a => canSeeApp(user, a)).map(a => a.id));
  const fns = (await c.query('SELECT app_id, code, weight, progress, enabled, test_status, note, notif_status, review_status FROM functions WHERE removed_at IS NULL')).rows
    .filter(x => visible.has(x.app_id));
  const f = {};
  for (const x of fns) {
    (f[x.app_id] ||= {})[x.code] = { w: x.weight, p: x.progress, on: x.enabled ? 1 : 0, t: x.test_status, nt: x.note, n: x.notif_status, rv: x.review_status };
  }
  const appW = Object.fromEntries((await c.query('SELECT id, weight FROM applications')).rows.filter(a => visible.has(a.id)).map(a => [a.id, a.weight]));
  const rep = Object.fromEntries((await c.query('SELECT app_id, progress, status, note FROM app_reports')).rows
    .filter(r => visible.has(r.app_id)).map(r => [r.app_id, { p: r.progress, rs: r.status, nt: r.note }]));
  const s = Object.fromEntries((await c.query('SELECT key, value FROM settings')).rows.map(r => [r.key, r.value]));
  const sch = (await c.query('SELECT * FROM schedule WHERE id=1')).rows[0] || {};
  return {
    v: 3, ts: Date.now(), mode: s['calc.weight_mode'] || 'fixed', appW,
    rep, nw: s['calc.notif_share'] ?? 0.1, repW: s['calc.reports_share'] ?? 0.15,
    ...(user.fullScope ? { sch: { start: sch.start_date ? new Date(sch.start_date).toISOString().slice(0, 10) : '', n: sch.periods || 11,
      unit: sch.unit || 'month', plan: sch.plan, act: sch.actual || [] } } : {}),
    f, source: 'ets-backend',
  };
}

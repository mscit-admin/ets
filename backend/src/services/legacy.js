// Import/export compatible with the original single-file tracker
// (reference/erp-tracker-original.html): its JSON export, or a standalone HTML
// copy with the state embedded in window.__SAVED.

const KEY = 'window.__SAVED=';

export function parseLegacy(text) {
  const t = String(text || '');
  if (/^\s*\{/.test(t)) return JSON.parse(t);
  const i = t.indexOf(KEY);
  if (i < 0) throw new Error('no_legacy_state');
  const seg = t.slice(i + KEY.length);
  const end = seg.indexOf(';</' + 'script>');
  return JSON.parse(end > 0 ? seg.slice(0, end) : seg);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, +v || 0));

// Applies a legacy payload inside a transaction (client c). Returns counts.
export async function applyLegacy(c, p, userId) {
  if (!p || typeof p !== 'object' || !p.f) throw new Error('no_legacy_state');
  const counts = { functions: 0, weights: 0, reports: 0, settings: 0, schedule: 0 };
  for (const [appId, items] of Object.entries(p.f)) {
    for (const [code, v] of Object.entries(items || {})) {
      const r = await c.query(`UPDATE functions SET weight=$3, progress=$4, enabled=$5, test_status=$6, note=$7,
          notif_status=$8, review_status=$9, updated_at=now(), updated_by=$10
        WHERE app_id=$1 AND code=$2`,
        [appId, code, clamp(v.w, 0, 1000), clamp(v.p, 0, 100), !!v.on, clamp(v.t, 0, 3) | 0,
          typeof v.nt === 'string' ? v.nt.slice(0, 2000) : '', clamp(v.n, 0, 3) | 0, clamp(v.rv, 0, 3) | 0, userId]);
      counts.functions += r.rowCount;
    }
  }
  if (p.appW) for (const [id, w] of Object.entries(p.appW)) {
    counts.weights += (await c.query('UPDATE applications SET weight=$2, updated_at=now(), updated_by=$3 WHERE id=$1',
      [id, clamp(w, 0, 1000), userId])).rowCount;
  }
  if (p.rep) for (const [id, v] of Object.entries(p.rep)) {
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
  if (p.sch) {
    const n = Math.min(60, Math.max(1, parseInt(p.sch.n, 10) || 11));
    const plan = Array.isArray(p.sch.plan) && p.sch.plan.length === n ? p.sch.plan.map(v => clamp(v, 0, 100)) : null;
    const act = Array.isArray(p.sch.act) ? p.sch.act.slice(0, n).map(v => (v === null || v === undefined || v === '' ? null : clamp(v, 0, 100))) : null;
    await c.query(`UPDATE schedule SET start_date=$1, periods=$2, unit=$3, plan=$4, actual=$5, updated_at=now(), updated_by=$6 WHERE id=1`,
      [/^\d{4}-\d{2}-\d{2}$/.test(p.sch.start || '') ? p.sch.start : null, n, p.sch.unit === 'fortnight' ? 'fortnight' : 'month', plan, act, userId]);
    counts.schedule = 1;
  }
  return counts;
}

// Builds a payload in the original format (v3) so the old page can also read it.
export async function buildLegacy(c) {
  const fns = (await c.query('SELECT app_id, code, weight, progress, enabled, test_status, note, notif_status, review_status FROM functions')).rows;
  const f = {};
  for (const x of fns) {
    (f[x.app_id] ||= {})[x.code] = { w: x.weight, p: x.progress, on: x.enabled ? 1 : 0, t: x.test_status, nt: x.note, n: x.notif_status, rv: x.review_status };
  }
  const appW = Object.fromEntries((await c.query('SELECT id, weight FROM applications')).rows.map(a => [a.id, a.weight]));
  const rep = Object.fromEntries((await c.query('SELECT app_id, progress, status, note FROM app_reports')).rows
    .map(r => [r.app_id, { p: r.progress, rs: r.status, nt: r.note }]));
  const s = Object.fromEntries((await c.query('SELECT key, value FROM settings')).rows.map(r => [r.key, r.value]));
  const sch = (await c.query('SELECT * FROM schedule WHERE id=1')).rows[0] || {};
  return {
    v: 3, ts: Date.now(), mode: s['calc.weight_mode'] || 'fixed', appW,
    rep, nw: s['calc.notif_share'] ?? 0.1, repW: s['calc.reports_share'] ?? 0.15,
    sch: { start: sch.start_date ? new Date(sch.start_date).toISOString().slice(0, 10) : '', n: sch.periods || 11,
      unit: sch.unit || 'month', plan: sch.plan, act: sch.actual || [] },
    f, source: 'ets-backend',
  };
}

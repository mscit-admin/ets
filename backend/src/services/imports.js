// Per-department import of results sent by the teams (JSON exported from the original tracker page),
// held for two-step approval before they change the approved data.
import { summarize } from './calc.js';
import { allSettings } from './settings.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, +v || 0));
const int03 = v => clamp(v, 0, 3) | 0;
const text = v => (typeof v === 'string' ? v.slice(0, 2000) : '');

// legacy key → [column, normaliser]
const FN_FIELDS = {
  w: ['weight', v => clamp(v, 0, 1000)],
  p: ['progress', v => clamp(v, 0, 100)],
  on: ['enabled', v => !!v],
  t: ['test_status', int03],
  n: ['notif_status', int03],
  rv: ['review_status', int03],
  nt: ['note', text],
};
const REP_FIELDS = {
  p: ['progress', v => clamp(v, 0, 100)],
  rs: ['status', int03],
  nt: ['note', text],
};

const same = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : a === b);

// Differences between the file and the approved data.
//   target 'department': functions + application weights of one department (reports excluded)
//   target 'reports'   : reports of the given departments
// only: the application ids the uploader has in scope — others are ignored even inside the department (ETS-SEC-007).
export async function diffTarget(c, payload, target, deptIds, only) {
  if (target === 'department') return diffDepartment(c, payload, deptIds[0], { reports: false, only });
  const out = [];
  for (const d of deptIds) out.push(...await diffDepartment(c, payload, d, { functions: false, weights: false, only }));
  return out;
}

async function diffDepartment(c, payload, deptId, { functions = true, reports = true, weights = true, only } = {}) {
  const apps = (await c.query('SELECT id, weight FROM applications WHERE department_id=$1', [deptId])).rows.filter(a => only.has(a.id));
  const changes = [];
  for (const a of apps) {
    const fileFns = functions ? payload.f?.[a.id] : null;
    if (fileFns && typeof fileFns === 'object') {
      const rows = (await c.query('SELECT * FROM functions WHERE app_id=$1 AND removed_at IS NULL', [a.id])).rows;   // removed items cannot come back through a file
      const byCode = new Map(rows.map(r => [r.code, r]));
      for (const [code, v] of Object.entries(fileFns)) {
        const cur = byCode.get(code);
        if (!cur || !v || typeof v !== 'object') continue;          // unknown item: ignored
        for (const [k, [col, norm]] of Object.entries(FN_FIELDS)) {
          if (v[k] === undefined) continue;
          const nv = norm(v[k]);
          if (!same(cur[col], nv)) changes.push({ kind: 'function', app_id: a.id, function_id: cur.id, code, field: col, old_value: cur[col], new_value: nv });
        }
      }
    }
    const fileRep = reports ? payload.rep?.[a.id] : null;
    if (fileRep && typeof fileRep === 'object') {
      const cur = (await c.query('SELECT * FROM app_reports WHERE app_id=$1', [a.id])).rows[0];
      if (cur) {
        for (const [k, [col, norm]] of Object.entries(REP_FIELDS)) {
          if (fileRep[k] === undefined) continue;
          const nv = norm(fileRep[k]);
          if (!same(cur[col], nv)) changes.push({ kind: 'report', app_id: a.id, field: col, old_value: cur[col], new_value: nv });
        }
      }
    }
    if (weights && payload.appW && payload.appW[a.id] !== undefined) {
      const nv = clamp(payload.appW[a.id], 0, 1000);
      if (!same(a.weight, nv)) changes.push({ kind: 'weight', app_id: a.id, field: 'weight', old_value: a.weight, new_value: nv });
    }
  }
  return changes;
}

// Approved data with a list of changes laid over it (for "before → after" figures).
async function loadAll(c) {
  const [d, a, f, r] = await Promise.all([
    c.query('SELECT * FROM departments ORDER BY sort'),
    c.query('SELECT * FROM applications ORDER BY sort'),
    c.query('SELECT id, app_id, code, source, weight, progress, enabled, test_status, notif_status, review_status FROM functions WHERE removed_at IS NULL'),
    c.query('SELECT * FROM app_reports'),
  ]);
  return { departments: d.rows, applications: a.rows, functions: f.rows, reports: r.rows };
}

function overlay(data, changes) {
  const fns = new Map(data.functions.map(x => [x.id, { ...x }]));
  const reps = new Map(data.reports.map(x => [x.app_id, { ...x }]));
  const apps = new Map(data.applications.map(x => [x.id, { ...x }]));
  for (const ch of changes) {
    if (ch.kind === 'function' && fns.has(ch.function_id)) fns.get(ch.function_id)[ch.field] = ch.new_value;
    if (ch.kind === 'report' && reps.has(ch.app_id)) reps.get(ch.app_id)[ch.field] = ch.new_value;
    if (ch.kind === 'weight' && apps.has(ch.app_id)) apps.get(ch.app_id).weight = ch.new_value;
  }
  return { ...data, functions: [...fns.values()], reports: [...reps.values()], applications: [...apps.values()] };
}

export async function impactSummary(c, changes) {
  const settings = await allSettings();
  const data = await loadAll(c);
  const before = summarize({ ...data, settings });
  const after = summarize({ ...overlay(data, changes), settings });
  const changedApps = new Set(changes.map(ch => ch.app_id));
  const deptOf = new Map(data.applications.map(a => [a.id, a.department_id]));
  const depts = [...new Set([...changedApps].map(id => deptOf.get(id)))];
  const r1 = v => Math.round(v * 100) / 100;
  return {
    counts: {
      total: changes.length,
      functions: new Set(changes.filter(c => c.kind === 'function').map(c => c.function_id)).size,
      reports: changes.filter(c => c.kind === 'report').length,
      weights: changes.filter(c => c.kind === 'weight').length,
    },
    departments: depts.map(id => ({ id, before: r1(before.departments.find(x => x.id === id)?.pct || 0),
      after: r1(after.departments.find(x => x.id === id)?.pct || 0) })),
    project: { before: r1(before.total.pct), after: r1(after.total.pct) },
    applications: data.applications.filter(a => changedApps.has(a.id)).map(a => a.id).map(id => ({
      id,
      before: r1(before.applications.find(x => x.id === id).pct),
      after: r1(after.applications.find(x => x.id === id).pct),
    })),
  };
}

// Applies an approved batch. A change is applied only if the approved value is still the one the
// batch was compared against; otherwise it is skipped (someone changed it meanwhile) and reported.
export async function applyBatch(c, batchId, userId) {
  const changes = (await c.query('SELECT * FROM import_changes WHERE batch_id=$1 ORDER BY id', [batchId])).rows;
  let applied = 0, skipped = 0;
  for (const ch of changes) {
    if (!ALLOWED_FIELDS.has(ch.field)) continue;      // never interpolate an unexpected column name
    let cur;
    if (ch.kind === 'function') cur = (await c.query(`SELECT ${ch.field} AS v FROM functions WHERE id=$1 AND removed_at IS NULL FOR UPDATE`, [ch.function_id])).rows[0];
    else if (ch.kind === 'report') cur = (await c.query(`SELECT ${ch.field} AS v FROM app_reports WHERE app_id=$1 FOR UPDATE`, [ch.app_id])).rows[0];
    else cur = (await c.query('SELECT weight AS v FROM applications WHERE id=$1 FOR UPDATE', [ch.app_id])).rows[0];
    const ok = cur && same(cur.v, ch.old_value);
    if (ok) {
      if (ch.kind === 'function') await c.query(`UPDATE functions SET ${ch.field}=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [ch.function_id, ch.new_value, userId]);
      else if (ch.kind === 'report') await c.query(`UPDATE app_reports SET ${ch.field}=$2, updated_at=now(), updated_by=$3 WHERE app_id=$1`, [ch.app_id, ch.new_value, userId]);
      else await c.query('UPDATE applications SET weight=$2, updated_at=now(), updated_by=$3 WHERE id=$1', [ch.app_id, ch.new_value, userId]);
      applied++;
    } else skipped++;
    await c.query('UPDATE import_changes SET applied=$2, note=$3 WHERE id=$1',
      [ch.id, ok, ok ? null : 'value changed after the file was imported']);
  }
  return { applied, skipped };
}

// Column names used above come only from these allow-lists.
const ALLOWED_FIELDS = new Set([...Object.values(FN_FIELDS), ...Object.values(REP_FIELDS)].map(x => x[0]));

// Per-department import of results sent by the teams (JSON exported from the original tracker page),
// held for two-step approval before they change the approved data.
import { summarize, CALC_FUNCTIONS_SQL } from './calc.js';
import { allSettings } from './settings.js';
import { setDisabled, clearDisabled, currentReasons, hadReason, importReason } from './disable.js';
import { passConflict, passRuleErrors } from './passRule.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, +v || 0));
const int03 = v => clamp(v, 0, 3) | 0;
const int05 = v => clamp(v, 0, 5) | 0;        // review_status has six states (1.12.17, migration 023)
const text = v => (typeof v === 'string' ? v.slice(0, 2000) : '');

// legacy key → [column, normaliser]
const FN_FIELDS = {
  w: ['weight', v => clamp(v, 0, 1000)],
  p: ['progress', v => clamp(v, 0, 100)],
  on: ['enabled', v => !!v],
  t: ['test_status', int03],
  n: ['notif_status', int03],
  rv: ['review_status', int05],
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

// Items whose changes in a file break «نجح» needs 100 % (1.8.1): [{ app_id, function_id, code, name_ar, error,
// progress, test_status }] — the import's row errors, shown in the preview; a part of the file with any is refused.
export async function passErrors(c, changes) {
  const byFn = new Map();
  for (const ch of changes) {
    if (ch.kind !== 'function' || !['test_status', 'progress'].includes(ch.field)) continue;
    const x = byFn.get(ch.function_id) || { app_id: ch.app_id, function_id: ch.function_id, code: ch.code, changes: {} };
    x.changes[ch.field] = ch.new_value;
    byFn.set(ch.function_id, x);
  }
  if (!byFn.size) return [];
  const rows = (await c.query('SELECT id, name_ar, name_en, item_type, progress, test_status FROM functions WHERE id = ANY($1)', [[...byFn.keys()]])).rows;
  const cur = new Map(rows.map(r => [r.id, r]));
  return passRuleErrors([...byFn.values()].filter(x => cur.has(x.function_id)).map(x => {
    const r = cur.get(x.function_id);
    return { cur: r, changes: x.changes, app_id: x.app_id, function_id: x.function_id, code: x.code, name_ar: r.name_ar, name_en: r.name_en, item_type: r.item_type };
  }));
}

// Approved data with a list of changes laid over it (for "before → after" figures).
async function loadAll(c) {
  const [d, a, f, r] = await Promise.all([
    c.query('SELECT * FROM departments ORDER BY sort'),
    c.query('SELECT * FROM applications ORDER BY sort'),
    c.query(CALC_FUNCTIONS_SQL),          // with item_type: report items count in the reports % (1.8.0)
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
// A file has no reason for the functions it turns off: they get the reason 'import' with the batch reference
// (migration 013); functions it turns on lose their reason. reasons: the extra before → after values of those
// functions for their audit rows (not part of the stored result).
export async function applyBatch(c, batchId, userId) {
  const changes = (await c.query('SELECT * FROM import_changes WHERE batch_id=$1 ORDER BY id', [batchId])).rows;
  const b = (await c.query('SELECT filename FROM import_batches WHERE id=$1', [batchId])).rows[0];
  const reason = importReason(`#${batchId}${b?.filename ? ' ' + b.filename : ''}`);
  const reasons = [];
  const extra = (ch, before, after) => ['disabled_reason', 'disabled_note'].forEach(field => reasons.push({ kind: 'function', app_id: ch.app_id,
    function_id: ch.function_id, field, old_value: before?.[field] ?? null, new_value: after ? { disabled_reason: after.reason, disabled_note: after.note }[field] : null }));
  let applied = 0, skipped = 0;
  for (const ch of changes) {
    if (!ALLOWED_FIELDS.has(ch.field)) continue;      // never interpolate an unexpected column name
    let cur;
    if (ch.kind === 'function') cur = (await c.query(`SELECT ${ch.field} AS v FROM functions WHERE id=$1 AND removed_at IS NULL FOR UPDATE`, [ch.function_id])).rows[0];
    else if (ch.kind === 'report') cur = (await c.query(`SELECT ${ch.field} AS v FROM app_reports WHERE app_id=$1 FOR UPDATE`, [ch.app_id])).rows[0];
    else cur = (await c.query('SELECT weight AS v FROM applications WHERE id=$1 FOR UPDATE', [ch.app_id])).rows[0];
    const ok = cur && same(cur.v, ch.old_value);
    if (ok) {
      if (ch.kind === 'function' && ch.field === 'enabled') {
        if (ch.new_value === false) { await setDisabled(c, [ch.function_id], reason, userId); extra(ch, null, reason); }
        else {
          const before = (await currentReasons(c, [ch.function_id])).get(ch.function_id);
          await clearDisabled(c, [ch.function_id]);
          if (hadReason(before)) {
            extra(ch, before, null);
            if (before.duplicate_of?.length) reasons.push({ kind: 'function', app_id: ch.app_id, function_id: ch.function_id, field: 'duplicate_of', old_value: before.duplicate_of, new_value: [] });
          }
        }
      }
      if (ch.kind === 'function') await c.query(`UPDATE functions SET ${ch.field}=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [ch.function_id, ch.new_value, userId]);
      else if (ch.kind === 'report') await c.query(`UPDATE app_reports SET ${ch.field}=$2, updated_at=now(), updated_by=$3 WHERE app_id=$1`, [ch.app_id, ch.new_value, userId]);
      else await c.query('UPDATE applications SET weight=$2, updated_at=now(), updated_by=$3 WHERE id=$1', [ch.app_id, ch.new_value, userId]);
      applied++;
    } else skipped++;
    await c.query('UPDATE import_changes SET applied=$2, note=$3 WHERE id=$1',
      [ch.id, ok, ok ? null : 'value changed after the file was imported']);
  }
  // «نجح» needs 100 % (1.8.1), checked again with the values as they are now: an item the batch would leave «نجح»
  // below 100 % (something changed since the file was imported) keeps its values — its test status / progress
  // changes are put back and reported as skipped.
  const ruled = changes.filter(ch => ch.kind === 'function' && ['test_status', 'progress'].includes(ch.field));
  const ids = [...new Set(ruled.map(ch => ch.function_id))];
  if (ids.length) {
    const now = (await c.query('SELECT id, progress, test_status FROM functions WHERE id = ANY($1)', [ids])).rows.filter(passConflict);
    for (const f of now) {
      const back = (await c.query(`SELECT * FROM import_changes WHERE batch_id=$1 AND function_id=$2 AND applied AND field IN ('test_status', 'progress')`,
        [batchId, f.id])).rows;
      if (!back.length) continue;                     // already passed below 100 % before, not changed by this batch
      for (const ch of back) {
        await c.query(`UPDATE functions SET ${ch.field}=$2 WHERE id=$1`, [f.id, ch.old_value]);
        await c.query('UPDATE import_changes SET applied=false, note=$2 WHERE id=$1',
          [ch.id, back.some(x => x.field === 'test_status') ? 'pass_requires_100' : 'progress_below_100_while_passed']);
        applied--; skipped++;
      }
    }
  }
  return { applied, skipped, reasons };
}

// Column names used above come only from these allow-lists.
const ALLOWED_FIELDS = new Set([...Object.values(FN_FIELDS), ...Object.values(REP_FIELDS)].map(x => x[0]));

// Daily whole-project progress snapshots (table progress_snapshots), taken hourly by the API.
// They give the progress trend, the current pace and the forecast close date on the project status page.
import { query } from '../db/pool.js';
import { allSettings } from './settings.js';
import { summarize } from './calc.js';

export async function takeSnapshot() {
  const [d, a, f, rep, settings] = await Promise.all([
    query('SELECT * FROM departments ORDER BY sort'),
    query('SELECT * FROM applications ORDER BY sort'),
    query(`SELECT id, app_id, code, source, weight, progress, enabled, test_status, notif_status, review_status,
             (note <> '') AS has_note FROM functions WHERE removed_at IS NULL`),
    query('SELECT * FROM app_reports'),
    allSettings(),
  ]);
  const calc = summarize({ departments: d.rows, applications: a.rows, functions: f.rows, reports: rep.rows, settings });
  const on = f.rows.filter(x => x.enabled);
  const r2 = v => Math.round(v * 100) / 100;
  await query(`INSERT INTO progress_snapshots(day, total_pct, fn_pct, functions, done, tested_ok, notes, departments)
      VALUES (current_date, $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (day) DO UPDATE SET total_pct=EXCLUDED.total_pct, fn_pct=EXCLUDED.fn_pct, functions=EXCLUDED.functions,
        done=EXCLUDED.done, tested_ok=EXCLUDED.tested_ok, notes=EXCLUDED.notes, departments=EXCLUDED.departments, taken_at=now()`,
    [r2(calc.total.pct), r2(calc.total.fnPct), on.length, on.filter(x => +x.progress >= 100).length,
      calc.total.tests[2], on.filter(x => x.has_note).length,
      JSON.stringify(Object.fromEntries(calc.departments.map(x => [x.id, r2(x.pct)])))]);
}

// Snapshots of the last `days` days, oldest first.
export async function recentSnapshots(days = 400) {
  return (await query(`SELECT to_char(day,'YYYY-MM-DD') AS day, total_pct::float AS pct, departments
    FROM progress_snapshots WHERE day > current_date - $1::int ORDER BY day`, [days])).rows;
}

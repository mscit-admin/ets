// Schedule (S-curve) and project-timeline maths (extracted from routes/tracker.js, BE-1). Pure period arithmetic plus
// the schedule row read/shape and the persisted save. The routes (/schedule, /timeline) stay thin and call these.
import { query, tx } from '../db/pool.js';
import { sCurve } from './calc.js';
import { logAudit } from './logs.js';
import { publishChange } from './live.js';
import { bad } from '../utils/http.js';

export const DATE = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Start + k periods (months keep the day of month, clamped to the month's length), as 'YYYY-MM-DD'.
export function addPeriods(start, unit, k) {
  const d = new Date(start + 'T00:00:00Z');
  if (unit === 'month') {
    const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + k);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  } else d.setUTCDate(d.getUTCDate() + 14 * k);
  return d.toISOString().slice(0, 10);
}

// Number of periods from start to close: the smallest k whose period end reaches the close date.
export function periodsBetween(start, end, unit) {
  let k = 1;
  while (addPeriods(start, unit, k) < end && k <= 61) k++;
  return k;
}

export function scheduleJson(s) {
  const n = s.periods;
  return {
    start_date: DATE(s.start_date), end_date: DATE(s.end_date), periods: n, unit: s.unit,
    plan: Array.isArray(s.plan) && s.plan.length === n ? s.plan : sCurve(n),
    plan_is_default: !(Array.isArray(s.plan) && s.plan.length === n),
    actual: Array.from({ length: n }, (_, i) => (s.actual && s.actual[i] != null ? s.actual[i] : null)),
  };
}

// Periods follow the close date when one is set; arrays are cut to fit, the plan returns to the S-curve
// when the number of periods changes.
export function fitTimeline({ start_date, end_date, unit, periods, plan, actual }) {
  if (start_date && end_date) {
    if (end_date <= start_date) throw bad('end_before_start');
    periods = periodsBetween(start_date, end_date, unit);
    if (periods > 60) throw bad('timeline_too_long', { max: 60 });
  }
  if (!(Array.isArray(plan) && plan.length === periods)) plan = null;
  actual = Array.isArray(actual) ? actual.slice(0, periods) : [];
  return { start_date: start_date || null, end_date: (start_date && end_date) || null, unit, periods, plan, actual };
}

export async function saveSchedule(req, next) {
  const old = (await query('SELECT * FROM schedule WHERE id=1')).rows[0];
  await tx(async c => {
    await c.query(`UPDATE schedule SET start_date=$1, end_date=$2, periods=$3, unit=$4, plan=$5, actual=$6, updated_at=now(), updated_by=$7 WHERE id=1`,
      [next.start_date, next.end_date, next.periods, next.unit, next.plan, next.actual, req.user.id]);
    await logAudit(req, { db: c, action: 'update', entity: 'schedule', entityId: 1,
      oldValue: { start_date: DATE(old.start_date), end_date: DATE(old.end_date), periods: old.periods, unit: old.unit, plan: old.plan, actual: old.actual },
      newValue: next });
  });
  publishChange();          // schedule / timeline: dashboard curve, project status
}

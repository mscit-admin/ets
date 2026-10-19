// Project health — shared, byte for byte, by the server (backend/src/services/health.js: plan alerts P1–P4 of the
// notifications) and the browser (frontend/src/lib/health.js: project status page, dashboard). Keep the two files
// identical (a backend test compares them). Pure functions: no imports, no I/O.
//
// Schedule model (scheduleModel): planned S-curve vs actual over the project periods; x is measured in periods from
// the start date (0 = start, k = end of period k), so "today" can sit between periods.
//
// Health (projectHealth): schedule variance, delay in days, pace, forecast close date, department lag and the
// recommendations shown on the project status page.
//
//  planned now   = planned curve at today's date (interpolated between period ends)
//  deviation     = actual − planned now (percentage points)
//  SPI           = actual ÷ planned now
//  delay (days)  = today − the date on which the plan reached today's actual %   (earned schedule)
//  SPI(t)        = (that date − start) ÷ (today − start)      — time-based, stays meaningful late in the project
//  pace          = % per day over the last 30 days of daily snapshots (≥ 7 days of history),
//                  otherwise the average since the start
//  forecast      = today + remaining % ÷ pace;   variance = forecast − planned close
//  required pace = remaining % ÷ days left until the planned close
//  department    = on track while its % is at most riskGap points behind the plan, at risk up to delayGap points,
//                  delayed beyond (Settings → Notifications: notify.dept_risk_gap / notify.dept_delay_gap, 5 / 15)

export const sCurve = n => Array.from({ length: n }, (_, i) => { const t = (i + 1) / n; return +(100 * t * t * (3 - 2 * t)).toFixed(1); });

// Start date + k periods (local time). Months keep the day of month, clamped to the month's length (31 Jan + 1 → 28/29 Feb).
export function addPeriods(start, unit, k) {
  const d = new Date(start + 'T00:00:00');
  if (unit === 'month') {
    const day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + k);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  } else d.setDate(d.getDate() + 14 * k);
  return d;
}

const num = v => (v === null || v === undefined || v === '' ? null : +v);

export function scheduleModel(s, now = new Date()) {
  const n = s.periods;
  const plan = s.plan && s.plan.length === n ? s.plan.map(Number) : sCurve(n);
  const actual = Array.from({ length: n }, (_, i) => num(s.actual?.[i]));
  const P = [0, ...plan];                                    // P[k] = planned at the end of period k
  const bounds = s.start_date ? Array.from({ length: n + 1 }, (_, k) => addPeriods(s.start_date, s.unit, k)) : null;
  if (bounds && s.end_date) bounds[n] = new Date(s.end_date + 'T00:00:00');   // the last period ends on the close date
  // date ↔ x (periods from the start, fractional between period ends)
  const xOf = date => {
    const tt = date.getTime();
    if (tt <= bounds[0].getTime()) return 0;
    if (tt >= bounds[n].getTime()) return n;
    let k = 0; while (tt >= bounds[k + 1].getTime()) k++;
    return k + (tt - bounds[k]) / (bounds[k + 1] - bounds[k]);
  };
  const dateOf = x => {
    const k = Math.min(n - 1, Math.max(0, Math.floor(x)));
    return new Date(bounds[k].getTime() + (bounds[k + 1] - bounds[k]) * (x - k));
  };
  const xNow = bounds ? xOf(now) : null;
  const plannedAt = x => { const k = Math.floor(x); return k >= n ? P[n] : P[k] + (P[k + 1] - P[k]) * (x - k); };
  let lastActual = -1;
  actual.forEach((v, i) => { if (v !== null) lastActual = i; });
  const current = +s.current_pct || 0;
  const plannedNow = xNow === null ? null : plannedAt(xNow);
  const deviation = plannedNow === null ? null : current - plannedNow;
  const spi = plannedNow ? current / plannedNow : null;
  // Row of the period in progress (schedule table highlight).
  const curIdx = xNow === null ? Math.max(0, lastActual) : Math.min(n - 1, Math.max(0, Math.ceil(xNow) - 1));
  // x at which the plan reached a given %: the inverse of the planned curve (earned schedule)
  const xAtPlanned = v => {
    if (v <= 0) return 0;
    for (let k = 0; k < n; k++) if (P[k + 1] >= v) return P[k + 1] === P[k] ? k + 1 : k + (v - P[k]) / (P[k + 1] - P[k]);
    return n;
  };
  return { n, plan, actual, P, bounds, xNow, plannedNow, current, deviation, spi, curIdx,
    xOf: bounds ? xOf : null, dateOf: bounds ? dateOf : null, xAtPlanned };
}

const DAY = 864e5;
const MONTH = 30.44;

export const STATUS_COLOR = { done: 'green', on_track: 'green', at_risk: 'orange', delayed: 'red', overdue: 'red', not_started: 'gray', no_dates: 'gray' };

// % per day from a series of {day, pct}, over the last `window` days; null without at least `minSpan` days.
function paceFrom(trend, window = 30, minSpan = 7) {
  if (!trend || trend.length < 2) return null;
  const pts = trend.map(d => ({ t: new Date(d.day + 'T00:00:00').getTime(), pct: +d.pct }));
  const last = pts[pts.length - 1];
  const from = pts.find(p => p.t >= last.t - window * DAY) || pts[0];
  const span = (last.t - from.t) / DAY;
  if (span < minSpan) return null;
  return { perDay: Math.max(0, (last.pct - from.pct) / span), days: Math.round(span), change: last.pct - from.pct };
}

export const DEFAULT_GAPS = { riskGap: 5, delayGap: 15 };

// Status of one department from its gap to the plan (points; null without dates).
export function deptStatus(pct, gap, { riskGap = DEFAULT_GAPS.riskGap, delayGap = DEFAULT_GAPS.delayGap } = {}) {
  if (gap === null || gap === undefined) return null;
  return pct >= 99.95 ? 'done' : gap >= -riskGap ? 'on_track' : gap >= -delayGap ? 'at_risk' : 'delayed';
}

// m: scheduleModel(); st: /api/tracker/project-status; gaps: { riskGap, delayGap } (st.health_gaps when present).
export function projectHealth(m, st, now = new Date(), gaps = st.health_gaps || DEFAULT_GAPS) {
  const h = { ready: !!m.bounds, insights: [] };
  const c = st.counts;
  const actual = m.current;
  if (h.ready) {
    const start = m.bounds[0], end = m.bounds[m.n];
    h.start = start; h.end = end;
    h.totalDays = Math.round((end - start) / DAY);
    h.elapsedDays = Math.max(0, Math.round((now - start) / DAY));
    h.remainingDays = Math.round((end - now) / DAY);
    h.timePct = Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
    h.planned = m.plannedNow;
    h.deviation = m.deviation;
    h.spi = m.spi;
    const started = now > start;
    // earned schedule
    const esX = m.xAtPlanned(Math.min(actual, 100));
    h.esDate = m.dateOf(esX);
    h.delayDays = started ? Math.round((now - h.esDate) / DAY) : 0;
    h.spiT = started && now - start > DAY ? (h.esDate - start) / (now - start) : null;
    // pace and forecast
    const recent = paceFrom(st.trend);
    const avg = started && h.elapsedDays > 0 ? actual / h.elapsedDays : null;
    h.pace = recent ? recent.perDay : avg;
    h.paceSource = recent ? 'recent' : avg !== null ? 'average' : null;
    h.paceWindow = recent?.days;
    h.pacePerMonth = h.pace === null ? null : h.pace * MONTH;
    const left = Math.max(0, 100 - actual);
    h.forecast = actual >= 100 ? now : h.pace > 0.001 ? new Date(now.getTime() + (left / h.pace) * DAY) : null;
    h.forecastDelay = h.forecast ? Math.round((h.forecast - end) / DAY) : null;
    h.forecastByEs = h.spiT > 0.05 ? new Date(start.getTime() + (end - start) / h.spiT) : null;
    h.requiredPerMonth = h.remainingDays > 0 ? (left / h.remainingDays) * MONTH : null;
    h.paceRatio = h.requiredPerMonth && h.pacePerMonth ? h.requiredPerMonth / h.pacePerMonth : null;
    // overall status
    if (actual >= 99.95) h.status = 'done';
    else if (now > end) h.status = 'overdue';
    else if (!started) h.status = 'not_started';
    else if (h.delayDays <= 14 && (h.forecastDelay === null || h.forecastDelay <= 14)) h.status = 'on_track';
    else if (h.delayDays <= 45 && (h.spi === null || h.spi >= 0.85) && (h.forecastDelay === null || h.forecastDelay <= 60)) h.status = 'at_risk';
    else h.status = 'delayed';
  } else h.status = 'no_dates';

  // departments: gap to the plan and their own 30-day pace
  const plannedNow = h.ready ? h.planned : null;
  h.departments = st.departments.map(d => {
    const gap = plannedNow === null ? null : d.pct - plannedNow;
    const p = paceFrom(st.dept_trend?.[d.id]);
    const status = deptStatus(d.pct, gap, gaps);
    return { ...d, gap, change30: p ? p.change : null, status };
  }).sort((a, b) => (a.gap ?? a.pct) - (b.gap ?? b.pct));

  // recommendations, most important first
  const add = (level, key, params = {}) => h.insights.push({ level, key, params });
  if (!h.ready) add('blue', 'in_no_dates');
  else if (h.status === 'done') add('green', 'in_done');
  else if (h.status === 'not_started') add('blue', 'in_not_started', { date: h.start });
  else {
    if (h.status === 'overdue') add('red', 'in_overdue', { days: -h.remainingDays, pct: actual });
    if (h.delayDays > 14) add(h.status === 'delayed' || h.status === 'overdue' ? 'red' : 'orange', 'in_delay', { days: h.delayDays, date: h.esDate });
    else if (h.delayDays < -14) add('green', 'in_ahead', { days: -h.delayDays });
    else add('green', 'in_on_plan');
    if (h.forecast && h.forecastDelay > 14) add('red', 'in_forecast_late', { date: h.forecast, days: h.forecastDelay, pace: h.pacePerMonth });
    else if (h.forecast && h.forecastDelay > 0) add('orange', 'in_forecast_near', { date: h.forecast, days: h.forecastDelay, pace: h.pacePerMonth });
    else if (h.forecast) add('green', 'in_forecast_ok', { date: h.forecast, pace: h.pacePerMonth });
    else if (actual < 100) add('red', 'in_no_pace');
    if (h.paceRatio > 1.15 && h.remainingDays > 0) add(h.paceRatio > 2 ? 'red' : 'orange', 'in_required_pace', { req: h.requiredPerMonth, pace: h.pacePerMonth, x: h.paceRatio });
    if (h.paceSource === 'recent' && h.pace * MONTH < 0.5) add('red', 'in_stalled', { days: h.paceWindow });
    const late = h.departments.filter(d => d.status === 'delayed');
    if (late.length) add('red', 'in_dept_late', { list: late, n: late.length });
    else if (h.departments.some(d => d.status === 'at_risk')) add('orange', 'in_dept_risk', { list: h.departments.filter(d => d.status === 'at_risk') });
  }
  if (c.functions && c.not_started / c.functions > 0.2 && (h.ready ? h.timePct > 40 : true)) add('orange', 'in_not_started_fns', { n: c.not_started, p: (c.not_started / c.functions) * 100 });
  if (c.tests[3] > 0) add('red', 'in_tests_failed', { n: c.tests[3] });
  const untested = Math.max(0, c.done - c.tests[2] - c.tests[1]);
  if (untested > 0) add('orange', 'in_done_untested', { n: untested, done: c.done });
  if (c.notif_bad > 0) add('orange', 'in_notif_bad', { n: c.notif_bad });
  if (c.review_missing > 0) add('orange', 'in_review_missing', { n: c.review_missing });
  if (c.notes > 0) add('blue', 'in_notes', { n: c.notes });
  if (st.pending.edits + st.pending.imports > 0) add('blue', 'in_pending', { e: st.pending.edits, i: st.pending.imports });
  if (h.ready && h.paceSource === 'average') add('blue', 'in_pace_average');
  return h;
}

// Cumulative progress (S-curve): planned vs actual over the project periods, shared by the
// dashboard and the schedule page. x is measured in periods from the start date (0 = start,
// k = end of period k), so the curve starts at the origin and "today" can sit between periods.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { pc } from '../lib/format.js';
import { NumberCard } from './ui.jsx';

export const sCurve = n => Array.from({ length: n }, (_, i) => { const t = (i + 1) / n; return +(100 * t * t * (3 - 2 * t)).toFixed(1); });

// Start date + k periods. Months keep the day of month, clamped to the month's length (31 Jan + 1 → 28/29 Feb).
export function addPeriods(start, unit, k) {
  const d = new Date(start + 'T00:00:00');
  if (unit === 'month') {
    const day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + k);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  } else d.setDate(d.getDate() + 14 * k);
  return d;
}

const iso = x => '\u2066' + x + '\u2069';                 // keep '-10.1' / '57.2%' intact inside Arabic text
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
  return { n, plan, actual, P, bounds, xNow, plannedNow, current, deviation, spi, curIdx, lastActual,
    xOf: bounds ? xOf : null, dateOf: bounds ? dateOf : null, xAtPlanned, plannedAt };
}

function useShortDate() {
  const { lang } = useI18n();
  const loc = lang === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB';
  return (d, unit) => d.toLocaleDateString(loc, unit === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });
}

export function CurveKpis({ m }) {
  const { t, fmtDay } = useI18n();
  const dev = m.deviation;
  return (
    <div className="grid-cards">
      <NumberCard label={t('actual_now')} value={iso(pc(m.current) + '%')} sub={t('current_pct')} />
      <NumberCard label={t('planned_now')} value={m.plannedNow === null ? '—' : iso(pc(m.plannedNow) + '%')}
        sub={m.plannedNow === null ? t('set_start_date_hint') : fmtDay(new Date())} />
      <NumberCard label={t('deviation')} value={dev === null ? '—' : iso((dev >= 0 ? '+' : '') + pc(dev))}
        color={dev === null ? '' : dev >= 0 ? 'green' : 'red'}
        sub={dev === null ? '' : (dev >= 0 ? '▲ ' + t('ahead_of_plan') : '▼ ' + t('behind_plan')) + ' · ' + t('pts')} />
      <NumberCard label={t('spi')} value={m.spi === null ? '—' : iso(m.spi.toFixed(2))}
        color={m.spi === null ? '' : m.spi >= 1 ? 'green' : m.spi >= 0.9 ? 'orange' : 'red'} sub={t('spi_hint')} />
    </div>
  );
}

export function SCurveChart({ m, s, compact = false, trend = null }) {
  const { t, dir } = useI18n();
  const shortDate = useShortDate();
  const wrap = useRef(null);
  const [hover, setHover] = useState(null);
  const [W, setW] = useState(760);                           // drawn at the container's real width so text stays 11px
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { n, P, bounds, xNow } = m;
  const narrow = W < 520;
  const H = compact ? (narrow ? 220 : 250) : (narrow ? 260 : 320), L = 40, R = narrow ? 16 : 28, T = 26, B = 30;
  const X = x => L + (x * (W - L - R)) / n;
  const Y = v => T + (H - T - B) * (1 - Math.max(0, Math.min(100, v)) / 100);
  const pt = (x, v) => `${X(x).toFixed(1)},${Y(v).toFixed(1)}`;
  const label = k => (bounds ? shortDate(bounds[k], s.unit) : k === 0 ? t('start') : String(k));

  // Actual: origin, then every recorded period end, plus the daily snapshots when given.
  const rec = m.actual.map((v, i) => (v === null ? null : [i + 1, v])).filter(Boolean);
  const daily = trend && m.xOf ? trend.map(d => [m.xOf(new Date(d.day + 'T00:00:00')), d.pct]).filter(([x]) => xNow === null || x < xNow - 1e-6) : [];
  const act = [[0, 0], ...[...rec, ...daily].sort((a, b) => a[0] - b[0])];
  const lastPt = act.filter(([x]) => xNow === null || x <= xNow + 1e-9).pop();
  const nowPt = xNow === null ? null : [xNow, m.current];
  const areaPts = [...act.filter(([x]) => xNow === null || x <= xNow), ...(nowPt && lastPt && lastPt[0] < xNow ? [nowPt] : [])];
  const area = areaPts.length > 1
    ? `${pt(areaPts[0][0], 0)} ${areaPts.map(([x, v]) => pt(x, v)).join(' ')} ${pt(areaPts[areaPts.length - 1][0], 0)}` : null;
  const step = Math.max(1, Math.ceil((n + 1) / Math.max(2, Math.floor((W - L - R) / 80))));

  const onMove = e => {
    const r = wrap.current.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n, Math.round(((vx - L) / (W - L - R)) * n))));
  };
  const hv = hover === null ? null : { k: hover, plan: P[hover], act: hover === 0 ? 0 : m.actual[hover - 1] };

  return (
    <div className="scurve">
      <ul className="scurve-legend" aria-hidden="true">
        <li><svg width="26" height="10"><line x1="1" x2="25" y1="5" y2="5" className="sc-plan" /></svg>{t('planned')}</li>
        <li><svg width="26" height="10"><line x1="1" x2="25" y1="5" y2="5" className="sc-act" /></svg>{t('actual')}</li>
        {nowPt && <li><svg width="14" height="14"><circle cx="7" cy="7" r="5" className="sc-now" /></svg>{t('today')}</li>}
      </ul>
      <div className="scurve-plot" dir="ltr" ref={wrap} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="curve" role="img"
          aria-label={`${t('schedule_title')}: ${t('actual')} ${pc(m.current)}%${m.plannedNow === null ? '' : `, ${t('planned')} ${pc(m.plannedNow)}%`}`}>
          {[0, 25, 50, 75, 100].map(g => (
            <g key={g}>
              <line x1={L} x2={W - R} y1={Y(g)} y2={Y(g)} className={g ? 'sc-grid' : 'sc-base'} />
              <text x={L - 8} y={Y(g) + 4} textAnchor="end" className="axis">{g}%</text>
            </g>
          ))}
          {Array.from({ length: n + 1 }, (_, k) => k).filter(k => (k % step === 0 && n - k >= step * 0.6) || k === n).map(k => (
            <text key={k} x={X(k)} y={H - 9} textAnchor={k === 0 ? 'start' : k === n ? 'end' : 'middle'} className="axis">{label(k)}</text>
          ))}
          {hv && <line x1={X(hv.k)} x2={X(hv.k)} y1={T} y2={H - B} className="sc-cross" />}
          {nowPt && <>
            <line x1={X(xNow)} x2={X(xNow)} y1={T - 14} y2={H - B} className="sc-today" />
            <text x={X(xNow)} y={T - 16} textAnchor={xNow > n * 0.85 ? 'end' : xNow < n * 0.15 ? 'start' : 'middle'} className="axis strong">{t('today')}</text>
          </>}
          {area && <polygon points={area} className="sc-area" />}
          <polyline points={P.map((v, k) => pt(k, v)).join(' ')} className="sc-plan" />
          <polyline points={act.map(([x, v]) => pt(x, v)).join(' ')} className="sc-act" />
          {nowPt && lastPt && lastPt[0] < xNow && <line x1={X(lastPt[0])} y1={Y(lastPt[1])} x2={X(xNow)} y2={Y(m.current)} className="sc-act sc-link" />}
          {rec.map(([x, v]) => <circle key={x} cx={X(x)} cy={Y(v)} r="4" className="sc-dot" />)}
          {nowPt && m.plannedNow !== null && <circle cx={X(xNow)} cy={Y(m.plannedNow)} r="4.5" className="sc-dot-plan" />}
          {nowPt && <>
            <circle cx={X(xNow)} cy={Y(m.current)} r="6.5" className="sc-now" />
            <text x={X(xNow) + (xNow > n * 0.85 ? -12 : 12)} y={Y(m.current) + (m.current > (m.plannedNow ?? 0) ? -8 : 16)}
              textAnchor={xNow > n * 0.85 ? 'end' : 'start'} className="sc-val">{pc(m.current)}%</text>
          </>}
          {hv && <>
            <circle cx={X(hv.k)} cy={Y(hv.plan)} r="4.5" className="sc-dot-plan" />
            {hv.act !== null && <circle cx={X(hv.k)} cy={Y(hv.act)} r="5" className="sc-dot" />}
          </>}
        </svg>
        {hv && (
          <div className="sc-tip" dir={dir} style={hv.k > n / 2 ? { right: `${100 - (X(hv.k) / W) * 100}%`, marginRight: 10 } : { left: `${(X(hv.k) / W) * 100}%`, marginLeft: 10 }}>
            <b>{bounds ? label(hv.k) : hv.k === 0 ? t('start') : t('period_n', { n: hv.k })}</b>
            <div><i className="key plan" />{t('planned')} <span className="num">{pc(hv.plan)}%</span></div>
            <div><i className="key act" />{t('actual')} <span className="num">{hv.act === null ? '—' : pc(hv.act) + '%'}</span></div>
            {hv.act !== null && <div className="muted">{t('deviation')} <span className="num">{iso((hv.act - hv.plan >= 0 ? '+' : '') + pc(hv.act - hv.plan))}</span></div>}
          </div>
        )}
      </div>
    </div>
  );
}

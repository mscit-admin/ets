// Small hand-built SVG donut for the dashboard's Users-overview (components/UsersOverview.jsx), in the same
// inline-SVG spirit as the ERP wheel (components/ErpWheel.jsx): no chart library. Each slice is an annular sector
// carrying an SVG <title> tooltip (label · count · percentage), and becomes a focusable link when it is given an
// href (e.g. the "online" slice → /users?tab=online). A legend lists every slice like the ERP wheel's legend.
// The figure is direction-agnostic; the legend flows with the page direction, so it reads correctly in RTL and LTR.
import { useId } from 'react';
import { useNavigate } from 'react-router-dom';
import { pc } from '../lib/format.js';
import { useI18n } from '../i18n/index.jsx';

const SIZE = 132, C = SIZE / 2, R_OUT = 60, R_IN = 38;
const TAU = Math.PI * 2;

const pt = (r, frac) => {       // frac 0..1 clockwise from the top
  const a = frac * TAU - Math.PI / 2;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
};
const f2 = n => n.toFixed(2);
function sectorPath(from, to) {
  const large = to - from > 0.5 ? 1 : 0;
  const [x0, y0] = pt(R_OUT, from), [x1, y1] = pt(R_OUT, to);
  const [x2, y2] = pt(R_IN, to), [x3, y3] = pt(R_IN, from);
  return `M${f2(x0)} ${f2(y0)}A${R_OUT} ${R_OUT} 0 ${large} 1 ${f2(x1)} ${f2(y1)}` +
    `L${f2(x2)} ${f2(y2)}A${R_IN} ${R_IN} 0 ${large} 0 ${f2(x3)} ${f2(y3)}Z`;
}

export function Donut({ title, segments, centerLabel }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const slices = segments.filter(s => s.value > 0);
  const total = segments.reduce((a, s) => a + s.value, 0);
  const titleId = useId();
  const tip = s => `${s.label}: ${s.value} (${pc(total ? (s.value / total) * 100 : 0)}%)`;

  let acc = 0;
  const shapes = slices.map(s => {
    const frac = s.value / total;
    const from = acc, to = acc + frac;
    acc = to;
    // a lone full-circle slice cannot be drawn as an arc (start === end): draw the whole ring instead
    const node = slices.length === 1
      ? <path d={`M${C} ${C - R_OUT}A${R_OUT} ${R_OUT} 0 1 1 ${f2(C - 0.01)} ${f2(C - R_OUT)}` +
          `M${C} ${C - R_IN}A${R_IN} ${R_IN} 0 1 0 ${f2(C - 0.01)} ${f2(C - R_IN)}Z`}
          fill={s.color} fillRule="evenodd" className="donut-seg" />
      : <path d={sectorPath(from, to)} fill={s.color} className="donut-seg" />;
    const content = <><title>{tip(s)}</title>{node}</>;
    return s.href
      ? <a key={s.key} href={s.href} aria-label={tip(s)} className="donut-link"
          onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(s.href); }}>{content}</a>
      : <g key={s.key} role="img" aria-label={tip(s)}>{content}</g>;
  });

  return (
    <div className="donut-chart">
      <h4 className="donut-title" id={titleId}>{title}</h4>
      <div className="donut-row">
        <svg className="donut-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-labelledby={titleId}>
          {total > 0 ? shapes : <circle cx={C} cy={C} r={(R_OUT + R_IN) / 2} fill="none" stroke="var(--gray-200)" strokeWidth={R_OUT - R_IN} />}
          <text className="donut-total" x={C} y={C - 2} textAnchor="middle" direction="ltr">{total}</text>
          <text className="donut-sub" x={C} y={C + 15} textAnchor="middle">{centerLabel}</text>
        </svg>
        <ul className="donut-legend">
          {segments.map(s => {
            const row = (
              <>
                <span className="dl-key"><i className="dl-sw" style={{ background: s.color }} />{s.label}</span>
                <b className="num">{s.value}</b>
              </>
            );
            return (
              <li key={s.key}>
                {s.href && s.value > 0
                  ? <a href={s.href} className="dl-link" onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(s.href); }}>{row}</a>
                  : row}
              </li>
            );
          })}
        </ul>
      </div>
      {total === 0 && <p className="muted small donut-empty">{t('uo_empty')}</p>}
    </div>
  );
}

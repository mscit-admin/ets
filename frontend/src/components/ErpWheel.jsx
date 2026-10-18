// ERP module wheel (dashboard): one segment per module around a hub with the overall progress.
// Modules and the department → module mapping: lib/erpModules.js. Pure inline SVG.
//   active segment  — department tracked by the system: icon, name, % (tone of lib/format.js pctTone) and a thin
//                     progress arc on the outer rim; a link to the department page (keyboard focusable)
//   faded segment   — module not activated, or outside the reader's scope (no % shown)
// Values glide to their new level when they change (live updates); no motion with prefers-reduced-motion.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { pc, pctGradient, pctTone } from '../lib/format.js';
import { Icon } from './Icon.jsx';

const SIZE = 560, C = SIZE / 2;
const R_HUB = 86, R_HUB_RING = 95, R_IN = 108, R_OUT = 236, R_RIM = 248, R_TEXT = 171;
const GAP = 6;                                       // white gap between segments (px, constant width)
// Corporate blue / navy fills of the active segments, alternating around the wheel (white text ≥ 4.5:1 on each).
const FILLS = ['#1b3a66', '#24508a', '#2c62a6'];

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Number that glides from its previous value to the new one (ease-out, 700 ms).
function useTween(target, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    if (reduceMotion() || start === target) { from.current = target; setV(target); return undefined; }
    let raf = 0;
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - (1 - k) ** 3;
      const x = start + (target - start) * e;
      from.current = x; setV(x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

// true for a moment after the value changed (not on first render): a soft highlight of the % chip.
function useFlash(value) {
  const [on, setOn] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return undefined;
    prev.current = value;
    setOn(true);
    const h = setTimeout(() => setOn(false), 1600);
    return () => clearTimeout(h);
  }, [value]);
  return on;
}

// Geometry: angles in degrees clockwise from the top; mirrored (counter-clockwise) in Arabic.
const geo = mirror => {
  const pt = (r, a) => {
    const rad = (a * Math.PI) / 180;
    return [C + (mirror ? -1 : 1) * r * Math.sin(rad), C - r * Math.cos(rad)];
  };
  const sweep = mirror ? 0 : 1;
  const f = n => n.toFixed(2);
  const arc = (r, a0, a1) => {
    const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1);
    return `M${f(x0)} ${f(y0)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} ${sweep} ${f(x1)} ${f(y1)}`;
  };
  const wedge = (a0, a1) => {
    const po = (GAP / 2 / R_OUT) * (180 / Math.PI), pi = (GAP / 2 / R_IN) * (180 / Math.PI);
    const [ax, ay] = pt(R_OUT, a0 + po), [bx, by] = pt(R_OUT, a1 - po);
    const [cx, cy] = pt(R_IN, a1 - pi), [dx, dy] = pt(R_IN, a0 + pi);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M${f(ax)} ${f(ay)}A${R_OUT} ${R_OUT} 0 ${large} ${sweep} ${f(bx)} ${f(by)}L${f(cx)} ${f(cy)}` +
      `A${R_IN} ${R_IN} 0 ${large} ${1 - sweep} ${f(dx)} ${f(dy)}Z`;
  };
  return { pt, arc, wedge };
};

const linesOf = (m, lang) => m[`lines_${lang}`] || [m[`name_${lang}`] || m.name_ar];

function Segment({ m, i, a0, a1, g, lang, t, onOpen }) {
  const active = m.state === 'active';
  const pct = useTween(active ? m.pct : 0);
  const flash = useFlash(active ? Math.round(m.pct * 10) : null);
  const mid = (a0 + a1) / 2;
  const [x, y] = g.pt(R_TEXT, mid);
  const lines = linesOf(m, lang);
  const name = m[`name_${lang}`] || m.name_ar;
  const tone = pctTone(pct);
  const rimPad = (GAP / 2 / R_RIM) * (180 / Math.PI);
  const rimStart = a0 + rimPad, rimEnd = a1 - rimPad;
  const rimTo = rimStart + ((rimEnd - rimStart) * Math.max(0, Math.min(100, pct))) / 100;
  const lineH = 15, nameTop = lines.length > 1 ? -12 : -4;

  const body = (
    <>
      <path className="erp-wedge" d={g.wedge(a0, a1)} style={active ? { fill: FILLS[i % FILLS.length] } : undefined} />
      {active && <path className="erp-rim-track" d={g.arc(R_RIM, rimStart, rimEnd)} />}
      {active && pct > 0.05 && <path className="erp-rim" d={g.arc(R_RIM, rimStart, rimTo)} style={{ stroke: tone.stroke }} />}
      <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} className="erp-content">
        <g transform={`translate(-12 ${nameTop - 34})`}><Icon name={m.icon} size={24} /></g>
        <text className="erp-name" textAnchor="middle" y={nameTop}>
          {lines.map((l, k) => <tspan key={k} x="0" dy={k ? lineH : 0}>{l}</tspan>)}
        </text>
        {active ? (
          <g transform={`translate(0 ${nameTop + (lines.length - 1) * lineH + 22})`} className={'erp-chip' + (flash ? ' flash' : '')}>
            <rect x="-34" y="-14" width="68" height="27" rx="13.5" />
            <text className="erp-pct" textAnchor="middle" y="6" direction="ltr" style={{ fill: tone.text }}>{pc(pct)}%</text>
          </g>
        ) : (
          <text className="erp-state" textAnchor="middle" y={nameTop + (lines.length - 1) * lineH + 21}>
            {m.state === 'out_of_scope' ? t('erp_out_of_scope') : t('erp_not_activated')}
          </text>
        )}
      </g>
    </>
  );

  if (!active) {
    const label = `${name}: ${m.state === 'out_of_scope' ? t('erp_out_of_scope') : t('erp_not_activated')}`;
    return (
      <g className={'erp-seg off' + (m.state === 'out_of_scope' ? ' scope' : '')} role="img" aria-label={label}>
        <title>{label}</title>
        {body}
      </g>
    );
  }
  const deptName = m.dept[`name_${lang}`] || m.dept.name_ar;
  const label = t('erp_seg_label', { module: name, dept: deptName, pct: pc(m.pct) });
  const href = '/department/' + encodeURIComponent(m.dept.id);
  return (
    <a className="erp-seg on" href={href} aria-label={label}
      onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onOpen(href); }}>
      <title>{label}</title>
      {body}
    </a>
  );
}

function Hub({ total, t }) {
  const v = useTween(total);
  const tone = pctTone(v);
  const c = 2 * Math.PI * R_HUB_RING;
  return (
    <g className="erp-hub" role="img" aria-label={`${t('erp_overall')}: ${pc(total)}%`}>
      <circle className="erp-hub-bg" cx={C} cy={C} r={R_HUB} />
      <circle className="erp-hub-track" cx={C} cy={C} r={R_HUB_RING} />
      <circle className="erp-hub-ring" cx={C} cy={C} r={R_HUB_RING} style={{ stroke: tone.stroke }}
        strokeDasharray={`${(c * Math.max(0, Math.min(100, v))) / 100} ${c}`} transform={`rotate(-90 ${C} ${C})`} />
      <text className="erp-hub-mark" x={C} y={C - 36} textAnchor="middle" direction="ltr">ERP</text>
      <text className="erp-hub-pct" x={C} y={C + 10} textAnchor="middle" direction="ltr" style={{ fill: tone.text }}>{pc(v)}%</text>
      <text className="erp-hub-label" x={C} y={C + 36} textAnchor="middle">{t('erp_overall')}</text>
    </g>
  );
}

export function ErpWheel({ segments, total }) {
  const { t, lang, dir } = useI18n();
  const navigate = useNavigate();
  const g = geo(dir === 'rtl');
  const n = segments.length;
  const step = 360 / n;
  return (
    <svg className="erp-wheel" viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label={t('erp_wheel_title')}>
      {segments.map((m, i) => (
        <Segment key={m.key} m={m} i={i} a0={i * step - step / 2} a1={i * step + step / 2} g={g} lang={lang} t={t} onOpen={navigate} />
      ))}
      <Hub total={total} t={t} />
    </svg>
  );
}

// Legend: what an active / faded segment means, and the colour scale of the percentages.
export function ErpLegend({ segments }) {
  const { t, dir } = useI18n();
  const scoped = segments.some(s => s.state === 'out_of_scope');
  return (
    <div className="erp-legend">
      <ul className="erp-keys">
        <li><i className="sw on" />{t('erp_active')}</li>
        <li><i className="sw off" />{t('erp_not_activated')}</li>
        {scoped && <li><i className="sw off scope" />{t('erp_out_of_scope')}</li>}
      </ul>
      <div className="erp-scale">
        <span className="muted small">{t('erp_scale')}</span>
        <div className="erp-scale-bar" style={{ background: pctGradient(dir === 'rtl' ? 'left' : 'right') }} aria-hidden="true" />
        <div className="erp-scale-ends small"><span>{t('erp_scale_low')} <bdi dir="ltr">0%</bdi></span><span>{t('erp_scale_high')} <bdi dir="ltr">100%</bdi></span></div>
      </div>
    </div>
  );
}

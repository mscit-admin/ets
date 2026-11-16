// ERP module wheel (dashboard): one segment per module around a hub with the overall progress.
// Modules and the department → module mapping: lib/erpModules.js; geometry and fills: lib/wheelGeometry.js. Pure inline SVG.
//   active segment  — department tracked by the system: icon, name, % (tone of lib/format.js pctTone) and a thin
//                     progress arc on the outer rim; a link to the department page (keyboard focusable)
//   faded segment   — module not activated, or outside the reader's scope (no % shown)
// Values glide to their new level when they change (live updates); no motion with prefers-reduced-motion.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { pc, pctGradient, pctTone } from '../lib/format.js';
import { Icon } from './Icon.jsx';
import { C, FILLS, R_HUB, R_HUB_RING, R_RIM, R_TEXT, SIZE, geo, linesOf, rimAngles, segmentAngles, weightedAngles } from '../lib/wheelGeometry.js';

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

function Segment({ m, i, a0, a1, g, lang, t, onOpen }) {
  const active = m.state === 'active';
  const pct = useTween(active ? m.pct : 0);
  const flash = useFlash(active ? Math.round(m.pct * 10) : null);
  const mid = (a0 + a1) / 2;
  const [x, y] = g.pt(R_TEXT, mid);
  const lines = linesOf(m, lang);
  const name = m[`name_${lang}`] || m.name_ar;
  const tone = pctTone(pct);
  const { rimStart, rimEnd, rimTo } = rimAngles(a0, a1, pct);
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

function Hub({ total, t, mark = 'ERP', label }) {
  const v = useTween(total);
  const tone = pctTone(v);
  const c = 2 * Math.PI * R_HUB_RING;
  const lbl = label || t('erp_overall');
  return (
    <g className="erp-hub" role="img" aria-label={`${lbl}: ${pc(total)}%`}>
      <circle className="erp-hub-bg" cx={C} cy={C} r={R_HUB} />
      <circle className="erp-hub-track" cx={C} cy={C} r={R_HUB_RING} />
      <circle className="erp-hub-ring" cx={C} cy={C} r={R_HUB_RING} style={{ stroke: tone.stroke }}
        strokeDasharray={`${(c * Math.max(0, Math.min(100, v))) / 100} ${c}`} transform={`rotate(-90 ${C} ${C})`} />
      <text className="erp-hub-mark" x={C} y={C - 36} textAnchor="middle" direction="ltr">{mark}</text>
      <text className="erp-hub-pct" x={C} y={C + 10} textAnchor="middle" direction="ltr" style={{ fill: tone.text }}>{pc(v)}%</text>
      <text className="erp-hub-label" x={C} y={C + 36} textAnchor="middle">{lbl}</text>
    </g>
  );
}

export function ErpWheel({ segments, total }) {
  const { t, lang, dir } = useI18n();
  const navigate = useNavigate();
  const g = geo(dir === 'rtl');
  const n = segments.length;
  return (
    <svg className="erp-wheel" viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label={t('erp_wheel_title')}>
      {segments.map((m, i) => (
        <Segment key={m.key} m={m} i={i} a0={segmentAngles(i, n)[0]} a1={segmentAngles(i, n)[1]} g={g} lang={lang} t={t} onOpen={navigate} />
      ))}
      <Hub total={total} t={t} />
    </svg>
  );
}

// ---- Project phases wheel ----
// Same geometry, tween and colours (pctTone) as the system wheel, but each segment's ANGULAR WIDTH is proportional to
// the phase weight (not equal), the arc shows the phase completion, and the hub shows the project overall %. A phase at
// 0 % (or with the `auto` phase following a 0 % system) renders faded, like an inactive module. Phases carry no links.
export const PHASE_ICON_FALLBACK = 'circle';

// Wrap a phase name to fit the segment: greedily pack words into lines of at most `maxChars`, capped at `maxLines`;
// if words are left over the last line ends with an ellipsis (the full name stays in the tooltip and the list below).
function projLines(name, maxChars, maxLines) {
  const words = String(name || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let w = 0; w < words.length; w++) {
    const next = cur ? cur + ' ' + words[w] : words[w];
    if (next.length <= maxChars || !cur) { cur = next; continue; }
    lines.push(cur); cur = words[w];
    if (lines.length === maxLines) { cur = ''; break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const shown = lines.join(' ').split(/\s+/).filter(Boolean).length;
  if (shown < words.length && lines.length) lines[lines.length - 1] += '…';
  return lines;
}

function ProjectSegment({ ph, i, a0, a1, g, lang }) {
  const eff = +ph.effective_pct || 0;
  const active = eff > 0.05 && a1 - a0 > 0.01;
  const pct = useTween(active ? eff : 0);
  const flash = useFlash(active ? Math.round(eff * 10) : null);
  const mid = (a0 + a1) / 2;
  const [x, y] = g.pt(R_TEXT, mid);
  const name = ph[`name_${lang}`] || ph.name_ar;
  const tone = pctTone(pct);
  const { rimStart, rimEnd, rimTo } = rimAngles(a0, a1, pct);
  const label = `${name}: ${pc(eff)}%`;
  // Fit the content to the segment's angular width so neighbouring labels never overlap: a narrow (low-weight)
  // segment shows only its icon and %, a wider one adds the name on one to three short lines.
  const arc = ((a1 - a0) * Math.PI / 180) * R_TEXT;
  const showName = arc > 70;
  // cap the line length so even a wide segment keeps short lines (a long tangential line would run off the drawing)
  const lines = showName ? projLines(name, Math.min(15, Math.max(6, Math.floor(arc / 7.4))), 3) : [];
  const iconSize = 22, lineH = 13.5;
  const stackH = iconSize + (lines.length ? lines.length * lineH + 6 : 0) + 26;
  const top = -stackH / 2;
  const nameY = top + iconSize + 6 + lineH - 3;
  const chipY = top + stackH - 11;
  return (
    <g className={'erp-seg' + (active ? ' on static' : ' off')} role="img" aria-label={label}>
      <title>{label}</title>
      <path className="erp-wedge" d={g.wedge(a0, a1)} style={active ? { fill: FILLS[i % FILLS.length] } : undefined} />
      {active && <path className="erp-rim-track" d={g.arc(R_RIM, rimStart, rimEnd)} />}
      {active && pct > 0.05 && <path className="erp-rim" d={g.arc(R_RIM, rimStart, rimTo)} style={{ stroke: tone.stroke }} />}
      {a1 - a0 > 9 && (
        <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} className="erp-content">
          <g transform={`translate(${-iconSize / 2} ${top.toFixed(1)})`}><Icon name={ph.icon || PHASE_ICON_FALLBACK} size={iconSize} /></g>
          {showName && (
            <text className="erp-name proj-name" textAnchor="middle" y={nameY.toFixed(1)}>
              {lines.map((l, k) => <tspan key={k} x="0" dy={k ? lineH : 0}>{l}</tspan>)}
            </text>
          )}
          {active ? (
            <g transform={`translate(0 ${chipY.toFixed(1)})`} className={'erp-chip' + (flash ? ' flash' : '')}>
              <rect x="-30" y="-13" width="60" height="25" rx="12.5" />
              <text className="erp-pct" textAnchor="middle" y="5" direction="ltr" style={{ fill: tone.text }}>{pc(pct)}%</text>
            </g>
          ) : (
            <text className="erp-state" textAnchor="middle" y={chipY.toFixed(1)} direction="ltr">{pc(eff)}%</text>
          )}
        </g>
      )}
    </g>
  );
}

export function ProjectWheel({ phases, total }) {
  const { t, lang, dir } = useI18n();
  const g = geo(dir === 'rtl');
  const angles = weightedAngles(phases.map(p => +p.weight || 0));
  return (
    <svg className="erp-wheel" viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label={t('erp_col_project')}>
      {phases.map((ph, i) => (
        <ProjectSegment key={ph.key} ph={ph} i={i} a0={angles[i][0]} a1={angles[i][1]} g={g} lang={lang} t={t} />
      ))}
      <Hub total={total} t={t} mark={t('proj_hub_mark')} label={t('proj_overall')} />
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

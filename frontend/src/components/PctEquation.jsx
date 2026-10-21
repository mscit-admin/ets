// Application progress as a visible, weighted equation (header of the application page):
//   functions % × (1 − reports_share)  +  reports % × reports_share  =  application %
// Two small input rings feed one large result ring; the weights and contributions sit on the connectors.
// Every number comes from the API (application.calc: fnPct, reportPct and the shares fnShare / reportShare the server
// used for calc.pct — services/calc.js), nothing is recomputed here (lib/equation.js, shared with the mobile app).
// Since 1.8.0 the reports ring is the application's report items with its reports track; an application without
// reports shows functions × 100 %, one whose counted items are all reports shows reports × 100 %.
// All three rings are coloured by pctTone(): a continuous red → orange → amber → green scale.
import { useI18n } from '../i18n/index.jsx';
import { pc, pctGradient, pctTone } from '../lib/format.js';
import { Icon } from './Icon.jsx';
import { equation, repParts, share } from '../lib/equation.js';

function EqRing({ value, size, stroke, big }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, +value || 0));
  const tone = pctTone(v);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="eq-ring" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone.bg} strokeWidth={stroke} />
      {v > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="eq-arc" stroke={tone.stroke} strokeWidth={stroke}
        strokeLinecap="round" strokeDasharray={`${(c * v) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
      <text x="50%" y="53%" dominantBaseline="middle" textAnchor="middle" className={big ? 'eq-ring-text big' : 'eq-ring-text'}
        style={{ fontSize: Math.round(size * (big ? 0.2 : 0.19)), fill: big ? tone.text : undefined }}>{pc(v)}%</text>
    </svg>
  );
}

function Stats({ calc }) {
  const { t } = useI18n();
  const n = calc.items || { function: calc.count, report: 0 };
  return (
    <div className="eq-stats">
      <div><span>{t('weight')}</span><b className="num">{pc(calc.weight)}</b></div>
      <div className="it-stat it-function" title={t('it_hint_function')}><Icon name="item_function" size={13} /><span>{t('it_functions')}</span><b className="num">{n.function}</b></div>
      <div className="it-stat it-report" title={t('it_hint_report')}><Icon name="item_report" size={13} /><span>{t('it_reports')}</span><b className="num">{n.report}</b></div>
      <div className="ok"><span>{t('ts_2')}</span><b className="num">{calc.tests[2]}</b></div>
      <div className="bad"><span>{t('ts_3')}</span><b className="num">{calc.tests[3]}</b></div>
    </div>
  );
}

function Note({ e }) {
  const { t } = useI18n();
  if (!e.withFunctions) return <div className="eq-note">{t('eq_only_reports')}</div>;
  return e.withReports
    ? <div className="eq-note">{t('app_pct_note', { fw: '\u0001', rw: '\u0002' }).split(/([\u0001\u0002])/).map((x, i) =>
        x === '\u0001' ? <span key={i} className="num">{share(e.fw)}</span>
          : x === '\u0002' ? <span key={i} className="num">{share(e.rw)}</span> : x)}</div>
    : <div className="eq-note">{t('eq_no_reports')}</div>;
}

function Input({ label, sub, value, w, part }) {
  return (
    <div className="eqb-row">
      <EqRing value={value} size={70} stroke={7} />
      <div className="eqb-lbl"><span>{label}</span>{sub && <small className="eqb-sub">{sub}</small>}</div>
      <div className="eqb-conn">
        {w != null
          ? <span className="eqb-chip num">× {share(w)} <i>=</i> <b>{pc(part)}%</b></span>
          : <span className="eqb-chip num">× 100%</span>}
      </div>
    </div>
  );
}

// Colour legend of the ring scale: 0 % (critical) … 100 % (good), drawn from the same helper.
function Legend() {
  const { t, dir } = useI18n();
  return (
    <div className="eq-legend" aria-hidden="true">
      <div className="eq-legend-bar" style={{ background: pctGradient(dir === 'rtl' ? 'left' : 'right') }} />
      <div className="eq-legend-labels">
        <span><b className="num">0%</b> {t('eq_critical')}</span>
        <span>{t('eq_fair')}</span>
        <span>{t('eq_good')} <b className="num">100%</b></span>
      </div>
    </div>
  );
}

export function PctEquation({ calc, settings }) {
  const { t } = useI18n();
  const e = equation(calc, settings);
  return (
    <div className="app-head card eq-card">
      <div className="eqb-main">
        <div className={'eqb-inputs' + (e.both ? ' two' : '')}>
          {e.withFunctions && <Input label={t('fn_progress')} value={e.fn} w={e.both ? e.fw : null} part={e.fnPart} />}
          {e.both && <div className="eqb-plus"><span>+</span></div>}
          {e.withReports && <Input label={t('report_progress')} sub={repParts(t, calc)} value={e.rep} w={e.both ? e.rw : null} part={e.repPart} />}
        </div>
        <div className="eqb-join"><span className="eq-sign">=</span></div>
        <div className="eqb-result">
          <EqRing value={e.result} size={150} stroke={14} big />
          <div className="eqb-rlabel">{t('app_progress')}</div>
        </div>
      </div>
      <Legend />
      <div className="eqb-foot">
        <Note e={e} />
        <Stats calc={calc} />
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { Alert, Card, ErrorBox, Field, Loading, NumberCard, PageHeader, toast, useLoad } from '../components/ui.jsx';

const sCurve = n => Array.from({ length: n }, (_, i) => { const t = (i + 1) / n; return +(100 * t * t * (3 - 2 * t)).toFixed(1); });

function periodLabel(s, i, t, fmtDay) {
  if (!s.start_date) return t('period_n', { n: i + 1 });
  const d = new Date(s.start_date + 'T00:00:00');
  if (s.unit === 'month') d.setMonth(d.getMonth() + i + 1); else d.setDate(d.getDate() + 14 * (i + 1));
  return fmtDay(d);
}

// Index of the current period: by date when a start date exists, else the last period with an actual value.
function currentIndex(s) {
  if (s.start_date) {
    const days = (Date.now() - new Date(s.start_date + 'T00:00:00').getTime()) / 864e5;
    const k = s.unit === 'month' ? Math.ceil(days / 30.44) : Math.ceil(days / 14);
    return Math.min(s.periods - 1, Math.max(0, k - 1));
  }
  let last = 0;
  s.actual.forEach((v, i) => { if (v !== null && v !== '') last = i; });
  return last;
}

function Curve({ plan, actual, cur, labels }) {
  const { t } = useI18n();
  const n = plan.length, W = 760, H = 300, L = 46, R = 18, T = 14, B = 34;
  const X = i => L + (n > 1 ? (i * (W - L - R)) / (n - 1) : 0);
  const Y = v => T + (H - T - B) * (1 - Math.max(0, Math.min(100, v)) / 100);
  const line = arr => arr.map((v, i) => (v === null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  const act = actual.map(v => (v === null || v === '' ? null : +v));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="curve" role="img" aria-label={t('schedule_title')}>
      {[0, 25, 50, 75, 100].map(g => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={Y(g)} y2={Y(g)} stroke="var(--gray-200)" />
          <text x={L - 8} y={Y(g) + 4} textAnchor="end" className="axis">{g}%</text>
        </g>
      ))}
      <line x1={X(cur)} x2={X(cur)} y1={T} y2={H - B} stroke="var(--gray-400)" strokeDasharray="4 4" />
      <polyline points={line(plan)} fill="none" stroke="var(--gray-500)" strokeWidth="2" strokeDasharray="6 4" />
      <polyline points={line(act)} fill="none" stroke="var(--primary-blue)" strokeWidth="2.6" />
      {act.map((v, i) => v !== null && <circle key={i} cx={X(i)} cy={Y(v)} r="4" fill="var(--primary-blue)" />)}
      {labels.map((l, i) => (n <= 14 || i % Math.ceil(n / 12) === 0) && (
        <text key={i} x={X(i)} y={H - 12} textAnchor="middle" className="axis">{i + 1}</text>
      ))}
      <g className="curve-legend" transform={`translate(${L + 10},${T + 8})`}>
        <line x1="0" x2="22" y1="0" y2="0" stroke="var(--gray-500)" strokeWidth="2" strokeDasharray="6 4" />
        <text x="28" y="4" className="axis">{t('planned')}</text>
        <line x1="90" x2="112" y1="0" y2="0" stroke="var(--primary-blue)" strokeWidth="2.6" />
        <text x="118" y="4" className="axis">{t('actual')}</text>
      </g>
    </svg>
  );
}

export default function Schedule() {
  const { t, errText, fmtDay } = useI18n();
  const { data, error, loading, reload } = useLoad(() => api.get('/tracker/schedule'), []);
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (data) setS({ ...data, plan: data.plan_is_default ? null : data.plan }); }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!s) return null;

  const plan = s.plan && s.plan.length === s.periods ? s.plan : sCurve(s.periods);
  const actual = Array.from({ length: s.periods }, (_, i) => (s.actual[i] ?? null));
  const cur = currentIndex({ ...s, actual });
  let li = -1;
  for (let i = cur; i >= 0; i--) if (actual[i] !== null && actual[i] !== '') { li = i; break; }
  const av = li >= 0 ? +actual[li] : null;
  const pvl = li >= 0 ? plan[li] : 0;
  const dev = li < 0 ? null : av - pvl;
  const spi = li < 0 || !pvl ? null : av / pvl;
  const can = data.can.sch;
  const labels = plan.map((_, i) => periodLabel(s, i, t, fmtDay));

  const setPeriods = n => {
    const p = Math.min(60, Math.max(1, n | 0));
    setS({ ...s, periods: p, plan: null, actual: actual.slice(0, p) });
  };
  const setCell = (key, i, v) => {
    const arr = key === 'plan' ? [...plan] : [...actual];
    arr[i] = v === '' ? (key === 'plan' ? 0 : null) : Math.min(100, Math.max(0, +v));
    setS({ ...s, [key]: arr });
  };
  const save = async () => {
    setErr(null);
    try {
      await api.put('/tracker/schedule', { start_date: s.start_date || null, periods: s.periods, unit: s.unit,
        plan: s.plan ? s.plan.map(Number) : null, actual: actual.map(v => (v === null || v === '' ? null : +v)) });
      toast(t('saved')); reload();
    } catch (e) { setErr(e); }
  };

  return (
    <div>
      <PageHeader title={t('schedule_title')} icon="curve">
        {can && <button className="btn btn-primary btn-sm" onClick={save}>{t('save')}</button>}
      </PageHeader>
      {err && <Alert>{errText(err)}</Alert>}
      <div className="grid-cards">
        <NumberCard label={t('current_pct')} value={pc(data.current_pct) + '%'} />
        <NumberCard label={t('planned')} value={pc(plan[cur]) + '%'} sub={labels[cur]} />
        <NumberCard label={t('actual')} value={av === null ? '—' : pc(av) + '%'} />
        <NumberCard label={t('deviation')} value={dev === null ? '—' : (dev >= 0 ? '+' : '') + pc(dev)} color={dev === null ? '' : dev >= 0 ? 'green' : 'red'} />
        <NumberCard label={t('spi')} value={spi === null ? '—' : spi.toFixed(2)} color={spi === null ? '' : spi >= 1 ? 'green' : spi >= 0.9 ? 'orange' : 'red'} />
      </div>
      <Card><Curve plan={plan} actual={actual} cur={cur} labels={labels} /></Card>
      <Card title={t('details')}>
        <div className="form-grid">
          <Field label={t('start_date')}><input className="input" type="date" value={s.start_date || ''} disabled={!can} onChange={e => setS({ ...s, start_date: e.target.value })} /></Field>
          <Field label={t('periods')}><input className="input" type="number" min={1} max={60} value={s.periods} disabled={!can} onChange={e => setPeriods(+e.target.value)} /></Field>
          <Field label={t('unit')}>
            <select className="input" value={s.unit} disabled={!can} onChange={e => setS({ ...s, unit: e.target.value })}>
              <option value="month">{t('unit_month')}</option><option value="fortnight">{t('unit_fortnight')}</option>
            </select>
          </Field>
          {can && <div className="field"><span className="field-label">&nbsp;</span><button className="btn btn-default" onClick={() => setS({ ...s, plan: null })}>{t('reset_curve')}</button></div>}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('period')}</th><th className="num-col">{t('planned')} %</th><th className="num-col">{t('actual')} %</th><th className="num-col">{t('deviation')}</th>{can && <th />}</tr></thead>
            <tbody>
              {plan.map((p, i) => {
                const a = actual[i];
                return (
                  <tr key={i} className={i === cur ? 'row-current' : ''}>
                    <td><span className="num">{i + 1}</span> · <span className="muted">{labels[i]}</span></td>
                    <td className="num-col"><input className="input input-sm num-input" type="number" min={0} max={100} step={0.1} value={p} disabled={!can} onChange={e => setCell('plan', i, e.target.value)} aria-label={t('planned')} /></td>
                    <td className="num-col"><input className="input input-sm num-input" type="number" min={0} max={100} step={0.1} value={a ?? ''} disabled={!can} onChange={e => setCell('actual', i, e.target.value)} aria-label={t('actual')} /></td>
                    <td className="num-col num">{a === null || a === '' ? '—' : pc(+a - p)}</td>
                    {can && <td className="end"><button className="btn btn-default btn-xs" onClick={() => setCell('actual', i, Math.round(data.current_pct * 10) / 10)} title={t('use_current')}>{t('use_current')}</button></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

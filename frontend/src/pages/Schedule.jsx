import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { Alert, Card, ErrorBox, Field, Loading, PageHeader, toast, useLoad } from '../components/ui.jsx';
import { CurveKpis, SCurveChart, addPeriods, scheduleModel } from '../components/SCurve.jsx';

function periodLabel(s, i, t, fmtDay) {
  return s.start_date ? fmtDay(addPeriods(s.start_date, s.unit, i + 1)) : t('period_n', { n: i + 1 });
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

  const m = scheduleModel({ ...s, current_pct: data.current_pct });
  const { plan, actual, curIdx: cur } = m;
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
      <CurveKpis m={m} />
      <Card className="curve-card"><SCurveChart m={m} s={s} /></Card>
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

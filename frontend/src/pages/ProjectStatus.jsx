// Project status: is the project on schedule, when will it close at the current pace, which departments
// are behind, and what needs a decision. Calculations: lib/health.js.
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { projectHealth, STATUS_COLOR } from '../lib/health.js';
import { Icon } from '../components/Icon.jsx';
import { SCurveChart, scheduleModel } from '../components/SCurve.jsx';
import { Card, ErrorBox, Indicator, Loading, NumberCard, PageHeader, useLoad } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { useLiveUpdates } from '../lib/live.js';

const iso = x => '⁦' + x + '⁩';
const STATUS_ICON = { done: 'check', on_track: 'check', at_risk: 'alert', delayed: 'alert', overdue: 'flag', not_started: 'clock', no_dates: 'info' };
const LEVEL_ICON = { red: 'alert', orange: 'alert', green: 'check', blue: 'info' };

export function StatusBadge({ status, big }) {
  const { t } = useI18n();
  return (
    <span className={'status-badge ' + STATUS_COLOR[status] + (big ? ' big' : '')}>
      <Icon name={STATUS_ICON[status]} size={big ? 18 : 14} /> {t('st_' + status)}
    </span>
  );
}

// Formats an insight's parameters (dates, percentages, department lists) and returns its sentence.
export function useInsightText() {
  const { t, nm, fmtDay } = useI18n();
  return i => {
    const p = {};
    for (const [k, v] of Object.entries(i.params)) {
      if (v instanceof Date) p[k] = fmtDay(v);
      else if (Array.isArray(v)) p[k] = v.slice(0, 4).map(d => `${nm(d)} (${iso((d.gap >= 0 ? '+' : '') + pc(d.gap))})`).join('، ');
      else if (typeof v === 'number') p[k] = iso(k === 'x' ? v.toFixed(1) : k === 'n' || k === 'days' || k === 'e' || k === 'i' || k === 'done' ? String(Math.round(v)) : pc(v));
      else p[k] = v;
    }
    return t(i.key, p);
  };
}

export default function ProjectStatus() {
  const { t, nm, fmtDay, dir } = useI18n();
  const { data, error, loading, refresh } = useLoad(o => api.get('/tracker/project-status', o), []);
  useLiveUpdates(refresh);
  const text = useInsightText();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const st = data;
  const m = scheduleModel({ ...st.schedule, current_pct: st.total.pct });
  const h = projectHealth(m, st);
  const c = st.counts;
  const days = n => t('n_days', { n: iso(Math.abs(n)) });
  const txt = x => <bdi dir={dir}>{x}</bdi>;           // words / dates inside the LTR number style
  const signed = v => iso((v >= 0 ? '+' : '') + pc(v));

  return (
    <div>
      <PageHeader title={t('status_title')} sub={t('status_sub')} icon="pulse">
        {st.can.timeline && <Link to="/settings#timeline" className="btn btn-default btn-sm"><Icon name="calendar" size={14} /> {t('project_timeline')}</Link>}
        <ExportButton report="project_status" />
      </PageHeader>

      <Card className="status-hero">
        <div className="sh-top">
          <StatusBadge status={h.status} big />
          <div className="sh-headline">{text(h.insights[0])}</div>
        </div>
        {h.ready && (
          <div className="sh-bars">
            <div className="sh-row">
              <span className="sh-label">{t('time_elapsed')}</span>
              <div className="sh-bar"><i className="time" style={{ width: h.timePct + '%' }} /></div>
              <b className="num">{pc(h.timePct)}%</b>
              <span className="muted small">{t('days_of', { a: iso(Math.min(h.elapsedDays, h.totalDays)), b: iso(h.totalDays) })}</span>
            </div>
            <div className="sh-row">
              <span className="sh-label">{t('work_done')}</span>
              <div className="sh-bar"><i className="work" style={{ width: Math.min(100, m.current) + '%' }} /><b className="mark" style={{ insetInlineStart: h.planned + '%' }} title={t('planned_now')} /></div>
              <b className="num">{pc(m.current)}%</b>
              <span className="muted small">{t('planned_now')}: {iso(pc(h.planned) + '%')}</span>
            </div>
            <div className="sh-dates">
              <span><Icon name="calendar" size={13} /> {t('project_start')}: <b>{fmtDay(h.start)}</b></span>
              <span>{t('today')}: <b>{fmtDay(new Date())}</b></span>
              <span><Icon name="flag" size={13} /> {t('project_end')}: <b>{fmtDay(h.end)}</b></span>
            </div>
          </div>
        )}
      </Card>

      {h.ready && <>
        <h2 className="section-title">{t('sec_schedule_perf')}</h2>
        <div className="grid-cards">
          <NumberCard label={t('planned_now')} value={iso(pc(h.planned) + '%')} sub={t('planned_now_hint')} />
          <NumberCard label={t('actual_now')} value={iso(pc(m.current) + '%')} sub={t('current_pct')} />
          <NumberCard label={t('deviation')} value={signed(h.deviation)} color={h.deviation >= 0 ? 'green' : 'red'}
            sub={(h.deviation >= 0 ? '▲ ' + t('ahead_of_plan') : '▼ ' + t('behind_plan')) + ' · ' + t('pts')} />
          <NumberCard label={t('schedule_delay')} value={txt(h.delayDays !== 0 ? days(h.delayDays) : t('none'))}
            color={h.delayDays > 45 ? 'red' : h.delayDays > 14 ? 'orange' : 'green'}
            sub={h.delayDays > 0 ? t('delay_hint', { date: fmtDay(h.esDate) }) : h.delayDays < 0 ? t('ahead_hint') : t('on_plan_hint')} />
          <NumberCard label={t('spi')} value={h.spi === null ? '—' : iso(h.spi.toFixed(2))}
            color={h.spi === null ? '' : h.spi >= 0.95 ? 'green' : h.spi >= 0.85 ? 'orange' : 'red'} sub={t('spi_hint')} />
          <NumberCard label={t('spi_t')} value={h.spiT === null ? '—' : iso(h.spiT.toFixed(2))}
            color={h.spiT === null ? '' : h.spiT >= 0.95 ? 'green' : h.spiT >= 0.85 ? 'orange' : 'red'} sub={t('spi_t_hint')} />
        </div>

        <h2 className="section-title">{t('sec_forecast')}</h2>
        <div className="grid-cards">
          <NumberCard label={t('forecast_end')} value={h.forecast ? txt(fmtDay(h.forecast)) : '—'}
            color={h.forecastDelay === null || h.forecastDelay > 14 ? 'red' : h.forecastDelay > 0 ? 'orange' : 'green'}
            sub={h.forecastDelay === null ? t('no_pace') : h.forecastDelay > 0 ? t('after_plan_by', { d: days(h.forecastDelay) }) : t('before_plan_by', { d: days(h.forecastDelay) })} />
          <NumberCard label={t('current_pace')} value={h.pacePerMonth === null ? '—' : iso(pc(h.pacePerMonth) + '%')}
            sub={h.paceSource === 'recent' ? t('pace_recent', { n: iso(h.paceWindow) }) : t('pace_average')} />
          <NumberCard label={t('required_pace')} value={h.requiredPerMonth === null ? '—' : iso(pc(h.requiredPerMonth) + '%')}
            color={h.paceRatio === null ? '' : h.paceRatio > 1.15 ? 'red' : 'green'}
            sub={h.paceRatio ? t('pace_ratio', { x: iso(h.paceRatio.toFixed(1)) }) : t('per_month')} />
          <NumberCard label={t('days_remaining')} value={h.remainingDays >= 0 ? iso(h.remainingDays) : '—'}
            color={h.remainingDays < 0 ? 'red' : ''} sub={h.remainingDays < 0 ? t('past_close_by', { d: days(h.remainingDays) }) : t('until_close')} />
          <NumberCard label={t('forecast_by_spi')} value={h.forecastByEs ? txt(fmtDay(h.forecastByEs)) : '—'} sub={t('forecast_by_spi_hint')} />
        </div>
      </>}

      <Card className="curve-card" title={t('schedule_title')}
        actions={<Link to="/schedule" className="btn btn-default btn-xs">{t('details')}</Link>}>
        <SCurveChart m={m} s={st.schedule} trend={st.trend} />
      </Card>

      <div className="grid-2">
        <Card title={<span className="link-row"><Icon name="flag" size={15} /> {t('recommendations')}</span>}>
          <ul className="insights">
            {h.insights.map((i, k) => (
              <li key={k} className={'lvl-' + i.level}><Icon name={LEVEL_ICON[i.level]} size={16} /><span>{text(i)}</span></li>
            ))}
          </ul>
        </Card>
        <Card title={t('dept_vs_plan')}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('departments')}</th><th className="num-col">{t('actual')}</th><th className="num-col">{t('gap_to_plan')}</th><th className="num-col">{t('change_30d')}</th><th>{t('status')}</th></tr></thead>
              <tbody>
                {h.departments.map(d => (
                  <tr key={d.id}>
                    <td><Link to={'/department/' + d.id} className="link-row"><Icon name={d.emblem} size={15} /> {nm(d)}</Link></td>
                    <td className="num-col num">{pc(d.pct)}%</td>
                    <td className={'num-col num ' + (d.gap === null ? '' : d.gap >= 0 ? 'green-text' : 'red-text')}>{d.gap === null ? '—' : signed(d.gap)}</td>
                    <td className="num-col num">{d.change30 === null ? '—' : signed(d.change30)}</td>
                    <td>{d.status ? <StatusBadge status={d.status} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <h2 className="section-title">{t('sec_quality')}</h2>
      <div className="grid-2">
        <Card title={t('functions_state')}>
          <div className="stack-bar">
            {[['done', 'green'], ['in_progress', 'blue'], ['not_started', 'gray']].map(([k, col]) => c[k] > 0 && (
              <div key={k} className={'seg ' + col} style={{ width: (c[k] / (c.functions || 1)) * 100 + '%' }} title={`${t('fs_' + k)}: ${c[k]}`} />
            ))}
          </div>
          <ul className="legend">
            {[['done', 'green'], ['in_progress', 'blue'], ['not_started', 'gray']].map(([k, col]) => (
              <li key={k}><Indicator color={col}>{t('fs_' + k)}</Indicator><b className="num">{c[k]} <span className="muted">({pc((c[k] / (c.functions || 1)) * 100)}%)</span></b></li>
            ))}
          </ul>
        </Card>
        <Card title={t('quality_flags')}>
          <div className="kv wide">
            <div><span>{t('ts_2')} / {t('ts_1')}</span><span className="num">{c.tests[2]} / {c.tests[1]}</span></div>
            <div><span>{t('ts_3')}</span><span className={'num ' + (c.tests[3] ? 'red-text' : '')}>{c.tests[3]}</span></div>
            <div><span>{t('ts_0')}</span><span className="num">{c.tests[0]}</span></div>
            <div><span>{t('with_notes')}</span><span className="num">{c.notes}</span></div>
            <div><span>{t('notif_status')}: {t('ns_3')}</span><span className={'num ' + (c.notif_bad ? 'red-text' : '')}>{c.notif_bad}</span></div>
            <div><span>{t('review_status')}: {t('rv_2')}</span><span className="num">{c.review_missing}</span></div>
            {c.reports > 0 && <div><span>{t('reports_title')}{c.report_items > 0 && <span className="muted small"> ({t('eq_rep_items', { n: c.report_items })})</span>}</span>
              <span className="num">{pc(c.reports_pct)}% · {c.reports_done}/{c.reports}</span></div>}
            <div><span>{t('pending_approvals')}</span><span className="num">{st.pending.edits + st.pending.imports}</span></div>
          </div>
        </Card>
      </div>
      <p className="muted small">{t('status_method')}</p>
    </div>
  );
}

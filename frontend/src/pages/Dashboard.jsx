import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { pc, pctTone, TEST_COLORS } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';
import { useLiveUpdates } from '../lib/live.js';
import { STANDARD_MODULES, wheelSegments } from '../lib/erpModules.js';
import { ErpLegend, ErpWheel } from '../components/ErpWheel.jsx';
import { LiveBadge } from '../components/LiveBadge.jsx';
import { Icon } from '../components/Icon.jsx';
import { CurveKpis, SCurveChart, scheduleModel } from '../components/SCurve.jsx';
import { projectHealth } from '../lib/health.js';
import { StatusBadge, useInsightText } from './ProjectStatus.jsx';
import { Card, ErrorBox, Indicator, Loading, PageHeader, Pct, ProgressBar, useLoad } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { UsersOverview } from '../components/UsersOverview.jsx';

export default function Dashboard() {
  const { t, nm, fmtDay } = useI18n();
  const { user, can } = useAuth();
  const sum = useLoad(o => api.get('/tracker/summary', o), []);
  const pendingL = useLoad(o => api.get('/imports/pending-count', o), []);
  const editsL = useLoad(o => api.get('/approvals/pending-count', o), []);
  const psL = useLoad(o => api.get('/tracker/project-status', o), []);
  // another user changed data → reload the wheel, the cards and the notices (scoped endpoints, no page reload)
  useLiveUpdates(() => { sum.refresh(); pendingL.refresh(); editsL.refresh(); psL.refresh(); });
  const { data, error, loading } = sum;
  const pending = pendingL.data, edits = editsL.data, ps = psL.data;
  const insightText = useInsightText();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { total, departments, applications, counts, settings } = data;
  const segments = wheelSegments(departments, { fullScope: !!user?.fullScope });
  const activeSegs = segments.filter(x => x.state === 'active');
  const activeStd = segments.filter(x => x.state === 'active' && STANDARD_MODULES.some(m => m.key === x.key)).length;
  const lowest = [...applications].sort((a, b) => a.calc.pct - b.calc.pct).slice(0, 5);
  const tests = total.tests;
  const testedTotal = tests.reduce((a, b) => a + b, 0) || 1;

  return (
    <div>
      <PageHeader title={t('nav_home')} sub={settings.weight_mode === 'auto' ? t('weight_mode_auto') : t('weight_mode_fixed')} icon="home">
        <ExportButton report="summary" />
        <ExportButton report="functions_all" label={t('export_functions_all')} />
      </PageHeader>

      {pending?.pending > 0 && (
        <Link to="/imports?status=pending" className="alert orange block-link">
          <b>{t('pending_notice', { n: pending.pending })}</b>
          {pending.awaiting_me > 0 && <> · {t('awaiting_you', { n: pending.awaiting_me })}</>}
        </Link>
      )}
      {edits?.awaiting_me > 0 && (
        <Link to="/approvals" className="alert orange block-link"><b>{t('edits_awaiting_you', { n: edits.awaiting_me })}</b></Link>
      )}
      <section className="card erp-card" aria-labelledby="erp-title">
        <div className="card-head">
          <h3 id="erp-title">{t('erp_wheel_title')}</h3>
          <div className="card-actions"><LiveBadge /></div>
        </div>
        <div className="card-body erp-body">
          <div className="erp-figure"><ErpWheel segments={segments} total={total.pct} /></div>
          <div className="erp-side">
            <div className="erp-overall">
              <span className="nc-label">{t('overall_progress')}</span>
              <b className="num" style={{ color: pctTone(total.pct).text }}>{pc(total.pct)}%</b>
              <span className="nc-sub">{pc(total.fnPct)}% {t('functions_only')}</span>
            </div>
            <p className="muted small erp-count">{t('erp_active_count', { n: activeStd, of: STANDARD_MODULES.length })}</p>
            <ul className="erp-list">
              {activeSegs.map(m => {
                const tone = pctTone(m.pct);
                return (
                  <li key={m.key}>
                    <Link to={'/department/' + m.dept.id} className="erp-row">
                      <span className="erp-row-icon"><Icon name={m.icon} size={16} /></span>
                      <span className="erp-row-name"><b>{nm(m)}</b><span className="muted small">{nm(m.dept)}</span></span>
                      <span className="erp-row-bar" aria-hidden="true"><i style={{ width: Math.min(100, m.pct) + '%', background: tone.stroke }} /></span>
                      <b className="num erp-row-pct" style={{ color: tone.text }}>{pc(m.pct)}%</b>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <ErpLegend segments={segments} />
          </div>
        </div>
        <div className="erp-stats">
          <div className="erp-stat">
            <span className="nc-label">{t('functions_counted')}</span>
            <b className="nc-value">{counts.functions}</b>
            {counts.report_items > 0 && <span className="nc-sub">{t('plus_report_items', { n: counts.report_items })}</span>}
          </div>
          <div className="erp-stat green">
            <span className="nc-label">{t('completed_functions')}</span>
            <b className="nc-value green">{counts.done}</b>
          </div>
          <div className="erp-stat blue">
            <span className="nc-label">{t('tested_ok')}</span>
            <b className="nc-value blue">{tests[2]}</b>
            <span className="nc-sub">{tests[1]} {t('ts_1')} · {tests[3]} {t('ts_3')}</span>
          </div>
          <div className="erp-stat orange">
            <span className="nc-label">{t('with_notes')}</span>
            <b className="nc-value orange">{counts.notes}</b>
          </div>
        </div>
      </section>

      {ps && (() => {
        const m = scheduleModel({ ...ps.schedule, current_pct: ps.total.pct });
        const h = projectHealth(m, ps);
        return (
          <Card className="curve-card" title={t('schedule_title')}
            actions={<Link to="/status" className="btn btn-default btn-xs">{t('view_status')}</Link>}>
            <Link to="/status" className="health-strip mb">
              <StatusBadge status={h.status} big />
              <span className="hs-text">{insightText(h.insights[0])}</span>
              {h.ready && (
                <span className="hs-facts">
                  <span>{t('forecast_end')}: <b>{h.forecast ? fmtDay(h.forecast) : '—'}</b></span>
                  <span>{t('project_end')}: <b>{fmtDay(h.end)}</b></span>
                </span>
              )}
            </Link>
            <CurveKpis m={m} />
            <SCurveChart m={m} s={ps.schedule} trend={ps.trend} compact />
          </Card>
        );
      })()}

      {can('usr') && <UsersOverview />}

      <div className="grid-2">
        <Card title={t('lowest_apps')}>
          <table className="table">
            <tbody>
              {lowest.map(a => (
                <tr key={a.id}>
                  <td><Link to={'/app/' + a.id} className="link-row"><Icon name={a.icon} size={15} /> {nm(a)}</Link></td>
                  <td className="w-40"><ProgressBar value={a.calc.pct} /></td>
                  <td className="end"><Pct value={a.calc.pct} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title={t('test_status_dist')}>
          <div className="stack-bar">
            {tests.map((n, i) => n > 0 && (
              <div key={i} className={'seg ' + TEST_COLORS[i]} style={{ width: (n / testedTotal) * 100 + '%' }} title={`${t('ts_' + i)}: ${n}`} />
            ))}
          </div>
          <ul className="legend">
            {tests.map((n, i) => (
              <li key={i}><Indicator color={TEST_COLORS[i]}>{t('ts_' + i)}</Indicator><b className="num">{n}</b></li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

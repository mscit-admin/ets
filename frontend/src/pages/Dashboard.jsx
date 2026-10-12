import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { pc, TEST_COLORS } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Card, ErrorBox, Indicator, Loading, NumberCard, PageHeader, Pct, ProgressBar, Ring, useLoad } from '../components/ui.jsx';

export default function Dashboard() {
  const { t, nm } = useI18n();
  const { data, error, loading } = useLoad(() => api.get('/tracker/summary'), []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { total, departments, applications, counts, settings } = data;
  const lowest = [...applications].sort((a, b) => a.calc.pct - b.calc.pct).slice(0, 5);
  const tests = total.tests;
  const testedTotal = tests.reduce((a, b) => a + b, 0) || 1;

  return (
    <div>
      <PageHeader title={t('nav_home')} sub={settings.weight_mode === 'auto' ? t('weight_mode_auto') : t('weight_mode_fixed')} icon="home" />

      <div className="grid-cards">
        <div className="number-card hero">
          <Ring value={total.pct} size={104} />
          <div>
            <div className="nc-label">{t('overall_progress')}</div>
            <div className="nc-sub">{pc(total.fnPct)}% {t('functions_only')}</div>
          </div>
        </div>
        <NumberCard label={t('functions_counted')} value={counts.functions} />
        <NumberCard label={t('completed_functions')} value={counts.done} color="green" />
        <NumberCard label={t('tested_ok')} value={tests[2]} sub={`${tests[1]} ${t('ts_1')} · ${tests[3]} ${t('ts_3')}`} color="blue" />
        <NumberCard label={t('with_notes')} value={counts.notes} color="orange" />
      </div>

      <h2 className="section-title">{t('departments')}</h2>
      <div className="grid-depts">
        {departments.map(d => (
          <Link key={d.id} to={'/department/' + d.id} className="dept-card">
            <div className="dept-top">
              <span className="dept-icon" style={{ color: d.color, background: d.color + '1a' }}><Icon name={d.emblem} size={22} /></span>
              <div className="dept-name">
                <b>{nm(d)}</b>
                <span>{t('apps_count', { n: d.apps })}{d.is_base ? ' · ' + t('base_dept') : ''}</span>
              </div>
              <div className="dept-pct"><Pct value={d.pct} /></div>
            </div>
            <ProgressBar value={d.pct} />
            <div className="dept-foot">
              <span>{t('weight')}: <b className="num">{pc(d.weight)}</b></span>
              <span>{t('dept_share')}: <b className="num">{pc(total.weight ? (d.weight / total.weight) * 100 : 0)}%</b></span>
            </div>
          </Link>
        ))}
      </div>

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

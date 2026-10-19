import { Link, useParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path, notFoundError } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Card, ErrorBox, Indicator, Loading, PageHeader, Pct, ProgressBar, useLoad } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { useLiveUpdates } from '../lib/live.js';

export default function Department() {
  const { id } = useParams();
  const { t, nm } = useI18n();
  const { data, error, loading, refresh } = useLoad(o => api.get(path`/tracker/departments/${id}`, o)
    .then(d => (d?.department && Array.isArray(d.applications) ? d : Promise.reject(notFoundError()))), [id]);
  // changes in this department (or project-wide ones) reload the page's data
  useLiveUpdates(refresh, { filter: m => !m.dept_id || m.dept_id === id });
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { department: d, applications } = data;
  return (
    <div>
      <div className="breadcrumb"><Link to="/">{t('nav_home')}</Link><Icon name="chevron" size={12} className="flip" /><span>{nm(d, 'short')}</span></div>
      <PageHeader title={nm(d)} sub={`${t('apps_count', { n: applications.length })} · ${t('weight')} ${pc(d.weight)}`} icon={d.emblem}>
        <ExportButton report="department" params={{ id: d.id }} />
        <div className="head-pct"><Pct value={d.pct} /></div>
      </PageHeader>
      <Card>
        <table className="table list-view">
          <thead>
            <tr>
              <th>{t('application')}</th>
              <th className="hide-mobile">{t('functions')}</th>
              <th className="hide-mobile">{t('test_status')}</th>
              <th className="num-col">{t('weight')}</th>
              <th className="w-30">{t('progress')}</th>
              <th className="num-col">%</th>
            </tr>
          </thead>
          <tbody>
            {applications.map(a => (
              <tr key={a.id}>
                <td>
                  <Link to={'/app/' + a.id} className="link-row">
                    <Icon name={a.icon} size={16} />
                    <span>
                      <b>{nm(a)}</b>
                      {a.sub_ar && <span className="muted small"> · {a.sub_ar}</span>}
                    </span>
                  </Link>
                  <div className="row-tags">
                    {a.addendum && <Indicator color="blue">{t('addendum')} {a.addendum}</Indicator>}
                    {a.scope_cut && <Indicator color="orange">{t('scope_cut')}</Indicator>}
                    {a.extra_module && <Indicator color="purple">{t('extra_module')}</Indicator>}
                  </div>
                </td>
                <td className="hide-mobile num">{a.calc.items ? a.calc.items.function : a.calc.count}
                  {a.calc.items?.report > 0 && <span className="it-count-rep" title={t('it_hint_report')}> + <Icon name="item_report" size={12} /> {a.calc.items.report}</span>}</td>
                <td className="hide-mobile">
                  <span className="mini-tests">
                    <span className="green" title={t('ts_2')}>{a.calc.tests[2]}</span>
                    <span className="orange" title={t('ts_1')}>{a.calc.tests[1]}</span>
                    <span className="red" title={t('ts_3')}>{a.calc.tests[3]}</span>
                    <span className="gray" title={t('ts_0')}>{a.calc.tests[0]}</span>
                  </span>
                </td>
                <td className="num-col num">{pc(a.calc.weight)}</td>
                <td><ProgressBar value={a.calc.pct} /></td>
                <td className="num-col"><Pct value={a.calc.pct} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

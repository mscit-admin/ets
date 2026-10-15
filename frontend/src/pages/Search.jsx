import { Link, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { Card, Empty, ErrorBox, Indicator, Loading, PageHeader, Pct, useLoad } from '../components/ui.jsx';

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const { t, nm } = useI18n();
  const { data, error, loading } = useLoad(() => api.get('/tracker/search?q=' + encodeURIComponent(q)), [q]);
  return (
    <div>
      <PageHeader title={t('search_results')} sub={`«${q}»`} icon="search" />
      {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : (
        <Card>
          {!data.results.length ? <Empty /> : (
            <table className="table">
              <thead><tr><th>{t('functions')}</th><th>{t('application')}</th><th className="num-col">%</th></tr></thead>
              <tbody>
                {data.results.map(r => (
                  <tr key={r.id} className={r.enabled ? '' : 'row-off'}>
                    <td><div lang="ar" dir="rtl">{r.name_ar}</div><div className="fn-meta"><span className="code">{r.code}</span>
                      <Indicator color="gray">{t('src_' + r.source)}</Indicator>{r.reference && <span className="muted">{r.reference}</span>}</div></td>
                    <td><Link to={'/app/' + r.app_id}>{nm(r, 'app_name')}</Link></td>
                    <td className="num-col"><Pct value={r.progress} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}

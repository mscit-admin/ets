import { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api, qs } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { Card, Empty, ErrorBox, Indicator, Loading, Modal, NumberCard, PageHeader, useLoad } from '../components/ui.jsx';

const TYPES = ['auth', 'audit', 'access', 'error', 'system'];

// Column definitions per log type: [label key, render(row)]
function columns(type, t, fmtDate) {
  const ts = ['time', r => <span className="nowrap small">{fmtDate(r.ts)}</span>];
  const who = ['user', r => <span dir="ltr">{r.username || '—'}</span>];
  const ip = ['ip', r => <span dir="ltr" className="code">{r.ip || ''}</span>];
  switch (type) {
    case 'auth': return [ts, who, ['event', r => <span className="code">{r.event}</span>],
      ['result', r => <Indicator color={r.success ? 'green' : 'red'}>{r.success ? t('success') : t('failure')}</Indicator>], ip];
    case 'audit': return [ts, who, ['action', r => <span className="code">{r.action}</span>], ['entity', r => <span>{r.entity} <span className="muted">{r.entity_id || ''}</span></span>],
      ['details', r => <span className="ellipsis small" title={r.summary || ''}>{r.summary}</span>]];
    case 'access': return [ts, who, ['method', r => <span className="code">{r.method}</span>], ['path', r => <span dir="ltr" className="code ellipsis">{r.path}</span>],
      ['status', r => <Indicator color={r.status >= 500 ? 'red' : r.status >= 400 ? 'orange' : 'green'}>{r.status}</Indicator>], ['duration', r => <span className="num">{r.duration_ms}</span>], ip];
    case 'error': return [ts, who, ['message', r => <span className="ellipsis">{r.message}</span>], ['path', r => <span dir="ltr" className="code">{r.method} {r.path}</span>]];
    default: return [ts, ['level', r => <Indicator color={r.level === 'error' ? 'red' : r.level === 'warn' ? 'orange' : 'blue'}>{r.level}</Indicator>],
      ['event', r => <span className="code">{r.event}</span>], ['message', r => <span className="ellipsis">{r.message}</span>]];
  }
}

export default function Logs() {
  const { t, fmtDate } = useI18n();
  const { user } = useAuth();
  const types = user.fullScope ? TYPES : ['audit'];
  const [type, setType] = useState(types[0]);
  const [f, setF] = useState({ q: '', from: '', to: '', event: '', success: '' });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const query = { ...applied, page, limit: 50 };
  const { data, error, loading } = useLoad(() => api.get(`/logs/${type}${qs(query)}`), [type, JSON.stringify(query)]);
  const stats = useLoad(() => (user.fullScope ? api.get('/logs/stats') : Promise.resolve(null)), []);
  const cols = columns(type, t, fmtDate);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const switchType = k => { setType(k); setPage(1); const e = { q: '', from: '', to: '', event: '', success: '' }; setF(e); setApplied(e); };

  return (
    <div>
      <PageHeader title={t('logs_title')} icon="logs">
        <a className="btn btn-default btn-sm" href={`/api/logs/${type}/export${qs(applied)}`}><Icon name="download" size={14} /> {t('export_csv')}</a>
      </PageHeader>
      {stats.data && (
        <div className="grid-cards">
          <NumberCard label={t('logins_24h')} value={stats.data.logins_24h} color="green" />
          <NumberCard label={t('failed_24h')} value={stats.data.failed_24h} color={stats.data.failed_24h ? 'red' : ''} />
          <NumberCard label={t('changes_24h')} value={stats.data.changes_24h} color="blue" />
          <NumberCard label={t('errors_24h')} value={stats.data.errors_24h} color={stats.data.errors_24h ? 'red' : ''} />
          <NumberCard label={t('active_sessions')} value={stats.data.active_sessions} sub={`${t('locked_users')}: ${stats.data.locked_users}`} />
        </div>
      )}
      <div className="tabs">
        {types.map(k => <button key={k} className={'tab' + (k === type ? ' active' : '')} onClick={() => switchType(k)}>{t('log_' + k)}</button>)}
      </div>
      <Card>
        <form className="filter-bar" onSubmit={e => { e.preventDefault(); setPage(1); setApplied(f); }}>
          <input className="input input-sm" placeholder={t('filter') + '…'} value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
          <label className="inline-field">{t('from')} <input className="input input-sm" type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
          <label className="inline-field">{t('to')} <input className="input input-sm" type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></label>
          {data?.events?.length > 0 && (
            <select className="input input-sm" value={f.event} onChange={e => setF({ ...f, event: e.target.value })} aria-label={t('event')}>
              <option value="">{t('event')}: {t('all')}</option>
              {data.events.map(ev => <option key={ev} value={ev}>{ev}</option>)}
            </select>
          )}
          {type === 'auth' && (
            <select className="input input-sm" value={f.success} onChange={e => setF({ ...f, success: e.target.value })} aria-label={t('result')}>
              <option value="">{t('result')}: {t('all')}</option><option value="true">{t('success')}</option><option value="false">{t('failure')}</option>
            </select>
          )}
          <button className="btn btn-default btn-sm"><Icon name="filter" size={14} /> {t('apply')}</button>
          {data && <span className="muted small push">{t('total_rows', { n: data.total })}</span>}
        </form>
        {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : !data.rows.length ? <Empty /> : (
          <div className="table-wrap">
            <table className="table list-view clickable">
              <thead><tr>{cols.map(([k]) => <th key={k}>{t(k)}</th>)}</tr></thead>
              <tbody>{data.rows.map(r => <tr key={r.id} onClick={() => setDetail(r)}>{cols.map(([k, fn]) => <td key={k}>{fn(r)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
        {data && pages > 1 && (
          <div className="pager">
            <button className="btn btn-default btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('previous')}</button>
            <span className="muted small">{t('page_of', { page, pages })}</span>
            <button className="btn btn-default btn-sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('next')}</button>
          </div>
        )}
      </Card>
      {detail && (
        <Modal title={t('details')} onClose={() => setDetail(null)} wide>
          <pre className="json" dir="ltr">{JSON.stringify(detail, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

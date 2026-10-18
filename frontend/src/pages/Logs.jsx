import { useMemo, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api, path, qs } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { Card, Empty, ErrorBox, Indicator, Loading, Modal, NumberCard, PageHeader, useLoad } from '../components/ui.jsx';
import { makeAudit } from '../lib/audit.js';
import { ExportButton } from '../components/ExportButton.jsx';

const TYPES = ['auth', 'audit', 'access', 'error', 'system'];

const ACTION_COLOR = {
  create: 'green', restore: 'green', edit_approve: 'green', import_apply: 'green', import_approve_lead: 'green', import_approve_final: 'green',
  remove: 'red', edit_reject: 'red', import_reject: 'red', reset: 'orange', edit_request: 'orange', import_submit: 'orange',
  edit_withdraw: 'gray', export: 'gray',
};

// "Field: from X to Y" (an addition has no "from")
function ChangeLine({ l, t }) {
  return (
    <div className="au-line">
      {l.item && <><span className="au-field">{l.item}</span> — </>}
      <span className="au-field">{l.label}:</span>{' '}
      {l.from ? <>{t('from')} <span className="au-old">{l.from}</span> {t('to')} <span className="au-new">{l.to}</span></> : <span className="au-new">{l.to}</span>}
    </div>
  );
}

// Readable audit row: the sentence, its first few changes, and how it came in.
function AuditText({ d, t }) {
  // a single change is already spelled out in the sentence
  const all = [...(d.lines.length > 1 ? d.lines : []), ...(d.items || [])];
  const shown = all.slice(0, d.maxInline);
  return (
    <div className="au-text">
      <div>{d.text}</div>
      {shown.map((l, i) => <ChangeLine key={i} l={l} t={t} />)}
      {all.length > shown.length && <div className="muted small">{t('au_more_items', { n: all.length - shown.length })}</div>}
      {d.notes.map((n, i) => <div key={'n' + i} className="muted small">{n}</div>)}
    </div>
  );
}

function AuditDetail({ r, d, t, fmtDate }) {
  return (
    <div className="au-detail">
      <p className="au-sentence">{d.text}</p>
      {d.notes.map((n, i) => <p key={i} className="muted">{n}</p>)}
      <dl className="au-meta">
        <dt>{t('by_user')}</dt><dd>{d.who} {r.username && r.full_name && <span className="muted small" dir="ltr">({r.username})</span>}</dd>
        <dt>{t('time')}</dt><dd>{fmtDate(r.ts)}</dd>
        <dt>{t('action')}</dt><dd><Indicator color={ACTION_COLOR[r.action] || 'blue'}>{d.type}</Indicator></dd>
        {r.ip && <><dt>{t('ip')}</dt><dd><span dir="ltr" className="code">{r.ip}</span></dd></>}
      </dl>
      {d.lines.length > 0 && (
        <>
          <h4>{t('changes_made')}</h4>
          <table className="table au-table">
            <thead><tr><th>{t('field')}</th><th>{t('old_value')}</th><th>{t('new_value')}</th></tr></thead>
            <tbody>{d.lines.map((l, i) => <tr key={i}><td>{l.label}</td><td className="au-old">{l.from || '—'}</td><td className="au-new">{l.to}</td></tr>)}</tbody>
          </table>
        </>
      )}
      {d.items && (
        <>
          <h4>{t('items_affected')} ({d.items.length})</h4>
          <div className="table-wrap au-items">
            <table className="table au-table">
              <thead><tr><th>{t('item')}</th><th>{t('field')}</th><th>{t('old_value')}</th><th>{t('new_value')}</th>
                {d.items.some(x => x.applied !== undefined) && <th>{t('applied_q')}</th>}</tr></thead>
              <tbody>{d.items.map((l, i) => (
                <tr key={i}><td>{l.item}</td><td>{l.label}</td><td className="au-old">{l.from || '—'}</td><td className="au-new">{l.to || '—'}</td>
                  {d.items.some(x => x.applied !== undefined) && <td>{l.applied === undefined || l.applied === null ? '—' : l.applied ? t('yes') : t('no')}</td>}</tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      <details className="au-raw">
        <summary className="muted small">{t('technical_details')}</summary>
        <pre className="json" dir="ltr">{JSON.stringify(r, null, 2)}</pre>
      </details>
    </div>
  );
}

// Column definitions per log type: [label key, render(row)]
function columns(type, t, fmtDate, describe) {
  const ts = ['time', r => <span className="nowrap small">{fmtDate(r.ts)}</span>];
  const who = ['user', r => <span dir="ltr">{r.username || '—'}</span>];
  const ip = ['ip', r => <span dir="ltr" className="code">{r.ip || ''}</span>];
  switch (type) {
    case 'auth': return [ts, who, ['event', r => <span className="code">{r.event}</span>],
      ['result', r => <Indicator color={r.success ? 'green' : 'red'}>{r.success ? t('success') : t('failure')}</Indicator>], ip];
    case 'audit': return [ts,
      ['user', r => <span>{r.full_name || r.username || '—'}</span>],
      ['action', r => <Indicator color={ACTION_COLOR[r.action] || 'blue'}>{describe(r).type}</Indicator>],
      ['description', r => <AuditText d={describe(r)} t={t} />]];
    case 'access': return [ts, who, ['method', r => <span className="code">{r.method}</span>], ['path', r => <span dir="ltr" className="code ellipsis">{r.path}</span>],
      ['status', r => <Indicator color={r.status >= 500 ? 'red' : r.status >= 400 ? 'orange' : 'green'}>{r.status}</Indicator>], ['duration', r => <span className="num">{r.duration_ms}</span>], ip];
    case 'error': return [ts, who, ['message', r => <span className="ellipsis">{r.message}</span>], ['path', r => <span dir="ltr" className="code">{r.method} {r.path}</span>]];
    default: return [ts, ['level', r => <Indicator color={r.level === 'error' ? 'red' : r.level === 'warn' ? 'orange' : 'blue'}>{r.level}</Indicator>],
      ['event', r => <span className="code">{r.event}</span>], ['message', r => <span className="ellipsis">{r.message}</span>]];
  }
}

export default function Logs() {
  const { t, fmtDate, lang } = useI18n();
  const describe = useMemo(() => makeAudit({ t, lang }), [t, lang]);
  const { user, can } = useAuth();
  // sign-in, request, error and system logs (and every IP address) are for system administrators only (ETS-SEC-047)
  const admin = user.role === 'admin';
  const types = admin ? TYPES : ['audit'];
  const [type, setType] = useState(types[0]);
  const [f, setF] = useState({ q: '', from: '', to: '', event: '', success: '' });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const query = { ...applied, page, limit: 50 };
  const { data, error, loading } = useLoad(() => api.get(path`/logs/${type}` + qs(query)), [type, JSON.stringify(query)]);
  const stats = useLoad(() => (admin ? api.get('/logs/stats') : Promise.resolve(null)), []);
  const [integrity, setIntegrity] = useState(null);
  const verify = async () => {
    setIntegrity({ busy: true });
    try { setIntegrity(await api.get('/logs/integrity')); } catch (e) { setIntegrity({ error: e }); }
  };
  const cols = columns(type, t, fmtDate, describe);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const switchType = k => { setType(k); setPage(1); const e = { q: '', from: '', to: '', event: '', success: '' }; setF(e); setApplied(e); };

  return (
    <div>
      <PageHeader title={t('logs_title')} icon="logs">
        {admin && (
          <button className="btn btn-default btn-sm" onClick={verify} disabled={integrity?.busy}>
            <Icon name="check" size={14} /> {t('verify_integrity')}
          </button>
        )}
        {/* every export needs 'exp' as well as 'log' (export policy); the server checks both */}
        {can('exp') && <a className="btn btn-default btn-sm" href={'/api' + path`/logs/${type}/export` + qs(applied)}><Icon name="download" size={14} /> {t('export_csv')}</a>}
        <ExportButton report="log" params={{ type, ...applied }} />
      </PageHeader>
      {integrity && !integrity.busy && (integrity.error ? <ErrorBox error={integrity.error} /> : (
        <Card>
          <Indicator color={integrity.ok ? 'green' : 'red'}>{integrity.ok ? t('integrity_ok') : t('integrity_broken')}</Indicator>
          {integrity.tables.map(x => (
            <div key={x.table} className="muted small" dir="ltr">
              {x.table}: {x.rows} · seq {x.first_seq ?? '-'}…{x.last_seq ?? '-'} · head {x.head.seq}:{x.head.hash.slice(0, 16)}
              {x.breaks.length > 0 && <> · <span className="code">{x.breaks.slice(0, 5).map(b => b.kind + '@' + (b.seq ?? '')).join(', ')}</span></>}
            </div>
          ))}
        </Card>
      ))}
      {stats.data && (
        <div className="grid-cards">
          <NumberCard label={t('logins_24h')} value={stats.data.logins_24h} color="green" />
          <NumberCard label={t('failed_24h')} value={stats.data.failed_24h} color={stats.data.failed_24h ? 'red' : ''} />
          <NumberCard label={t('changes_24h')} value={stats.data.changes_24h} color="blue" />
          <NumberCard label={t('errors_24h')} value={stats.data.errors_24h} color={stats.data.errors_24h ? 'red' : ''} />
          <NumberCard label={t('active_sessions')} value={stats.data.active_sessions} sub={`${t('locked_users')}: ${stats.data.locked_users}`} />
          {stats.data.log_write_failures > 0 && <NumberCard label={t('log_write_failures')} value={stats.data.log_write_failures} color="red" />}
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
              {data.events.map(ev => <option key={ev} value={ev}>{type === 'audit' && t('au_a_' + ev) !== 'au_a_' + ev ? t('au_a_' + ev) : ev}</option>)}
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
          {type === 'audit' && detail.action
            ? <AuditDetail r={detail} d={describe(detail)} t={t} fmtDate={fmtDate} />
            : <pre className="json" dir="ltr">{JSON.stringify(detail, null, 2)}</pre>}
        </Modal>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path, qs } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Alert, Card, Empty, ErrorBox, Field, Indicator, Loading, Modal, PageHeader, toast, useLoad } from '../components/ui.jsx';

const STATUS_COLOR = { pending: 'orange', applied: 'green', rejected: 'red', superseded: 'gray', withdrawn: 'gray' };
const FIELD_LABEL = { progress: 'progress', weight: 'weight', enabled: 'enabled', test_status: 'test_status',
  notif_status: 'notif_status', review_status: 'review_status', note: 'note', status: 'report_status', name_en: 'name',
  create: 'fn_add', removed: 'fn_remove' };

function useFmt() {
  const { t } = useI18n();
  return (kind, field, v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (field === 'create') return `${v.name_ar} · ${t('weight')} \u2066${v.weight}\u2069 · \u2066${pc(v.progress)}%\u2069 · ${v.enabled ? t('include_in_calc') : t('exclude_hint')}`;
    if (field === 'removed') return v.removed ? `${t('fn_state_removed')}${v.reason ? ' — ' + v.reason : ''}` : t('fn_state_present');
    const P = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_' };
    if (P[field]) return t(P[field] + v);
    if (kind === 'report' && field === 'status') return t('rs_' + v);
    if (field === 'progress') return pc(v) + '%';
    if (field === 'enabled') return v ? t('yes') : t('no');
    return String(v);
  };
}

export default function Approvals() {
  const { t, nm, errText, fmtDate } = useI18n();
  const fmt = useFmt();
  const [status, setStatus] = useState('pending');
  const [mine, setMine] = useState(false);
  const [dlg, setDlg] = useState(null); // {req, mode:'reject'}
  const { data, error, loading, reload } = useLoad(() => api.get('/approvals' + qs({ status, mine: mine ? 1 : '' })), [status, mine]);

  const act = async (rq, action, body = {}) => {
    try {
      const r = await api.post(path`/approvals/${rq.id}/${action}`, body);
      toast(r.applied ? t('applied_result', { a: r.applied_changes, s: r.skipped_changes }) : t('saved'));
      setDlg(null); reload();
    } catch (e) { toast(errText(e), 'red'); }
  };
  const approveAll = async () => {
    if (!window.confirm(t('are_you_sure'))) return;
    try {
      const r = await api.post('/approvals/approve-all', {});
      toast(t('applied_result', { a: r.applied_changes, s: r.skipped_changes }));
      if (r.blocked_requests) toast(t('blocked_requests_n', { n: r.blocked_requests }), 'red');
      reload();
    }
    catch (e) { toast(errText(e), 'red'); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const canApproveAny = data.requests.some(r => r.can.approve);

  return (
    <div>
      <PageHeader title={t('approvals_title')} sub={t('approvals_sub')} icon="check">
        {status === 'pending' && canApproveAny && <button className="btn btn-primary btn-sm" onClick={approveAll}>{t('approve_all')}</button>}
      </PageHeader>
      <div className="filter-bar">
        <select className="input input-sm" value={status} onChange={e => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('status')}: {t('all')}</option>
          {Object.keys(STATUS_COLOR).map(s => <option key={s} value={s}>{t('rq_' + s)}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /> {t('my_requests')}</label>
      </div>
      {!data.requests.length ? <Card><Empty>{t('no_requests')}</Empty></Card> : data.requests.map(rq => (
        <Card key={rq.id} className="req-card"
          title={<span className="link-row"><Icon name={rq.icon} size={15} /> <Link to={'/app/' + rq.app_id}>{nm(rq, 'app_name')}</Link>
            <span className="muted small">· {nm(rq, 'dept_name')}</span>
            {rq.kind.endsWith('_function') && <Indicator color={rq.kind === 'remove_function' ? 'red' : 'blue'}>{t('rq_kind_' + rq.kind)}</Indicator>}</span>}
          actions={<>
            <span className="muted small">{rq.requested_by_name} · {fmtDate(rq.requested_at)}</span>
            <Indicator color={STATUS_COLOR[rq.status]}>{t('rq_' + rq.status)}</Indicator>
            {rq.can.approve && <button className="btn btn-primary btn-xs" onClick={() => act(rq, 'approve')}>{t('approve')}</button>}
            {rq.can.reject && <button className="btn btn-default btn-xs" onClick={() => setDlg({ rq, mode: 'reject' })}>{t('reject')}</button>}
            {rq.can.withdraw && <button className="btn btn-default btn-xs" onClick={() => act(rq, 'withdraw')}>{t('withdraw')}</button>}
          </>}>
          {rq.status === 'rejected' && <Alert kind="red">{t('rejected_by', { name: rq.decided_by_name })}: {rq.reason}</Alert>}
          {rq.status === 'applied' && <Alert kind="green">{t('approved_by', { name: rq.decided_by_name })} · {fmtDate(rq.decided_at)}</Alert>}
          <div className="table-wrap">
            <table className="table req-items">
              <thead><tr><th>{t('functions')}</th><th>{t('field')}</th><th>{t('before')}</th><th>{t('after')}</th></tr></thead>
              <tbody>
                {rq.items.map(i => (
                  <tr key={i.id}>
                    <td>{i.kind === 'report' ? t('kind_report') : i.field === 'create' ? <b>＋ {t('add_function')}</b>
                      : <><span className="code">{i.code}</span> <span lang="ar" dir="rtl">{i.fn_name_ar}</span></>}</td>
                    <td className="nowrap">{t(FIELD_LABEL[i.field] || i.field)}</td>
                    <td className="muted">{fmt(i.kind, i.field, i.old_value)}</td>
                    <td><b>{fmt(i.kind, i.field, i.new_value)}</b>{i.applied === false && <> <Indicator color="red" title={i.note}>✗</Indicator></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      {dlg && <RejectModal onClose={() => setDlg(null)} onSubmit={reason => act(dlg.rq, 'reject', { reason })} />}
    </div>
  );
}

function RejectModal({ onClose, onSubmit }) {
  const { t } = useI18n();
  const [v, setV] = useState('');
  return (
    <Modal title={t('reject')} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={!v.trim()} onClick={() => onSubmit(v)}>{t('reject')}</button></>}>
      <Field label={t('reject_reason') + ' *'}><textarea className="input" rows={4} maxLength={1000} value={v} onChange={e => setV(e.target.value)} /></Field>
    </Modal>
  );
}

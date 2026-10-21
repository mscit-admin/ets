import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path, qs } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Alert, Card, Empty, ErrorBox, Field, Indicator, Loading, Modal, PageHeader, toast, useLoad } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { DisabledReason } from '../components/DisableReason.jsx';
import { TypeBadge } from '../components/ItemType.jsx';
import { MoveImpact } from '../components/MoveDialog.jsx';
import { RQ_FIELD_LABEL as FIELD_LABEL, RQ_STATUSES, RQ_STATUS_COLOR as STATUS_COLOR, REJECT_MAX, approveAllToasts, approveLabelKey, canApproveAny as anyApprovable,
  decisionToast, fmtChange, moveStage, rejectProblem, showRenameReason } from '../lib/approvalRules.js';

// How a change reads, the stages of a move and the toasts of a decision: lib/approvalRules.js (shared with the mobile app).
function useFmt() {
  const { t, nm } = useI18n();
  return (kind, field, v) => fmtChange({ t, nm, pc }, kind, field, v);
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
      const m = decisionToast(r);
      toast(t(m.key, m.vars));
      setDlg(null); reload();
    } catch (e) { toast(errText(e), 'red'); }
  };
  const approveAll = async () => {
    if (!window.confirm(t('are_you_sure'))) return;
    try {
      const r = await api.post('/approvals/approve-all', {});
      for (const m of approveAllToasts(r)) toast(t(m.key, m.vars), m.kind === 'red' ? 'red' : undefined);
      reload();
    }
    catch (e) { toast(errText(e), 'red'); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const canApproveAny = anyApprovable(data.requests);

  return (
    <div>
      <PageHeader title={t('approvals_title')} sub={t('approvals_sub')} icon="check">
        <ExportButton report="approvals" params={{ status, mine: mine ? 1 : '' }} />
        {status === 'pending' && canApproveAny && <button className="btn btn-primary btn-sm" onClick={approveAll}>{t('approve_all')}</button>}
      </PageHeader>
      <div className="filter-bar">
        <select className="input input-sm" value={status} onChange={e => setStatus(e.target.value)} aria-label={t('status')}>
          <option value="">{t('status')}: {t('all')}</option>
          {RQ_STATUSES.map(s => <option key={s} value={s}>{t('rq_' + s)}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /> {t('my_requests')}</label>
      </div>
      {!data.requests.length ? <Card><Empty>{t('no_requests')}</Empty></Card> : data.requests.map(rq => (
        <Card key={rq.id} className="req-card"
          title={rq.kind === 'move_function'
            ? <span className="link-row mv-route"><Icon name="move" size={15} /> {t('mv_rq_title', {
              from: `${nm(rq, 'app_name')} (${nm(rq, 'dept_name')})`, to: `${nm(rq, 'target_app_name')} (${nm(rq, 'target_dept_name')})` })}
            <Indicator color="purple">{t('rq_kind_move_function')}</Indicator></span>
            : <span className="link-row"><Icon name={rq.icon} size={15} /> <Link to={'/app/' + rq.app_id}>{nm(rq, 'app_name')}</Link>
            <span className="muted small">· {nm(rq, 'dept_name')}</span>
            {rq.kind.endsWith('_function') && <Indicator color={rq.kind === 'remove_function' ? 'red' : 'blue'}>{t('rq_kind_' + rq.kind)}</Indicator>}</span>}
          actions={<>
            <span className="muted small">{rq.requested_by_name} · {fmtDate(rq.requested_at)}</span>
            <Indicator color={STATUS_COLOR[rq.status]}>{t('rq_' + rq.status)}</Indicator>
            {rq.can.approve && <button className="btn btn-primary btn-xs" onClick={() => act(rq, 'approve')}>{t(approveLabelKey(rq.can))}</button>}
            {rq.can.reject && <button className="btn btn-default btn-xs" onClick={() => setDlg({ rq, mode: 'reject' })}>{t('reject')}</button>}
            {rq.can.withdraw && <button className="btn btn-default btn-xs" onClick={() => act(rq, 'withdraw')}>{t('withdraw')}</button>}
          </>}>
          {rq.status === 'rejected' && <Alert kind="red">{t('rejected_by', { name: rq.decided_by_name })}: {rq.reason}</Alert>}
          {rq.status === 'applied' && <Alert kind="green">{t('approved_by', { name: rq.decided_by_name })} · {fmtDate(rq.decided_at)}</Alert>}
          {rq.kind === 'move_function' && <MoveRequest rq={rq} />}
          <div className="table-wrap">
            <table className="table req-items">
              <thead><tr><th>{t('functions')}</th><th>{t('field')}</th><th>{t('before')}</th><th>{t('after')}</th></tr></thead>
              <tbody>
                {rq.items.map(i => (
                  <tr key={i.id}>
                    <td>{i.kind === 'report' ? t('kind_report') : i.field === 'create' ? <b>＋ {t('add_function')}</b>
                      : <><span className="code">{i.code}</span> <span lang="ar" dir="rtl">{i.fn_name_ar}</span></>}</td>
                    <td className="nowrap">{t(FIELD_LABEL[i.field] || i.field)}</td>
                    <td className="muted">{i.field === 'item_type' ? <TypeBadge type={i.old_value} /> : fmt(i.kind, i.field, i.old_value)}</td>
                    <td><b>{i.field === 'item_type' ? <TypeBadge type={i.new_value} /> : fmt(i.kind, i.field, i.new_value)}</b>{i.applied === false && <> <Indicator color="red" title={i.note}>✗</Indicator></>}
                      {i.field === 'enabled' && i.new_value === false && (
                        <div className="req-reason">
                          <span className="muted small">{t('dr_reason')}:</span> <DisabledReason f={i.meta || {}} appId={rq.app_id} />
                          {i.meta?.disabled_note && <div className="small">{t('dr_note')}: <span className="muted">{i.meta.disabled_note}</span></div>}
                        </div>
                      )}
                      {i.field === 'move' && <div className="req-reason small">{t('mv_weight_moved')}: <span className="num">{(+(i.meta?.weight_share || 0)).toFixed(2)}</span></div>}
                      {showRenameReason(i, rq.items) && (
                        <div className="req-reason small">{t('rn_reason')}: <span className="muted rn-reason-text">{i.meta.rename_reason}</span></div>
                      )}</td>
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
        <button className="btn btn-primary" disabled={!!rejectProblem(v)} onClick={() => onSubmit(v)}>{t('reject')}</button></>}>
      <Field label={t('reject_reason') + ' *'}><textarea className="input" rows={4} maxLength={REJECT_MAX} value={v} onChange={e => setV(e.target.value)} /></Field>
    </Modal>
  );
}

// A move request (1.10.0): its reason, which approval is done / awaited, the weight share when it was requested and as
// it would be now (applied at approval), and the impact computed when it was requested.
function MoveRequest({ rq }) {
  const { t, fmtDate } = useI18n();
  const m = rq.meta || {};
  const now = rq.move_now;
  const st = moveStage(rq);
  const share = v => (Number.isFinite(+v) ? (+v).toFixed(2) : '—');
  return (
    <div className="mv-request">
      {m.reason && <div className="req-reason"><span><b>{t('mv_reason')}:</b> <span className="rn-reason-text">{m.reason}</span></span></div>}
      <div className="mv-stage" role="status">
        {st.sourceDone && <span className="green-text">✓ {t('mv_rq_source_done', { name: st.sourceDone.name, date: fmtDate(st.sourceDone.at) })}</span>}
        {st.targetDone && <span className="green-text">✓ {t('mv_rq_target_done', { name: st.targetDone.name, date: fmtDate(st.targetDone.at) })}</span>}
        {st.waitKey && <b>⏳ {t(st.waitKey)}</b>}
      </div>
      <div className="mv-shares">
        <span>{t('mv_rq_share_then')}: <b className="num">{share(m.weight_share)}</b></span>
        {rq.status === 'pending' && now && <span>{t('mv_rq_share_now')}: <b className="num">{share(now.share)}</b></span>}
        {rq.status === 'applied' && rq.apply_result?.weight && <span>{t('mv_weight_moved')}: <b className="num">{share(rq.apply_result.weight.share)}</b></span>}
      </div>
      {rq.status === 'pending' && now && now.still_in_source === false && <Alert kind="red">{t('mv_rq_moved_out')}</Alert>}
      {m.impact && <MoveImpact impact={m.impact} />}
    </div>
  );
}

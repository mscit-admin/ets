import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path, qs } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Alert, Card, Empty, ErrorBox, Field, Indicator, Loading, Modal, PageHeader, toast, useLoad } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { DisabledReason } from '../components/DisableReason.jsx';
import { TypeBadge } from '../components/ItemType.jsx';
import { MoveImpact } from '../components/MoveDialog.jsx';
import { RQ_FIELD_LABEL as FIELD_LABEL, RQ_STATUSES, RQ_STATUS_COLOR as STATUS_COLOR, REJECT_MAX, approveAllToasts, approveLabelKey,
  decisionToast, fmtChange, moveStage, rejectProblem, showRenameReason } from '../lib/approvalRules.js';

// How a change reads, the stages of a move and the toasts of a decision: lib/approvalRules.js (shared with the mobile app).
function useFmt() {
  const { t, nm } = useI18n();
  return (kind, field, v) => fmtChange({ t, nm, pc }, kind, field, v);
}

// Filters of the screen (1.12.1), kept in the address (?status=&dept=…) so a filtered list can be shared or reloaded.
// No «status» in the address means «pending»; «status=» (empty) means every status. The server applies them all
// (routes/approvals.js) and still shows only the requests the user may see; the choices come from GET /approvals/facets.
const FILTER_KEYS = ['status', 'mine', 'awaiting', 'returned', 'dept', 'app', 'kind', 'field', 'requester', 'decided_by', 'from', 'to', 'q'];
const readFilters = params => Object.fromEntries(FILTER_KEYS.map(k => [k, k === 'status' && !params.has('status') ? 'pending' : params.get(k) || '']));
const isFiltered = f => FILTER_KEYS.some(k => (k === 'status' ? f.status !== 'pending' : !!f[k]));

export default function Approvals() {
  const { t, nm, errText, fmtDate } = useI18n();
  const fmt = useFmt();
  const [params, setParams] = useSearchParams();
  const f = readFilters(params);
  const setFilter = (k, v) => setParams(prev => {
    const next = new URLSearchParams(prev);
    if (k === 'status' ? v === 'pending' : !v) next.delete(k); else next.set(k, v);
    if (k === 'dept' && v) next.delete('app');                // the application list follows the department
    return next;
  }, { replace: true });
  // the search box applies after a short pause in typing
  const [text, setText] = useState(f.q);
  useEffect(() => { setText(f.q); }, [f.q]);
  useEffect(() => {
    if (text.trim() === f.q) return undefined;
    const h = setTimeout(() => setFilter('q', text.trim()), 350);
    return () => clearTimeout(h);
  });
  const [dlg, setDlg] = useState(null); // {req, mode:'reject'}
  const [confirm, setConfirm] = useState(null); // { kind: 'approve', rq } | { kind: 'approveAll' } — rich confirm (UX-4)
  const key = JSON.stringify(f);
  const { data, error, loading, reload } = useLoad(() => api.get('/approvals' + qs({ ...f, mine: f.mine === '1' ? 1 : '', awaiting: f.awaiting === '1' ? 1 : '', returned: f.returned === '1' ? 1 : '' })), [key]);
  const facets = useLoad(() => api.get('/approvals/facets' + qs({ status: f.status })), [f.status]).data;

  const act = async (rq, action, body = {}) => {
    try {
      const r = await api.post(path`/approvals/${rq.id}/${action}`, body);
      const m = decisionToast(r);
      toast(t(m.key, m.vars));
      setDlg(null); setConfirm(null); reload();
    } catch (e) { toast(errText(e), 'red'); }
  };
  // «approve all shown»: only the requests listed now (the filters applied) that this user may approve
  const approvable = (data?.requests || []).filter(rq => rq.can?.approve).map(rq => rq.id);
  const approveAll = async () => {
    try {
      const r = await api.post('/approvals/approve-all', { ids: approvable });
      for (const m of approveAllToasts(r)) toast(t(m.key, m.vars), m.kind === 'red' ? 'red' : undefined);
      setConfirm(null); reload();
    }
    catch (e) { toast(errText(e), 'red'); }
  };

  const filtered = isFiltered(f);
  const apps = (facets?.applications || []).filter(a => !f.dept || a.department_id === f.dept);
  const fieldLabel = k => (k === 'name' ? t('rqf_field_name') : t(FIELD_LABEL[k] || k));
  const sel = (k, label, options) => (
    <select className={'input input-sm' + (f[k] ? ' filter-on' : '')} value={f[k]} onChange={e => setFilter(k, e.target.value)} aria-label={label}>
      <option value="">{label}: {t('all')}</option>
      {/* a value in the address that is not offered any more stays selectable, so it can be seen and cleared */}
      {f[k] && !options.some(([v]) => String(v) === f[k]) && <option value={f[k]}>{f[k]}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );

  return (
    <div>
      <PageHeader title={t('approvals_title')} sub={t('approvals_sub')} icon="check">
        <ExportButton report="approvals" params={{ ...f, mine: f.mine === '1' ? 1 : '', awaiting: f.awaiting === '1' ? 1 : '' }} />
        {approvable.length > 0 && <button className="btn btn-primary btn-sm" onClick={() => setConfirm({ kind: 'approveAll' })}>
          {filtered ? t('approve_shown_n', { n: approvable.length }) : t('approve_all')}</button>}
      </PageHeader>
      <Card className="rq-filters">
        <div className="filter-bar">
          <input className="input input-sm" type="search" placeholder={t('rqf_search')} title={t('rqf_search_hint')} aria-label={t('rqf_search')} value={text} onChange={e => setText(e.target.value)} />
          <select className="input input-sm" value={f.status} onChange={e => setFilter('status', e.target.value)} aria-label={t('status')}>
            <option value="">{t('status')}: {t('all')}</option>
            {RQ_STATUSES.map(s => <option key={s} value={s}>{t('rq_' + s)}</option>)}
          </select>
          {sel('dept', t('department'), (facets?.departments || []).map(d => [d.id, nm(d)]))}
          {sel('app', t('application'), apps.map(a => [a.id, nm(a)]))}
          {sel('requester', t('rqf_requester'), (facets?.requesters || []).map(u => [u.id, u.name]))}
          {sel('kind', t('rqf_kind'), (facets?.kinds || []).map(k => [k, t('rq_kind_' + k)]))}
          {sel('field', t('rqf_field'), (facets?.fields || []).map(k => [k, fieldLabel(k)]))}
          {f.status !== 'pending' && sel('decided_by', t('rqf_decided_by'), (facets?.deciders || []).map(u => [u.id, u.name]))}
          <label className="inline-field">{t('from')} <input className="input input-sm" type="date" value={f.from} max={f.to || undefined} onChange={e => setFilter('from', e.target.value)} /></label>
          <label className="inline-field">{t('to')} <input className="input input-sm" type="date" value={f.to} min={f.from || undefined} onChange={e => setFilter('to', e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={f.awaiting === '1'} onChange={e => setFilter('awaiting', e.target.checked ? '1' : '')} /> {t('rqf_awaiting')}</label>
          <label className="check"><input type="checkbox" checked={f.returned === '1'} onChange={e => setFilter('returned', e.target.checked ? '1' : '')} /> {t('rqf_returned_to_me')}</label>
          <label className="check"><input type="checkbox" checked={f.mine === '1'} onChange={e => setFilter('mine', e.target.checked ? '1' : '')} /> {t('my_requests')}</label>
          {filtered && <button type="button" className="btn btn-default btn-sm" onClick={() => { setText(''); setParams({}, { replace: true }); }}>
            <Icon name="x" size={13} /> {t('rqf_clear')}</button>}
          {data && <span className="muted small push" role="status">{t('rqf_count', { n: data.requests.length })}</span>}
        </div>
      </Card>
      {data?.truncated && <Alert kind="orange">{t('rqf_truncated', { n: data.requests.length })}</Alert>}
      {error ? <ErrorBox error={error} /> : loading && !data ? <Loading /> : !data.requests.length
        ? <Card><Empty>{filtered ? t('rqf_none') : t('no_requests')}</Empty></Card> : data.requests.map(rq => (
        <Card key={rq.id} className="req-card"
          title={rq.kind === 'move_application'
            ? <span className="link-row mv-route"><Icon name="move" size={15} /> {t('amv_rq_title', {
              app: nm(rq, 'app_name'), from: nm(rq, 'dept_name'), to: nm(rq, 'target_dept_name') })}
            <Indicator color="purple">{t('rq_kind_move_application')}</Indicator></span>
            : rq.kind === 'move_function'
            ? <span className="link-row mv-route"><Icon name="move" size={15} /> {t('mv_rq_title', {
              from: `${nm(rq, 'app_name')} (${nm(rq, 'dept_name')})`, to: `${nm(rq, 'target_app_name')} (${nm(rq, 'target_dept_name')})` })}
            <Indicator color="purple">{t('rq_kind_move_function')}</Indicator></span>
            : <span className="link-row"><Icon name={rq.icon} size={15} /> <Link to={'/app/' + rq.app_id}>{nm(rq, 'app_name')}</Link>
            <span className="muted small">· {nm(rq, 'dept_name')}</span>
            {rq.kind.endsWith('_function') && <Indicator color={rq.kind === 'remove_function' ? 'red' : 'blue'}>{t('rq_kind_' + rq.kind)}</Indicator>}</span>}
          actions={<>
            <span className="muted small">{rq.requested_by_name} · {fmtDate(rq.requested_at)}</span>
            <Indicator color={STATUS_COLOR[rq.status]}>{t('rq_' + rq.status)}</Indicator>
            {rq.can.approve && <button className="btn btn-primary btn-xs" onClick={() => setConfirm({ kind: 'approve', rq })}>{t(approveLabelKey(rq.can))}</button>}
            {rq.can.reject && <button className="btn btn-default btn-xs" onClick={() => setDlg({ rq, mode: 'reject' })}>{t('reject')}</button>}
            {rq.can.resubmit && <button className="btn btn-primary btn-xs" onClick={() => act(rq, 'resubmit')}>{t('resubmit')}</button>}
            {rq.can.withdraw && <button className="btn btn-default btn-xs" onClick={() => act(rq, 'withdraw')}>{t('withdraw')}</button>}
          </>}>
          {rq.status === 'returned' && (
            <Alert kind="orange">
              {t('returned_by', { name: rq.decided_by_name })}: {rq.returned_reason || rq.reason}
              {rq.returned_to_name && <div className="small">{t('returned_to_label')}: <b>{rq.returned_to_name}</b>
                {rq.returned_to !== rq.requested_by && <> — {t('returned_to_substitute_note', { name: rq.requested_by_name })}</>}</div>}
            </Alert>
          )}
          {rq.status === 'rejected' && <Alert kind="red">{t('rejected_by', { name: rq.decided_by_name })}: {rq.reason}</Alert>}
          {rq.status === 'applied' && <Alert kind="green">{t('approved_by', { name: rq.decided_by_name })} · {fmtDate(rq.decided_at)}</Alert>}
          {rq.kind === 'move_function' && <MoveRequest rq={rq} />}
          {rq.kind === 'move_application' && <MoveAppRequest rq={rq} />}
          {rq.kind !== 'move_application' && (
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
          )}
        </Card>
      ))}
      {dlg && <RejectModal onClose={() => setDlg(null)} onSubmit={reason => act(dlg.rq, 'reject', { reason })} />}
      {confirm && <ApproveConfirm confirm={confirm} n={approvable.length} nm={nm}
        onClose={() => setConfirm(null)}
        onConfirm={() => (confirm.kind === 'approveAll' ? approveAll() : act(confirm.rq, 'approve'))} />}
    </div>
  );
}

// Confirm an approval — a single request or «approve all shown» — through the app's rich Modal, so both carry the
// same affordance (UX-4: before, a single approve had no confirmation while «approve all» used window.confirm).
function ApproveConfirm({ confirm, n, nm, onClose, onConfirm }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const all = confirm.kind === 'approveAll';
  const rq = confirm.rq;
  const run = async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } };
  return (
    <Modal title={all ? t('approve_all') : t(approveLabelKey(rq.can))} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={run} disabled={busy}><Icon name="check" size={14} /> {t('confirm')}</button></>}>
      {!all && <p className="muted small">{nm(rq, 'app_name')}{rq.dept_name ? <> · {nm(rq, 'dept_name')}</> : null}</p>}
      <Alert kind="blue">{all ? t('approve_shown_confirm', { n }) : t('approve_confirm')}</Alert>
    </Modal>
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

// An application move request (1.12.16): its reason, which department lead approved / is awaited, and the impact on
// the two departments and the project computed when it was requested.
function MoveAppRequest({ rq }) {
  const { t, nm, fmtDate } = useI18n();
  const m = rq.meta || {};
  const st = moveStage(rq);
  const impact = m.impact;
  return (
    <div className="mv-request">
      {m.reason && <div className="req-reason"><span><b>{t('mv_reason')}:</b> <span className="rn-reason-text">{m.reason}</span></span></div>}
      <div className="mv-stage" role="status">
        {st.sourceDone && <span className="green-text">✓ {t('amv_rq_source_done', { name: st.sourceDone.name, date: fmtDate(st.sourceDone.at) })}</span>}
        {st.targetDone && <span className="green-text">✓ {t('amv_rq_target_done', { name: st.targetDone.name, date: fmtDate(st.targetDone.at) })}</span>}
        {st.waitKey && <b>⏳ {t(st.waitKey)}</b>}
      </div>
      {impact && (
        <div className="impact mv-impact">
          <div className="impact-title">{t('mv_impact_title')}</div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col" /><th scope="col" className="num-col">{t('before')}</th><th scope="col" className="num-col">{t('after')}</th></tr></thead>
              <tbody>
                {impact.departments.map(d => (
                  <tr key={d.id}><th scope="row" className="mv-row-label">{t(d.role === 'source' ? 'amv_row_src' : 'amv_row_dst', { name: nm(d) })}</th>
                    <td className="num-col num">{(+d.weight.before).toFixed(2)}</td><td className="num-col num"><b>{(+d.weight.after).toFixed(2)}</b></td></tr>
                ))}
                <tr className="mv-moved"><th scope="row" className="mv-row-label">{t('amv_weight_moved')}</th><td /><td className="num-col num"><b>{(+(impact.app_weight || 0)).toFixed(2)}</b></td></tr>
                <tr><th scope="row" className="mv-row-label">{t('mv_row_project')}</th><td className="num-col num">{pc(impact.total.before)}%</td><td className="num-col num"><b>{pc(impact.total.after)}%</b></td></tr>
              </tbody>
            </table>
          </div>
          <p className="muted small mv-note">{impact.mode === 'auto' ? t('amv_weight_auto') : t('amv_weight_rule')}</p>
        </div>
      )}
    </div>
  );
}

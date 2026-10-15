import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Alert, Card, Empty, ErrorBox, Field, Indicator, Loading, Modal, PageHeader, toast, useLoad } from '../components/ui.jsx';

const STATUS_COLOR = { pending: 'orange', applied: 'green', rejected: 'red', superseded: 'gray', no_changes: 'gray' };

// "12.5% → 14.0%" with direction colour
function Delta({ before, after }) {
  const d = (after ?? 0) - (before ?? 0);
  return (
    <span className="num nowrap">
      {pc(before)}% → <b className={d > 0 ? 'green-text' : d < 0 ? 'red-text' : ''}>{pc(after)}%</b>
      {d !== 0 && <span className="muted small"> ({d > 0 ? '+' : ''}{pc(d)})</span>}
    </span>
  );
}

function targetLabel(b, t, nm) {
  return b.target === 'reports' ? t('import_target_reports') : nm({ name_ar: b.dept_name_ar, name_en: b.dept_name_en });
}

function Signature({ who, at, note, label }) {
  const { t, fmtDate } = useI18n();
  return (
    <div className={'sign ' + (who ? 'done' : 'wait')}>
      <div className="sign-label">{label}</div>
      {who ? <><Indicator color="green">{who}</Indicator><div className="muted small">{fmtDate(at)}</div>{note && <div className="small">{note}</div>}</>
        : <Indicator color="orange">{t('awaiting')}</Indicator>}
    </div>
  );
}

export function ImportList() {
  const { t, nm, fmtDate } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') || '');
  const [open, setOpen] = useState(false);
  const { data, error, loading } = useLoad(() => api.get('/imports' + (status ? '?status=' + status : '')), [status]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div>
      <PageHeader title={t('imports_title')} sub={t('imports_sub')} icon="upload">
        {data.can_import && <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}><Icon name="upload" size={14} /> {t('import_file')}</button>}
      </PageHeader>
      <Alert kind="blue">{t('two_approvals_hint')}</Alert>
      <Card>
        <div className="filter-bar">
          <select className="input input-sm" value={status} onChange={e => setStatus(e.target.value)} aria-label={t('status')}>
            <option value="">{t('status')}: {t('all')}</option>
            {Object.keys(STATUS_COLOR).map(s => <option key={s} value={s}>{t('st_' + s)}</option>)}
          </select>
        </div>
        {!data.batches.length ? <Empty /> : (
          <div className="table-wrap">
            <table className="table list-view clickable">
              <thead><tr><th>#</th><th>{t('target')}</th><th>{t('uploaded_by')}</th><th className="num-col">{t('changes')}</th>
                <th>{t('result_change')}</th><th>{t('approval_lead')}</th><th>{t('approval_final')}</th><th>{t('status')}</th></tr></thead>
              <tbody>
                {data.batches.map(b => {
                  const s = b.summary || {};
                  const d0 = s.departments?.[0];
                  return (
                    <tr key={b.id} onClick={() => nav('/imports/' + b.id)}>
                      <td className="num">{b.id}</td>
                      <td><b>{targetLabel(b, t, nm)}</b>{b.filename && <div className="muted small" dir="ltr">{b.filename}</div>}</td>
                      <td>{b.uploaded_by_name}<div className="muted small">{fmtDate(b.uploaded_at)}</div></td>
                      <td className="num-col num">{b.change_count}</td>
                      <td>{d0 ? <Delta before={d0.before} after={d0.after} /> : '—'}{s.departments?.length > 1 && <span className="muted small"> +{s.departments.length - 1}</span>}</td>
                      <td>{b.lead_by_name ? <Indicator color="green">{b.lead_by_name}</Indicator> : b.status === 'pending' ? <Indicator color="orange">{t('awaiting')}</Indicator> : '—'}</td>
                      <td>{b.final_by_name ? <Indicator color="green">{b.final_by_name}</Indicator> : b.status === 'pending' ? <Indicator color="orange">{t('awaiting')}</Indicator> : '—'}</td>
                      <td><Indicator color={STATUS_COLOR[b.status]}>{t('st_' + b.status)}</Indicator>
                        {(b.can?.approve_lead || b.can?.approve_final) && <> <Indicator color="blue">✎</Indicator></>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && <ImportModal onClose={() => setOpen(false)} onDone={id => { setOpen(false); nav('/imports/' + id); }} />}
    </div>
  );
}

function ImportModal({ onClose, onDone }) {
  const { t, nm, errText, fmtDate } = useI18n();
  const [file, setFile] = useState(null);
  const [content, setContent] = useState(null);
  const [preview, setPreview] = useState(null);
  const [choice, setChoice] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const read = async f => {
    setErr(null); setPreview(null); setChoice(''); setFile(f);
    if (!f) return;
    setBusy(true);
    try {
      const text = await f.text();
      setContent(text);
      setPreview(await api.post('/imports/preview', { content: text }));
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  const submit = async () => {
    if (!choice) { setErr({ code: 'department_required' }); return; }
    setBusy(true); setErr(null);
    const [target, dep] = choice.split(':');
    try {
      const r = await api.post('/imports', { content, filename: file?.name, target, department_id: dep || undefined });
      toast(t('saved')); onDone(r.batch.id);
    } catch (e) { setErr(e); setBusy(false); }
  };
  const deptName = id => nm(preview?.options.find(o => o.department_id === id) || { name_ar: id });

  return (
    <Modal title={t('import_file')} onClose={onClose} wide
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={busy || !preview || !choice} onClick={submit}>{t('import_submit')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <Field label={t('import_choose_file')}>
        <input className="input" type="file" accept=".json,.html,.htm" onChange={e => read(e.target.files[0])} />
      </Field>
      {busy && !preview && <Loading />}
      {preview && (
        <>
          {preview.file_ts && <p className="muted small">{t('import_file_date')}: {fmtDate(preview.file_ts)}</p>}
          <div className="field-label mb-s">{t('import_choose_target')} *</div>
          <div className="option-list" role="radiogroup">
            {preview.options.map(o => {
              const key = o.target + ':' + (o.department_id || '');
              const d0 = o.summary?.departments?.[0];
              return (
                <label key={key} className={'option-row' + (choice === key ? ' on' : '') + (o.target === 'reports' ? ' reports' : '')}>
                  <input type="radio" name="target" checked={choice === key} onChange={() => setChoice(key)} />
                  <span className="option-main">
                    <b>{o.target === 'reports' ? t('import_target_reports') : nm(o)}</b>
                    {o.target === 'reports' && <span className="muted small">{t('import_target_reports_sub', { depts: o.departments.map(deptName).join('، ') })}</span>}
                  </span>
                  <span className="option-side">
                    {o.changes ? <Indicator color="orange">{t('import_n_changes', { n: o.changes })}</Indicator> : <Indicator color="gray">{t('import_no_changes')}</Indicator>}
                    {o.target === 'department' && d0 && <Delta before={d0.before} after={d0.after} />}
                  </span>
                </label>
              );
            })}
          </div>
          {!choice && <div className="field-hint mt-s">{t('import_target_required')}</div>}
          <Alert kind="gray">{t('import_only_part')} {t('two_approvals_hint')}</Alert>
        </>
      )}
    </Modal>
  );
}

// Human-readable value of a changed field
function useFmt() {
  const { t } = useI18n();
  const STATUS_PREFIX = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_', status: 'rs_' };
  return (field, v) => {
    if (v === null || v === undefined) return '—';
    if (STATUS_PREFIX[field]) return t(STATUS_PREFIX[field] + v);
    if (field === 'enabled') return v ? t('yes') : t('no');
    if (field === 'progress') return pc(v) + '%';
    if (field === 'note') return v ? String(v) : '—';
    return String(v);
  };
}
const FIELD_LABEL = { progress: 'progress', weight: 'weight', enabled: 'enabled', test_status: 'test_status', notif_status: 'notif_status',
  review_status: 'review_status', note: 'note', status: 'report_status' };

export function ImportDetail() {
  const { id } = useParams();
  const { t, nm, errText, fmtDate } = useI18n();
  const fmt = useFmt();
  const { data, error, loading, reload } = useLoad(() => api.get('/imports/' + id), [id]);
  const [dlg, setDlg] = useState(null); // {mode:'lead'|'final'|'reject'}
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { batch: b, changes, departments } = data;
  const s = b.summary || {};
  const dname = did => nm(departments.find(d => d.id === did) || { name_ar: did });
  const appSum = new Map((s.applications || []).map(a => [a.id, a]));
  const groups = [];
  for (const ch of changes) {
    let g = groups.find(x => x.app_id === ch.app_id);
    if (!g) groups.push(g = { app_id: ch.app_id, name: nm(ch, 'app_name'), icon: ch.icon, rows: [] });
    g.rows.push(ch);
  }

  return (
    <div>
      <div className="breadcrumb"><Link to="/imports">{t('nav_imports')}</Link><Icon name="chevron" size={12} className="flip" /><span>{t('batch')} #{b.id}</span></div>
      <PageHeader title={`${t('batch')} #${b.id} — ${targetLabel(b, t, nm)}`}
        sub={<>{t('uploaded_by')}: {b.uploaded_by_name} · {fmtDate(b.uploaded_at)}{b.filename && <> · <span dir="ltr">{b.filename}</span></>}</>} icon="upload">
        <Indicator color={STATUS_COLOR[b.status]}>{t('st_' + b.status)}</Indicator>
        {b.can.approve_lead && <button className="btn btn-primary btn-sm" onClick={() => setDlg({ mode: 'lead' })}>{t('approve')} — {t('approval_lead')}</button>}
        {b.can.approve_final && <button className="btn btn-primary btn-sm" onClick={() => setDlg({ mode: 'final' })}>{t('approve')} — {t('approval_final')}</button>}
        {b.can.reject && <button className="btn btn-default btn-sm" onClick={() => setDlg({ mode: 'reject' })}>{t('reject')}</button>}
      </PageHeader>

      {b.status === 'pending' && <Alert kind="orange">{t('two_approvals_hint')}</Alert>}
      {b.status === 'rejected' && <Alert kind="red"><b>{t('st_rejected')}</b> — {b.rejected_by_name} · {fmtDate(b.rejected_at)}<div>{b.reject_reason}</div></Alert>}
      {b.status === 'applied' && b.apply_result && <Alert kind="green">{t('applied_result', { a: b.apply_result.applied, s: b.apply_result.skipped })}</Alert>}

      <div className="grid-2">
        <Card title={t('result_change')}>
          <table className="table">
            <tbody>
              {(s.departments || []).map(d => <tr key={d.id}><td>{dname(d.id)}</td><td className="end"><Delta before={d.before} after={d.after} /></td></tr>)}
              {s.project && <tr><td><b>{t('project_total')}</b></td><td className="end"><Delta before={s.project.before} after={s.project.after} /></td></tr>}
            </tbody>
          </table>
        </Card>
        <Card title={t('approvals')}>
          <div className="signs">
            <Signature label={t('approval_lead')} who={b.lead_by_name} at={b.lead_at} note={b.lead_note} />
            <Signature label={t('approval_final')} who={b.final_by_name} at={b.final_at} note={b.final_note} />
          </div>
        </Card>
      </div>

      {!changes.length ? <Card><Empty>{t('import_no_changes')}</Empty></Card> : groups.map(g => {
        const a = appSum.get(g.app_id);
        return (
          <Card key={g.app_id} title={<span className="link-row"><Icon name={g.icon} size={15} /> <Link to={'/app/' + g.app_id}>{g.name}</Link></span>}
            actions={a && <Delta before={a.before} after={a.after} />}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('functions')}</th><th>{t('field')}</th><th>{t('before')}</th><th>{t('after')}</th>{b.status === 'applied' && <th />}</tr></thead>
                <tbody>
                  {g.rows.map(ch => (
                    <tr key={ch.id}>
                      <td>{ch.kind === 'function' ? <><span className="code">{ch.code}</span> <span lang="ar" dir="rtl">{ch.fn_name_ar}</span></> : t(ch.kind === 'report' ? 'kind_report' : 'kind_weight')}</td>
                      <td className="nowrap">{t(FIELD_LABEL[ch.field] || ch.field)}</td>
                      <td className="muted">{fmt(ch.field, ch.old_value)}</td>
                      <td><b>{fmt(ch.field, ch.new_value)}</b></td>
                      {b.status === 'applied' && <td>{ch.applied ? <Indicator color="green">✓</Indicator> : <Indicator color="red" title={ch.note}>✗</Indicator>}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}

      {dlg && <DecisionModal mode={dlg.mode} batchId={b.id} onClose={() => setDlg(null)}
        onDone={r => { setDlg(null); if (r?.applied) toast(t('applied_result', { a: r.applied_changes, s: r.skipped_changes })); else toast(t('saved')); reload(); }}
        errText={errText} />}
    </div>
  );
}

function DecisionModal({ mode, batchId, onClose, onDone, errText }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  const reject = mode === 'reject';
  const run = async () => {
    try {
      const r = reject ? await api.post(`/imports/${batchId}/reject`, { reason: text })
        : await api.post(`/imports/${batchId}/approve`, { stage: mode, note: text });
      onDone(r);
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={reject ? t('reject') : `${t('approve')} — ${t(mode === 'lead' ? 'approval_lead' : 'approval_final')}`} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={reject && !text.trim()} onClick={run}>{reject ? t('reject') : t('approve')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <Field label={reject ? t('reject_reason') + ' *' : t('approval_note')}>
        <textarea className="input" rows={4} maxLength={1000} value={text} onChange={e => setText(e.target.value)} />
      </Field>
    </Modal>
  );
}

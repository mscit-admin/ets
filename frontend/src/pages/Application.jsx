import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path, notFoundError } from '../lib/api.js';
import { pc, VENDOR_COLORS } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { PctEquation } from '../components/PctEquation.jsx';
import { Alert, Card, ErrorBox, Field, Indicator, Loading, Modal, PageHeader, toast, useLoad } from '../components/ui.jsx';

// "… with notes" statuses: choosing one makes the note mandatory (also enforced by the server).
const NOTE_REQUIRED = { test_status: 1, notif_status: 2, review_status: 3 };
const needsNote = f => Object.entries(NOTE_REQUIRED).some(([k, v]) => f[k] === v);

const FIELD_LABEL = { progress: 'progress', weight: 'weight', enabled: 'enabled', test_status: 'test_status',
  notif_status: 'notif_status', review_status: 'review_status', note: 'note' };

const SRC_COLOR = { design: 'blue', vendor_list: 'cyan', experience: 'purple', custom: 'gray' };

// Number input that only commits on blur / Enter (one request per edit, not per keystroke).
function NumCell({ value, min, max, step = 1, disabled, onCommit, label }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  const commit = () => {
    const n = Math.min(max, Math.max(min, parseFloat(v)));
    if (!Number.isFinite(n)) { setV(String(value)); return; }
    if (n !== +value) onCommit(n); else setV(String(value));
  };
  return (
    <input className="input input-sm num-input" type="number" min={min} max={max} step={step} value={v} disabled={disabled}
      aria-label={label} onChange={e => setV(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

function StatusSelect({ value, prefix, disabled, onChange, label }) {
  const { t } = useI18n();
  return (
    <select className={'input input-sm select-status s' + value} value={value} disabled={disabled} aria-label={label}
      onChange={e => onChange(parseInt(e.target.value, 10))}>
      {[0, 1, 2, 3].map(i => <option key={i} value={i}>{t(prefix + i)}</option>)}
    </select>
  );
}

export default function Application() {
  const { id } = useParams();
  const { t, nm, errText, fmtDate } = useI18n();
  const { data, error, loading, reload } = useLoad(() => api.get(path`/tracker/applications/${id}`)
    .then(d => (d?.application && Array.isArray(d.functions) ? d : Promise.reject(notFoundError()))), [id]);
  const [fns, setFns] = useState([]);
  const [filter, setFilter] = useState({ q: '', source: '', test: '', showOff: false, showRemoved: false });
  const [noteFor, setNoteFor] = useState(null);
  const [bulk, setBulk] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);   // {f, mode: 'remove' | 'restore' | 'toggle', enabled?}

  useEffect(() => { if (data) setFns(data.functions); }, [data]);

  const shown = useMemo(() => fns.filter(f =>
    (f.removed_at ? filter.showRemoved : (filter.showOff || f.enabled || f.source !== 'experience')) &&
    (!filter.source || f.source === filter.source) &&
    (filter.test === '' || f.test_status === +filter.test) &&
    (!filter.q || (f.name_ar + ' ' + (f.reference || '') + ' ' + f.note).toLowerCase().includes(filter.q.toLowerCase()))
  ), [fns, filter]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { application: a, department: d, can, settings } = data;
  // values waiting for the team lead, per function: { [function_id]: [{field, new_value, requested_by_name}] }
  // (add/remove/restore requests are listed in the lifecycle box above the table instead)
  const pendingByFn = {};
  for (const p of data.pending || []) {
    if (p.function_id && p.field !== 'removed' && p.field !== 'create') (pendingByFn[p.function_id] ||= []).push(p);
  }
  const calc = a.calc;
  const totalW = calc.fnWeight || 0;

  const patch = async (f, body) => {
    setFns(list => list.map(x => (x.id === f.id ? { ...x, ...body } : x)));
    try {
      const r = await api.patch(path`/tracker/functions/${f.id}`, body);
      if (r?.pending) toast(t('sent_for_approval'), 'blue');
      reload();
    } catch (e) {
      toast(errText(e), 'red');
      setFns(list => list.map(x => (x.id === f.id ? f : x)));
    }
  };

  const fmtPending = (field, v) => {
    const P = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_' };
    if (P[field]) return t(P[field] + v);
    if (field === 'progress') return '\u2066' + pc(v) + '%\u2069';   // keep "80.0%" in Arabic text
    if (field === 'enabled') return v ? '✓' : '✗';
    if (field === 'note') return '✎';
    return String(v);
  };

  // A "with notes" status on an item without a note opens the note window first;
  // status and note are then saved together (cancel = no change).
  const setStatus = (f, field, v) => {
    const after = { ...f, [field]: v };
    if (needsNote(after) && !(f.note || '').trim()) setNoteFor({ f, pending: { [field]: v } });
    else patch(f, { [field]: v });
  };

  const removedCount = fns.filter(f => f.removed_at).length;
  const pendingLife = (data.pending || []).filter(p => p.field === 'create' || p.field === 'removed');

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/">{t('nav_home')}</Link><Icon name="chevron" size={12} className="flip" />
        <Link to={'/department/' + d.id}>{nm(d, 'short')}</Link><Icon name="chevron" size={12} className="flip" />
        <span>{nm(a)}</span>
      </div>
      {data.needs_approval && <Alert kind="blue">{t('edits_need_lead_notice')}</Alert>}
      <PageHeader title={nm(a)} sub={a.sub_ar} icon={a.icon}>
        {(can.pct || can.tst) && <button className="btn btn-default btn-sm" onClick={() => setBulk(true)}>{t('bulk_set')}</button>}
        {can.tog && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> {t('add_function')}</button>}
      </PageHeader>

      <PctEquation calc={calc} settings={settings} />

      {(a.note_ar || a.addendum || a.scope_cut || a.extra_module) && (
        <Alert kind={a.scope_cut ? 'orange' : 'blue'}>
          <div className="row-tags mb-s">
            {a.addendum && <Indicator color="blue">{t('addendum')} {a.addendum}</Indicator>}
            {a.scope_cut && <Indicator color="orange">{t('scope_cut')}</Indicator>}
            {a.extra_module && <Indicator color="purple">{t('extra_module')}</Indicator>}
          </div>
          {a.note_ar && <div lang="ar" dir="rtl">{a.note_ar}</div>}
        </Alert>
      )}

      {pendingLife.length > 0 && (
        <Alert kind="blue">
          <b>{t('lifecycle_pending')}</b>
          <ul className="plain-list">
            {pendingLife.map((p, i) => (
              <li key={i}>{p.field === 'create' ? `＋ ${t('fn_add')}: ${p.new_value?.name_ar}` : p.new_value?.removed
                ? `－ ${t('fn_remove')}: ${fns.find(f => f.id === p.function_id)?.name_ar || ''} (${p.new_value.reason})`
                : `↺ ${t('fn_restore')}: ${fns.find(f => f.id === p.function_id)?.name_ar || ''}`} — <span className="muted">{p.requested_by_name}</span></li>
            ))}
          </ul>
        </Alert>
      )}

      <Card>
        <div className="filter-bar">
          <input className="input input-sm" placeholder={t('filter') + '…'} value={filter.q} onChange={e => setFilter({ ...filter, q: e.target.value })} />
          <select className="input input-sm" value={filter.source} onChange={e => setFilter({ ...filter, source: e.target.value })} aria-label={t('source')}>
            <option value="">{t('source')}: {t('all')}</option>
            {['design', 'vendor_list', 'experience', 'custom'].map(s => <option key={s} value={s}>{t('src_' + s)}</option>)}
          </select>
          <select className="input input-sm" value={filter.test} onChange={e => setFilter({ ...filter, test: e.target.value })} aria-label={t('test_status')}>
            <option value="">{t('test_status')}: {t('all')}</option>
            {[0, 1, 2, 3].map(i => <option key={i} value={i}>{t('ts_' + i)}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={filter.showOff} onChange={e => setFilter({ ...filter, showOff: e.target.checked })} /> {t('show_disabled')}</label>
          {removedCount > 0 && <label className="check"><input type="checkbox" checked={filter.showRemoved} onChange={e => setFilter({ ...filter, showRemoved: e.target.checked })} /> {t('show_removed', { n: removedCount })}</label>}
          <span className="muted small push">{shown.length} / {fns.length}</span>
        </div>

        <div className="table-wrap">
          <table className="table fn-table">
            <thead>
              <tr>
                <th className="w-check" title={t('enabled')}>✓</th>
                <th>{t('functions')}</th>
                <th className="num-col">{t('weight')}</th>
                <th className="num-col">{t('progress')} %</th>
                <th>{t('test_status')}</th>
                <th>{t('notif_status')}</th>
                <th>{t('review_status')}</th>
                <th className="w-check">{t('note')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(f => (
                <tr key={f.id} className={f.removed_at ? 'row-off row-removed' : f.enabled ? '' : 'row-off'}>
                  <td className="w-check">
                    <input type="checkbox" checked={f.enabled} disabled={!can.tog || !!f.removed_at} aria-label={t('enabled')}
                      title={f.enabled ? t('exclude_hint') : t('include_hint')}
                      onChange={e => setConfirm({ f, mode: 'toggle', enabled: e.target.checked })} />
                  </td>
                  <td className="fn-name">
                    <div lang="ar" dir="rtl">{f.name_ar}</div>
                    <div className="fn-meta">
                      <span className="code">{f.code}</span>
                      <Indicator color={SRC_COLOR[f.source]}>{t('src_' + f.source)}</Indicator>
                      {f.vendor_status > 0 && <Indicator color={VENDOR_COLORS[f.vendor_status]} title={t('vendor_status')}>{t('vs_' + f.vendor_status)}</Indicator>}
                      {f.reference && <span className="muted" lang="ar">{f.reference}</span>}
                      {f.enabled && totalW > 0 && <span className="muted">{t('share')} <span className="num">{pc((f.weight / totalW) * 100)}%</span></span>}
                      {f.updated_by_name && <span className="muted" title={fmtDate(f.updated_at)}>{t('last_updated_by', { name: f.updated_by_name })}</span>}
                      {pendingByFn[f.id] && (
                        <Link to="/approvals" className="pending-chip" title={pendingByFn[f.id].map(p => `${t(FIELD_LABEL[p.field] || p.field)}: ${fmtPending(p.field, p.new_value)} — ${p.requested_by_name}`).join('\n')}>
                          ⏳ {t('awaiting_approval')}: {pendingByFn[f.id].map(p => `${t(FIELD_LABEL[p.field] || p.field)} ${fmtPending(p.field, p.new_value)}`).join(' · ')}
                        </Link>
                      )}
                      {f.removed_at && <Indicator color="red" title={f.removed_reason}>{t('removed_by_on', { name: f.removed_by_name || '—', date: fmtDate(f.removed_at) })}</Indicator>}
                      {f.removed_at && <span className="muted">{t('reason')}: {f.removed_reason}</span>}
                      {can.tog && !f.removed_at && <button className="btn-link small red-text" onClick={() => setConfirm({ f, mode: 'remove' })}>{t('fn_remove')}</button>}
                      {can.tog && f.removed_at && <button className="btn-link small" onClick={() => setConfirm({ f, mode: 'restore' })}>{t('fn_restore')}</button>}
                    </div>
                  </td>
                  <td className="num-col"><NumCell value={f.weight} min={0} max={1000} step={0.5} disabled={!can.wgt || !f.enabled} label={t('weight')} onCommit={v => patch(f, { weight: v })} /></td>
                  <td className="num-col">
                    <NumCell value={f.progress} min={0} max={100} step={5} disabled={!can.pct || !f.enabled} label={t('progress')} onCommit={v => patch(f, { progress: v })} />
                    <div className="mini-progress"><i style={{ width: f.progress + '%' }} /></div>
                  </td>
                  <td><StatusSelect value={f.test_status} prefix="ts_" disabled={!can.tst || !f.enabled} label={t('test_status')} onChange={v => setStatus(f, 'test_status', v)} /></td>
                  <td><StatusSelect value={f.notif_status} prefix="ns_" disabled={!can.pct || !f.enabled} label={t('notif_status')} onChange={v => setStatus(f, 'notif_status', v)} /></td>
                  <td><StatusSelect value={f.review_status} prefix="rv_" disabled={!can.tst || !f.enabled} label={t('review_status')} onChange={v => setStatus(f, 'review_status', v)} /></td>
                  <td className="w-check">
                    <button className={'btn-icon' + (f.note ? ' has-note' : needsNote(f) ? ' note-missing' : '')} onClick={() => setNoteFor({ f })}
                      title={f.note || (needsNote(f) ? t('note_required_hint') : t('edit_note'))} aria-label={t('edit_note')}>
                      <Icon name="note" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {noteFor && <NoteModal f={noteFor.f} pending={noteFor.pending} canEdit={can.tst || !!noteFor.pending}
        onClose={() => setNoteFor(null)} onSave={async note => { await patch(noteFor.f, { ...(noteFor.pending || {}), note }); setNoteFor(null); }} />}
      {bulk && <BulkModal app={a} can={can} onClose={() => setBulk(false)} onDone={() => { setBulk(false); reload(); }} />}
      {adding && <AddModal app={a} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {confirm && <ConfirmModal app={a} {...confirm} onClose={() => setConfirm(null)}
        onDone={async () => {
          if (confirm.mode === 'toggle') { setConfirm(null); await patch(confirm.f, { enabled: confirm.enabled }); return; }
          setConfirm(null); reload();
        }} />}
    </div>
  );
}

function NoteModal({ f, pending, canEdit, onClose, onSave }) {
  const { t } = useI18n();
  const [v, setV] = useState(f.note || '');
  const after = { ...f, ...(pending || {}) };
  const required = needsNote(after);
  const empty = !v.trim();
  // which "with notes" status(es) make the note mandatory, e.g. "حالة الاختبار: نجح مع ملاحظة"
  const reasons = Object.entries(NOTE_REQUIRED).filter(([k, val]) => after[k] === val)
    .map(([k, val]) => `${t({ test_status: 'test_status', notif_status: 'notif_status', review_status: 'review_status' }[k])}: ${t({ test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_' }[k] + val)}`);
  return (
    <Modal title={required ? t('note_required_title') : t('edit_note')} onClose={onClose}
      footer={canEdit && <>
        {!pending && <button className="btn btn-default" disabled={required} title={required ? t('note_required_hint') : ''} onClick={() => onSave('')}>{t('clear')}</button>}
        {pending && <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>}
        <button className="btn btn-primary" disabled={required && empty} onClick={() => onSave(v)}>{t('save')}</button>
      </>}>
      <p className="muted small" lang="ar" dir="rtl">{f.name_ar}</p>
      {required && <Alert kind="orange">{t('note_required_msg')} <b>{reasons.join(' · ')}</b></Alert>}
      <textarea className={'input' + (required && empty ? ' input-required' : '')} rows={6} maxLength={2000} value={v} readOnly={!canEdit}
        autoFocus onChange={e => setV(e.target.value)} placeholder={required ? t('note_required_placeholder') : ''} />
    </Modal>
  );
}

function BulkModal({ app, can, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [field, setField] = useState(can.pct ? 'progress' : 'test_status');
  const [value, setValue] = useState(field === 'progress' ? 100 : 2);
  const [err, setErr] = useState(null);
  const run = async () => {
    try {
      const r = await api.post(path`/tracker/applications/${app.id}/bulk`, { field, value: +value });
      toast(r.pending ? t('sent_for_approval') : t('done_n', { n: r.updated }), r.pending ? 'blue' : 'green'); onDone();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={t('bulk_set')} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button><button className="btn btn-primary" onClick={run}>{t('apply')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <Field label={t('bulk_set')}>
        <select className="input" value={field} onChange={e => { setField(e.target.value); setValue(e.target.value === 'progress' ? 100 : 2); }}>
          {can.pct && <option value="progress">{t('bulk_progress')}</option>}
          {can.tst && <option value="test_status">{t('bulk_test')}</option>}
        </select>
      </Field>
      {field === 'progress'
        ? <Field label={t('progress') + ' %'}><input className="input" type="number" min={0} max={100} value={value} onChange={e => setValue(e.target.value)} /></Field>
        : <Field label={t('test_status')}><select className="input" value={value} onChange={e => setValue(e.target.value)}>{[0, 1, 2, 3].map(i => <option key={i} value={i}>{t('ts_' + i)}</option>)}</select></Field>}
    </Modal>
  );
}

// Before → after percentages of the application, its department and the project for a proposed change.
function useImpact(appId, body, key) {
  const [v, setV] = useState(null);
  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      api.post(path`/tracker/applications/${appId}/impact`, body).then(r => { if (alive) setV(r); }).catch(() => { if (alive) setV(null); });
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [appId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

function ImpactTable({ impact }) {
  const { t } = useI18n();
  if (!impact) return <div className="muted small">{t('loading')}…</div>;
  const rows = [['app', t('application')], ['dept', t('department')], ['total', t('project')]];
  return (
    <div className="impact">
      <div className="impact-title">{t('impact_title')}</div>
      <table className="table">
        <thead><tr><th /><th className="num-col">{t('before')}</th><th className="num-col">{t('after')}</th><th className="num-col">{t('change')}</th></tr></thead>
        <tbody>
          {rows.map(([k, label]) => {
            const d = impact[k].after - impact[k].before;
            return (
              <tr key={k}>
                <td>{label}</td>
                <td className="num-col num">{pc(impact[k].before)}%</td>
                <td className="num-col num"><b>{pc(impact[k].after)}%</b></td>
                <td className={'num-col num ' + (Math.abs(d) < 0.05 ? 'muted' : d > 0 ? 'green-text' : 'red-text')}>{Math.abs(d) < 0.05 ? '—' : (d > 0 ? '+' : '') + pc(d)}</td>
              </tr>
            );
          })}
          <tr><td>{t('included_functions')}</td><td className="num-col num">{impact.included.before}</td><td className="num-col num"><b>{impact.included.after}</b></td>
            <td className="num-col num muted">{(d => (d > 0 ? '+' + d : d || '—'))(impact.included.after - impact.included.before)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function AddModal({ app, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [f, setF] = useState({ name_ar: '', name_en: '', reference: '', weight: 1, progress: 0, enabled: true });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const preview = { weight: +f.weight || 0, progress: +f.progress || 0, enabled: f.enabled };
  const impact = useImpact(app.id, { add: preview }, JSON.stringify(preview));
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/applications/${app.id}/functions`, { ...f, weight: +f.weight, progress: +f.progress });
      toast(r?.pending ? t('sent_for_approval') : t('fn_added'), r?.pending ? 'blue' : 'green'); onDone();
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  return (
    <Modal title={t('add_function')} onClose={onClose} wide
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={run} disabled={!f.name_ar.trim() || busy}>{t('confirm_add')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <Field label={t('fn_name_ar') + ' *'}><textarea className="input" rows={2} lang="ar" dir="rtl" value={f.name_ar} onChange={e => setF({ ...f, name_ar: e.target.value })} /></Field>
      <div className="form-grid">
        <Field label={t('fn_name_en')}><input className="input" dir="ltr" value={f.name_en} onChange={e => setF({ ...f, name_en: e.target.value })} /></Field>
        <Field label={t('requirement_reason')}><input className="input" value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label={t('weight')}><input className="input" type="number" min={0} max={1000} step={0.5} value={f.weight} onChange={e => setF({ ...f, weight: e.target.value })} /></Field>
        <Field label={t('progress') + ' %'}><input className="input" type="number" min={0} max={100} step={5} value={f.progress} onChange={e => setF({ ...f, progress: e.target.value })} /></Field>
      </div>
      <label className="check mb"><input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} /> <b>{t('include_in_calc')}</b></label>
      <ImpactTable impact={impact} />
    </Modal>
  );
}

// Confirmation with impact for: remove (reason required), restore, include / exclude.
function ConfirmModal({ app, f, mode, enabled, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const body = mode === 'remove' ? { drop: [f.id] } : { set: [{ function_id: f.id, enabled: mode === 'restore' ? true : enabled }] };
  const impact = useImpact(app.id, body, mode + f.id + enabled);
  const title = { remove: t('fn_remove_title'), restore: t('fn_restore_title'), toggle: enabled ? t('include_title') : t('exclude_title') }[mode];
  const run = async () => {
    if (mode === 'toggle') return onDone();
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/functions/${f.id}/${mode}`, mode === 'remove' ? { reason } : {});
      toast(r?.pending ? t('sent_for_approval') : mode === 'remove' ? t('fn_removed') : t('fn_restored'), r?.pending ? 'blue' : 'green');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} wide
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className={'btn ' + (mode === 'remove' ? 'btn-danger' : 'btn-primary')} disabled={busy || (mode === 'remove' && !reason.trim())} onClick={run}>
          {{ remove: t('confirm_remove'), restore: t('confirm_restore'), toggle: enabled ? t('confirm_include') : t('confirm_exclude') }[mode]}
        </button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <p lang="ar" dir="rtl"><span className="code">{f.code}</span> {f.name_ar}</p>
      {mode === 'remove' && <Alert kind="orange">{f.source === 'custom' ? t('fn_remove_msg_custom') : t('fn_remove_msg_scope')}</Alert>}
      {mode === 'toggle' && <Alert kind="blue">{enabled ? t('include_msg') : t('exclude_msg')}</Alert>}
      {mode === 'remove' && <Field label={t('remove_reason') + ' *'}><textarea className="input" rows={3} maxLength={1000} value={reason} autoFocus onChange={e => setReason(e.target.value)} /></Field>}
      <ImpactTable impact={impact} />
    </Modal>
  );
}

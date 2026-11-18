import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { Alert, Card, ErrorBox, Loading, Modal, Field, toast, useLoad } from './ui.jsx';
import { Icon } from './Icon.jsx';
import { IconPicker } from './IconPicker.jsx';
import { useLiveUpdates } from '../lib/live.js';

const DEPT_COLORS = ['#2490ef', '#29cd42', '#ecad4b', '#e24c4c', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f97316', '#6366f1', '#64748b'];

// Create / edit dialog for a department.
function DepartmentDialog({ dept, onClose, onSaved }) {
  const { t, errText } = useI18n();
  const editing = !!dept;
  const [f, setF] = useState(() => ({
    name_ar: dept?.name_ar || '', name_en: dept?.name_en || '', short_ar: dept?.short_ar || '', short_en: dept?.short_en || '',
    color: dept?.color || DEPT_COLORS[0], emblem: dept?.emblem || 'layers', is_base: !!dept?.is_base,
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = p => setF(x => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = editing ? await api.patch(`/tracker/departments/${dept.id}`, f) : await api.post('/tracker/departments', f);
      toast(t('saved')); onSaved(r.department);
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={editing ? t('str_edit_dept') : t('str_add_dept')} onClose={onClose}
      footer={<>
        <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !f.name_ar.trim()}>{busy ? t('saving') : t('save')}</button>
      </>}>
      {err && <Alert>{errText(err)}</Alert>}
      <Field label={t('str_name_ar')}><input className="input" value={f.name_ar} onChange={e => set({ name_ar: e.target.value })} maxLength={200} /></Field>
      <Field label={t('str_name_en')}><input className="input" value={f.name_en} onChange={e => set({ name_en: e.target.value })} maxLength={200} dir="ltr" /></Field>
      <div className="row gap wrap">
        <Field label={t('str_short_ar')} className="grow"><input className="input" value={f.short_ar} onChange={e => set({ short_ar: e.target.value })} maxLength={120} placeholder={f.name_ar} /></Field>
        <Field label={t('str_short_en')} className="grow"><input className="input" value={f.short_en} onChange={e => set({ short_en: e.target.value })} maxLength={120} dir="ltr" placeholder={f.name_en} /></Field>
      </div>
      <div className="row gap wrap" style={{ alignItems: 'flex-end' }}>
        <Field label={t('str_emblem')}><IconPicker value={f.emblem} onChange={v => set({ emblem: v })} label={t('str_emblem')} /></Field>
        <Field label={t('str_color')} className="grow">
          <div className="row gap wrap" style={{ alignItems: 'center' }}>
            {DEPT_COLORS.map(c => (
              <button key={c} type="button" aria-label={c} onClick={() => set({ color: c })}
                className={'color-dot' + (f.color === c ? ' on' : '')} style={{ background: c }} />
            ))}
            <input type="color" className="color-input" value={f.color} onChange={e => set({ color: e.target.value })} aria-label={t('str_color')} />
          </div>
        </Field>
      </div>
      <Field label=""><label className="row gap" style={{ alignItems: 'center' }}>
        <input type="checkbox" checked={f.is_base} onChange={e => set({ is_base: e.target.checked })} />
        <span>{t('str_is_base')}</span>
      </label></Field>
      <p className="muted small">{t('str_is_base_hint')}</p>
    </Modal>
  );
}

// Create / edit dialog for an application (weight only on create; editing weight stays in the Weights screen).
function ApplicationDialog({ deptId, app, onClose, onSaved }) {
  const { t, errText } = useI18n();
  const editing = !!app;
  const [f, setF] = useState(() => ({
    name_ar: app?.name_ar || '', name_en: app?.name_en || '', sub_ar: app?.sub_ar || '',
    icon: app?.icon || 'item_function', note_ar: app?.note_ar || '', weight: app?.weight != null ? String(app.weight) : '1',
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = p => setF(x => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { name_ar: f.name_ar, name_en: f.name_en, sub_ar: f.sub_ar, icon: f.icon, note_ar: f.note_ar };
      const r = editing ? await api.patch(`/tracker/applications/${app.id}`, body)
        : await api.post(`/tracker/departments/${deptId}/applications`, { ...body, weight: +f.weight });
      toast(t('saved')); onSaved(r.application);
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={editing ? t('str_edit_app') : t('str_add_app')} onClose={onClose}
      footer={<>
        <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !f.name_ar.trim()}>{busy ? t('saving') : t('save')}</button>
      </>}>
      {err && <Alert>{errText(err)}</Alert>}
      <Field label={t('str_name_ar')}><input className="input" value={f.name_ar} onChange={e => set({ name_ar: e.target.value })} maxLength={300} /></Field>
      <Field label={t('str_name_en')}><input className="input" value={f.name_en} onChange={e => set({ name_en: e.target.value })} maxLength={300} dir="ltr" /></Field>
      <Field label={t('str_sub_ar')}><input className="input" value={f.sub_ar} onChange={e => set({ sub_ar: e.target.value })} maxLength={300} /></Field>
      <div className="row gap wrap" style={{ alignItems: 'flex-end' }}>
        <Field label={t('str_icon')}><IconPicker value={f.icon} onChange={v => set({ icon: v })} label={t('str_icon')} /></Field>
        {!editing && (
          <Field label={t('str_weight')} className="grow">
            <input className="input" type="number" min={0} max={100000} step={0.5} value={f.weight} onChange={e => set({ weight: e.target.value })} />
          </Field>
        )}
      </div>
      {editing && <p className="muted small">{t('str_weight_in_weights')}</p>}
      <Field label={t('str_note_ar')}><textarea className="input" rows={2} value={f.note_ar} onChange={e => set({ note_ar: e.target.value })} maxLength={2000} /></Field>
    </Modal>
  );
}

// Archive confirmation (with an optional reason). Used for both a department and an application.
function ArchiveDialog({ kind, row, onClose, onDone }) {
  const { t, errText, nm } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/tracker/${kind === 'dept' ? 'departments' : 'applications'}/${row.id}/archive`, { reason });
      toast(t('str_archived')); onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={t('str_archive_title')} onClose={onClose}
      footer={<>
        <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-danger" onClick={go} disabled={busy}>{busy ? t('saving') : t('str_archive')}</button>
      </>}>
      {err && <Alert>{errText(err)}</Alert>}
      <p>{t('str_archive_confirm', { name: nm(row) })}</p>
      <p className="muted small">{t('str_archive_note')}</p>
      <Field label={t('str_archive_reason')}><input className="input" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /></Field>
    </Modal>
  );
}

// The structure screen (Settings → «إدارة الهيكلة», permission 'str'): a tree of departments → applications, with
// add / edit / archive at each level. Functions are managed on the application page (link), reusing the existing UI.
export function StructureSection() {
  const { t, nm, errText } = useI18n();
  const { data, error, loading, reload, refresh } = useLoad(o => api.get('/tracker/structure', o), []);
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState(null);           // { type, deptId?, dept?, app?, row?, kind? }
  const [actErr, setActErr] = useState(null);
  useLiveUpdates(refresh);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const close = () => setDialog(null);
  const saved = () => { close(); reload(); };
  const act = async (fn) => { setActErr(null); try { await fn(); reload(); } catch (e) { setActErr(e); } };
  const restoreDept = d => act(() => api.post(`/tracker/departments/${d.id}/restore`));
  const restoreApp = a => act(() => api.post(`/tracker/applications/${a.id}/restore`));

  const appsOf = id => data.applications.filter(a => a.department_id === id);
  const liveDepts = data.departments.filter(d => !d.archived_at);
  const archivedDepts = data.departments.filter(d => d.archived_at);
  const hasArchived = archivedDepts.length > 0 || data.applications.some(a => a.archived_at);

  const DeptBlock = ({ d }) => {
    const apps = appsOf(d.id);
    const live = apps.filter(a => !a.archived_at);
    const arch = apps.filter(a => a.archived_at);
    return (
      <div className={'str-dept' + (d.archived_at ? ' archived' : '')}>
        <div className="str-dept-head">
          <span className="str-emblem" style={{ color: d.color }}><Icon name={d.emblem || 'layers'} size={20} /></span>
          <span className="str-names">
            <b>{nm(d)}{d.is_base && <span className="chip">{t('str_base_chip')}</span>}{d.archived_at && <span className="chip gray">{t('str_archived_chip')}</span>}</b>
            <span className="muted small">{d.name_en} · {t('str_app_count', { n: d.active_app_count })}</span>
          </span>
          <span className="str-actions">
            {!d.archived_at && <>
              <button className="btn btn-default btn-xs" onClick={() => setDialog({ type: 'app', deptId: d.id })}><Icon name="plus" size={13} /> {t('str_add_app')}</button>
              <button className="btn-icon btn-xs" title={t('edit')} aria-label={t('edit')} onClick={() => setDialog({ type: 'dept', dept: d })}><Icon name="edit" size={15} /></button>
              <button className="btn-icon btn-xs" title={t('str_archive')} aria-label={t('str_archive')} onClick={() => setDialog({ type: 'archive', kind: 'dept', row: d })}><Icon name="archive" size={15} /></button>
            </>}
            {d.archived_at && <button className="btn btn-default btn-xs" onClick={() => restoreDept(d)}><Icon name="refresh" size={13} /> {t('str_restore')}</button>}
          </span>
        </div>
        {(live.length > 0 || (showArchived && arch.length > 0)) && (
          <ul className="str-apps">
            {live.map(a => <AppRow key={a.id} a={a} />)}
            {showArchived && arch.map(a => <AppRow key={a.id} a={a} />)}
          </ul>
        )}
      </div>
    );
  };

  const AppRow = ({ a }) => (
    <li className={'str-app' + (a.archived_at ? ' archived' : '')}>
      <span className="str-app-icon"><Icon name={a.icon || 'item_function'} size={16} /></span>
      <span className="str-app-names">
        <Link to={'/app/' + a.id}><b>{nm(a)}</b></Link>
        {a.archived_at && <span className="chip gray">{t('str_archived_chip')}</span>}
        <span className="muted small">{t('str_fn_count', { n: a.function_count })} · {t('str_weight')} {(+a.weight).toString()}</span>
      </span>
      <span className="str-actions">
        {!a.archived_at && <>
          <Link to={'/app/' + a.id} className="btn btn-default btn-xs">{t('str_manage_functions')}</Link>
          <button className="btn-icon btn-xs" title={t('edit')} aria-label={t('edit')} onClick={() => setDialog({ type: 'app', app: a, deptId: a.department_id })}><Icon name="edit" size={14} /></button>
          <button className="btn-icon btn-xs" title={t('str_archive')} aria-label={t('str_archive')} onClick={() => setDialog({ type: 'archive', kind: 'app', row: a })}><Icon name="archive" size={14} /></button>
        </>}
        {a.archived_at && <button className="btn btn-default btn-xs" onClick={() => restoreApp(a)}><Icon name="refresh" size={13} /> {t('str_restore')}</button>}
      </span>
    </li>
  );

  return (
    <div className="str-section">
      <div className="mb"><span className="muted small">{t('str_intro')}</span></div>
      {actErr && <Alert>{errText(actErr)}</Alert>}
      <Card title={t('str_title')} actions={
        <div className="row gap wrap" style={{ alignItems: 'center' }}>
          {hasArchived && (
            <label className="row gap small" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> <span className="muted">{t('str_show_archived')}</span>
            </label>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => setDialog({ type: 'dept' })}><Icon name="plus" size={14} /> {t('str_add_dept')}</button>
        </div>}>
        <div className="str-tree">
          {liveDepts.map(d => <DeptBlock key={d.id} d={d} />)}
          {liveDepts.length === 0 && <p className="muted">{t('str_empty')}</p>}
          {showArchived && archivedDepts.map(d => <DeptBlock key={d.id} d={d} />)}
        </div>
      </Card>

      {dialog?.type === 'dept' && <DepartmentDialog dept={dialog.dept} onClose={close} onSaved={saved} />}
      {dialog?.type === 'app' && <ApplicationDialog deptId={dialog.deptId} app={dialog.app} onClose={close} onSaved={saved} />}
      {dialog?.type === 'archive' && <ArchiveDialog kind={dialog.kind} row={dialog.row} onClose={close} onDone={saved} />}
    </div>
  );
}

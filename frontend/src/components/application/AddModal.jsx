import { useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { api, path } from '../../lib/api.js';
import { Alert, Field, Modal, toast } from '../ui.jsx';
import { ImpactTable, TypeChoice, useImpact } from './common.jsx';

export function AddModal({ app, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [f, setF] = useState({ name_ar: '', name_en: '', reference: '', weight: 1, progress: 0, enabled: true, item_type: 'function' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const preview = { weight: +f.weight || 0, progress: +f.progress || 0, enabled: f.enabled, item_type: f.item_type };
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
      <TypeChoice value={f.item_type} onChange={v => setF({ ...f, item_type: v })} label={t('item_type')} />
      <label className="check mb"><input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} /> <b>{t('include_in_calc')}</b></label>
      <ImpactTable impact={impact} />
    </Modal>
  );
}

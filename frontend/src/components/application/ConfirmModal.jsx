import { useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { api, path } from '../../lib/api.js';
import { Alert, Field, Modal, toast } from '../ui.jsx';
import { DisableReasonForm } from '../DisableReason.jsx';
import { ImpactTable, useImpact } from './common.jsx';
import { emptyReason, noteProblem, reasonBody, reasonProblem } from '../../lib/itemRules.js';

// Confirmation with impact for: remove (reason required), restore, include / exclude (exclusion: reason required).
export function ConfirmModal({ app, f, mode, enabled, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [reason, setReason] = useState('');
  const [why, setWhy] = useState(emptyReason);          // why it is excluded (unticked)
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const excluding = mode === 'toggle' && !enabled;
  const body = mode === 'remove' ? { drop: [f.id] } : { set: [{ function_id: f.id, enabled: mode === 'restore' ? true : enabled }] };
  const impact = useImpact(app.id, body, mode + f.id + enabled);
  const title = { remove: t('fn_remove_title'), restore: t('fn_restore_title'), toggle: enabled ? t('include_title') : t('exclude_title') }[mode];
  const run = async () => {
    if (excluding) {
      setTried(true);
      if (reasonProblem(why)) return;
      setBusy(true); setErr(null);
      try {
        const r = await api.patch(path`/tracker/functions/${f.id}`, { enabled: false, ...reasonBody(why) });
        toast(r?.pending ? t('sent_for_approval') : t('fn_excluded'), r?.pending ? 'blue' : 'green');
        onDone();
      } catch (e) { setErr(e); setBusy(false); }
      return;
    }
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
        <button className={'btn ' + (mode === 'remove' ? 'btn-danger' : 'btn-primary')} disabled={busy || (mode === 'remove' && !reason.trim()) || (excluding && !!noteProblem(why))} onClick={run}>
          {{ remove: t('confirm_remove'), restore: t('confirm_restore'), toggle: enabled ? t('confirm_include') : t('confirm_exclude') }[mode]}
        </button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <p lang="ar" dir="rtl"><span className="code">{f.code}</span> {f.name_ar}</p>
      {mode === 'remove' && <Alert kind="orange">{f.source === 'custom' ? t('fn_remove_msg_custom') : t('fn_remove_msg_scope')}</Alert>}
      {mode === 'toggle' && <Alert kind="blue">{enabled ? t('include_msg') : t('exclude_msg')}</Alert>}
      {excluding && <DisableReasonForm appId={app.id} excludeIds={[f.id]} value={why} onChange={setWhy} showErrors={tried} />}
      {mode === 'remove' && <Field label={t('remove_reason') + ' *'}><textarea className="input" rows={3} maxLength={1000} value={reason} autoFocus onChange={e => setReason(e.target.value)} /></Field>}
      <ImpactTable impact={impact} />
    </Modal>
  );
}

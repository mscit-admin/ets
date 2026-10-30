import { useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { api, path } from '../../lib/api.js';
import { Alert, Field, Modal, toast } from '../ui.jsx';
import { Icon } from '../Icon.jsx';

// Reopen a closed function (migration 033): requires BOTH an attached official document (PDF or image) AND a written
// reason. The document is read as a data: URL in the browser (like a branding upload) and sent in the JSON body.
const REOPEN_DOC_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,.pdf';
const REOPEN_DOC_MAX = 3 * 1024 * 1024;
const REOPEN_REASON_MIN = 3;
export function ReopenModal({ f, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [file, setFile] = useState(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const tooBig = file && file.size > REOPEN_DOC_MAX;
  const reasonShort = reason.replace(/\s/gu, '').length < REOPEN_REASON_MIN;
  const run = async () => {
    setTried(true);
    if (!file || tooBig || reasonShort) return;
    setBusy(true); setErr(null);
    try {
      const document = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      await api.post(path`/tracker/functions/${f.id}/reopen`, { document, reason: reason.trim() });
      toast(t('reopen_done'), 'green'); onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={t('reopen_title')} onClose={onClose} wide
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={run} disabled={busy || !file || tooBig || reasonShort}><Icon name="restore" size={14} /> {t('confirm_reopen')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <p lang="ar" dir="rtl"><span className="code">{f.code}</span> {f.name_ar}</p>
      <Alert kind="orange">{t('reopen_msg')}</Alert>
      <Field label={t('reopen_doc_label') + ' *'}>
        <label className="btn btn-default">
          <Icon name="upload" size={14} /> {file ? file.name : t('reopen_doc_pick')}
          <input type="file" accept={REOPEN_DOC_ACCEPT} hidden onChange={e => { setFile(e.target.files[0] || null); e.target.value = ''; }} />
        </label>
        <span className="field-hint">{t('reopen_doc_hint')}</span>
        {tooBig && <span className="field-hint red-text">{t('err_reopen_doc_too_large', { max_kb: Math.round(REOPEN_DOC_MAX / 1024) })}</span>}
        {tried && !file && <span className="field-hint red-text">{t('reopen_doc_missing')}</span>}
      </Field>
      <Field label={t('reopen_reason_label') + ' *'}>
        <textarea className={'input' + (tried && reasonShort ? ' input-required' : '')} rows={3} maxLength={500} value={reason}
          onChange={e => setReason(e.target.value)} placeholder={t('reopen_reason_placeholder')} />
        {tried && reasonShort && <span className="field-hint red-text">{t('reopen_reason_short', { min: REOPEN_REASON_MIN })}</span>}
      </Field>
    </Modal>
  );
}

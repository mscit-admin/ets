import { useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { api, path } from '../../lib/api.js';
import { Alert, Modal, toast } from '../ui.jsx';
import { Icon } from '../Icon.jsx';

// Close / lock a finished function (migration 033): a holder of 'apv_final' marks it as done. It becomes read-only and
// counts as 100 % in the calculation while staying counted — it is NOT excluded.
export function CloseModal({ f, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { await api.post(path`/tracker/functions/${f.id}/close`); toast(t('close_done'), 'green'); onDone(); }
    catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={t('close_title')} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={run} disabled={busy}><Icon name="lock" size={14} /> {t('confirm_close')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <p lang="ar" dir="rtl"><span className="code">{f.code}</span> {f.name_ar}</p>
      <Alert kind="blue">{t('close_msg')}</Alert>
    </Modal>
  );
}

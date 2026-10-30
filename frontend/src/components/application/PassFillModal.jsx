import { useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { Alert, Modal } from '../ui.jsx';
import { pctText } from '../../lib/itemRules.js';

// Confirm the «نجح» auto-fill (1.12.21): choosing «نجح» on an item below 100 % brings its progress up to 100 %.
// Confirm → the status and the progress are saved together; cancel → nothing is saved (the select reverts on its own).
export function PassFillModal({ f, onClose, onConfirm }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { await onConfirm(); } catch { setBusy(false); } };
  return (
    <Modal title={t('pass_fill_title')} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={run} disabled={busy}>{t('pass_fill_confirm')}</button></>}>
      <p lang="ar" dir="rtl"><span className="code">{f.code}</span> {f.name_ar}</p>
      <Alert kind="blue">{t('pass_fill_msg', { progress: pctText(f.progress) })}</Alert>
    </Modal>
  );
}

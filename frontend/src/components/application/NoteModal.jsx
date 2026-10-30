import { useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { Alert, Modal } from '../ui.jsx';
import { needsNote, noteReasons } from '../../lib/itemRules.js';

export function NoteModal({ f, pending, canEdit, onClose, onSave }) {
  const { t } = useI18n();
  const [v, setV] = useState(f.note || '');
  const after = { ...f, ...(pending || {}) };
  const required = needsNote(after);
  const empty = !v.trim();
  // which "with notes" status(es) make the note mandatory, e.g. "حالة الاختبار: نجح مع ملاحظة"
  const reasons = noteReasons(t, after);
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

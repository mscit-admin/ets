import { useId, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';
import { Alert, Modal, toast } from './ui.jsx';

// Renaming a function / report item (1.9.1, backend services/rename.js): the code stays, the Arabic name is required,
// the English name may be cleared, and the reason is required — same rule as the exclusion note: 3–500 characters,
// spaces not counted. The rename is sent on its own; a member's rename waits for the team lead (202).
export const NAME_MAX = 500;
export const REASON_MIN = 3, REASON_MAX = 500;

export function reasonProblem(v) {
  const r = v.trim();
  if (r.length > REASON_MAX) return 'rn_reason_too_long';
  if (r.replace(/\s/gu, '').length < REASON_MIN) return 'rn_reason_required';
  return null;
}

// f: the item; others: the other items of the application (for the "same name" notice); onDone(): after saving.
export function RenameDialog({ f, others = [], onClose, onDone }) {
  const { t, errText } = useI18n();
  const uid = useId();
  const [ar, setAr] = useState(f.name_ar || '');
  const [en, setEn] = useState(f.name_en || '');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const newAr = ar.trim(), newEn = en.trim();
  const arChanged = newAr !== f.name_ar, enChanged = newEn !== (f.name_en || '');
  const arProblem = !newAr ? 'rn_name_required' : newAr.length > NAME_MAX ? 'rn_name_too_long' : null;
  const enProblem = newEn.length > NAME_MAX ? 'rn_name_too_long' : null;
  const rProblem = reasonProblem(reason);
  const unchanged = !arChanged && !enChanged;
  const ok = !arProblem && !enProblem && !rProblem && !unchanged;
  const showReasonErr = !!rProblem && touched;
  const dup = arChanged && newAr && others.some(o => o.id !== f.id && !o.removed_at && (o.name_ar || '').trim().toLowerCase() === newAr.toLowerCase());
  const len = reason.trim().length;

  const run = async () => {
    if (!ok || busy) return;
    setBusy(true); setErr(null);
    try {
      const body = { rename_reason: reason.trim(), ...(arChanged ? { name_ar: newAr } : {}), ...(enChanged ? { name_en: newEn || null } : {}) };
      const r = await api.patch(path`/tracker/functions/${f.id}`, body);
      toast(r?.pending ? t('sent_for_approval') : t('rn_done'), r?.pending ? 'blue' : 'green');
      if (r?.warning === 'duplicate_name') toast(t('rn_duplicate_notice'), 'orange');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };

  return (
    <Modal title={t('rn_title')} onClose={onClose} wide
      footer={<>
        <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={!ok || busy} onClick={run}
          title={unchanged ? t('rn_unchanged') : rProblem ? t(rProblem, { min: REASON_MIN }) : ''}>{t('rn_confirm')}</button>
      </>}>
      {err && <Alert>{errText(err)}</Alert>}
      <dl className="rn-current">
        <div><dt>{t('rn_code')}</dt><dd><span className="code">{f.code}</span> <span className="muted small">{t('rn_code_fixed')}</span></dd></div>
        <div><dt>{t('rn_current')}</dt><dd lang="ar" dir="rtl">{f.name_ar}{f.name_en && <div className="muted small" lang="en" dir="ltr">{f.name_en}</div>}</dd></div>
      </dl>
      <div className="field">
        <label className="field-label" htmlFor={uid + '-ar'}>{t('rn_new_ar')} *</label>
        <textarea id={uid + '-ar'} className={'input' + (arProblem ? ' input-required' : '')} rows={2} lang="ar" dir="rtl"
          maxLength={NAME_MAX + 50} value={ar} onChange={e => setAr(e.target.value)} required aria-required="true"
          aria-invalid={!!arProblem || undefined} aria-describedby={arProblem ? uid + '-are' : undefined} />
        {arProblem && <span id={uid + '-are'} className="field-hint red-text">{t(arProblem, { max: NAME_MAX })}</span>}
      </div>
      {dup && <Alert kind="orange">{t('rn_duplicate_notice')}</Alert>}
      <div className="field">
        <label className="field-label" htmlFor={uid + '-en'}>{t('rn_new_en')}</label>
        <input id={uid + '-en'} className="input" lang="en" dir="ltr" maxLength={NAME_MAX + 50} value={en} onChange={e => setEn(e.target.value)}
          aria-invalid={!!enProblem || undefined} aria-describedby={uid + '-enh'} />
        <span id={uid + '-enh'} className={'field-hint' + (enProblem ? ' red-text' : '')}>{enProblem ? t(enProblem, { max: NAME_MAX }) : t('rn_en_hint')}</span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={uid + '-r'}>{t('rn_reason')} *</label>
        <textarea id={uid + '-r'} className={'input' + (showReasonErr ? ' input-required' : '')} rows={3} maxLength={REASON_MAX + 50} value={reason}
          onChange={e => { setReason(e.target.value); if (e.target.value.trim()) setTouched(true); }} onBlur={() => setTouched(true)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); }}
          required aria-required="true" aria-invalid={showReasonErr || undefined}
          aria-describedby={uid + '-rh' + (showReasonErr ? ' ' + uid + '-re' : '')} placeholder={t('rn_reason_placeholder')} />
        <span id={uid + '-rh'} className="field-hint dr-count">
          <span>{t('rn_reason_hint', { min: REASON_MIN })}</span>
          <bdi dir="ltr" className={len > REASON_MAX ? 'red-text' : ''} aria-live="polite">{len}/{REASON_MAX}</bdi>
        </span>
        {showReasonErr && <span id={uid + '-re'} className="field-hint red-text" role="alert">{t(rProblem, { min: REASON_MIN })}</span>}
      </div>
      {unchanged && touched && <div className="muted small">{t('rn_unchanged')}</div>}
    </Modal>
  );
}

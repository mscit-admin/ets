import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, qs } from '../lib/api.js';
import { MultiSelect } from './MultiSelect.jsx';

// Why a function is excluded from the calculation (backend services/disable.js, migration 013).
export const DISABLE_REASONS = ['duplicate', 'out_of_scope', 'not_required', 'other'];
export const NOTE_MAX = 500;
export const NOTE_MIN = 3;           // the note is required for every reason (1.5.1): at least 3 non-whitespace characters
export const emptyReason = () => ({ reason: '', note: '', duplicates: [] });

// null when the note can be sent, else the message key of the problem (same rule as the server).
export function noteProblem(v) {
  const note = v.note.trim();
  if (note.length > NOTE_MAX) return 'dr_note_too_long';
  if (note.replace(/\s/gu, '').length < NOTE_MIN) return 'dr_note_required';
  return null;
}
// null when the reason can be sent, else the message key of what is missing.
export function reasonProblem(v) {
  if (!DISABLE_REASONS.includes(v.reason)) return 'dr_pick_reason';
  if (v.reason === 'duplicate' && !v.duplicates.length) return 'dr_pick_duplicates';
  return noteProblem(v);
}
// The request body fields of a reason.
export const reasonBody = v => ({ disabled_reason: v.reason, disabled_note: v.note.trim(),
  ...(v.reason === 'duplicate' ? { duplicate_of: v.duplicates.map(d => d.id) } : {}) });

// "D3" for a function of the same application, "att/D3" for one of another application.
export const dupCode = (d, appId) => (d.app_id && d.app_id !== appId ? `${d.app_id}/${d.code}` : d.code);

// The reason form: category (radio group), the duplicated functions (when "duplicate") and the note.
//   appId: application of the function(s); excludeIds: the function(s) being excluded (never offered).
export function DisableReasonForm({ appId, excludeIds, value, onChange, showErrors }) {
  const { t, nm } = useI18n();
  const uid = useId();
  const set = patch => onChange({ ...value, ...patch });
  const [touched, setTouched] = useState(false);       // the note was typed in or left: its error shows live
  const problem = reasonProblem(value);
  const noteErr = noteProblem(value);
  const showNoteErr = !!noteErr && (showErrors || touched);
  const len = value.note.trim().length;
  const load = (q, all) => api.get('/tracker/function-options' + qs({ app_id: all ? '' : appId, all: all ? 1 : '', q,
    exclude: excludeIds.join(',') }))
    .then(r => r.options);
  return (
    <div className="dr-form">
      <fieldset className="dr-reasons">
        <legend className="field-label">{t('dr_reason')} *</legend>
        <div role="radiogroup" aria-required="true" aria-invalid={showErrors && problem === 'dr_pick_reason' || undefined}>
          {DISABLE_REASONS.map(r => (
            <label key={r} className={'dr-reason' + (value.reason === r ? ' on' : '')}>
              <input type="radio" name={uid + '-reason'} value={r} checked={value.reason === r}
                onChange={() => set({ reason: r, duplicates: r === 'duplicate' ? value.duplicates : [] })} />
              <span>
                <b>{t('dr_' + r)}</b>
                <span className="muted small">{t('dr_hint_' + r)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {value.reason === 'duplicate' && (
        <div className="field">
          <MultiSelect value={value.duplicates} onChange={duplicates => set({ duplicates })} load={load}
            label={t('dr_duplicates') + ' *'} placeholder={t('dr_duplicates_placeholder')} allLabel={t('dr_search_all')}
            invalid={showErrors && problem === 'dr_pick_duplicates'} describedBy={uid + '-dh'}
            chipLabel={o => dupCode(o, appId)}
            renderOption={o => (
              <>
                <span className="code">{o.code}</span> <span lang="ar" dir="rtl">{o.name_ar}</span>
                <span className="muted small ms-app"> · {nm(o, 'app_name') || o.app_id}</span>
              </>
            )} />
          <span id={uid + '-dh'} className="field-hint">{t('dr_duplicates_hint')}</span>
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={uid + '-note'}>{t('dr_note')} *</label>
        <textarea id={uid + '-note'} className={'input' + (showNoteErr ? ' input-required' : '')}
          rows={3} maxLength={NOTE_MAX + 50} value={value.note}
          onChange={e => { set({ note: e.target.value }); if (e.target.value.trim()) setTouched(true); }} onBlur={() => setTouched(true)}
          required aria-required="true" aria-invalid={showNoteErr || undefined}
          aria-describedby={uid + '-nh' + (showNoteErr ? ' ' + uid + '-ne' : '')} placeholder={t('dr_note_placeholder')} />
        <span id={uid + '-nh'} className="field-hint dr-count">
          <span>{t('dr_note_hint', { min: NOTE_MIN })}</span>
          <bdi dir="ltr" className={len > NOTE_MAX ? 'red-text' : ''} aria-live="polite">{len}/{NOTE_MAX}</bdi>
        </span>
        {showNoteErr && <span id={uid + '-ne'} className="field-hint red-text" role="alert">{t(noteErr, { min: NOTE_MIN })}</span>}
      </div>
      {showErrors && problem && problem !== noteErr && <div className="alert red" role="alert">{t(problem)}</div>}
    </div>
  );
}

// Badge of an excluded function on the functions page: «مكررة مع: D3، D5» with links to those functions, and the
// note / who / when on demand.
export function DisabledReason({ f, appId }) {
  const { t, fmtDate, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const uid = useId();
  const r = f.disabled_reason;
  const sep = lang === 'ar' ? '، ' : ', ';
  const label = r ? t('dr_' + r) : t('dr_none');
  const dups = f.duplicate_of || [];
  const details = [f.disabled_note && `${t('dr_note')}: ${f.disabled_note}`,
    f.disabled_by_name && t('dr_by', { name: f.disabled_by_name }), f.disabled_at && fmtDate(f.disabled_at)].filter(Boolean);
  return (
    <span className="dr-badge-wrap">
      <span className={'dr-badge' + (r ? '' : ' none')}>
        <button type="button" className="dr-badge-btn" aria-expanded={open} aria-controls={uid}
          title={details.join('\n') || label} onClick={() => setOpen(o => !o)}>
          {r === 'duplicate' && dups.length ? t('dr_duplicate_of') : label}{r === 'duplicate' && dups.length ? ':' : ''}
        </button>
        {r === 'duplicate' && dups.map((d, i) => (
          <span key={d.id}>
            <Link className={'dr-chip' + (d.removed ? ' removed' : '')} to={`/app/${d.app_id}#fn-${d.id}`}
              title={[d.name_ar, d.removed ? t('fn_state_removed') : ''].filter(Boolean).join(' — ') || dupCode(d, appId)}>{dupCode(d, appId)}</Link>
            {i < dups.length - 1 && sep.trim()}
          </span>
        ))}
      </span>
      {open && (
        <span id={uid} className="dr-details" role="note">
          {details.length ? details.map((x, i) => <span key={i}>{x}</span>) : <span>{t('dr_no_details')}</span>}
        </span>
      )}
    </span>
  );
}

// The reason as one line of text (approvals screen, pending badges): «مكررة مع D3، D5 — note».
export function reasonText(t, lang, m, appId) {
  if (!m) return '';
  const sep = lang === 'ar' ? '، ' : ', ';
  const dups = (m.duplicate_of || []).map(d => dupCode(d, appId)).join(sep);
  const r = m.disabled_reason === 'duplicate' && dups ? t('dr_duplicate_of_list', { codes: dups }) : m.disabled_reason ? t('dr_' + m.disabled_reason) : t('dr_none');
  return [r, m.disabled_note].filter(Boolean).join(' — ');
}

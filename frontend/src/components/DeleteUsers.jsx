import { useId, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';
import { Alert, Modal, toast } from './ui.jsx';
import { Icon } from './Icon.jsx';

// Deleting users (1.7.0): a soft delete on the server (backend routes/users.js, migration 015). The account can no
// longer sign in, its sessions end, its pending requests are withdrawn; its name stays in the history.
export const REASON_MIN = 3;          // same rule as the server: 3+ characters, spaces not counted
export const REASON_MAX = 500;

// null when the reason can be sent, else the message key of the problem.
export function reasonProblem(v) {
  const s = v.trim();
  if (s.length > REASON_MAX) return 'del_reason_too_long';
  if (s.replace(/\s/gu, '').length < REASON_MIN) return 'del_reason_required';
  return null;
}

// Why a user cannot be deleted from this screen (null when it can): own account, or the last active administrator.
// The server applies the same rules (and counts permission overrides too).
export function undeletable(u, me, users) {
  if (u.id === me?.id) return 'del_self_tip';
  const admins = users.filter(x => x.role_id === 'admin' && x.is_active);
  if (u.role_id === 'admin' && u.is_active && admins.length <= 1) return 'del_last_admin_tip';
  return null;
}

// The required reason: textarea, live counter, error once typed in or left (same style as the exclusion note).
function ReasonField({ value, onChange, label, showErrors }) {
  const { t } = useI18n();
  const uid = useId();
  const [touched, setTouched] = useState(false);
  const problem = reasonProblem(value);
  const show = !!problem && (showErrors || touched);
  const len = value.trim().length;
  return (
    <div className="field">
      <label className="field-label" htmlFor={uid}>{label} *</label>
      <textarea id={uid} className={'input' + (show ? ' input-required' : '')} rows={3} maxLength={REASON_MAX + 50} value={value}
        onChange={e => { onChange(e.target.value); if (e.target.value.trim()) setTouched(true); }} onBlur={() => setTouched(true)}
        required aria-required="true" aria-invalid={show || undefined} aria-describedby={uid + '-h' + (show ? ' ' + uid + '-e' : '')}
        placeholder={t('del_reason_placeholder')} />
      <span id={uid + '-h'} className="field-hint dr-count">
        <span>{t('del_reason_hint', { min: REASON_MIN })}</span>
        <bdi dir="ltr" className={len > REASON_MAX ? 'red-text' : ''} aria-live="polite">{len}/{REASON_MAX}</bdi>
      </span>
      {show && <span id={uid + '-e'} className="field-hint red-text" role="alert">{t(problem, { min: REASON_MIN, max: REASON_MAX })}</span>}
    </div>
  );
}

// Confirmation dialog for one or several users: lists the names, asks for the reason, warns that history is kept.
// users: [{id, full_name, username}]
export function DeleteUsersDialog({ users, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [tried, setTried] = useState(false);
  const one = users.length === 1;
  const byId = new Map(users.map(u => [u.id, u]));
  const run = async () => {
    setTried(true);
    if (reasonProblem(reason)) return;
    setBusy(true); setErr(null);
    try {
      const r = one ? await api.del(path`/users/${users[0].id}`, { reason: reason.trim() })
        : await api.post('/users/bulk-delete', { ids: users.map(u => u.id), reason: reason.trim() });
      toast(t('del_done_n', { n: r.deleted.length }) + (r.requests_withdrawn || r.imports_rejected
        ? ' — ' + t('del_closed_n', { n: r.requests_withdrawn + r.imports_rejected }) : ''));
      onDone(r);
    } catch (e) { setErr(e); setBusy(false); }
  };
  const perId = err?.code === 'bulk_delete_refused' && Array.isArray(err.data?.errors) ? err.data.errors : null;
  return (
    <Modal title={one ? t('del_title_one') : t('del_title_n', { n: users.length })} onClose={onClose} wide
      footer={<>
        <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-danger" disabled={busy || !!reasonProblem(reason)} onClick={run}>
          <Icon name="trash" size={14} /> {busy ? t('saving') : one ? t('del_confirm_one') : t('del_confirm_n', { n: users.length })}
        </button>
      </>}>
      {err && <Alert>{perId ? t('err_bulk_delete_refused', { n: perId.length }) : errText(err)}
        {perId && <ul className="del-errors">{perId.map(e => (
          <li key={e.id}><b>{byId.get(e.id)?.full_name || e.username || '#' + e.id}</b> — {t('err_' + e.error)}</li>
        ))}</ul>}
      </Alert>}
      <div className="alert red del-warning" role="note">
        <Icon name="alert" size={16} />
        <span>{t('del_warning')}</span>
      </div>
      <p className="strong">{t('del_intro', { n: users.length })}</p>
      <ul className="del-names">
        {users.map(u => <li key={u.id}><b>{u.full_name}</b> <bdi dir="ltr" className="muted code">{u.username}</bdi></li>)}
      </ul>
      <ReasonField value={reason} onChange={setReason} label={t('del_reason')} showErrors={tried} />
    </Modal>
  );
}

// Restore a deleted user: reason, then the new temporary password shown once.
export function RestoreUserDialog({ user, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(null);
  const run = async () => {
    setTried(true);
    if (reasonProblem(reason)) return;
    setBusy(true); setErr(null);
    try { setDone(await api.post(path`/users/${user.id}/restore`, { reason: reason.trim() })); toast(t('restore_done')); }
    catch (e) { setErr(e); }
    setBusy(false);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(done.temporary_password); toast(t('copied')); } catch { toast(t('imp_copy_failed'), 'red'); }
  };
  const close = () => (done ? onDone(done) : onClose());
  return (
    <Modal title={t('restore_title', { name: user.full_name })} onClose={close}
      footer={done ? <button className="btn btn-primary" onClick={close}>{t('close')}</button> : <>
        <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={busy || !!reasonProblem(reason)} onClick={run}>
          <Icon name="restore" size={14} /> {busy ? t('saving') : t('restore_user')}</button>
      </>}>
      {err && <Alert>{errText(err)}</Alert>}
      {done ? <>
        <Alert kind="orange">{t('imp_passwords_once')}</Alert>
        <p>{t('restore_password', { username: done.username })}</p>
        <div className="row gap">
          <code dir="ltr" className="temp-pw">{done.temporary_password}</code>
          <button className="btn btn-default btn-sm" onClick={copy}>{t('copy')}</button>
        </div>
      </> : <>
        <p className="muted">{t('restore_hint')}</p>
        <ReasonField value={reason} onChange={setReason} label={t('restore_reason')} showErrors={tried} />
      </>}
    </Modal>
  );
}

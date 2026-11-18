import { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { Alert, Field, Modal } from './ui.jsx';

// Step-up re-authentication fields for the most sensitive admin actions (reset another user's password, reset their
// 2FA, delete an account): the administrator re-enters their OWN password, plus a 2FA code when they have 2FA on.
// Returns the input node to drop into a dialog, the request-body fragment to merge (reauth_password + code/recovery),
// and whether it is ready to submit. The server re-verifies via reauth() — see backend routes/users.js stepUp().
export function useReauth() {
  const { t } = useI18n();
  const { user } = useAuth();
  const needCode = !!user?.totp_enabled;
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const node = (
    <div className="reauth-fields">
      <Field label={t('reauth_password')} hint={t('reauth_hint')}>
        <input className="input" type="password" dir="ltr" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
      </Field>
      {needCode && (
        <Field label={t('code_or_recovery')}>
          <input className="input otp" dir="ltr" autoComplete="one-time-code" value={code} placeholder="123456 / xxxx-xxxx-xxxx" onChange={e => setCode(e.target.value)} />
        </Field>
      )}
    </div>
  );
  const second = !needCode ? {} : /^\d{6}$/.test(code.trim()) ? { code: code.trim() } : { recovery_code: code.trim() };
  return { node, body: { reauth_password: pw, ...second }, ready: !!pw && (!needCode || !!code.trim()) };
}

// A small confirm dialog that only collects the step-up re-auth (no other fields). onConfirm receives the body
// fragment to merge into the request; it should throw on failure so the error shows inline.
export function ReauthConfirm({ title, hint, confirmLabel, danger, onConfirm, onClose }) {
  const { t, errText } = useI18n();
  const reauth = useReauth();
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onConfirm(reauth.body); } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} onClick={go} disabled={busy || !reauth.ready}>{confirmLabel || t('confirm')}</button>
      </>}>
      {err && <Alert>{errText(err)}</Alert>}
      {hint && <p className="muted small">{hint}</p>}
      {reauth.node}
    </Modal>
  );
}

import { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Alert, Card, Field, Indicator, Modal, PageHeader, toast } from '../components/ui.jsx';
import { PasswordForm, RecoveryCodes, TotpEnroll } from './Login.jsx';
import { DevicesCard, NotifyPrefsCard } from '../components/ProfileNotify.jsx';

export default function Profile() {
  const { t, nm, lang, setLang, errText } = useI18n();
  const { user, me, refresh } = useAuth();
  const [enrolling, setEnrolling] = useState(null);  // setup data (QR) once the password was confirmed
  const [codes, setCodes] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'enable' | 'disable' | 'codes'
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');          // authenticator code or recovery code (disable / new codes)
  const [err, setErr] = useState(null);

  const mode = me.mfa_mode;
  const needsCode = confirm !== 'enable' && user.totp_enabled;
  const closeConfirm = () => { setConfirm(null); setPw(''); setCode(''); setErr(null); };
  const runConfirm = async () => {
    setErr(null);
    // 6 digits = authenticator code; anything else is taken as a recovery code
    const second = !needsCode ? {} : /^\d{6}$/.test(code.trim()) ? { code: code.trim() } : { recovery_code: code.trim() };
    try {
      if (confirm === 'enable') setEnrolling(await api.post('/auth/2fa/setup', { password: pw }));
      else if (confirm === 'disable') { await api.post('/auth/2fa/disable', { password: pw, ...second }); toast(t('saved')); }
      else setCodes((await api.post('/auth/2fa/recovery-codes', { password: pw, ...second })).recovery_codes);
      closeConfirm(); refresh();
    } catch (e) { setErr(e); }
  };
  const changeLang = async l => { setLang(l); try { await api.put('/auth/language', { language: l }); } catch { /* ignore */ } };

  return (
    <div>
      <PageHeader title={t('profile_title')} sub={`${user.full_name} · ${nm(user, 'role_name')}`} icon="user" />
      <div className="grid-2">
        <Card title={t('details')}>
          <div className="kv">
            <div><span>{t('username')}</span><span dir="ltr">{user.username}</span></div>
            <div><span>{t('role')}</span><span>{nm(user, 'role_name')}</span></div>
            <div><span>{t('scope')}</span><span>{user.fullScope ? t('full_scope') : [...user.scope.departments, ...user.scope.applications].join('، ') || t('no_scope')}</span></div>
            <div><span>{t('permissions')}</span><span className="row-tags">{user.permissions.map(p => <Indicator key={p} color="blue">{t('perm_' + p)}</Indicator>)}</span></div>
          </div>
          <Field label={t('language')} className="mt">
            <select className="input" value={lang} onChange={e => changeLang(e.target.value)}><option value="ar">العربية</option><option value="en">English</option></select>
          </Field>
        </Card>

        <Card title={t('two_fa')}>
          {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : enrolling ? (
            <TotpEnroll preset={enrolling} onEnabled={c => { setEnrolling(null); setCodes(c); refresh(); }} />
          ) : (
            <div>
              {mode === 'off' && <Alert kind="gray">{t('tfa_disabled_policy')}</Alert>}
              {user.totp_exempt && <Alert kind="gray">{t('tfa_exempt_note')}</Alert>}
              <p>{user.totp_enabled ? <Indicator color="green">{t('tfa_on')}</Indicator> : <Indicator color="orange">{t('tfa_off')}</Indicator>}
                {user.totp_enabled && <span className="muted small"> · {t('codes_left', { n: user.recovery_codes_left })}</span>}</p>
              {user.recovery_codes_outdated && <Alert kind="orange">{t('recovery_codes_outdated')}</Alert>}
              <div className="row gap wrap">
                {!user.totp_enabled && mode !== 'off' && <button className="btn btn-primary btn-sm" onClick={() => setConfirm('enable')}>{t('enable_2fa')}</button>}
                {user.totp_enabled && <button className="btn btn-default btn-sm" onClick={() => setConfirm('codes')}>{t('regenerate_codes')}</button>}
                {user.totp_enabled && (mode !== 'required' || user.totp_exempt) && <button className="btn btn-default btn-sm" onClick={() => setConfirm('disable')}>{t('disable_2fa')}</button>}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title={t('change_password')}>
        <div className="narrow"><PasswordForm /></div>
      </Card>

      <NotifyPrefsCard />
      <DevicesCard />

      {confirm && (
        <Modal title={t(needsCode ? 'confirm_with_password_code' : 'confirm_with_password')} onClose={closeConfirm}
          footer={<><button className="btn btn-default" onClick={closeConfirm}>{t('cancel')}</button><button className="btn btn-primary" onClick={runConfirm}>{t('confirm')}</button></>}>
          {err && <Alert>{errText(err)}</Alert>}
          <Field label={t('password')}><input className="input" type="password" dir="ltr" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
          {needsCode && (
            <Field label={t('code_or_recovery')}>
              <input className="input otp" dir="ltr" autoComplete="one-time-code" value={code} placeholder="123456 / xxxx-xxxx-xxxx"
                onChange={e => setCode(e.target.value)} />
            </Field>
          )}
        </Modal>
      )}
    </div>
  );
}

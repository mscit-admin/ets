import { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Alert, Card, Field, Indicator, Modal, PageHeader, toast } from '../components/ui.jsx';
import { PasswordForm, RecoveryCodes, TotpEnroll } from './Login.jsx';

export default function Profile() {
  const { t, nm, lang, setLang, errText } = useI18n();
  const { user, me, refresh } = useAuth();
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'disable' | 'codes'
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(null);

  const mode = me.mfa_mode;
  const runConfirm = async () => {
    setErr(null);
    try {
      if (confirm === 'disable') { await api.post('/auth/2fa/disable', { password: pw }); toast(t('saved')); }
      else setCodes((await api.post('/auth/2fa/recovery-codes', { password: pw })).recovery_codes);
      setConfirm(null); setPw(''); refresh();
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
            <div><span>{t('scope')}</span><span>{user.fullScope ? t('full_scope') : [...user.scope.departments, ...user.scope.applications].join('، ')}</span></div>
            <div><span>{t('permissions')}</span><span className="row-tags">{user.permissions.map(p => <Indicator key={p} color="blue">{t('perm_' + p)}</Indicator>)}</span></div>
          </div>
          <Field label={t('language')} className="mt">
            <select className="input" value={lang} onChange={e => changeLang(e.target.value)}><option value="ar">العربية</option><option value="en">English</option></select>
          </Field>
        </Card>

        <Card title={t('two_fa')}>
          {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : enrolling ? (
            <TotpEnroll onEnabled={c => { setEnrolling(false); setCodes(c); refresh(); }} />
          ) : (
            <div>
              {mode === 'off' && <Alert kind="gray">{t('tfa_disabled_policy')}</Alert>}
              {user.totp_exempt && <Alert kind="gray">{t('tfa_exempt_note')}</Alert>}
              <p>{user.totp_enabled ? <Indicator color="green">{t('tfa_on')}</Indicator> : <Indicator color="orange">{t('tfa_off')}</Indicator>}
                {user.totp_enabled && <span className="muted small"> · {t('codes_left', { n: user.recovery_codes_left })}</span>}</p>
              <div className="row gap wrap">
                {!user.totp_enabled && mode !== 'off' && <button className="btn btn-primary btn-sm" onClick={() => setEnrolling(true)}>{t('enable_2fa')}</button>}
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

      {confirm && (
        <Modal title={t('confirm_with_password')} onClose={() => { setConfirm(null); setErr(null); }}
          footer={<><button className="btn btn-default" onClick={() => setConfirm(null)}>{t('cancel')}</button><button className="btn btn-primary" onClick={runConfirm}>{t('confirm')}</button></>}>
          {err && <Alert>{errText(err)}</Alert>}
          <Field label={t('password')}><input className="input" type="password" dir="ltr" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
        </Modal>
      )}
    </div>
  );
}

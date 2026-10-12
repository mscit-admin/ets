import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api, downloadText } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { Alert } from '../components/ui.jsx';

function AuthCard({ title, sub, children }) {
  const { t, lang, setLang, nm } = useI18n();
  const [info, setInfo] = useState(null);
  useEffect(() => { api.get('/auth/public-info').then(setInfo).catch(() => {}); }, []);
  return (
    <div className="auth-page">
      <div className="auth-top">
        <button className="btn btn-sm btn-ghost" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
          <Icon name="globe" size={15} /> {t('lang_switch')}
        </button>
      </div>
      <div className="auth-wrap">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" width="44" height="44" />
          <div className="auth-org">{info ? nm({ name_ar: info.org_name_ar, name_en: info.org_name_en }) : t('app_title')}</div>
        </div>
        <div className="auth-card">
          <h2>{title}</h2>
          {sub && <p className="auth-sub">{sub}</p>}
          {children}
        </div>
        <div className="auth-foot">ETS · {new Date().getFullYear()}</div>
      </div>
    </div>
  );
}

// Shows the one-time recovery codes after enabling 2FA.
export function RecoveryCodes({ codes, onDone }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  return (
    <div>
      <Alert kind="orange">{t('recovery_sub')}</Alert>
      <div className="codes">{codes.map(c => <code key={c}>{c}</code>)}</div>
      <div className="row gap">
        <button type="button" className="btn btn-default btn-sm" onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); }}>
          {copied ? t('copied') : t('copy')}
        </button>
        <button type="button" className="btn btn-default btn-sm" onClick={() => downloadText('ets-recovery-codes.txt', text)}>
          <Icon name="download" size={14} /> {t('download')}
        </button>
      </div>
      {onDone && <button className="btn btn-primary btn-block mt" onClick={onDone}>{t('recovery_saved')}</button>}
    </div>
  );
}

// QR + code entry; used at login (enroll stage) and from the profile page.
export function TotpEnroll({ onEnabled }) {
  const { t, errText } = useI18n();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.post('/auth/2fa/setup').then(setSetup).catch(setErr); }, []);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { onEnabled((await api.post('/auth/2fa/enable', { code })).recovery_codes); }
    catch (x) { setErr(x); setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      {err && <Alert>{errText(err)}</Alert>}
      {setup && (
        <div className="enroll">
          <img src={setup.qr} alt="QR" width="200" height="200" className="qr" />
          <div className="muted small">{t('enroll_manual')}</div>
          <code className="secret" dir="ltr">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
        </div>
      )}
      <label className="field">
        <span className="field-label">{t('mfa_code')}</span>
        <input className="input otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, ''))} dir="ltr" required />
      </label>
      <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>{t('enable')}</button>
    </form>
  );
}

export default function Login() {
  const { t, errText } = useI18n();
  const { me, refresh, logout } = useAuth();
  const [stage, setStage] = useState(me?.authenticated ? me.stage : 'password');
  const [form, setForm] = useState({ username: '', password: '' });
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [codes, setCodes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (me?.authenticated && me.stage !== 'done') setStage(me.stage); }, [me]);

  const login = async e => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api.post('/auth/login', form);
      if (r.stage === 'done') await refresh(); else setStage(r.stage);
    } catch (x) { setErr(x); }
    setBusy(false);
  };

  const verify = async e => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api.post('/auth/2fa/verify', useRecovery ? { recovery_code: code.trim() } : { code });
      await refresh();
    } catch (x) { setErr(x); setCode(''); setBusy(false); }
  };

  const back = async () => { await logout(); setStage('password'); setCode(''); setErr(null); };

  if (codes) {
    return <AuthCard title={t('recovery_title')}><RecoveryCodes codes={codes} onDone={() => refresh()} /></AuthCard>;
  }

  if (stage === 'enroll') {
    return (
      <AuthCard title={t('enroll_title')} sub={t('enroll_sub')}>
        <TotpEnroll onEnabled={setCodes} />
        <button className="btn btn-link btn-block" onClick={back}>{t('back_to_login')}</button>
      </AuthCard>
    );
  }

  if (stage === 'verify') {
    return (
      <AuthCard title={t('mfa_title')} sub={useRecovery ? t('recovery_code') : t('mfa_sub')}>
        <form onSubmit={verify}>
          {err && <Alert>{errText(err)}</Alert>}
          {useRecovery ? (
            <input className="input otp" value={code} onChange={e => setCode(e.target.value)} placeholder="xxxx-xxxx" dir="ltr" autoFocus required />
          ) : (
            <input className="input otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))} dir="ltr" autoFocus required aria-label={t('mfa_code')} />
          )}
          <button className="btn btn-primary btn-block" disabled={busy || (!useRecovery && code.length !== 6)}>{t('verify')}</button>
        </form>
        <button className="btn btn-link btn-block" onClick={() => { setUseRecovery(u => !u); setCode(''); setErr(null); }}>
          {useRecovery ? t('use_app_code') : t('use_recovery')}
        </button>
        <button className="btn btn-link btn-block" onClick={back}>{t('back_to_login')}</button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('login_title')} sub={t('login_sub')}>
      <form onSubmit={login}>
        {err && <Alert>{errText(err)}</Alert>}
        <label className="field">
          <span className="field-label">{t('username')}</span>
          <input className="input" autoComplete="username" value={form.username} dir="ltr" autoFocus required
            onChange={e => setForm({ ...form, username: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">{t('password')}</span>
          <input className="input" type="password" autoComplete="current-password" value={form.password} dir="ltr" required
            onChange={e => setForm({ ...form, password: e.target.value })} />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t('signing_in') : t('sign_in')}</button>
      </form>
    </AuthCard>
  );
}

export function ForcePasswordChange() {
  const { t } = useI18n();
  const { logout } = useAuth();
  return (
    <AuthCard title={t('change_password')} sub={t('must_change_password')}>
      <PasswordForm />
      <button className="btn btn-link btn-block" onClick={logout}>{t('logout')}</button>
    </AuthCard>
  );
}

export function PasswordForm({ onDone }) {
  const { t, errText } = useI18n();
  const { refresh } = useAuth();
  const [f, setF] = useState({ current_password: '', new_password: '', confirm: '' });
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setErr(null); setOk(false);
    if (f.new_password !== f.confirm) { setErr({ code: 'passwords_mismatch_local' }); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { current_password: f.current_password, new_password: f.new_password });
      setOk(true); setF({ current_password: '', new_password: '', confirm: '' });
      await refresh(); onDone?.();
    } catch (x) { setErr(x); }
    setBusy(false);
  };
  return (
    <form onSubmit={submit}>
      {err && <Alert>{err.code === 'passwords_mismatch_local' ? t('passwords_mismatch') : errText(err)}</Alert>}
      {ok && <Alert kind="green">{t('saved')}</Alert>}
      {[['current_password', 'current-password'], ['new_password', 'new-password'], ['confirm', 'new-password']].map(([k, ac]) => (
        <label className="field" key={k}>
          <span className="field-label">{t(k === 'confirm' ? 'confirm_password' : k)}</span>
          <input className="input" type="password" autoComplete={ac} dir="ltr" required value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} />
        </label>
      ))}
      <div className="field-hint mb">{t('password_hint')}</div>
      <button className="btn btn-primary" disabled={busy}>{t('change_password')}</button>
    </form>
  );
}

// Sign-in, same flow as the web (frontend/src/pages/Login.jsx, backend routes/auth.js):
//   1. POST /auth/login { username (or e-mail), password } → stage done | verify | enroll
//   2. verify: POST /auth/2fa/verify { code } or { recovery_code }
//   3. enroll (the policy requires 2FA and the account has none): POST /auth/2fa/setup → QR + key,
//      POST /auth/2fa/enable { code } → one-time recovery codes
// "Back to sign-in" signs the half-open session out, as on the web.
import { useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { AuthCard } from '@/components/AuthCard';
import { Alert, Button, Field, Txt } from '@/components/ui';
import { colors, fontSize, pills, radius, space } from '@/theme';

type Stage = 'password' | 'verify' | 'enroll';

function ErrorAlert({ err }: { err: unknown }) {
  const { t, errText } = useI18n();
  if (!err) return null;
  const code = (err as { code?: string }).code;
  return (
    <Alert kind="red" icon="alert">
      <Txt size={fontSize.m} color={pills.red.text}>{errText(err)}</Txt>
      {code === 'network' || code === 'timeout' ? <Txt size={fontSize.s} color={pills.red.text}>{t('m_network_hint')}</Txt> : null}
    </Alert>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  return (
    <View>
      <Alert kind="orange">{t('recovery_sub')}</Alert>
      <View style={st.codes}>
        <Txt selectable size={15} style={st.mono}>{codes.join('\n')}</Txt>
      </View>
      <Txt size={fontSize.s} color={colors.textMuted} style={{ marginBottom: space.l }}>{t('m_recovery_select')}</Txt>
      <Button title={t('recovery_saved')} onPress={onDone} />
    </View>
  );
}

function Enroll({ onEnabled }: { onEnabled: (codes: string[]) => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.post<{ secret: string; qr: string }>('/auth/2fa/setup').then(setSetup).catch(setErr); }, [api]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { onEnabled((await api.post<{ recovery_codes: string[] }>('/auth/2fa/enable', { code })).recovery_codes); }
    catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <View>
      <ErrorAlert err={err} />
      {setup ? (
        <View style={st.enroll}>
          <Image source={{ uri: setup.qr }} style={st.qr} accessibilityLabel="QR" />
          <Txt size={fontSize.s} color={colors.textMuted}>{t('enroll_manual')}</Txt>
          <Txt selectable w={600} size={14} style={st.mono}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</Txt>
        </View>
      ) : null}
      <Field label={t('mfa_code')} value={code} onChangeText={v => setCode(v.replace(/\D/g, ''))} keyboardType="number-pad"
        maxLength={6} textContentType="oneTimeCode" autoComplete="one-time-code" ltr onSubmitEditing={submit} />
      <Button title={t('enable')} onPress={submit} busy={busy} disabled={code.length !== 6 || !setup} />
    </View>
  );
}

export default function Login() {
  const { t } = useI18n();
  const { api, me, refresh, logout, notice, clearNotice, server, forgetServer } = useSession();
  // the step comes from the server: a session waiting for 2FA (GET /auth/me stage verify / enroll), else the password
  const stage: Stage = me?.authenticated && me.stage !== 'done' ? me.stage : 'password';
  const [form, setForm] = useState({ username: '', password: '' });
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [localErr, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const err = localErr ?? (notice ? { code: notice } : null);   // «انتهت الجلسة» / the server cannot be reached

  const login = async () => {
    setBusy(true); setErr(null); clearNotice();
    try {
      await api.post<{ stage: 'done' | 'verify' | 'enroll' }>('/auth/login', form);
      await refresh();
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  const verify = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/auth/2fa/verify', useRecovery ? { recovery_code: code.trim() } : { code });
      await refresh();
    } catch (e) { setErr(e); setCode(''); setBusy(false); }
  };
  const back = async () => { await logout(); setCode(''); setErr(null); setUseRecovery(false); };

  if (codes) {
    return <AuthCard title={t('recovery_title')}><RecoveryCodes codes={codes} onDone={() => refresh()} /></AuthCard>;
  }
  if (stage === 'enroll') {
    return (
      <AuthCard title={t('enroll_title')} sub={t('enroll_sub')}>
        <Enroll onEnabled={setCodes} />
        <Button kind="link" title={t('back_to_login')} onPress={back} />
      </AuthCard>
    );
  }
  if (stage === 'verify') {
    return (
      <AuthCard title={t('mfa_title')} sub={useRecovery ? t('recovery_code') : t('mfa_sub')}>
        <ErrorAlert err={err} />
        {useRecovery ? (
          <Field key="rc" label={t('recovery_code')} value={code} onChangeText={setCode} placeholder="xxxx-xxxx-xxxx" autoCapitalize="none"
            autoCorrect={false} ltr onSubmitEditing={verify} autoFocus />
        ) : (
          <Field key="otp" label={t('mfa_code')} value={code} onChangeText={v => setCode(v.replace(/\D/g, ''))} keyboardType="number-pad"
            maxLength={6} textContentType="oneTimeCode" autoComplete="one-time-code" ltr onSubmitEditing={verify} autoFocus
            style={st.otp} />
        )}
        <Button title={t('verify')} onPress={verify} busy={busy} disabled={useRecovery ? !code.trim() : code.length !== 6} />
        <Button kind="link" title={useRecovery ? t('use_app_code') : t('use_recovery')}
          onPress={() => { setUseRecovery(u => !u); setCode(''); setErr(null); }} />
        <Button kind="link" title={t('back_to_login')} onPress={back} />
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('login_title')} sub={t('login_sub')}>
      <ErrorAlert err={err} />
      <Field label={t('login_identifier')} value={form.username} onChangeText={v => setForm(f => ({ ...f, username: v }))}
        placeholder={t('login_identifier_ph')} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
        textContentType="username" autoComplete="username" ltr returnKeyType="next" />
      <Field label={t('password')} value={form.password} onChangeText={v => setForm(f => ({ ...f, password: v }))} secureTextEntry
        textContentType="password" autoComplete="current-password" ltr onSubmitEditing={login} returnKeyType="go" />
      <Button title={busy ? t('signing_in') : t('sign_in')} onPress={login} busy={busy} disabled={!form.username.trim() || !form.password} />
      <View style={st.server}>
        <Txt size={fontSize.s} color={colors.textMuted} numberOfLines={1} style={{ flexShrink: 1 }}>{t('m_server_current', { url: server ?? '' })}</Txt>
        <Button kind="link" small title={t('m_server_change')} onPress={forgetServer} />
      </View>
    </AuthCard>
  );
}

const st = StyleSheet.create({
  codes: { backgroundColor: colors.gray100, borderRadius: radius.md, padding: space.l, marginBottom: space.s, alignItems: 'center' },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), direction: 'ltr', textAlign: 'center', letterSpacing: 1 },
  enroll: { alignItems: 'center', gap: space.s, marginBottom: space.l },
  qr: { width: 200, height: 200, borderRadius: radius.md },
  otp: { fontSize: 22, letterSpacing: 6, textAlign: 'center' },
  server: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m, marginTop: space.l,
    paddingTop: space.m, borderTopWidth: 1, borderTopColor: colors.border },
});

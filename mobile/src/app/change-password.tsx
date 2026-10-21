// Forced password change (an administrator set or reset the password): the only screen until it is changed, as on
// the web (ForcePasswordChange). POST /auth/change-password { current_password, new_password }.
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { AuthCard } from '@/components/AuthCard';
import { Alert, Button, Field, Txt } from '@/components/ui';
import { colors, fontSize } from '@/theme';

const FIELDS = [
  ['current_password', 'current_password', 'current-password'],
  ['new_password', 'new_password', 'new-password'],
  ['confirm', 'confirm_password', 'new-password'],
] as const;

export default function ChangePassword() {
  const { t, errText } = useI18n();
  const { api, refresh, logout } = useSession();
  const [f, setF] = useState({ current_password: '', new_password: '', confirm: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr(null);
    if (f.new_password !== f.confirm) { setErr(t('passwords_mismatch')); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { current_password: f.current_password, new_password: f.new_password });
      await refresh();
    } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <AuthCard title={t('change_password')} sub={t('must_change_password')}>
      {err ? <Alert kind="red" icon="alert">{err}</Alert> : null}
      {FIELDS.map(([k, label, ac]) => (
        <Field key={k} label={t(label)} value={f[k]} onChangeText={v => setF(x => ({ ...x, [k]: v }))} secureTextEntry
          autoComplete={ac} textContentType={ac === 'new-password' ? 'newPassword' : 'password'} ltr />
      ))}
      <Txt size={fontSize.xs} color={colors.textMuted} style={{ marginBottom: 12 }}>{t('password_hint')}</Txt>
      <Button title={t('change_password')} onPress={submit} busy={busy}
        disabled={!f.current_password || !f.new_password || !f.confirm} />
      <Button kind="link" title={t('logout')} onPress={logout} />
    </AuthCard>
  );
}

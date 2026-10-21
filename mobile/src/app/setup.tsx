// «عنوان الخادم»: the ETS server address, asked at first launch (and after "Change server" on the sign-in screen).
// Only https:// is accepted (lib/server.ts); the address is checked (GET /api/health and /api/auth/public-info)
// before it is stored in the secure store.
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { probeServer, useSession } from '@/lib/session';
import { AuthCard } from '@/components/AuthCard';
import { Alert, Button, Field, Txt } from '@/components/ui';
import { colors, fontSize, pills } from '@/theme';

export default function Setup() {
  const { t, errText } = useI18n();
  const { setServer } = useSession();
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await probeServer(url);
      await setServer(r.url);
    } catch (e) {
      setErr(e); setBusy(false);
    }
  };
  const code = (err as { code?: string } | null)?.code;
  return (
    <AuthCard title={t('m_server_title')} sub={t('m_server_sub')}>
      {err ? (
        <Alert kind="red" icon="alert">
          <Txt size={fontSize.m} color={pills.red.text}>{errText(err)}</Txt>
          {code === 'network' || code === 'timeout' ? <Txt size={fontSize.s} color={pills.red.text}>{t('m_network_hint')}</Txt> : null}
        </Alert>
      ) : null}
      <Field label={t('m_server_label')} value={url} onChangeText={setUrl} placeholder={t('m_server_ph')} autoCapitalize="none"
        autoCorrect={false} keyboardType="url" textContentType="URL" autoComplete="url" inputMode="url" returnKeyType="go"
        onSubmitEditing={submit} autoFocus ltr />
      <Button title={busy ? t('m_server_checking') : t('m_server_continue')} onPress={submit} busy={busy} disabled={!url.trim()} />
      <Txt size={fontSize.s} color={colors.textMuted} style={{ marginTop: 12 }}>{t('m_server_cert_hint')}</Txt>
    </AuthCard>
  );
}

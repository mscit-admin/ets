// حسابي (web: pages/Profile.jsx, the parts of phase 1): name, role, scope, permissions, language (saved to the
// account with PUT /api/auth/language, as on the web), the notification preferences (phase 2, components/NotifyPrefs),
// the live-updates state, the server, the app version, sign out. 2FA management and password change stay on the website.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Constants from 'expo-constants';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Lang } from '@/shared/web';
import { colors, fontSize, radius, space } from '@/theme';
import { TopBar } from '@/components/TopBar';
import { NotifyPrefs } from '@/components/NotifyPrefs';
import { useLiveStatus } from '@/lib/liveContext';
import { Alert, Button, Card, Pill, Screen, Txt, s as ui } from '@/components/ui';

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <View style={st.kv}>
      <Txt size={fontSize.s} color={colors.textMuted} style={st.k}>{k}</Txt>
      <View style={ui.flex}>{typeof children === 'string' ? <Txt size={fontSize.m}>{children}</Txt> : children}</View>
    </View>
  );
}

const LANGS: { v: Lang; label: string }[] = [{ v: 'ar', label: 'العربية' }, { v: 'en', label: 'English' }];

export default function Profile() {
  const { t, nm, lang, setLang, restartNeeded } = useI18n();
  const { user, api, server, logout } = useSession();
  const liveStatus = useLiveStatus();
  if (!user) return null;
  const changeLang = async (l: Lang) => {
    if (l === lang) return;
    try { await api.put('/auth/language', { language: l }); } catch { /* the choice still applies on this phone */ }
    setLang(l);
  };
  const scope = user.fullScope ? t('full_scope') : [...user.scope.departments, ...user.scope.applications].join('، ') || t('no_scope');
  return (
    <View style={ui.flex}>
      <TopBar title={t('profile_title')} sub={`${user.full_name} · ${nm(user as unknown as Record<string, unknown>, 'role_name')}`} />
      <Screen>
        {restartNeeded ? <Alert kind="orange" icon="info">{t('m_direction_restart')}</Alert> : null}
        <Card title={t('details')}>
          <Kv k={t('full_name')}>{user.full_name}</Kv>
          <Kv k={t('username')}><Txt size={fontSize.m} style={st.ltr}>{user.username}</Txt></Kv>
          <Kv k={t('role')}>{nm(user as unknown as Record<string, unknown>, 'role_name')}</Kv>
          <Kv k={t('scope')}>{scope}</Kv>
          <Kv k={t('permissions')}>
            <View style={st.perms}>{user.permissions.map(p => <Pill key={p} color="blue">{t('perm_' + p)}</Pill>)}</View>
          </Kv>
        </Card>
        <Card title={t('language')}>
          <View style={st.seg} accessibilityRole="radiogroup">
            {LANGS.map(o => (
              <Pressable key={o.v} onPress={() => changeLang(o.v)} style={[st.segBtn, lang === o.v && st.segOn]}
                accessibilityRole="radio" accessibilityState={{ checked: lang === o.v }}>
                <Txt w={600} size={fontSize.m} color={lang === o.v ? colors.white : colors.text} center>{o.label}</Txt>
              </Pressable>
            ))}
          </View>
        </Card>
        <NotifyPrefs />
        <Card>
          <Txt size={fontSize.s} color={colors.textMuted} style={st.ltr}>{server}</Txt>
          {liveStatus !== 'off' ? <Txt size={fontSize.s} color={colors.textMuted} accessibilityHint={t('live_hint_' + liveStatus)}>{t('live_' + liveStatus)}</Txt> : null}
          <Txt size={fontSize.s} color={colors.textMuted}>{t('m_version', { v: Constants.expoConfig?.version ?? '' })}</Txt>
          <Button kind="default" icon="logout" title={t('logout')} onPress={logout} style={{ marginTop: space.l }} />
        </Card>
      </Screen>
    </View>
  );
}

const st = StyleSheet.create({
  kv: { flexDirection: 'row', gap: space.l, paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: colors.border },
  k: { width: 96 },
  ltr: { direction: 'ltr', writingDirection: 'ltr' },
  perms: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  seg: { flexDirection: 'row', gap: space.s, backgroundColor: colors.gray100, borderRadius: radius.md, padding: 4 },
  segBtn: { flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.primary },
});

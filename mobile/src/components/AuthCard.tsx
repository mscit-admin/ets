// Frame of the screens before sign-in (web: Login.jsx AuthCard): language switch at the top, a white card with the
// logo and the organisation's name, the title, and the form.
import { type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { colors, fontSize, radius, shadows, space } from '@/theme';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Alert, Txt } from './ui';

export function AuthCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  const { t, lang, setLang, nm, restartNeeded } = useI18n();
  const { info } = useSession();
  const insets = useSafeAreaInsets();
  const org = info?.org_name_ar ? nm({ name_ar: info.org_name_ar, name_en: info.org_name_en }) : t('app_title');
  return (
    <KeyboardAvoidingView style={st.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[st.scroll, { paddingTop: insets.top + space.m, paddingBottom: insets.bottom + space.xxl }]}
        keyboardShouldPersistTaps="handled">
        <View style={st.top}>
          <Pressable onPress={() => setLang(lang === 'ar' ? 'en' : 'ar')} style={st.lang} accessibilityRole="button" accessibilityLabel={t('lang_switch')}>
            <Icon name="globe" size={15} color={colors.gray700} />
            <Txt w={600} size={fontSize.m} color={colors.gray700}>{t('lang_switch')}</Txt>
          </Pressable>
        </View>
        {restartNeeded ? <Alert kind="orange" icon="info">{t('m_direction_restart')}</Alert> : null}
        <View style={st.card}>
          <View style={st.brand}>
            <Logo height={56} />
            <Txt w={700} size={17} center>{org}</Txt>
          </View>
          <Txt w={700} size={fontSize.xl} accessibilityRole="header">{title}</Txt>
          {sub ? <Txt size={fontSize.m} color={colors.textMuted} style={st.sub}>{sub}</Txt> : null}
          {children}
        </View>
        <Txt size={fontSize.s} color={colors.gray500} center style={st.foot}>ETS · {new Date().getFullYear()}</Txt>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, paddingHorizontal: space.xl },
  top: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: space.l },
  lang: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, minHeight: 36, borderRadius: radius.md },
  card: {
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, boxShadow: shadows.sm,
    paddingHorizontal: 22, paddingTop: 24, paddingBottom: 16, width: '100%', maxWidth: 420, alignSelf: 'center',
  },
  brand: { alignItems: 'center', gap: 10, paddingBottom: 18, marginBottom: 18, borderBottomWidth: 1, borderBottomColor: colors.border },
  sub: { marginBottom: space.xl, marginTop: 2 },
  foot: { marginTop: 18 },
});

// Top bar of the signed-in screens (web: the navbar): back arrow or logo, title, and the bell with the unread
// count (red when a critical alert is unread, «99+» above 99) that opens the alerts tab.
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/lib/i18n';
import { badgeText, useNotifCount } from '@/lib/notifCount';
import { backIcon } from '@/lib/rtl';
import { colors, fontSize, space } from '@/theme';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Txt } from './ui';

export function Bell() {
  const { t } = useI18n();
  const { count } = useNotifCount();
  const badge = badgeText(count.unread);
  return (
    <Pressable onPress={() => router.navigate('/notifications')} style={st.iconBtn} hitSlop={8}
      accessibilityRole="button" accessibilityLabel={count.unread ? t('notif_bell_n', { n: badge }) : t('notifications')}>
      <Icon name="bell" size={22} color={colors.gray800} />
      {count.unread > 0 && (
        <View style={[st.badge, count.top_severity === 'critical' && st.badgeCritical]} pointerEvents="none">
          <Txt w={700} size={10.5} color={colors.white} center style={st.badgeText}>{badge}</Txt>
        </View>
      )}
    </Pressable>
  );
}

export function TopBar({ title, sub, back = false, bell = true }: { title: string; sub?: string; back?: boolean; bell?: boolean }) {
  const { t, rtl } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View style={[st.bar, { paddingTop: insets.top }]}>
      <View style={st.inner}>
        {back ? (
          <Pressable onPress={() => (router.canGoBack() ? router.back() : router.navigate('/home'))} style={st.iconBtn} hitSlop={8}
            accessibilityRole="button" accessibilityLabel={t('m_back')}>
            <Icon name={backIcon(rtl)} size={22} color={colors.gray800} />
          </Pressable>
        ) : (
          <Logo height={30} />
        )}
        <View style={st.titles}>
          <Txt w={700} size={fontSize.l} numberOfLines={1} accessibilityRole="header">{title}</Txt>
          {sub ? <Txt size={fontSize.xs} color={colors.textMuted} numberOfLines={1}>{sub}</Txt> : null}
        </View>
        {bell ? <Bell /> : null}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  bar: { backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border },
  inner: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space.l, paddingHorizontal: space.l },
  titles: { flex: 1, minWidth: 0 },
  iconBtn: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute', top: 2, end: 0, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9,
    backgroundColor: colors.gray600, borderWidth: 2, borderColor: colors.white, alignItems: 'center', justifyContent: 'center', direction: 'ltr',
  },
  badgeCritical: { backgroundColor: colors.bellCritical },
  badgeText: { lineHeight: 13 },
});

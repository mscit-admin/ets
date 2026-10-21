// Bottom tabs of the signed-in app: الرئيسية (dashboard → department → application), التنبيهات, حسابي.
// The alerts tab carries the unread count (lib/notifCount.tsx); the live-updates stream (lib/liveContext.tsx) runs here,
// for a signed-in user only.
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { useI18n } from '@/lib/i18n';
import { LiveProvider } from '@/lib/liveContext';
import { NotifCountProvider, badgeText, useNotifCount } from '@/lib/notifCount';
import { colors, fontFamily } from '@/theme';

function TabsInner() {
  const { t } = useI18n();
  const { count } = useNotifCount();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.gray600,
        // Cairo is taller than the system font: room for the label under the icon
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border, height: 62 + insets.bottom, paddingTop: 4 },
        tabBarLabelStyle: { fontFamily: fontFamily(600), fontSize: 12, lineHeight: 18, paddingBottom: 2 },
        tabBarBadgeStyle: { fontFamily: fontFamily(700), fontSize: 10.5, backgroundColor: count.top_severity === 'critical' ? colors.bellCritical : colors.gray600 },
        sceneStyle: { backgroundColor: colors.bg },
      }}>
      <Tabs.Screen name="home" options={{
        title: t('m_tab_home'),
        tabBarIcon: ({ color, size }) => <Icon name="home" size={size} color={color} />,
      }} />
      <Tabs.Screen name="notifications" options={{
        title: t('notifications'),
        tabBarIcon: ({ color, size }) => <Icon name="bell" size={size} color={color} />,
        tabBarBadge: count.unread > 0 ? badgeText(count.unread) : undefined,
        tabBarAccessibilityLabel: count.unread ? t('notif_bell_n', { n: badgeText(count.unread) }) : t('notifications'),
      }} />
      <Tabs.Screen name="profile" options={{
        title: t('profile_title'),
        tabBarIcon: ({ color, size }) => <Icon name="user" size={size} color={color} />,
      }} />
    </Tabs>
  );
}

export default function TabsLayout() {
  return (
    <LiveProvider>
      <NotifCountProvider>
        <TabsInner />
      </NotifCountProvider>
    </LiveProvider>
  );
}

// Bottom tabs of the signed-in app: الرئيسية (dashboard → department → application), الاعتمادات, التنبيهات, حسابي.
// The alerts tab carries the unread count (lib/notifCount.tsx); the approvals tab — shown to approvers and to users with
// requests of their own still pending (lib/approvalsCount.tsx) — the requests waiting for this user. The live-updates
// stream (lib/liveContext.tsx) and the dialogs' host (components/Sheet.tsx) live here, for a signed-in user only.
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { SheetHost } from '@/components/Sheet';
import { useI18n } from '@/lib/i18n';
import { LiveProvider } from '@/lib/liveContext';
import { NotifCountProvider, badgeText, useNotifCount } from '@/lib/notifCount';
import { ApprovalsCountProvider, useApprovalsCount } from '@/lib/approvalsCount';
import { colors, fontFamily } from '@/theme';

function TabsInner() {
  const { t } = useI18n();
  const { count } = useNotifCount();
  const approvals = useApprovalsCount();
  const insets = useSafeAreaInsets();
  const waiting = approvals.count.awaiting_me;
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
      <Tabs.Screen name="approvals" options={{
        title: t('m_tab_approvals'),
        href: approvals.visible ? undefined : null,
        tabBarIcon: ({ color, size }) => <Icon name="check" size={size} color={color} />,
        tabBarBadge: waiting > 0 ? badgeText(waiting) : undefined,
        tabBarBadgeStyle: { fontFamily: fontFamily(700), fontSize: 10.5, backgroundColor: colors.bellCritical },
        tabBarAccessibilityLabel: waiting ? `${t('m_tab_approvals')}: ${t('edits_awaiting_you', { n: waiting })}` : t('m_tab_approvals'),
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
        <ApprovalsCountProvider>
          <SheetHost>
            <TabsInner />
          </SheetHost>
        </ApprovalsCountProvider>
      </NotifCountProvider>
    </LiveProvider>
  );
}

// Alert categories (tabs of the bell) and severity colours / icons. Plain data, no imports: used by
// components/NotificationBell.jsx, pages/Notifications.jsx and the mobile app (mobile/src/app/(tabs)/notifications.tsx).
export const SEV_COLOR = { critical: 'red', warning: 'orange', info: 'blue' };
export const SEV_ICON = { critical: 'alert', warning: 'alert', info: 'info' };
export const TABS = ['all', 'approvals', 'tracking', 'plan', 'security'];
// "security" groups the security and system categories
export const inTab = (tab, n) => tab === 'all' || n.category === tab || (tab === 'security' && n.category === 'system');

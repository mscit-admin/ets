// Alert categories (tabs of the bell), severity colours / icons and the preference rules. Plain data, no imports: used by
// components/NotificationBell.jsx, pages/Notifications.jsx, components/ProfileNotify.jsx and the mobile app (mobile/src/shared/web.ts).
export const SEV_COLOR = { critical: 'red', warning: 'orange', info: 'blue' };
export const SEV_ICON = { critical: 'alert', warning: 'alert', info: 'info' };
export const TABS = ['all', 'approvals', 'tracking', 'plan', 'security'];
// "security" groups the security and system categories
export const inTab = (tab, n) => tab === 'all' || n.category === tab || (tab === 'security' && n.category === 'system');

// Notification preferences (Profile → «التنبيهات», GET / PUT /api/notifications/prefs): the categories in order, the
// reason a type cannot be changed, and the PUT body that turns one type on or off. A mandatory type is never muted
// (the server refuses it: mandatory_type); the phone column needs the in-app one.
export const PREF_CATS = ['approvals', 'tracking', 'plan', 'security', 'system'];
export const prefLockKey = x => (x.mandatory ? 'notif_mandatory_role' : x.blocked ? 'notif_blocked_admin' : null);
export const prefPhoneShown = x => !!x.push_allowed && !x.mobile_blocked;
export const prefOn = (x, k) => (k === 'muted' ? !x.muted && !x.blocked : !x.mobile_muted && !x.muted && !x.blocked);
export const prefLocked = (x, k) => !!(x.mandatory || x.blocked || (k === 'mobile_muted' && x.muted));
export const prefFlip = (types, k, type, on) => {
  const list = types.filter(x => x[k]).map(x => x.type);
  return { [k]: on ? list.filter(x => x !== type) : [...list, type] };
};

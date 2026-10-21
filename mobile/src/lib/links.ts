// Alert links are paths of the web UI (backend services/notify.js: '/app/per', '/department/hr', '/approvals'…).
// The phone opens the screens it has; anything else stays on the alerts list (phase 2 adds approvals).
export type MobileHref = `/home/app/${string}` | `/home/department/${string}` | '/home' | null;

const ID = /^[A-Za-z0-9_-]{1,40}$/;

export function mobileRoute(link: string | null | undefined): MobileHref {
  if (!link || !link.startsWith('/')) return null;
  const [p] = link.split(/[?#]/);
  const parts = p.split('/').filter(Boolean);
  if (parts.length === 0) return '/home';
  if (parts.length === 2 && parts[0] === 'app' && ID.test(parts[1])) return `/home/app/${parts[1]}`;
  if (parts.length === 2 && parts[0] === 'department' && ID.test(parts[1])) return `/home/department/${parts[1]}`;
  return null;
}

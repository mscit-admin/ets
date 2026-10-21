// Alert links are paths of the web UI (backend services/notify-events.js, notify-scan.js): '/app/per',
// '/app/per?filter=conflict', '/app/per#fn-12', '/department/hr', '/approvals', '/approvals?mine=1', '/notifications'…
// The phone opens the screens it has (expo-router paths); anything else (logs, settings, imports…) stays on the list.
//   /app/<id>                 → /home/app/<id>     (?filter=conflict → the «نجح» below 100 % filter, #fn-<n> → that item)
//   /department/<id>          → /home/department/<id>
//   /approvals[?mine=1]       → /approvals[?mine=1]
//   /                         → /home
export type MobileHref = string | null;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const FILTERS = new Set(['conflict']);

export function mobileRoute(link: string | null | undefined): MobileHref {
  if (!link || !link.startsWith('/') || link.startsWith('//')) return null;
  const hashAt = link.indexOf('#');
  const hash = hashAt >= 0 ? link.slice(hashAt + 1) : '';
  const noHash = hashAt >= 0 ? link.slice(0, hashAt) : link;
  const [p, query = ''] = noHash.split('?');
  const q = new Map(query.split('&').filter(Boolean).map(kv => { const [k, v = ''] = kv.split('='); return [k, v] as [string, string]; }));
  const parts = p.split('/').filter(Boolean);
  if (parts.length === 0) return '/home';
  if (parts.length === 2 && parts[0] === 'app' && ID.test(parts[1])) {
    const fn = /^fn-(\d{1,10})$/.exec(hash)?.[1];
    const filter = q.get('filter');
    const params = [fn ? `fn=${fn}` : '', filter && FILTERS.has(filter) ? `filter=${filter}` : ''].filter(Boolean).join('&');
    return `/home/app/${parts[1]}${params ? '?' + params : ''}`;
  }
  if (parts.length === 2 && parts[0] === 'department' && ID.test(parts[1])) return `/home/department/${parts[1]}`;
  if (parts.length === 1 && parts[0] === 'approvals') return q.get('mine') === '1' ? '/approvals?mine=1' : '/approvals';
  if (parts.length === 1 && parts[0] === 'notifications') return '/notifications';
  return null;
}

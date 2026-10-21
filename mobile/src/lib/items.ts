// Rules of the items list, as in the web's pages/Application.jsx (one-liners there too).
import type { PillName } from '@/theme';
import type { Item } from './types';

export const typeOf = (f: Pick<Item, 'item_type'>) => (f.item_type === 'report' ? 'report' : 'function');
// «نجح» (2) needs 100 % (1.8.1): an item passed below 100 % is flagged ⚠
export const passConflict = (f: Pick<Item, 'test_status' | 'progress' | 'removed_at'>) => !f.removed_at && f.test_status === 2 && +f.progress < 100;
export const SRC_COLOR: Record<string, PillName> = { design: 'blue', vendor_list: 'cyan', experience: 'purple', custom: 'gray' };
// "D3" for an item of the same application, "att/D3" for one of another (web: DisableReason.jsx dupCode)
export const dupCode = (d: { app_id?: string; code: string }, appId: string) => (d.app_id && d.app_id !== appId ? `${d.app_id}/${d.code}` : d.code);

export type TestFilter = '' | '0' | '1' | '2' | '3' | 'conflict';

/** The web's default list: removed items hidden; items of the "experience" source that are excluded shown only on
 * request; then the test status filter and the search (code, name, reference, note). */
export function visibleItems(fns: Item[], f: { q: string; test: TestFilter; showOff: boolean }) {
  const q = f.q.trim().toLowerCase();
  return fns.filter(x =>
    !x.removed_at &&
    (f.showOff || x.enabled || x.source !== 'experience') &&
    (f.test === '' || (f.test === 'conflict' ? passConflict(x) : x.test_status === +f.test)) &&
    (!q || `${x.code} ${x.name_ar} ${x.reference || ''} ${x.note || ''}`.toLowerCase().includes(q)));
}

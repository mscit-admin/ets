// Rules of the items list, as in the web's pages/Application.jsx; the edit rules themselves are shared
// (frontend/src/lib/itemRules.js through src/shared/web.ts).
import { passConflict as passConflictRaw } from '@/shared/web';
import type { Item } from './types';

export { SRC_COLOR, dupCode, typeOf } from '@/shared/web';
// «نجح» (2) needs 100 % (1.8.1): an item passed below 100 % is flagged ⚠ (not a removed one)
export const passConflict = (f: Pick<Item, 'test_status' | 'progress' | 'removed_at'>) => !f.removed_at && passConflictRaw(f);

export type TestFilter = '' | '0' | '1' | '2' | '3' | 'conflict';
export type ListFilter = { q: string; test: TestFilter; showOff: boolean; showRemoved?: boolean };

/** The web's default list: removed items only on request; items of the "experience" source that are excluded shown
 * only on request; then the test status filter and the search (code, name, reference, note). */
export function visibleItems(fns: Item[], f: ListFilter) {
  const q = f.q.trim().toLowerCase();
  return fns.filter(x =>
    (x.removed_at ? !!f.showRemoved : (f.showOff || x.enabled || x.source !== 'experience')) &&
    (f.test === '' || (f.test === 'conflict' ? passConflict(x) : x.test_status === +f.test)) &&
    (!q || `${x.code} ${x.name_ar} ${x.reference || ''} ${x.note || ''}`.toLowerCase().includes(q)));
}

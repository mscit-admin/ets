// What the reader may change on an item, and the list rules of editing, as the web's pages/Application.jsx decides
// them from the server's `can` flags (GET /tracker/applications/:id; the server checks every change again):
//   progress, notification status → can.pct;  test status, review status, note → can.tst;  weight → can.wgt;
//   include / exclude, item type, add, remove / restore → can.tog;  rename → can.ren;  move → can.mov.
// The status and number fields of an excluded item stay as they are (web: disabled while !f.enabled).
import type { Can, Item } from './types';

export const NO_CAN: Can = { pct: false, wgt: false, tst: false, tog: false, ren: false, mov: false, rep: false };

export function editability(can: Can, f: Pick<Item, 'enabled' | 'removed_at'>) {
  const live = !f.removed_at;
  return {
    progress: can.pct && f.enabled && live,
    notif: can.pct && f.enabled && live,
    test: can.tst && f.enabled && live,
    review: can.tst && f.enabled && live,
    weight: can.wgt && f.enabled && live,
    note: can.tst && live,
    toggle: can.tog && live,
    type: can.tog && live,
    rename: can.ren && live,
    move: can.mov && live,
    remove: can.tog && live,
    restore: can.tog && !live,
  };
}
export type Editability = ReturnType<typeof editability>;

/** Any edit control at all on this page? (an observer: none — the items are only shown) */
export const canEditAny = (can: Can) => can.pct || can.wgt || can.tst || can.tog || can.ren || can.mov;
/** «تعيين جماعي» (web: shown with pct / tst / tog / mov) */
export const canBulk = (can: Can) => can.pct || can.tst || can.tog || can.mov;

export type BulkField = 'progress' | 'test_status' | 'exclude' | 'item_type' | 'move';
/** The bulk options of this reader, in the web's order. */
export const bulkFields = (can: Can): BulkField[] => ([
  can.pct && 'progress', can.tst && 'test_status', can.tog && 'exclude', can.tog && 'item_type', can.mov && 'move',
].filter(Boolean) as BulkField[]);
/** the option chosen first: items picked in the list → the first option that uses them */
export const firstBulkField = (can: Can, picked: number) => {
  const all = bulkFields(can);
  return (picked ? all.find(f => f === 'exclude' || f === 'item_type' || f === 'move') : undefined) ?? all[0] ?? 'progress';
};
/** bulk options that apply to the chosen items (the others apply to every counted item of the application) */
export const usesChosen = (f: BulkField) => f === 'exclude' || f === 'item_type' || f === 'move';

/**
 * Rows from the server, except those this user is saving right now (inflight): a reload — pull, live event, poll —
 * must not put an old value back while the answer to the user's own change has not come (the web's rule).
 */
export function mergeRows(server: Item[], current: Item[], inflight: ReadonlyMap<number, number>) {
  if (!inflight.size) return server;
  const cur = new Map(current.map(x => [x.id, x]));
  return server.map(f => (inflight.has(f.id) ? cur.get(f.id) ?? f : f));
}

/** The values of the «إضافة وظيفة» form: Arabic name required; weight 0–1000, progress 0–100 */
export type NewItem = { name_ar: string; name_en: string; reference: string; weight: string; progress: string; enabled: boolean; item_type: 'function' | 'report' };
export const emptyNewItem = (): NewItem => ({ name_ar: '', name_en: '', reference: '', weight: '1', progress: '0', enabled: true, item_type: 'function' });
export const newItemReady = (v: NewItem) => !!v.name_ar.trim();
export const newItemBody = (v: NewItem) => ({ ...v, weight: +v.weight || 0, progress: +v.progress || 0 });
export const newItemPreview = (v: NewItem) => ({ weight: +v.weight || 0, progress: +v.progress || 0, enabled: v.enabled, item_type: v.item_type });

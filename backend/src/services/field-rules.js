// Field-edit rule tables for a tracker function (extracted from routes/tracker.js, BE-1). These describe which
// permission a field needs, how its value is validated and which values make a note mandatory. They are shared by
// the direct field edit (routes/tracker.js) and the bulk operations (services/bulk.js).
//
// NOTE_REQUIRED is hand-duplicated on the client (frontend/src/lib/itemRules.js) and guarded by
// test/rule-parity.test.js, which parses the authoritative server copy from THIS file's text. Keep its literal shape
// (a plain {key: [numbers]} map) and its value identical to the client.
import { numIn, intIn } from '../utils/http.js';
import { ITEM_TYPES } from './calc.js';

// Field → permission needed to change it.
export const FIELD_PERM = {
  progress: 'pct', notif_status: 'pct', weight: 'wgt', enabled: 'tog',
  test_status: 'tst', review_status: 'tst', note: 'tst',
  item_type: 'tog',          // function / report (1.8.0): whoever adds and removes items sets their type
};

export const FIELD_OK = {
  progress: v => numIn(v, 0, 100), weight: v => numIn(v, 0, 1000), enabled: v => typeof v === 'boolean',
  test_status: v => intIn(v, 0, 7), notif_status: v => intIn(v, 0, 3), review_status: v => intIn(v, 0, 5),
  note: v => typeof v === 'string' && v.length <= 2000,
  item_type: v => ITEM_TYPES.includes(v),
};

// Statuses that mean "… with notes": choosing one makes the note mandatory. A field may have more than one such
// value — test_status needs a note for «نجح مع ملاحظة» (1), «إعادة الاختبار» (4, 1.12.25), «غير متاح للاختبار» (5),
// «لم يتم عرضها» (6) and «لم يتم التدريب» (7, migration 030).
export const NOTE_REQUIRED = { test_status: [1, 4, 5, 6, 7], notif_status: [2], review_status: [3] };
export const notedValue = (k, v) => (NOTE_REQUIRED[k] || []).includes(v);
export const needsNote = f => Object.entries(NOTE_REQUIRED).some(([k]) => notedValue(k, f[k]));

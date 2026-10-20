// Renaming a function / report item (1.9.1): the Arabic name (and the English one) change only with a reason, sent
// on its own (PATCH /tracker/functions/:id with name_ar / name_en + rename_reason). The code never changes.
// The reason follows the rule of the exclusion note (services/disable.js): 3–500 characters, spaces not counted.
import { bad } from '../utils/http.js';
import { NOTE_MIN, NOTE_MAX } from './disable.js';

export const RENAME_KEYS = ['name_ar', 'name_en', 'rename_reason'];
export const NAME_MAX = 500;
export const REASON_MIN = NOTE_MIN, REASON_MAX = NOTE_MAX;

export function parseRenameReason(raw) {
  if (raw === undefined || raw === null) throw bad('rename_reason_required', { min: REASON_MIN });
  if (typeof raw !== 'string') throw bad('invalid_value', { field: 'rename_reason' });
  const reason = raw.trim();
  if (reason.length > REASON_MAX) throw bad('invalid_value', { field: 'rename_reason', max: REASON_MAX });
  if (reason.replace(/\s/gu, '').length < REASON_MIN) throw bad('rename_reason_required', { min: REASON_MIN });
  return reason;
}

// The changed names of a rename body against the current row: { name_ar?, name_en? } — throws 400.
//   name_ar: trimmed, not empty, at most 500 characters; name_en: the same, or empty / null to clear it.
export function parseRename(body, cur) {
  const hasAr = Object.hasOwn(body, 'name_ar'), hasEn = Object.hasOwn(body, 'name_en');
  if (!hasAr && !hasEn) throw bad('invalid_value', { field: 'name_ar' });       // a reason alone renames nothing
  const changes = {};
  if (hasAr) {
    const v = typeof body.name_ar === 'string' ? body.name_ar.trim() : null;
    if (!v || v.length > NAME_MAX) throw bad('invalid_value', { field: 'name_ar', max: NAME_MAX });
    if (v !== cur.name_ar) changes.name_ar = v;
  }
  if (hasEn) {
    if (body.name_en !== null && typeof body.name_en !== 'string') throw bad('invalid_value', { field: 'name_en' });
    const v = (body.name_en ?? '').trim() || null;
    if (v && v.length > NAME_MAX) throw bad('invalid_value', { field: 'name_en', max: NAME_MAX });
    if (v !== (cur.name_en ?? null)) changes.name_en = v;
  }
  if (!Object.keys(changes).length) throw bad('name_unchanged');
  return changes;
}

// Another item of the same application (not removed) already called that: the rename is allowed, with a warning.
export async function duplicateName(c, appId, id, name) {
  if (!name) return false;
  return (await c.query(`SELECT 1 FROM functions WHERE app_id=$1 AND id<>$2 AND removed_at IS NULL
    AND lower(btrim(name_ar))=lower($3) LIMIT 1`, [appId, id, name])).rowCount > 0;
}

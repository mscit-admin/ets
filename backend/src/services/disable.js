// Why a function is excluded from the calculation (migration 013). Every path that turns a function off goes
// through here: the direct edit and the bulk exclusion (routes/tracker.js), an approved request (services/edits.js),
// an approved import batch (services/imports.js) and the legacy import (services/legacy.js).
import { canSeeApp } from '../middleware/auth.js';
import { bad, isId } from '../utils/http.js';

// Reasons a user chooses; 'import' is set by the system for files that turn functions off.
export const DISABLE_REASONS = ['duplicate', 'out_of_scope', 'not_required', 'other'];
export const NOTE_MAX = 500;
// The note is required for every reason a user chooses (1.5.1): at least NOTE_MIN non-whitespace characters.
export const NOTE_MIN = 3;
export const MAX_DUPLICATES = 50;
// Fields of a request body that belong to the reason (not columns edited directly).
export const REASON_KEYS = ['disabled_reason', 'disabled_note', 'duplicate_of'];

// The reason sent with an exclusion: { reason, note, duplicate_of: [ids] } — throws 400. Checked when the change is
// made or the request is submitted; approving a request applies the reason it carries as is (requests created before
// 1.5.1 may have no note).
export function parseDisableReason(body = {}) {
  const reason = body.disabled_reason;
  if (reason === undefined || reason === null || reason === '') throw bad('disable_reason_required');
  if (typeof reason !== 'string' || !DISABLE_REASONS.includes(reason)) throw bad('invalid_value', { field: 'disabled_reason' });
  const raw = body.disabled_note ?? '';
  if (typeof raw !== 'string') throw bad('invalid_value', { field: 'disabled_note' });
  const note = raw.trim();
  if (note.length > NOTE_MAX) throw bad('invalid_value', { field: 'disabled_note', max: NOTE_MAX });
  if (note.replace(/\s/gu, '').length < NOTE_MIN) throw bad('disable_note_required', { min: NOTE_MIN });
  let ids = [];
  if (reason === 'duplicate') {
    const v = body.duplicate_of;
    if (!Array.isArray(v) || !v.length) throw bad('duplicate_of_required');
    if (v.length > MAX_DUPLICATES || !v.every(isId)) throw bad('invalid_value', { field: 'duplicate_of' });
    ids = [...new Set(v)];
  } else if (body.duplicate_of !== undefined && !(Array.isArray(body.duplicate_of) && body.duplicate_of.length === 0)) {
    throw bad('invalid_value', { field: 'duplicate_of' });       // only a duplicate points at other functions
  }
  return { reason, note, duplicate_of: ids };
}

// The functions a duplicate points at must exist, be in the user's scope, not be one of the functions being
// excluded, and not be removed. Missing and out-of-scope look the same (no hint that an id exists).
// Returns [{id, app_id, code, name_ar, name_en}] in the order given.
export async function checkDuplicates(c, user, ids, selfIds = []) {
  if (!ids.length) return [];
  const self = new Set(selfIds);
  const rows = new Map((await c.query(`SELECT f.id, f.app_id, f.code, f.name_ar, f.name_en, f.removed_at, a.department_id
    FROM functions f JOIN applications a ON a.id=f.app_id WHERE f.id = ANY($1)`, [ids])).rows.map(r => [r.id, r]));
  return ids.map(id => {
    const f = rows.get(id);
    if (self.has(id)) throw bad('invalid_duplicate', { id, problem: 'self' });
    if (!f || !canSeeApp(user, { id: f.app_id, department_id: f.department_id })) throw bad('invalid_duplicate', { id, problem: 'unavailable' });
    if (f.removed_at) throw bad('invalid_duplicate', { id, problem: 'removed' });
    return { id: f.id, app_id: f.app_id, code: f.code, name_ar: f.name_ar, name_en: f.name_en };
  });
}

// Short form of the linked functions stored in audit rows and request items.
export const refs = list => list.map(f => ({ id: f.id, app_id: f.app_id, code: f.code }));

// Records the reason on functions that are being turned off (same transaction as the change).
export async function setDisabled(c, ids, d, userId) {
  if (!ids.length) return;
  await c.query(`UPDATE functions SET disabled_reason=$2, disabled_note=$3, disabled_by=$4, disabled_at=now() WHERE id = ANY($1)`,
    [ids, d.reason ?? null, d.note ?? null, userId ?? null]);
  await c.query('DELETE FROM function_duplicates WHERE function_id = ANY($1)', [ids]);
  const dup = d.reason === 'duplicate' ? (d.duplicate_of || []) : [];
  if (dup.length) {
    await c.query(`INSERT INTO function_duplicates(function_id, duplicate_of_id)
      SELECT f, t FROM unnest($1::int[]) f CROSS JOIN unnest($2::int[]) t WHERE f <> t ON CONFLICT DO NOTHING`, [ids, dup]);
  }
}

// Clears the active reason of functions that count again (the audit trail keeps the history).
export async function clearDisabled(c, ids) {
  if (!ids.length) return;
  await c.query(`UPDATE functions SET disabled_reason=NULL, disabled_note=NULL, disabled_by=NULL, disabled_at=NULL
    WHERE id = ANY($1) AND (disabled_reason IS NOT NULL OR disabled_note IS NOT NULL OR disabled_by IS NOT NULL OR disabled_at IS NOT NULL)`, [ids]);
  await c.query('DELETE FROM function_duplicates WHERE function_id = ANY($1)', [ids]);
}

// The reason of these functions as it stands (for the "before" side of an audit row): Map id → {…}.
export async function currentReasons(c, ids) {
  if (!ids.length) return new Map();
  const rows = (await c.query(`SELECT f.id, f.disabled_reason, f.disabled_note,
      coalesce((SELECT json_agg(json_build_object('id', t.id, 'app_id', t.app_id, 'code', t.code) ORDER BY t.app_id, t.sort, t.id)
        FROM function_duplicates d JOIN functions t ON t.id=d.duplicate_of_id WHERE d.function_id=f.id), '[]') AS duplicate_of
    FROM functions f WHERE f.id = ANY($1)`, [ids])).rows;
  return new Map(rows.map(r => [r.id, { disabled_reason: r.disabled_reason, disabled_note: r.disabled_note, duplicate_of: r.duplicate_of }]));
}

// Values of an audit row for an exclusion / inclusion, so the trail shows the reason before → after.
export function reasonValues(d) {
  return { disabled_reason: d?.reason ?? null, disabled_note: d?.note ?? null, duplicate_of: refs(d?.duplicates || []) };
}
export const hadReason = r => !!r && (r.disabled_reason || r.disabled_note || r.duplicate_of?.length);

// The reason recorded for functions turned off by an import file: 'import' with the batch reference.
export const importReason = ref => ({ reason: 'import', note: String(ref || '').slice(0, NOTE_MAX) || null, duplicate_of: [] });

// For the screens: the functions each function duplicates, with names only for the reader's scope.
// Returns Map function_id → [{id, app_id, code, name_ar?, name_en?, removed}].
export async function duplicatesOf(q, user, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = (await q(`SELECT d.function_id, t.id, t.app_id, t.code, t.name_ar, t.name_en, t.removed_at, a.department_id
    FROM function_duplicates d JOIN functions t ON t.id=d.duplicate_of_id JOIN applications a ON a.id=t.app_id
    WHERE d.function_id = ANY($1) ORDER BY a.sort, t.sort, t.id`, [ids])).rows;
  for (const r of rows) {
    const visible = canSeeApp(user, { id: r.app_id, department_id: r.department_id });
    if (!out.has(r.function_id)) out.set(r.function_id, []);
    out.get(r.function_id).push({ id: r.id, app_id: r.app_id, code: r.code, removed: !!r.removed_at, visible,
      ...(visible ? { name_ar: r.name_ar, name_en: r.name_en } : {}) });
  }
  return out;
}

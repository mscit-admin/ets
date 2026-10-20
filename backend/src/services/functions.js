// Add / remove / restore functions (migration 006). Used directly by approvers and, for data-entry users,
// when the team lead approves their request (services/edits.js).
import { str } from '../utils/http.js';
import { ITEM_TYPES } from './calc.js';

const num = (v, lo, hi, d) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, +v)) : d);

// Validated fields of a new function; throws 'name_required' / 'invalid_value'.
// item_type (1.8.0): 'function' (default) or 'report'.
export function newFunctionData(body = {}) {
  const name_ar = str(body.name_ar, 1000);
  if (!name_ar) { const e = new Error('name_required'); e.code = 'name_required'; throw e; }
  const item_type = body.item_type ?? 'function';
  if (!ITEM_TYPES.includes(item_type)) { const e = new Error('invalid_value'); e.code = 'invalid_value'; throw e; }
  const weight = num(body.weight, 0, 1000, 1);
  const progress = num(body.progress, 0, 100, 0);
  return { name_ar, name_en: str(body.name_en, 500) || null, reference: str(body.reference, 1000) || null,
    weight, progress, enabled: body.enabled !== false, item_type };
}

// Next free "C<n>" code of the application: never reuses a code, even of a removed function, nor one of an item that
// was moved out of it (1.10.0: function_moves.from_code). Callers lock the application row first (FOR UPDATE).
export async function nextCode(c, appId) {
  return 'C' + (await c.query(`SELECT GREATEST(
      (SELECT COALESCE(max(substring(code from 2)::int), -1) FROM functions WHERE app_id=$1 AND code ~ '^C[0-9]+$'),
      (SELECT COALESCE(max(substring(from_code from 2)::int), -1) FROM function_moves WHERE from_app_id=$1 AND from_code ~ '^C[0-9]+$')
    ) + 1 AS n`, [appId])).rows[0].n;
}

export async function createFunction(c, appId, d, userId) {
  await c.query('SELECT id FROM applications WHERE id=$1 FOR UPDATE', [appId]);      // serialise code numbering
  const code = await nextCode(c, appId);
  const sort = (await c.query('SELECT COALESCE(max(sort), 0) + 1 AS s FROM functions WHERE app_id=$1', [appId])).rows[0].s;
  // a request approved after an upgrade to 1.8.0 may carry no item_type: a function
  return (await c.query(`INSERT INTO functions(app_id, code, source, name_ar, name_en, reference, weight, progress, enabled, sort,
      created_at, created_by, updated_by, item_type)
    VALUES ($1,$2,'custom',$3,$4,$5,$6,$7,$8,$9, now(), $10, $10, $11) RETURNING *`,
  [appId, code, d.name_ar, d.name_en, d.reference, d.weight, d.progress, d.enabled, sort, userId, d.item_type === 'report' ? 'report' : 'function'])).rows[0];
}

// Removal keeps the row (restorable, and the catalog seed never re-creates it) and takes it out of every calculation.
export async function removeFunction(c, id, reason, userId) {
  return (await c.query(`UPDATE functions SET removed_at=now(), removed_by=$2, removed_reason=$3, enabled=false,
      updated_at=now(), updated_by=$2 WHERE id=$1 AND removed_at IS NULL RETURNING *`, [id, userId, reason])).rows[0];
}

// A restored function counts again, so an exclusion reason it had is cleared too (migration 013).
export async function restoreFunction(c, id, userId) {
  const f = (await c.query(`UPDATE functions SET removed_at=NULL, removed_by=NULL, removed_reason=NULL, enabled=true,
      disabled_reason=NULL, disabled_note=NULL, disabled_by=NULL, disabled_at=NULL,
      updated_at=now(), updated_by=$2 WHERE id=$1 AND removed_at IS NOT NULL RETURNING *`, [id, userId])).rows[0];
  if (f) await c.query('DELETE FROM function_duplicates WHERE function_id=$1', [id]);
  return f;
}

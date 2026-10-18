// Helpers for a readable audit trail: names of the people and items involved, and one audit row per
// changed function / report / application with its value before and after (see migration 007).
import { logAudit } from './logs.js';

const MAX_ITEMS = 500;

export const userRef = u => (u ? { id: u.id, username: u.username, full_name: u.full_name || null } : null);

// The IP from which a request / import was sent: the one on its own audit row ('edit_request' / 'import_submit').
// Changes applied later are recorded with it, not with the IP of the approver (ETS-SEC-052).
export async function originIp(c, action, entity, id) {
  return (await c.query(`SELECT host(ip) AS ip FROM audit_log WHERE action=$1 AND entity=$2 AND entity_id=$3
    ORDER BY chain_seq LIMIT 1`, [action, entity, String(id)])).rows[0]?.ip || null;
}

export async function loadUser(c, id) {
  if (!id) return null;
  return (await c.query('SELECT id, username, full_name FROM users WHERE id=$1', [id])).rows[0] || null;
}

// Change items ({kind, app_id, function_id?, field, old_value, new_value, applied?, meta?}) with the code and name of
// each function, as stored in an audit row's context (meta: the reason of an exclusion, migration 013).
export async function namedItems(c, items) {
  const ids = [...new Set(items.map(i => i.function_id).filter(Boolean))];
  const fns = ids.length ? new Map((await c.query('SELECT id, code, name_ar, name_en FROM functions WHERE id = ANY($1)', [ids])).rows.map(f => [f.id, f])) : new Map();
  return items.slice(0, MAX_ITEMS).map(i => {
    const f = fns.get(i.function_id);
    const created = i.field === 'create' ? i.new_value : null;
    return { kind: i.kind, app_id: i.app_id, function_id: i.function_id ?? null, code: f?.code ?? i.code ?? null,
      name_ar: f?.name_ar ?? created?.name_ar ?? null, name_en: f?.name_en ?? created?.name_en ?? null,
      field: i.field, old: i.old_value ?? null, new: i.new_value ?? null, ...(i.applied === undefined ? {} : { applied: i.applied }),
      ...(i.meta ? { meta: i.meta } : {}) };
  });
}

// Writes one 'update' audit row per function / report / application weight that an approved request or
// import changed, so each item's history shows its own before → after values.
export async function logAppliedChanges(req, c, items, { actor = null, actorIp = null, context = null } = {}) {
  const groups = new Map();
  for (const it of items) {
    const key = it.kind === 'function' ? `f${it.function_id}` : `${it.kind}${it.app_id}`;
    if (!groups.has(key)) groups.set(key, { ...it, old: {}, new: {} });
    const g = groups.get(key);
    g.old[it.field] = it.old_value;
    g.new[it.field] = it.new_value;
  }
  const ids = [...groups.values()].filter(g => g.kind === 'function').map(g => g.function_id);
  const fns = ids.length ? new Map((await c.query('SELECT id, app_id, code, name_ar FROM functions WHERE id = ANY($1)', [ids])).rows.map(f => [f.id, f])) : new Map();
  for (const g of groups.values()) {
    const f = fns.get(g.function_id);
    const [entity, entityId, summary] = g.kind === 'function' ? ['function', g.function_id, f && `${f.app_id}/${f.code} ${f.name_ar.slice(0, 80)}`]
      : g.kind === 'report' ? ['report', g.app_id, null] : ['application', g.app_id, 'weight'];
    await logAudit(req, { db: c, actor, actorIp, action: 'update', entity, entityId, summary, oldValue: g.old, newValue: g.new, context });
  }
}

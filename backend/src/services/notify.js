// Notifications: who receives an alert, storing it (summaries, de-duplication, hourly cap), and reading it back with
// every rule checked again (proposal §3, §5). Alerts are created after the change they follow has committed
// (services/notify-events.js, called through onCommit) or by the periodic check (services/notify-scan.js).
//
// Receiving = ① eligibility in code ∧ ② policy (notify.policy) ∧ ③ the user's restrictions ∧ an active account:
//   ① eligible(): the permission of the type (effective permissions, after overrides) and its scope rule —
//      app: canSeeApp · dept: coversDept (the whole department) · project: full scope · approver: team-lead
//      permission + the application in scope · import: an approval permission + every department of the batch
//      covered · self: the user the alert is about · admin: the admin role only (security / system, ETS-SEC-047).
//   ② the cell (type × role) is on in the policy; mandatory cells cannot be switched off (notify-catalog.js).
//   ③ blocks set by an administrator on this user, then the user's own muting (non-mandatory types only).
// Checked when an alert is created AND whenever it is read (list, count, phone): a row the user may no longer see —
// permission or scope removed, type switched off, account deactivated — is hidden, not deleted, and shows again if
// the right comes back while the row is kept (notify.retention_days).
//
// The phone (Android app) receives only types whose policy allows the phone and that the user / an administrator did
// not take off the phone; a mandatory type that may not go to the phone is shown there as a generic «لديك تنبيه جديد»
// (no title, no body), other types are left out. Security / system alerts reach the phone without their body.
import { query } from '../db/pool.js';
import { hasPerm, canSeeApp, coversDept } from '../middleware/auth.js';
import { allSettings } from './settings.js';
import { logger } from './logs.js';
import { publishNotif, registerNotifSource } from './live.js';
import { TYPES, RATE_CAPPED, typeInfo, effectivePolicy, policyOn, isMandatory, pushAllowed, SEVERITIES } from './notify-catalog.js';
import { render, GENERIC } from './notify-text.js';

const SEV_RANK = { info: 0, warning: 1, critical: 2 };
export const LINK_RE = /^\/[A-Za-z0-9/_?=&.-]*$/;
const READ_SCAN_MAX = 2000;          // unread rows looked at for a count (a user never has that many open summaries)

// ---------------------------------------------------------------- users
// Active accounts (not deleted, not deactivated, no forced password change) with the same context as a session
// (middleware/auth.js loadUserContext), in one query.
export async function activeUsers(ids = null) {
  const r = await query(`SELECT u.id, u.username, u.full_name, u.role_id, u.language, r.full_scope, r.permissions AS role_perms,
      COALESCE((SELECT json_agg(json_build_object('p',permission,'g',granted)) FROM user_permissions WHERE user_id=u.id),'[]') AS overrides,
      COALESCE((SELECT json_agg(json_build_object('k',kind,'r',ref_id)) FROM user_scopes WHERE user_id=u.id),'[]') AS scopes
    FROM users u JOIN roles r ON r.id=u.role_id
    WHERE u.is_active AND u.deleted_at IS NULL AND NOT u.must_change_password ${ids ? 'AND u.id = ANY($1)' : ''}
    ORDER BY u.id`, ids ? [ids] : []);
  return r.rows.map(u => {
    const perms = new Set(u.role_perms);
    for (const o of u.overrides) o.g ? perms.add(o.p) : perms.delete(o.p);
    if (u.role_id !== 'admin') perms.delete('usr');
    return { id: u.id, username: u.username, full_name: u.full_name, role: u.role_id, language: u.language,
      is_active: true, must_change_password: false, permissions: [...perms], fullScope: !!u.full_scope,
      scope: { departments: u.scopes.filter(s => s.k === 'department').map(s => s.r), applications: u.scopes.filter(s => s.k === 'application').map(s => s.r) } };
  });
}

export const appMap = async () => new Map((await query('SELECT id, department_id, name_ar, name_en FROM applications')).rows.map(a => [a.id, a]));

// ---------------------------------------------------------------- the three layers
// ① eligibility in code. row: { type, user_id, app_id, dept_id, params }.
export function eligible(user, row, apps) {
  const t = typeInfo(row.type);
  if (!t || !user || !user.is_active || user.must_change_password) return false;
  if (t.admin) return user.role === 'admin';
  if (t.perms?.length && !t.perms.some(p => hasPerm(user, p))) return false;
  const app = row.app_id ? apps.get(row.app_id) : null;
  switch (t.scope) {
    case 'self': return row.user_id === user.id;
    case 'app': return !!app && canSeeApp(user, app);
    case 'app_or_dept': return row.app_id ? !!app && canSeeApp(user, app) : row.dept_id ? coversDept(user, row.dept_id) : !!user.fullScope;
    case 'dept': return !!row.dept_id && coversDept(user, row.dept_id);
    case 'project': return !!user.fullScope;
    case 'approver': return !!app && hasPerm(user, 'apv_dept') && canSeeApp(user, app);
    case 'approvals': return hasPerm(user, 'apv_dept') || (hasPerm(user, 'apv_final') && !!user.fullScope);
    case 'import': {
      const ds = Array.isArray(row.params?.depts) ? row.params.depts : [];
      return user.fullScope || (ds.length > 0 && ds.every(d => coversDept(user, d)));
    }
    default: return false;
  }
}

// The user's restrictions: { blocks: Set('type|channel'), prefs: { muted:[], mobile_muted:[], digest } }
export async function restrictions(userIds) {
  const [b, p] = await Promise.all([
    query('SELECT user_id, type, channel FROM notification_user_blocks WHERE user_id = ANY($1)', [userIds]),
    query('SELECT user_id, prefs FROM notification_prefs WHERE user_id = ANY($1)', [userIds]),
  ]);
  const out = new Map(userIds.map(id => [id, { blocks: new Set(), prefs: normPrefs(null) }]));
  for (const x of b.rows) out.get(x.user_id)?.blocks.add(`${x.type}|${x.channel}`);
  for (const x of p.rows) if (out.has(x.user_id)) out.get(x.user_id).prefs = normPrefs(x.prefs);
  return out;
}
export function normPrefs(p) {
  const v = p && typeof p === 'object' ? p : {};
  const list = a => (Array.isArray(a) ? a.filter(t => Object.hasOwn(TYPES, t)) : []);
  return { muted: list(v.muted), mobile_muted: list(v.mobile_muted), digest: v.digest !== false };
}

// ② + ③ for the web (in-app) channel.
export function wanted(user, type, pol, rs) {
  if (!policyOn(pol, type, user.role)) return false;
  if (type === RATE_CAPPED) return true;
  if (isMandatory(pol, type, user.role)) return true;
  if (rs?.blocks.has(`${type}|all`) || rs?.blocks.has('*|all')) return false;
  if (rs?.prefs.muted.includes(type)) return false;
  if (TYPES[type]?.digest && rs && !rs.prefs.digest) return false;
  return true;
}
// The phone: 'full' (title and body; no body for security / system), 'generic' or 'omit'.
export function mobileMode(user, type, pol, rs) {
  const mandatory = isMandatory(pol, type, user.role);
  const off = !pushAllowed(pol, type) || rs?.blocks.has(`${type}|mobile`) || rs?.blocks.has('*|mobile') ||
    (!mandatory && rs?.prefs.mobile_muted.includes(type));
  if (!off) return 'full';
  return mandatory ? 'generic' : 'omit';
}

const policyOf = s => effectivePolicy(s['notify.policy']);

// ---------------------------------------------------------------- creating
// entries: [{ user (context), dedupeKey, params?, count?, severity?, link?, appId?, deptId?, mode?: 'set'|'add' }]
// The type's rules are applied to each entry; returns the ids written per user. Never throws (logged).
export async function deliver(type, entries, { now = new Date() } = {}) {
  try {
    const s = await allSettings();
    if (!s['notify.enabled'] && type !== RATE_CAPPED) return new Map();
    const t = typeInfo(type);
    if (!t || !entries.length) return new Map();
    const pol = policyOf(s);
    const apps = await appMap();
    const rs = await restrictions([...new Set(entries.map(e => e.user.id))]);
    const out = new Map();
    for (const e of entries) {
      const row = { type, user_id: e.user.id, app_id: e.appId || null, dept_id: e.deptId || null, params: e.params || {} };
      if (!eligible(e.user, row, apps) || !wanted(e.user, type, pol, rs.get(e.user.id))) continue;
      const id = await store(e.user, type, t, e, row, { cap: +s['notify.rate_cap_per_hour'] || 50, mandatory: isMandatory(pol, type, e.user.role), now });
      if (id) (out.get(e.user.id) || out.set(e.user.id, []).get(e.user.id)).push(Number(id));   // bigserial → string
    }
    for (const [uid, ids] of out) publishNotif(uid, ids);
    return out;
  } catch (err) {
    logger.warn({ err: err.message, type }, 'notify: delivery failed');
    return new Map();
  }
}

const repeatAfterMs = sev => (sev === 'critical' ? 1 : 7) * 864e5;

async function store(user, type, t, e, row, { cap, mandatory, now }) {
  const severity = SEVERITIES.includes(e.severity) ? e.severity : t.severity;
  const count = Math.max(1, e.count ?? 1);
  const link = typeof e.link === 'string' && LINK_RE.test(e.link) ? e.link : null;
  const add = e.mode === 'add';
  const params = JSON.stringify(row.params);
  // an open (unread) row with the same key is brought up to date: a summary's new count, or one more event merged in
  const upd = await query(`UPDATE notifications SET count = ${add ? 'count + $3' : '$3'}, params=$4::jsonb, severity=$5, link=COALESCE($6, link),
      updated_at=now(), resolved_at=NULL
    WHERE user_id=$1 AND dedupe_key=$2 AND read_at IS NULL
      AND (${add ? 'true' : `count <> $3 OR params <> $4::jsonb OR severity <> $5`})
    RETURNING id`, [user.id, e.dedupeKey, count, params, severity, link]);
  if (upd.rows[0]) return upd.rows[0].id;
  if (!add && (await query('SELECT 1 FROM notifications WHERE user_id=$1 AND dedupe_key=$2 AND read_at IS NULL', [user.id, e.dedupeKey])).rowCount) return null;
  // a periodic summary already read comes back only when it grew, got worse, or after the repeat interval
  if (t.kind === 'periodic') {
    const last = (await query(`SELECT count, severity, updated_at FROM notifications WHERE user_id=$1 AND dedupe_key=$2
      ORDER BY updated_at DESC LIMIT 1`, [user.id, e.dedupeKey])).rows[0];
    if (last && now - new Date(last.updated_at) < repeatAfterMs(severity) && count <= last.count && SEV_RANK[severity] <= SEV_RANK[last.severity]) return null;
  }
  // hourly cap of new alerts per user; mandatory alerts are never held back
  if (!mandatory && type !== RATE_CAPPED) {
    const n = (await query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type <> $2 AND created_at > now() - interval '1 hour'`,
      [user.id, RATE_CAPPED])).rows[0].n;
    if (n >= cap) {
      const capped = await upsert(user.id, { type: RATE_CAPPED, category: 'system', severity: 'info', params: '{}', link: '/notifications',
        appId: null, deptId: null, key: RATE_CAPPED, count: 1, add: true });
      return capped;
    }
  }
  return upsert(user.id, { type, category: t.category, severity, params, link, appId: row.app_id, deptId: row.dept_id, key: e.dedupeKey, count, add });
}

async function upsert(userId, r) {
  const q = await query(`INSERT INTO notifications(user_id, type, category, severity, params, link, app_id, dept_id, dedupe_key, count)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
    ON CONFLICT (user_id, dedupe_key) WHERE read_at IS NULL DO UPDATE SET
      count = ${r.add ? 'notifications.count + EXCLUDED.count' : 'EXCLUDED.count'}, params = EXCLUDED.params,
      severity = EXCLUDED.severity, updated_at = now(), resolved_at = NULL
    RETURNING id`, [userId, r.type, r.category, r.severity, r.params, r.link, r.appId, r.deptId, r.key, r.count]);
  return q.rows[0]?.id || null;
}

// Open summaries whose condition no longer holds are closed (marked read and resolved): for this type, every unread
// row not in keep ([{userId, key}]); with onlyKey, only the rows of that dedupe key.
export async function resolveExcept(type, keep, { onlyKey = null } = {}) {
  const r = await query(`UPDATE notifications n SET read_at=now(), resolved_at=now()
    WHERE n.type=$1 AND n.read_at IS NULL ${onlyKey ? 'AND n.dedupe_key = $4' : ''}
      AND NOT EXISTS (SELECT 1 FROM unnest($2::int[], $3::text[]) k(u, key) WHERE k.u=n.user_id AND k.key=n.dedupe_key)
    RETURNING user_id`, [type, keep.map(k => k.userId), keep.map(k => k.key), ...(onlyKey ? [onlyKey] : [])]);
  for (const uid of new Set(r.rows.map(x => x.user_id))) publishNotif(uid, []);
  return r.rowCount;
}

// ---------------------------------------------------------------- reading
// Everything a read needs for one user: settings, policy, applications, restrictions.
export async function readContext(user) {
  const s = await allSettings();
  return { user, pol: policyOf(s), apps: await appMap(), rs: (await restrictions([user.id])).get(user.id), enabled: s['notify.enabled'] !== false };
}
const visible = (ctx, row) => row.user_id === ctx.user.id && eligible(ctx.user, row, ctx.apps) && wanted(ctx.user, row.type, ctx.pol, ctx.rs);

export function present(row, lang, mode = 'full') {
  const generic = mode === 'generic';
  const text = generic ? GENERIC[lang === 'en' ? 'en' : 'ar'] : render(row, lang);
  const t = typeInfo(row.type);
  return { id: Number(row.id), type: row.type, category: row.category, severity: row.severity,
    title: text.title, body: generic || (mode === 'mobile' && t && (t.admin || t.category === 'security')) ? null : text.body,
    link: generic ? '/notifications' : row.link, count: row.count, created_at: row.created_at, updated_at: row.updated_at, read: !!row.read_at };
}

const COLS = 'id, user_id, type, category, severity, params, link, app_id, dept_id, count, created_at, updated_at, read_at';

// The web list: filters { unread, category, type, severity, before (id), limit }, newest first.
export async function listFor(user, f = {}, lang = user.language) {
  const ctx = await readContext(user);
  const limit = Math.min(100, Math.max(1, f.limit | 0 || 20));
  const params = [user.id], where = ['user_id=$1'];
  if (f.unread) where.push('read_at IS NULL');
  if (f.category) { params.push(f.category); where.push(`category=$${params.length}`); }
  if (f.type) { params.push(f.type); where.push(`type=$${params.length}`); }
  if (f.severity) { params.push(f.severity); where.push(`severity=$${params.length}`); }
  const out = [];
  let before = f.before || null, more = true;
  for (let pass = 0; out.length < limit && more && pass < 20; pass++) {
    const p = [...params]; const w = [...where];
    if (before) { p.push(before); w.push(`id < $${p.length}`); }
    const rows = (await query(`SELECT ${COLS} FROM notifications WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT 200`, p)).rows;
    more = rows.length === 200;
    for (const r of rows) {
      before = r.id;
      if (visible(ctx, r)) { out.push(present(r, lang)); if (out.length >= limit) break; }
    }
  }
  return { items: out, next_before: out.length >= limit ? Number(before) : null };
}

// Unread rows the user may see (web): { unread, critical, top_severity }
export async function unreadSummary(user) {
  const ctx = await readContext(user);
  const rows = (await query(`SELECT ${COLS} FROM notifications WHERE user_id=$1 AND read_at IS NULL ORDER BY id DESC LIMIT ${READ_SCAN_MAX}`, [user.id])).rows
    .filter(r => visible(ctx, r));
  const top = rows.reduce((m, r) => Math.max(m, SEV_RANK[r.severity] ?? 0), -1);
  return { unread: rows.length, critical: rows.filter(r => r.severity === 'critical').length, top_severity: top < 0 ? null : SEVERITIES[top] };
}

// Marks read (ids, or every visible unread row with all=true); only rows the user may see. → number marked.
export async function markRead(user, { ids = null, all = false, read = true } = {}) {
  const ctx = await readContext(user);
  const rows = (await query(`SELECT ${COLS} FROM notifications WHERE user_id=$1 AND ${read ? 'read_at IS NULL' : 'read_at IS NOT NULL'}
    ${all ? '' : 'AND id = ANY($2)'} ORDER BY id DESC LIMIT ${READ_SCAN_MAX}`, all ? [user.id] : [user.id, ids])).rows.filter(r => visible(ctx, r));
  if (!rows.length) return 0;
  let n;
  if (read) n = (await query('UPDATE notifications SET read_at=now() WHERE id = ANY($1) AND read_at IS NULL', [rows.map(r => r.id)])).rowCount;
  else {
    // back to unread — unless a newer open row has the same key (one open row per key)
    n = (await query(`UPDATE notifications n SET read_at=NULL, resolved_at=NULL WHERE n.id = ANY($1) AND n.read_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM notifications o WHERE o.user_id=n.user_id AND o.dedupe_key=n.dedupe_key AND o.read_at IS NULL)`,
    [rows.map(r => r.id)])).rowCount;
  }
  publishNotif(user.id, []);
  return n;
}

// ---- the phone
// Items for the Android app: { items, unread }.
//   after_id given (0 included): the alerts with id > after_id, OLDEST FIRST (ascending id), up to limit — the app
//                                pages forward from the last id it has;
//   no after_id:                 the newest `limit` alerts, newest first.
// A summary that grows while unread keeps its id: the stream's "notification" / "unread" events announce it.
export async function mobileList(user, { afterId = null, limit = 20 } = {}) {
  const ctx = await readContext(user);
  const lim = Math.min(100, Math.max(1, limit | 0 || 20));
  const asc = afterId !== null;
  const rows = (await query(`SELECT ${COLS} FROM notifications WHERE user_id=$1 AND id > $2 ORDER BY id ${asc ? 'ASC' : 'DESC'} LIMIT ${READ_SCAN_MAX}`,
    [user.id, afterId || 0])).rows;
  const items = [];
  for (const r of rows) {
    if (items.length >= lim) break;
    const m = mobileVisible(ctx, r);
    if (m) items.push(mobileItem(r, user.language, m));
  }
  return { items, unread: await mobileUnread(user, ctx) };
}
const mobileVisible = (ctx, r) => {
  if (!visible(ctx, r)) return null;
  const m = mobileMode(ctx.user, r.type, ctx.pol, ctx.rs);
  return m === 'omit' ? null : m;
};
const mobileItem = (r, lang, m) => {
  const p = present(r, lang, m === 'generic' ? 'generic' : 'mobile');
  return { id: p.id, type: p.type, severity: p.severity, title: p.title, body: p.body, link: p.link, created_at: p.created_at, read: p.read };
};
export async function mobileUnread(user, ctx = null) {
  ctx ||= await readContext(user);
  const rows = (await query(`SELECT ${COLS} FROM notifications WHERE user_id=$1 AND read_at IS NULL ORDER BY id DESC LIMIT ${READ_SCAN_MAX}`, [user.id])).rows;
  return rows.filter(r => mobileVisible(ctx, r)).length;
}
// Of these ids, the ones the phone of this user may be told about.
export async function mobileIds(user, ids) {
  if (!ids.length) return [];
  const ctx = await readContext(user);
  const rows = (await query(`SELECT ${COLS} FROM notifications WHERE user_id=$1 AND id = ANY($2) AND read_at IS NULL`, [user.id, ids])).rows;
  return rows.filter(r => mobileVisible(ctx, r)).map(r => Number(r.id));
}
export async function mobileMarkRead(user, id) {
  const ctx = await readContext(user);
  const r = (await query(`SELECT ${COLS} FROM notifications WHERE user_id=$1 AND id=$2`, [user.id, id])).rows[0];
  if (!r || !mobileVisible(ctx, r)) return false;
  if (!r.read_at) await query('UPDATE notifications SET read_at=now() WHERE id=$1 AND read_at IS NULL', [id]);
  publishNotif(user.id, []);
  return true;
}

// The live stream (services/live.js) asks these when an alert of a user changes.
registerNotifSource({ webSummary: unreadSummary, mobileIds, mobileUnread });

// ---------------------------------------------------------------- preferences
// The types this user may receive at all (① by permission / role, ② policy), with what they chose.
export async function prefsFor(user) {
  const s = await allSettings();
  const pol = policyOf(s);
  const rs = (await restrictions([user.id])).get(user.id);
  const types = Object.entries(TYPES).filter(([k, t]) => policyOn(pol, k, user.role) &&
    (t.admin ? user.role === 'admin' : !t.perms?.length || t.perms.some(p => hasPerm(user, p))) &&
    (t.scope !== 'project' || user.fullScope))
    .map(([k, t]) => {
      const mandatory = isMandatory(pol, k, user.role);
      const blocked = rs.blocks.has(`${k}|all`) || (!mandatory && rs.blocks.has('*|all'));
      return { type: k, code: t.code, category: t.category, kind: t.kind, digest: !!t.digest, mandatory, blocked: blocked && !mandatory,
        mobile_blocked: rs.blocks.has(`${k}|mobile`) || rs.blocks.has('*|mobile'), push_allowed: pushAllowed(pol, k),
        muted: !mandatory && rs.prefs.muted.includes(k), mobile_muted: !mandatory && rs.prefs.mobile_muted.includes(k) };
    });
  return { types, digest: rs.prefs.digest };
}

export const DIGEST_TYPES = Object.keys(TYPES).filter(k => TYPES[k].digest);

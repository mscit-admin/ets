import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm, requireAdmin, ADMIN_ROLE } from '../middleware/auth.js';
import { hashPassword, checkPolicy, generateTemporaryPassword, hashManyPasswords } from '../services/passwords.js';
import { getSetting } from '../services/settings.js';
import { logAudit, logAuth } from '../services/logs.js';
import { publishSessionCheck, publishChange, publishApps } from '../services/live.js';
import { requestContext } from '../services/edits.js';
import { userRef, namedItems, loadUser as loadAuditUser } from '../services/audit.js';
import { userImportJson } from '../middleware/body.js';
import { HttpError, bad, notFound, str, idParam, isId, isDate } from '../utils/http.js';
import { matchList, matchOne, roleIndex, languageIndex, placeIndex } from '../utils/importMatch.js';
import { revokeDevices } from '../services/devices.js';
import { requestsSettled, accountUnlocked, accountReactivated } from '../services/notify-events.js';
import { isDelayed } from '../services/lockout.js';
import { publishNotif } from '../services/live.js';
import { TYPES, isLockedCell } from '../services/notify-catalog.js';

const r = Router();
// User administration = system administrators only (owner decision, ETS-SEC-004): 'usr' AND the admin role.
r.use(requireAuth, requirePerm('usr'), requireAdmin);

const PERMISSIONS = ['pct', 'wgt', 'tst', 'tog', 'ren', 'mov', 'sch', 'rep', 'exp', 'imp', 'usr', 'log', 'cfg', 'apv_dept', 'apv_final', 'msg'];

// Never includes secrets (password hash, TOTP secret), so rows can be returned as-is.
const USER_COLS = `u.id, u.username, u.full_name, u.email, u.role_id, u.language, u.is_active, u.must_change_password,
  u.totp_enabled, u.totp_exempt, u.totp_enabled_at, u.failed_attempts, u.locked_until, u.last_login_at,
  host(u.last_login_ip) AS last_login_ip, u.created_at, u.updated_at, u.password_changed_at,
  u.on_leave, u.leave_from, u.leave_to, u.substitute_user_id,
  (SELECT full_name FROM users s WHERE s.id=u.substitute_user_id) AS substitute_name`;

r.get('/meta', async (req, res) => {
  const [roles, depts, apps] = await Promise.all([
    query(`SELECT * FROM roles ORDER BY array_position(ARRAY['admin','pm','tm','lead','member','mgr','ed','qa','obs'], id)`),
    query('SELECT id, name_ar, name_en, short_ar, short_en FROM departments ORDER BY sort'),
    query('SELECT id, department_id, name_ar, name_en FROM applications ORDER BY sort'),
  ]);
  res.json({ roles: roles.rows, permissions: PERMISSIONS, departments: depts.rows, applications: apps.rows,
    mfa_mode: await getSetting('mfa.mode') });
});

// The user list of the Users screen and its Excel export (administrators only, see the router guard above and
// routes/export.js).
export async function listUsers() {
  return (await query(`SELECT ${USER_COLS},
      (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>now()) AS active_sessions,
      (SELECT count(*)::int FROM user_scopes s WHERE s.user_id=u.id) AS scope_count,
      r.name_ar AS role_name_ar, r.name_en AS role_name_en, r.full_scope AS role_full_scope
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.deleted_at IS NULL ORDER BY u.username`)).rows;
}

// ?deleted=1: the deleted (archived) accounts instead, for the "Deleted users" view (see the delete block below).
r.get('/', async (req, res) => res.json(req.query.deleted === '1' ? { users: await listDeletedUsers(), deleted: true }
  : { users: await listUsers(), mfa_mode: await getSetting('mfa.mode') }));

async function loadUser(id) {
  // a deleted account is not found: it is only listed (GET /?deleted=1) and restored (POST /:id/restore)
  const u = (await query(`SELECT ${USER_COLS} FROM users u WHERE u.id=$1 AND u.deleted_at IS NULL`, [id])).rows[0];
  if (!u) throw notFound();
  u.scopes = (await query('SELECT kind, ref_id FROM user_scopes WHERE user_id=$1', [id])).rows;
  u.overrides = (await query('SELECT permission, granted FROM user_permissions WHERE user_id=$1', [id])).rows;
  u.sessions = (await query(`SELECT left(id,8) AS ref, host(ip) AS ip, user_agent, created_at, last_seen_at, expires_at, mfa_passed
    FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC`, [id])).rows;
  u.recovery_codes_left = +(await query('SELECT count(*) FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [id])).rows[0].count;
  // phones paired with the account (1.9.0): active ones, and the ones revoked in the last 30 days
  u.devices = (await query(`SELECT id, name, platform, app_version, created_at, last_seen_at, host(last_ip) AS last_ip, revoked_at, revoke_reason
    FROM mobile_devices WHERE user_id=$1 AND (revoked_at IS NULL OR revoked_at > now() - interval '30 days')
    ORDER BY revoked_at IS NOT NULL, created_at DESC`, [id])).rows;
  u.notify_blocks = (await query('SELECT type, channel FROM notification_user_blocks WHERE user_id=$1 ORDER BY type, channel', [id])).rows;
  return u;
}

// Opening a user record (sessions, IPs, devices) is recorded: who looked at whose personal data (ETS-SEC-050).
r.get('/:id', async (req, res) => {
  const user = await loadUser(idParam(req.params.id));
  await logAudit(req, { soft: true, action: 'view', entity: 'user', entityId: user.id, summary: user.username });
  res.json({ user });
});

// Usernames: 3–60 of A–Z a–z 0–9 . _ - — never "@", so a sign-in name with "@" is always an e-mail address
// (routes/auth.js, 1.6.0). E-mail addresses are stored trimmed and in lower case, one account per address.
const USERNAME_RE = /^[A-Za-z0-9._-]{3,60}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const normEmail = e => e.trim().toLowerCase();

// The address may not belong to another account, nor equal the username of an older account that has "@" in it
// (both would be the same sign-in name). Checked without regard to case; the unique index of migration 014 backs it.
async function emailTaken(email, exceptId = 0) {
  return (await query(`SELECT 1 FROM users WHERE id<>$2 AND deleted_at IS NULL
      AND (lower(email::text) = lower($1) OR lower(username::text) = lower($1)) LIMIT 1`,
    [email, exceptId])).rowCount > 0;
}
const EMAIL_INDEX = 'users_email_lower_uniq';
// The same address saved by someone else between the check and the write: the index refuses it → email_taken.
async function emailIndexed(fn) {
  try { return await fn(); } catch (e) {
    if (e?.code === '23505' && e.constraint === EMAIL_INDEX) throw bad('email_taken');
    throw e;
  }
}

// keepUsername: the account's current username (update) — sent back unchanged it is not checked again, so an
// account created before with a name the rules no longer accept (e.g. containing "@") can still be edited.
async function validateCommon(body, { creating, keepUsername, selfId } = {}) {
  const out = {};
  if (creating || body.username !== undefined) {
    const un = str(body.username, 60);
    if (!(keepUsername !== undefined && un === keepUsername)) {
      if (!USERNAME_RE.test(un)) throw bad('invalid_username');
      out.username = un;
    }
  }
  if (creating || body.full_name !== undefined) {
    const fn = str(body.full_name, 120);
    if (!fn) throw bad('full_name_required');
    out.full_name = fn;
  }
  if (body.email !== undefined) {
    const e = normEmail(str(body.email, 200));
    if (e && !EMAIL_RE.test(e)) throw bad('invalid_email');
    out.email = e || null;
  }
  if (creating || body.role_id !== undefined) {
    if (typeof body.role_id !== 'string' || !(await query('SELECT 1 FROM roles WHERE id=$1', [body.role_id])).rowCount) throw bad('invalid_role');
    out.role_id = body.role_id;
  }
  if (body.language !== undefined) { if (!['ar', 'en'].includes(body.language)) throw bad('invalid_language'); out.language = body.language; }
  for (const k of ['is_active', 'must_change_password', 'totp_exempt', 'on_leave']) {
    if (body[k] !== undefined) { if (typeof body[k] !== 'boolean') throw bad('invalid_value', { field: k }); out[k] = body[k]; }
  }
  // on-leave window (1.12.28): optional dates, each a YYYY-MM-DD string or null (clears it)
  for (const k of ['leave_from', 'leave_to']) {
    if (body[k] !== undefined) {
      if (body[k] !== null && !isDate(body[k])) throw bad('invalid_value', { field: k });
      out[k] = body[k] || null;
    }
  }
  // pre-assigned substitute (1.12.28): an existing, non-deleted account other than this user
  if (body.substitute_user_id !== undefined) {
    const s = body.substitute_user_id;
    if (s === null || s === '') out.substitute_user_id = null;
    else {
      if (!isId(s)) throw bad('invalid_value', { field: 'substitute_user_id' });
      if (selfId && s === selfId) throw bad('invalid_substitute', { reason: 'self' });
      if (!(await query('SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL', [s])).rowCount) throw bad('invalid_substitute');
      out.substitute_user_id = s;
    }
  }
  return out;
}

async function validatePassword(pw, username, roleId) {
  const errs = checkPolicy(pw, { minLength: await getSetting('security.password_min_length'), username, admin: roleId === 'admin' });
  if (errs.length) throw bad('weak_password', { reasons: errs });
}

// 'usr' (user administration) may only be held by the admin role — never granted to another role by override.
function assertOverridesAllowed(roleId, overrides) {
  if (!Array.isArray(overrides)) return;
  if (roleId !== ADMIN_ROLE && overrides.some(o => o?.permission === 'usr' && o.granted === true)) throw bad('usr_admin_only');
}

// Effective permissions of a role + overrides (same rule as the session context).
function effectivePerms(rolePerms, overrides) {
  const p = new Set(rolePerms);
  for (const o of overrides) o.granted ? p.add(o.permission) : p.delete(o.permission);
  return p;
}

// Nobody grants themselves permissions or scope (ETS-SEC-004): an administrator editing their own account may
// only keep or reduce their permissions, may not change their scope, and may not exempt themselves from 2FA.
async function assertNoSelfGrant(before, b, v) {
  if (Array.isArray(b.overrides)) {
    const rolePerms = (await query('SELECT permissions FROM roles WHERE id=$1', [before.role_id])).rows[0].permissions;
    const now = effectivePerms(rolePerms, before.overrides), next = effectivePerms(rolePerms, b.overrides);
    if ([...next].some(p => !now.has(p))) throw bad('cannot_change_own_permissions');
  }
  if (Array.isArray(b.scopes)) {
    const key = list => list.map(s => `${s?.kind}:${s?.ref_id}`).sort().join('|');
    if (key(b.scopes) !== key(before.scopes)) throw bad('cannot_change_own_permissions');
  }
  if (v.totp_exempt === true && !before.totp_exempt) throw bad('cannot_change_own_permissions');
}

// Malformed scope / override entries are refused before any rule that compares them (e.g. no self-grant).
function assertShapes(scopes, overrides) {
  if (Array.isArray(scopes) && scopes.some(s => !s || !['department', 'application'].includes(s.kind) || typeof s.ref_id !== 'string')) throw bad('invalid_scope');
  if (Array.isArray(overrides) && overrides.some(o => !o || !PERMISSIONS.includes(o.permission) || typeof o.granted !== 'boolean')) throw bad('invalid_permission');
  // one entry per permission: a duplicate would hit the unique key and end as a 500 (V2-N4)
  if (Array.isArray(overrides) && new Set(overrides.map(o => o.permission)).size !== overrides.length) throw bad('invalid_permission', { reason: 'duplicate' });
}

async function writeScopes(c, userId, scopes, overrides) {
  if (Array.isArray(scopes)) {
    await c.query('DELETE FROM user_scopes WHERE user_id=$1', [userId]);
    for (const s of scopes) {
      if (!s || !['department', 'application'].includes(s.kind) || typeof s.ref_id !== 'string') throw bad('invalid_scope');
      const table = s.kind === 'department' ? 'departments' : 'applications';
      if (!(await c.query(`SELECT 1 FROM ${table} WHERE id=$1`, [s.ref_id])).rowCount) throw bad('invalid_scope');
      await c.query('INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, s.kind, s.ref_id]);
    }
  }
  if (Array.isArray(overrides)) {
    await c.query('DELETE FROM user_permissions WHERE user_id=$1', [userId]);
    for (const o of overrides) {
      if (!o || !PERMISSIONS.includes(o.permission) || typeof o.granted !== 'boolean') throw bad('invalid_permission');
      await c.query('INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,$2,$3)', [userId, o.permission, o.granted]);
    }
  }
}

r.post('/', async (req, res) => {
  const b = req.body || {};
  const v = await validateCommon(b, { creating: true });
  await validatePassword(b.password, v.username, v.role_id);
  if ((await query('SELECT 1 FROM users WHERE username=$1 AND deleted_at IS NULL', [v.username])).rowCount) throw bad('username_taken');
  if (v.email && await emailTaken(v.email)) throw bad('email_taken');
  assertShapes(b.scopes, b.overrides);
  assertOverridesAllowed(v.role_id, b.overrides);
  v.language ||= await getSetting('app.default_language');   // Settings → default language when none was picked
  const id = await emailIndexed(() => tx(async c => {
    const row = (await c.query(`INSERT INTO users(username,full_name,email,password_hash,role_id,language,is_active,must_change_password,totp_exempt,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [v.username, v.full_name, v.email || null, await hashPassword(b.password), v.role_id, v.language || 'ar',
        v.is_active ?? true, v.must_change_password ?? true, v.totp_exempt ?? false, req.user.id])).rows[0];
    await writeScopes(c, row.id, b.scopes, b.overrides);
    await logAudit(req, { db: c, action: 'create', entity: 'user', entityId: row.id, summary: v.username,
      newValue: { ...v, scopes: b.scopes || [], overrides: b.overrides || [] } });
    return row.id;
  }));
  res.status(201).json({ user: await loadUser(id) });
});

// ---- bulk import (rows read from an .xlsx / .csv file in the browser) ----
// POST /import/preview checks every row and writes nothing; POST /import checks them again and creates every row
// in one transaction, or nothing when any row is refused. Each new account gets a random temporary password that
// must be changed at first sign-in; the passwords are returned once, in the answer to POST /import, and are never
// stored or logged in clear.
export const IMPORT_MAX_ROWS = 500;
const cell = v => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
// departments / applications: one cell or an array of cells (the template's extra columns), each holding ids or
// names separated by "," "،" ";" — matched by utils/importMatch.js
const listCells = v => (Array.isArray(v) ? v.slice(0, 50).map(cell) : [cell(v)]);
// the value quoted back in an error message: the admin's own text, shortened
const quote = v => String(v).slice(0, 80);

function importRows(body) {
  const rows = body?.rows;
  if (!Array.isArray(rows) || !rows.length) throw bad('invalid_value', { field: 'rows' });
  if (rows.length > IMPORT_MAX_ROWS) throw bad('too_many_rows', { max: IMPORT_MAX_ROWS, count: rows.length });
  return rows;
}

// → [{ index, username, status: 'ok'|'error', errors: [codes], user? }] — `user` (the values to insert) when ok.
async function checkImportRows(rows) {
  const [roles, depts, apps, defaultLang] = await Promise.all([
    query('SELECT id, name_ar, name_en, full_scope FROM roles'), query('SELECT id, name_ar, name_en, short_ar, short_en FROM departments'),
    query('SELECT id, name_ar, name_en FROM applications'), getSetting('app.default_language'),
  ]);
  const roleMap = new Map(roles.rows.map(x => [x.id, x]));
  // ids, Arabic / English names and short names are accepted (ambiguous name → ambiguous_value)
  const ix = { role: roleIndex(roles.rows), language: languageIndex(), departments: placeIndex(depts.rows), applications: placeIndex(apps.rows) };
  const names = rows.map(x => (x && typeof x === 'object' && !Array.isArray(x) ? cell(x.username) : ''));
  const count = new Map();
  for (const n of names) if (n) count.set(n.toLowerCase(), (count.get(n.toLowerCase()) || 0) + 1);
  const valid = names.filter(n => USERNAME_RE.test(n));
  const taken = new Set(valid.length
    ? (await query('SELECT lower(username::text) AS u FROM users WHERE username = ANY($1::citext[]) AND deleted_at IS NULL', [valid])).rows.map(x => x.u) : []);
  // e-mail addresses (trimmed, lower case): one account each, in the file and against the accounts (1.6.0)
  const emails = rows.map(x => (x && typeof x === 'object' && !Array.isArray(x) ? normEmail(cell(x.email)) : ''));
  const emailCount = new Map();
  for (const e of emails) if (e) emailCount.set(e, (emailCount.get(e) || 0) + 1);
  const wellFormed = [...emailCount.keys()].filter(e => e.length <= 200 && EMAIL_RE.test(e));
  const emailsTaken = new Set(wellFormed.length
    ? (await query(`SELECT lower(email::text) AS e FROM users WHERE lower(email::text) = ANY($1::text[]) AND deleted_at IS NULL
        UNION SELECT lower(username::text) FROM users WHERE lower(username::text) = ANY($1::text[]) AND deleted_at IS NULL`, [wellFormed])).rows.map(x => x.e) : []);

  return rows.map((row, index) => {
    const errors = [], details = [];
    const add = c => { if (!errors.includes(c)) errors.push(c); };
    // which value was not recognised: { code, field, value[, matches] } (the admin's own text and catalog ids only)
    const detail = (code, field, value, matches) => { add(code); details.push({ code, field, value: quote(value), ...(matches ? { matches } : {}) }); };
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { index, username: '', status: 'error', errors: ['invalid_row'], details };
    const username = names[index];
    if (!USERNAME_RE.test(username)) add('invalid_username');
    else if (taken.has(username.toLowerCase())) add('username_taken');
    if (username && count.get(username.toLowerCase()) > 1) add('duplicate_in_file');
    const fullName = cell(row.full_name);
    if (!fullName) add('full_name_required');
    else if (fullName.length > 120) add('full_name_too_long');
    const email = emails[index];
    if (email && (email.length > 200 || !EMAIL_RE.test(email))) add('invalid_email');
    else if (email && emailsTaken.has(email)) detail('email_taken', 'email', email);
    if (email && emailCount.get(email) > 1) detail('duplicate_email_in_file', 'email', email);
    const roleText = cell(row.role_id ?? row.role);
    const rm = matchOne(ix.role, roleText);
    const role = rm.id !== undefined ? roleMap.get(rm.id) : undefined;
    if (!role) {
      if (rm.error === 'ambiguous') detail('ambiguous_value', 'role', roleText, rm.matches);
      else if (roleText) detail('invalid_role', 'role', roleText); else add('invalid_role');
    }
    const langText = cell(row.language);
    const lm = langText ? matchOne(ix.language, langText) : {};
    if (langText && lm.id === undefined) detail('invalid_language', 'language', langText);
    const dm = matchList(ix.departments, listCells(row.departments)), am = matchList(ix.applications, listCells(row.applications));
    const dl = dm.ids, al = am.ids;
    for (const [field, m] of [['departments', dm], ['applications', am]]) {
      for (const v of m.unknown) detail('invalid_scope', field, v);
      for (const a of m.ambiguous) detail('ambiguous_value', field, a.value, a.matches);
    }
    // a scoped role with no department / application would see nothing (ETS-SEC-005): refused, not created empty
    if (!dm.unknown.length && !am.unknown.length && !dm.ambiguous.length && !am.ambiguous.length &&
        role && !role.full_scope && !dl.length && !al.length) add('scope_required');
    // optional, API only (the template has no such column): same rules as POST /users
    const overrides = row.overrides ?? [];
    try {
      if (!Array.isArray(overrides)) throw bad('invalid_permission');
      assertShapes(undefined, overrides);
      if (role) assertOverridesAllowed(role.id, overrides);
    } catch (e) { add(e.code || 'invalid_permission'); }
    if (errors.length) return { index, username, status: 'error', errors, details };
    // a full-scope role sees everything: departments / applications given for it are not stored
    const scopes = role.full_scope ? [] : [...dl.map(ref_id => ({ kind: 'department', ref_id })), ...al.map(ref_id => ({ kind: 'application', ref_id }))];
    return { index, username, status: 'ok', errors,
      user: { username, full_name: fullName, email: email || null, role_id: role.id, language: lm.id || defaultLang || 'ar', scopes,
        overrides: overrides.map(o => ({ permission: o.permission, granted: o.granted })) } };
  });
}

const importSummary = results => ({
  results: results.map(({ index, username, status, errors, details }) => ({ index, username, status, errors, ...(details?.length ? { details } : {}) })),
  ok: results.filter(x => x.status === 'ok').length, errors: results.filter(x => x.status === 'error').length,
});

r.post('/import/preview', userImportJson, async (req, res) => {
  res.json(importSummary(await checkImportRows(importRows(req.body))));
});

r.post('/import', userImportJson, async (req, res) => {
  const rows = importRows(req.body);
  const refuse = results => bad('import_has_errors', importSummary(results));
  const results = await checkImportRows(rows);
  if (results.some(x => x.status === 'error')) throw refuse(results);
  const minLength = await getSetting('security.password_min_length');
  const users = results.map(x => x.user);
  const passwords = users.map(u => generateTemporaryPassword({ minLength, username: u.username, admin: u.role_id === ADMIN_ROLE }));
  const hashes = await hashManyPasswords(passwords);   // before the transaction: it is slow and needs no lock
  let created;
  try {
    created = await tx(async c => {
      const out = [];
      for (const [i, u] of users.entries()) {
        const id = (await c.query(`INSERT INTO users(username,full_name,email,password_hash,role_id,language,is_active,must_change_password,totp_exempt,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,true,true,false,$7) RETURNING id`,
          [u.username, u.full_name, u.email, hashes[i], u.role_id, u.language, req.user.id])).rows[0].id;
        await writeScopes(c, id, u.scopes, u.overrides);
        // same shape as a single create (no password: none is sent or stored in clear)
        await logAudit(req, { db: c, action: 'create', entity: 'user', entityId: id, summary: u.username,
          newValue: { username: u.username, full_name: u.full_name, email: u.email, role_id: u.role_id, language: u.language,
            is_active: true, must_change_password: true, totp_exempt: false, scopes: u.scopes, overrides: u.overrides },
          context: { via: 'bulk_import' } });
        out.push({ id, username: u.username });
      }
      await logAudit(req, { db: c, action: 'bulk_create', entity: 'user', summary: `${out.length} users imported`,
        newValue: { count: out.length, usernames: out.map(x => x.username) } });
      return out;
    });
  } catch (e) {
    // a username created by someone else meanwhile: nothing was written; the rows are checked again for the answer
    if (e?.code === '23505') throw refuse(await checkImportRows(rows));
    throw e;
  }
  res.status(201).json({ created: created.length,
    users: created.map((x, i) => ({ id: x.id, username: x.username, temporary_password: passwords[i] })) });
});

// Prevents locking everybody out: there must always be one active admin who still holds user administration
// and settings after permission overrides (ETS-SEC-023).
const EFFECTIVE_ADMINS = `SELECT count(*)::int AS n FROM users u JOIN roles ro ON ro.id=u.role_id
  WHERE u.role_id='admin' AND u.is_active AND u.deleted_at IS NULL AND ${['usr', 'cfg'].map(p => `(EXISTS (SELECT 1 FROM user_permissions o WHERE o.user_id=u.id AND o.permission='${p}' AND o.granted)
    OR ('${p}' = ANY(ro.permissions) AND NOT EXISTS (SELECT 1 FROM user_permissions o WHERE o.user_id=u.id AND o.permission='${p}' AND NOT o.granted)))`).join(' AND ')}`;
const effectiveAdmins = async c => (await c.query(EFFECTIVE_ADMINS)).rows[0].n;
// Called at the start of the transaction: locks every admin row (and the edited one) so that two concurrent
// changes cannot each believe another administrator remains (ETS-SEC-021/023). Returns the count before.
async function lockAdmins(c, userId) {
  await c.query(`SELECT id FROM users WHERE role_id='admin' OR id=$1 ORDER BY id FOR UPDATE`, [userId]);
  return effectiveAdmins(c);
}
// Called after the change, inside the same transaction: rolls it back when it removed the last administrator.
async function assertAdminRemains(c, before) {
  if (before > 0 && (await effectiveAdmins(c)) === 0) throw bad('last_admin');
}

r.patch('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const before = await loadUser(id);
  const b = req.body || {};
  const v = await validateCommon(b, { creating: false, keepUsername: before.username, selfId: id });
  if (v.username && v.username.toLowerCase() !== before.username.toLowerCase() &&
      (await query('SELECT 1 FROM users WHERE username=$1 AND id<>$2 AND deleted_at IS NULL', [v.username, id])).rowCount) throw bad('username_taken');
  // only a changed address is checked: an account that already shares its address (data from before 1.6.0) can
  // still be edited, and given its own address
  if (v.email && v.email !== String(before.email || '').toLowerCase() && await emailTaken(v.email, id)) throw bad('email_taken');
  if (id === req.user.id && (v.is_active === false || (v.role_id && v.role_id !== before.role_id))) throw bad('cannot_change_own_role');
  assertShapes(b.scopes, b.overrides);
  if (id === req.user.id) await assertNoSelfGrant(before, b, v);
  const nextRole = v.role_id || before.role_id;
  assertOverridesAllowed(nextRole, b.overrides);
  await emailIndexed(() => tx(async c => {
    const admins = await lockAdmins(c, id);
    const keys = Object.keys(v);
    if (keys.length) {
      await c.query(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`,
        [id, ...keys.map(k => v[k])]);
    }
    await writeScopes(c, id, b.scopes, b.overrides);
    // leaving the admin role also drops a stored 'usr' grant (it would be ignored anyway)
    if (nextRole !== ADMIN_ROLE) await c.query(`DELETE FROM user_permissions WHERE user_id=$1 AND permission='usr' AND granted`, [id]);
    await assertAdminRemains(c, admins);
    if (v.is_active === false) {
      await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='user_deactivated' WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
      // the deactivated user's edits still waiting for approval are withdrawn (ETS-SEC-027)
      await c.query(`UPDATE edit_requests SET status='withdrawn', decided_at=now(), reason='user deactivated'
        WHERE requested_by=$1 AND status='pending'`, [id]);
    }
    await logAudit(req, { db: c, action: 'update', entity: 'user', entityId: id, summary: before.username,
      oldValue: { ...Object.fromEntries(keys.map(k => [k, before[k]])), ...(b.scopes ? { scopes: before.scopes } : {}), ...(b.overrides ? { overrides: before.overrides } : {}) },
      newValue: { ...v, ...(b.scopes ? { scopes: b.scopes } : {}), ...(b.overrides ? { overrides: b.overrides } : {}) } });
    // a deactivated account's phones are revoked in the same transaction (1.9.0)
    if (v.is_active === false) await revokeDevices(c, req, { userIds: [id], reason: 'user_disabled', by: req.user });
    // audit row first, then the auth row: every transaction takes the two log chains in the same order
    if (v.totp_exempt !== undefined && v.totp_exempt !== before.totp_exempt) {
      await logAuth(req, { db: c, userId: id, username: before.username, event: v.totp_exempt ? 'mfa_exempted_by_admin' : 'mfa_exemption_removed',
        success: true, detail: { by: req.user.username } });
    }
  }));
  // open live-updates streams of this user: closed when deactivated, new scope / permissions otherwise
  publishSessionCheck(id);
  publishNotif(id, []);                         // the bell recounts with the new permissions / scope
  // (a move request, 1.10.0, also waited for its destination application)
  if (v.is_active === false) for (const a of (await query(`SELECT DISTINCT unnest(array[app_id, target_app_id]) AS app_id FROM edit_requests
    WHERE requested_by=$1 AND status='withdrawn'`, [id])).rows.filter(x => x.app_id)) await requestsSettled(a.app_id);
  res.json({ user: await loadUser(id) });
});

r.post('/:id/reset-password', async (req, res) => {
  const id = idParam(req.params.id);
  // an administrator changes their own password through /auth/change-password, which asks for the current
  // one: a hijacked session must not be able to set a new password without it (V2-N5)
  if (id === req.user.id) throw bad('use_change_password');
  const u = await loadUser(id);
  await validatePassword(req.body?.password, u.username, u.role_id);
  await tx(async c => {
    await c.query(`UPDATE users SET password_hash=$2, must_change_password=$3, failed_attempts=0, locked_until=NULL,
      last_failed_at=NULL, password_changed_at=now(), updated_at=now() WHERE id=$1`, [id, await hashPassword(req.body.password), req.body?.must_change !== false]);
    await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='password_reset' WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
    await logAudit(req, { db: c, action: 'reset_password', entity: 'user', entityId: id, summary: u.username });
    await revokeDevices(c, req, { userIds: [id], reason: 'password_reset', by: req.user });     // phones too (1.9.0)
    await logAuth(req, { db: c, userId: id, username: u.username, event: 'password_reset_by_admin', success: true, detail: { by: req.user.username } });
  });
  publishSessionCheck(id);
  res.json({ ok: true });
});

// Removes the user's authenticator; they enrol again on next login if 2FA is required.
r.post('/:id/reset-2fa', async (req, res) => {
  const id = idParam(req.params.id);
  const u = await loadUser(id);
  await tx(async c => {
    await c.query('UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL, totp_enabled_at=NULL WHERE id=$1', [id]);
    await c.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [id]);
    // signed-in sessions passed the removed second factor: they end too (ETS-SEC-018)
    await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='mfa_reset' WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`,
      [id, req.session.id]);
    await logAudit(req, { db: c, action: 'reset_2fa', entity: 'user', entityId: id, summary: u.username });
    await logAuth(req, { db: c, userId: id, username: u.username, event: 'mfa_reset_by_admin', success: true, detail: { by: req.user.username } });
  });
  publishSessionCheck(id);
  res.json({ ok: true });
});

r.post('/:id/unlock', async (req, res) => {
  const id = idParam(req.params.id);
  const u = await loadUser(id);
  // Was the account actually paused (locked_until in the future) at the moment of the unlock? Only then is it a
  // real unlock worth notifying about; clearing an already-open account is a no-op that notifies no one.
  const wasLocked = isDelayed(u);
  await tx(async c => {
    await c.query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE id=$1', [id]);
    await logAudit(req, { db: c, action: 'unlock', entity: 'user', entityId: id, summary: u.username });
    await logAuth(req, { db: c, userId: id, username: u.username, event: 'account_unlocked_by_admin', success: true, detail: { by: req.user.username } });
  });
  if (wasLocked) {
    await accountUnlocked(u, req.user.username);   // S14 → administrators
    await accountReactivated(u);                   // S15 → the unlocked user (directed FYI)
  }
  res.json({ ok: true });
});

// Ends every session of the user (the administrator's own current one excepted) or, with { session_ref } (1.11.0, the
// «إنهاء الجلسة» action of the online users screen: the first 16 hex characters of a session id), only that one.
const SESSION_REF_RE = /^[0-9a-f]{16}$/;
r.post('/:id/revoke-sessions', async (req, res) => {
  const id = idParam(req.params.id);
  const ref = req.body?.session_ref;
  if (ref !== undefined && (typeof ref !== 'string' || !SESSION_REF_RE.test(ref))) throw bad('invalid_value', { field: 'session_ref' });
  if (ref && req.session.id.startsWith(ref)) throw bad('cannot_end_own_session');
  const u = await loadUser(id);
  const q = await tx(async c => {
    const q = ref
      ? await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='revoked_by_admin'
          WHERE user_id=$1 AND revoked_at IS NULL AND id <> $2 AND left(id, 16) = $3`, [id, req.session.id, ref])
      : await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='revoked_by_admin'
          WHERE user_id=$1 AND revoked_at IS NULL AND id <> $2`, [id, req.session.id]);
    if (ref && !q.rowCount) throw notFound('session_not_found');
    const one = ref ? { session_ref: ref, source: 'online_users' } : {};
    await logAudit(req, { db: c, action: 'revoke_sessions', entity: 'user', entityId: id, summary: u.username, newValue: { count: q.rowCount, ...one } });
    await logAuth(req, { db: c, userId: id, username: u.username, event: 'sessions_revoked_by_admin', success: true,
      detail: { by: req.user.username, count: q.rowCount, ...one } });
    return q;
  });
  publishSessionCheck(id);
  res.json({ revoked: q.rowCount });
});

// Turn 2FA off (exempt) or back on for many users at once: { user_ids:[..] | all:true, exempt:true|false }
r.post('/bulk-2fa', async (req, res) => {
  const { user_ids, all, exempt } = req.body || {};
  if (typeof exempt !== 'boolean') throw bad('invalid_value', { field: 'exempt' });
  if (!all && !(Array.isArray(user_ids) && user_ids.length && user_ids.length <= 10000 && user_ids.every(isId))) throw bad('invalid_value', { field: 'user_ids' });
  // nobody exempts themselves (same rule as PATCH, V2-N1): a list naming the caller is refused, and "all"
  // leaves the caller out. Removing exemptions stays allowed for everyone, the caller included.
  if (exempt && !all && user_ids.includes(req.user.id)) throw bad('cannot_change_own_permissions');
  const skip = exempt ? req.user.id : 0;
  const q = await tx(async c => {
    const q = all
      ? await c.query('UPDATE users SET totp_exempt=$1, updated_at=now() WHERE totp_exempt<>$1 AND id<>$2 AND deleted_at IS NULL RETURNING id, username', [exempt, skip])
      : await c.query('UPDATE users SET totp_exempt=$1, updated_at=now() WHERE id = ANY($2) AND totp_exempt<>$1 AND id<>$3 AND deleted_at IS NULL RETURNING id, username', [exempt, user_ids, skip]);
    await logAudit(req, { db: c, action: 'bulk_update', entity: 'user', summary: `totp_exempt=${exempt} on ${q.rowCount} users`,
      newValue: { all: !!all, user_ids: user_ids || null, exempt } });
    for (const u of q.rows) {
      await logAuth(req, { db: c, userId: u.id, username: u.username, event: exempt ? 'mfa_exempted_by_admin' : 'mfa_exemption_removed', success: true,
        detail: { by: req.user.username, bulk: true } });
    }
    return q;
  });
  res.json({ updated: q.rowCount });
});

// ---- phones and notification restrictions of a user (1.9.0) ----
// DELETE /users/:id/devices/:deviceId — an administrator revokes a phone of this user.
r.delete('/:id/devices/:deviceId', async (req, res) => {
  const id = idParam(req.params.id), deviceId = idParam(req.params.deviceId, 'deviceId');
  await loadUser(id);
  const rows = await tx(async c => {
    const d = (await c.query('SELECT id FROM mobile_devices WHERE id=$1 AND user_id=$2', [deviceId, id])).rows[0];
    if (!d) throw notFound();
    return revokeDevices(c, req, { ids: [deviceId], reason: 'admin', by: req.user });
  });
  res.json({ revoked: rows.length });
});

// PUT /users/:id/notify-blocks { blocks: [{ type: <type> | '*', channel: 'all' | 'mobile' }] } — replaces the user's
// restrictions. Block only (never a grant); not on one's own account; a type mandatory in code for the user's role
// cannot be blocked on every channel (the phone may still be blocked).
r.put('/:id/notify-blocks', async (req, res) => {
  const id = idParam(req.params.id);
  if (id === req.user.id) throw bad('cannot_change_own_permissions');
  const u = await loadUser(id);
  const list = req.body?.blocks;
  if (!Array.isArray(list) || list.length > 200) throw bad('invalid_value', { field: 'blocks' });
  const seen = new Set(), blocks = [];
  for (const x of list) {
    const type = x?.type, channel = x?.channel;
    if (typeof type !== 'string' || !(type === '*' || Object.hasOwn(TYPES, type)) || !['all', 'mobile'].includes(channel)) throw bad('invalid_value', { field: 'blocks' });
    if (channel === 'all' && type !== '*' && isLockedCell(type, u.role_id)) throw bad('mandatory_type', { type });
    const k = type + '|' + channel;
    if (!seen.has(k)) { seen.add(k); blocks.push({ type, channel }); }
  }
  blocks.sort((a, b) => (a.type + a.channel).localeCompare(b.type + b.channel));
  const old = u.notify_blocks;
  if (JSON.stringify(old) !== JSON.stringify(blocks)) {
    await tx(async c => {
      await c.query('DELETE FROM notification_user_blocks WHERE user_id=$1', [id]);
      for (const x of blocks) await c.query('INSERT INTO notification_user_blocks(user_id, type, channel, created_by) VALUES ($1,$2,$3,$4)', [id, x.type, x.channel, req.user.id]);
      await logAudit(req, { db: c, action: 'update', entity: 'user', entityId: id, summary: u.username,
        oldValue: { notify_blocks: old }, newValue: { notify_blocks: blocks }, context: { target: userRef(u), field: 'notify_blocks' } });
    });
    publishNotif(id, []);
  }
  res.json({ blocks });
});

// ---- delete (archive) and restore — 1.7.0, migration 015 ----
// Deleting is a soft delete: the row stays, so every name in the history still resolves (audit_log, auth_log,
// functions.updated_by / removed_by / disabled_by, edit requests, import batches…), and audit_log / auth_log are
// only appended to. In one transaction, for each deleted user:
//   · deleted_at / deleted_by / delete_reason are set; the account is inactive everywhere (middleware/auth.js)
//   · every session is revoked (the live-updates streams close after COMMIT, services/live.js)
//   · the authenticator and the 2FA recovery codes are removed (a restored account starts again)
//   · their edit requests still waiting are withdrawn, and their import files still waiting are rejected, each with
//     its own audit row (approving them would fail anyway: requester_inactive)
//   · scopes and permission overrides are kept but inert (no session can use them); a restore brings them back
//   · the username and e-mail are free for a new account (partial unique indexes)
// Refused for the caller's own account, for the last effective administrator, for an unknown or already deleted id.
// A bulk request is all-or-nothing: any refused id refuses the whole request with the reason of each id.
export const DELETE_MAX = 200;
export const DELETE_REASON_MIN = 3, DELETE_REASON_MAX = 500;

// The reason (required): 3+ non-whitespace characters, at most 500 — same rule as the exclusion note (1.5.1).
function deleteReason(body) {
  const v = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (v.length > DELETE_REASON_MAX) throw bad('delete_reason_too_long', { max: DELETE_REASON_MAX });
  if (v.replace(/\s/gu, '').length < DELETE_REASON_MIN) throw bad('delete_reason_required', { min: DELETE_REASON_MIN });
  return v;
}

const EFFECTIVE_ADMIN_IDS = EFFECTIVE_ADMINS.replace('count(*)::int AS n', 'u.id');

export async function listDeletedUsers() {
  return (await query(`SELECT u.id, u.username, u.full_name, u.email, u.role_id, u.is_active, u.deleted_at, u.delete_reason,
      u.last_login_at, r.name_ar AS role_name_ar, r.name_en AS role_name_en,
      d.full_name AS deleted_by_name, d.username AS deleted_by_username,
      EXISTS (SELECT 1 FROM users o WHERE o.deleted_at IS NULL AND o.username = u.username) AS username_taken,
      (u.email IS NOT NULL AND EXISTS (SELECT 1 FROM users o WHERE o.deleted_at IS NULL AND (lower(o.email::text) = lower(u.email::text) OR lower(o.username::text) = lower(u.email::text)))) AS email_taken
    FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN users d ON d.id=u.deleted_by
    WHERE u.deleted_at IS NOT NULL ORDER BY u.deleted_at DESC, u.id DESC`)).rows;
}

// Context of the audit row of an edit request / import batch closed because its author was deleted.
async function closedContext(c, req, kind, row, reason) {
  if (kind === 'edit_request') return { ...(await requestContext(c, row, req, { reason })), user_deleted: true };
  const changes = (await c.query('SELECT * FROM import_changes WHERE batch_id=$1 ORDER BY id', [row.id])).rows;
  return { via: 'import', batch_id: row.id, target: row.target, department_id: row.department_id, departments: row.departments,
    filename: row.filename, uploaded_by: userRef(await loadAuditUser(c, row.uploaded_by)), lead_by: userRef(await loadAuditUser(c, row.lead_by)),
    final_by: userRef(await loadAuditUser(c, row.final_by)), items: await namedItems(c, changes), reason, user_deleted: true };
}

async function deleteUsers(req, ids, reason, { bulk }) {
  const out = await tx(async c => {
    // the administrators and the users concerned are locked first (same order as PATCH, see lockAdmins)
    await c.query(`SELECT id FROM users WHERE role_id='admin' OR id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
    const rows = new Map((await c.query(`SELECT id, username, full_name, email, role_id, is_active, deleted_at FROM users WHERE id = ANY($1)`, [ids]))
      .rows.map(u => [u.id, u]));
    const admins = (await c.query(EFFECTIVE_ADMIN_IDS)).rows.map(x => x.id);
    const errors = [];
    for (const id of ids) {
      const u = rows.get(id);
      if (!u) errors.push({ id, error: 'not_found' });
      else if (u.deleted_at) errors.push({ id, username: u.username, error: 'already_deleted' });
      else if (id === req.user.id) errors.push({ id, username: u.username, error: 'cannot_delete_self' });
    }
    // deleting every remaining effective administrator is refused (the caller is never deleted, see above)
    if (admins.length && admins.every(a => ids.includes(a))) {
      for (const a of admins) if (!errors.some(e => e.id === a)) errors.push({ id: a, username: rows.get(a)?.username, error: 'last_admin' });
    }
    if (errors.length) {
      if (!bulk) throw errors[0].error === 'not_found' ? notFound() : bad(errors[0].error, { id: errors[0].id });
      throw bad('bulk_delete_refused', { errors });
    }
    const users = ids.map(id => rows.get(id));
    await c.query(`UPDATE users SET deleted_at=now(), deleted_by=$2, delete_reason=$3, totp_enabled=false, totp_secret=NULL,
      totp_last_step=NULL, totp_enabled_at=NULL, failed_attempts=0, locked_until=NULL, last_failed_at=NULL, updated_at=now()
      WHERE id = ANY($1)`, [ids, req.user.id, reason]);
    await c.query('DELETE FROM user_recovery_codes WHERE user_id = ANY($1)', [ids]);
    const sessions = await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='user_deleted'
      WHERE user_id = ANY($1) AND revoked_at IS NULL RETURNING user_id`, [ids]);
    // their requests still waiting would stay stuck (approval refuses an inactive author): closed now, audited
    const note = `user deleted: ${reason}`;
    const reqs = (await c.query(`UPDATE edit_requests SET status='withdrawn', decided_by=$2, decided_at=now(), reason=$3
      WHERE requested_by = ANY($1) AND status='pending' RETURNING *`, [ids, req.user.id, note])).rows;
    const batches = (await c.query(`UPDATE import_batches SET status='rejected', rejected_by=$2, rejected_at=now(), reject_reason=$3
      WHERE uploaded_by = ANY($1) AND status='pending' RETURNING *`, [ids, req.user.id, note])).rows;
    const by = userRef(req.user);
    for (const u of users) {
      const [scopes, overrides] = await Promise.all([
        c.query('SELECT kind, ref_id FROM user_scopes WHERE user_id=$1 ORDER BY kind, ref_id', [u.id]),
        c.query('SELECT permission, granted FROM user_permissions WHERE user_id=$1 ORDER BY permission', [u.id])]);
      await logAudit(req, { db: c, action: 'delete', entity: 'user', entityId: u.id, summary: u.username,
        oldValue: { username: u.username, full_name: u.full_name, email: u.email, role_id: u.role_id, is_active: u.is_active,
          scopes: scopes.rows, overrides: overrides.rows },
        newValue: { deleted: true, reason },
        context: { reason, target: userRef(u), by, ...(bulk ? { bulk: true, count: users.length } : {}),
          sessions_revoked: sessions.rows.filter(x => x.user_id === u.id).length,
          requests_withdrawn: reqs.filter(x => x.requested_by === u.id).map(x => x.id),
          imports_rejected: batches.filter(x => x.uploaded_by === u.id).map(x => x.id) } });
    }
    if (bulk) {
      await logAudit(req, { db: c, action: 'bulk_delete', entity: 'user', summary: `${users.length} users deleted`,
        newValue: { count: users.length, ids, usernames: users.map(u => u.username), reason },
        context: { reason, by, users: users.map(userRef), requests_withdrawn: reqs.map(x => x.id), imports_rejected: batches.map(x => x.id) } });
    }
    for (const rq of reqs) {
      await logAudit(req, { db: c, action: 'edit_withdraw', entity: 'edit_request', entityId: rq.id, summary: note,
        context: await closedContext(c, req, 'edit_request', rq, note) });
    }
    for (const b of batches) {
      await logAudit(req, { db: c, action: 'import_reject', entity: 'import_batch', entityId: b.id, summary: note,
        context: await closedContext(c, req, 'import_batch', b, note) });
    }
    // their phones are revoked in the same transaction (1.9.0): audit rows, then auth rows, like the rest
    const devices = await revokeDevices(c, req, { userIds: ids, reason: 'user_deleted', by: req.user });
    // audit rows first, then the auth rows: every transaction takes the two log chains in the same order
    for (const u of users) {
      await logAuth(req, { db: c, userId: u.id, username: u.username, event: 'user_deleted_by_admin', success: true,
        detail: { by: req.user.username, reason, ...(bulk ? { bulk: true } : {}) } });
    }
    return { users, reqs, batches, devices };
  });
  // after COMMIT: open streams of these users close; "awaiting approval" badges and pending lists refresh
  for (const id of ids) publishSessionCheck(id);
  if (out.reqs.length) {
    publishApps((await query('SELECT id, department_id FROM applications WHERE id = ANY($1)', [out.reqs.map(x => x.app_id)])).rows);
  }
  for (const b of out.batches) for (const d of (b.departments?.length ? b.departments : [b.department_id]).filter(Boolean)) publishChange({ dept_id: d });
  for (const appId of new Set(out.reqs.flatMap(x => [x.app_id, x.target_app_id]).filter(Boolean))) await requestsSettled(appId);
  return { deleted: out.users.map(u => ({ id: u.id, username: u.username })), requests_withdrawn: out.reqs.length,
    imports_rejected: out.batches.length, devices_revoked: out.devices.length };
}

// DELETE /users/:id  { reason }
r.delete('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const reason = deleteReason(req.body);
  res.json(await deleteUsers(req, [id], reason, { bulk: false }));
});

// POST /users/bulk-delete  { ids: [..] (1–200), reason }
r.post('/bulk-delete', async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every(isId)) throw bad('invalid_value', { field: 'ids' });
  if (ids.length > DELETE_MAX) throw bad('too_many_ids', { max: DELETE_MAX, count: ids.length });
  if (new Set(ids).size !== ids.length) throw bad('invalid_value', { field: 'ids', reason: 'duplicate' });
  const reason = deleteReason(req.body);
  res.json(await deleteUsers(req, ids, reason, { bulk: true }));
});

// POST /users/:id/restore  { reason } — the account comes back with its role, scopes and overrides, a new temporary
// password (returned once, must be changed at the next sign-in, same as the bulk import) and no authenticator.
// Refused (409) when its username or e-mail now belongs to another account.
r.post('/:id/restore', async (req, res) => {
  const id = idParam(req.params.id);
  const reason = deleteReason(req.body);
  const u0 = (await query('SELECT id, username, role_id, deleted_at FROM users WHERE id=$1', [id])).rows[0];
  if (!u0) throw notFound();
  if (!u0.deleted_at) throw bad('not_deleted');
  const password = generateTemporaryPassword({ minLength: await getSetting('security.password_min_length'), username: u0.username,
    admin: u0.role_id === ADMIN_ROLE });
  const hash = await hashPassword(password);      // before the transaction: slow, needs no lock
  let u;
  try {
    u = await tx(async c => {
      const x = (await c.query('SELECT id, username, full_name, email, role_id, deleted_at, delete_reason FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!x.deleted_at) throw bad('not_deleted');
      if ((await c.query('SELECT 1 FROM users WHERE username=$1 AND deleted_at IS NULL', [x.username])).rowCount) throw new HttpError(409, 'username_taken');
      if (x.email && await emailTaken(x.email, id)) throw new HttpError(409, 'email_taken');
      await c.query(`UPDATE users SET deleted_at=NULL, deleted_by=NULL, delete_reason=NULL, password_hash=$2, must_change_password=true,
        failed_attempts=0, locked_until=NULL, last_failed_at=NULL, password_changed_at=now(), updated_at=now() WHERE id=$1`, [id, hash]);
      await logAudit(req, { db: c, action: 'restore', entity: 'user', entityId: id, summary: x.username,
        oldValue: { deleted_at: x.deleted_at, delete_reason: x.delete_reason }, newValue: { deleted: false, reason, must_change_password: true },
        context: { reason, target: userRef(x), by: userRef(req.user) } });
      await logAuth(req, { db: c, userId: id, username: x.username, event: 'user_restored_by_admin', success: true,
        detail: { by: req.user.username, reason } });
      return x;
    });
  } catch (e) {
    // taken meanwhile (unique indexes)
    if (e?.code === '23505') throw new HttpError(409, e.constraint === EMAIL_INDEX ? 'email_taken' : 'username_taken');
    throw e;
  }
  res.json({ user: await loadUser(id), username: u.username, temporary_password: password });
});

export default r;

import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm, requireAdmin, ADMIN_ROLE } from '../middleware/auth.js';
import { hashPassword, checkPolicy, generateTemporaryPassword, hashManyPasswords } from '../services/passwords.js';
import { getSetting } from '../services/settings.js';
import { logAudit, logAuth } from '../services/logs.js';
import { userImportJson } from '../middleware/body.js';
import { bad, notFound, str, idParam, isId } from '../utils/http.js';

const r = Router();
// User administration = system administrators only (owner decision, ETS-SEC-004): 'usr' AND the admin role.
r.use(requireAuth, requirePerm('usr'), requireAdmin);

const PERMISSIONS = ['pct', 'wgt', 'tst', 'tog', 'sch', 'rep', 'exp', 'imp', 'usr', 'log', 'cfg', 'apv_dept', 'apv_final'];

// Never includes secrets (password hash, TOTP secret), so rows can be returned as-is.
const USER_COLS = `u.id, u.username, u.full_name, u.email, u.role_id, u.language, u.is_active, u.must_change_password,
  u.totp_enabled, u.totp_exempt, u.totp_enabled_at, u.failed_attempts, u.locked_until, u.last_login_at,
  host(u.last_login_ip) AS last_login_ip, u.created_at, u.updated_at, u.password_changed_at`;

r.get('/meta', async (req, res) => {
  const [roles, depts, apps] = await Promise.all([
    query(`SELECT * FROM roles ORDER BY array_position(ARRAY['admin','pm','tm','lead','member','mgr','ed','qa','obs'], id)`),
    query('SELECT id, name_ar, name_en, short_ar, short_en FROM departments ORDER BY sort'),
    query('SELECT id, department_id, name_ar, name_en FROM applications ORDER BY sort'),
  ]);
  res.json({ roles: roles.rows, permissions: PERMISSIONS, departments: depts.rows, applications: apps.rows,
    mfa_mode: await getSetting('mfa.mode') });
});

r.get('/', async (req, res) => {
  const rows = (await query(`SELECT ${USER_COLS},
      (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>now()) AS active_sessions,
      (SELECT count(*)::int FROM user_scopes s WHERE s.user_id=u.id) AS scope_count,
      r.name_ar AS role_name_ar, r.name_en AS role_name_en, r.full_scope AS role_full_scope
    FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.username`)).rows;
  res.json({ users: rows, mfa_mode: await getSetting('mfa.mode') });
});

async function loadUser(id) {
  const u = (await query(`SELECT ${USER_COLS} FROM users u WHERE u.id=$1`, [id])).rows[0];
  if (!u) throw notFound();
  u.scopes = (await query('SELECT kind, ref_id FROM user_scopes WHERE user_id=$1', [id])).rows;
  u.overrides = (await query('SELECT permission, granted FROM user_permissions WHERE user_id=$1', [id])).rows;
  u.sessions = (await query(`SELECT left(id,8) AS ref, host(ip) AS ip, user_agent, created_at, last_seen_at, expires_at, mfa_passed
    FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC`, [id])).rows;
  u.recovery_codes_left = +(await query('SELECT count(*) FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [id])).rows[0].count;
  return u;
}

// Opening a user record (sessions, IPs, devices) is recorded: who looked at whose personal data (ETS-SEC-050).
r.get('/:id', async (req, res) => {
  const user = await loadUser(idParam(req.params.id));
  await logAudit(req, { soft: true, action: 'view', entity: 'user', entityId: user.id, summary: user.username });
  res.json({ user });
});

async function validateCommon(body, { creating }) {
  const out = {};
  if (creating || body.username !== undefined) {
    const un = str(body.username, 60);
    if (!/^[A-Za-z0-9._-]{3,60}$/.test(un)) throw bad('invalid_username');
    out.username = un;
  }
  if (creating || body.full_name !== undefined) {
    const fn = str(body.full_name, 120);
    if (!fn) throw bad('full_name_required');
    out.full_name = fn;
  }
  if (body.email !== undefined) {
    const e = str(body.email, 200);
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('invalid_email');
    out.email = e || null;
  }
  if (creating || body.role_id !== undefined) {
    if (typeof body.role_id !== 'string' || !(await query('SELECT 1 FROM roles WHERE id=$1', [body.role_id])).rowCount) throw bad('invalid_role');
    out.role_id = body.role_id;
  }
  if (body.language !== undefined) { if (!['ar', 'en'].includes(body.language)) throw bad('invalid_language'); out.language = body.language; }
  for (const k of ['is_active', 'must_change_password', 'totp_exempt']) {
    if (body[k] !== undefined) { if (typeof body[k] !== 'boolean') throw bad('invalid_value', { field: k }); out[k] = body[k]; }
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
  if ((await query('SELECT 1 FROM users WHERE username=$1', [v.username])).rowCount) throw bad('username_taken');
  assertShapes(b.scopes, b.overrides);
  assertOverridesAllowed(v.role_id, b.overrides);
  v.language ||= await getSetting('app.default_language');   // Settings → default language when none was picked
  const id = await tx(async c => {
    const row = (await c.query(`INSERT INTO users(username,full_name,email,password_hash,role_id,language,is_active,must_change_password,totp_exempt,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [v.username, v.full_name, v.email || null, await hashPassword(b.password), v.role_id, v.language || 'ar',
        v.is_active ?? true, v.must_change_password ?? true, v.totp_exempt ?? false, req.user.id])).rows[0];
    await writeScopes(c, row.id, b.scopes, b.overrides);
    await logAudit(req, { db: c, action: 'create', entity: 'user', entityId: row.id, summary: v.username,
      newValue: { ...v, scopes: b.scopes || [], overrides: b.overrides || [] } });
    return row.id;
  });
  res.status(201).json({ user: await loadUser(id) });
});

// ---- bulk import (rows read from an .xlsx / .csv file in the browser) ----
// POST /import/preview checks every row and writes nothing; POST /import checks them again and creates every row
// in one transaction, or nothing when any row is refused. Each new account gets a random temporary password that
// must be changed at first sign-in; the passwords are returned once, in the answer to POST /import, and are never
// stored or logged in clear.
export const IMPORT_MAX_ROWS = 500;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,60}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const cell = v => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
// "hr, fin" / "hr;fin" / "hr،fin" (Arabic comma) or ["hr","fin"] → ['hr','fin'] (empty entries and repeats dropped)
const idList = v => [...new Set((Array.isArray(v) ? v.map(cell) : cell(v).split(/[,;،]/)).map(x => x.trim()).filter(Boolean))];

function importRows(body) {
  const rows = body?.rows;
  if (!Array.isArray(rows) || !rows.length) throw bad('invalid_value', { field: 'rows' });
  if (rows.length > IMPORT_MAX_ROWS) throw bad('too_many_rows', { max: IMPORT_MAX_ROWS, count: rows.length });
  return rows;
}

// → [{ index, username, status: 'ok'|'error', errors: [codes], user? }] — `user` (the values to insert) when ok.
async function checkImportRows(rows) {
  const [roles, depts, apps, defaultLang] = await Promise.all([
    query('SELECT id, full_scope FROM roles'), query('SELECT id FROM departments'), query('SELECT id FROM applications'),
    getSetting('app.default_language'),
  ]);
  const roleMap = new Map(roles.rows.map(x => [x.id, x]));
  const deptIds = new Set(depts.rows.map(x => x.id)), appIds = new Set(apps.rows.map(x => x.id));
  const names = rows.map(x => (x && typeof x === 'object' && !Array.isArray(x) ? cell(x.username) : ''));
  const count = new Map();
  for (const n of names) if (n) count.set(n.toLowerCase(), (count.get(n.toLowerCase()) || 0) + 1);
  const valid = names.filter(n => USERNAME_RE.test(n));
  const taken = new Set(valid.length
    ? (await query('SELECT lower(username::text) AS u FROM users WHERE username = ANY($1::citext[])', [valid])).rows.map(x => x.u) : []);

  return rows.map((row, index) => {
    const errors = [];
    const add = c => { if (!errors.includes(c)) errors.push(c); };
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { index, username: '', status: 'error', errors: ['invalid_row'] };
    const username = names[index];
    if (!USERNAME_RE.test(username)) add('invalid_username');
    else if (taken.has(username.toLowerCase())) add('username_taken');
    if (username && count.get(username.toLowerCase()) > 1) add('duplicate_in_file');
    const fullName = cell(row.full_name);
    if (!fullName) add('full_name_required');
    else if (fullName.length > 120) add('full_name_too_long');
    const email = cell(row.email);
    if (email && (email.length > 200 || !EMAIL_RE.test(email))) add('invalid_email');
    const roleId = cell(row.role_id ?? row.role).toLowerCase();
    const role = roleMap.get(roleId);
    if (!role) add('invalid_role');
    const lang = cell(row.language).toLowerCase();
    if (lang && !['ar', 'en'].includes(lang)) add('invalid_language');
    const dl = idList(row.departments), al = idList(row.applications);
    if (dl.some(d => !deptIds.has(d)) || al.some(a => !appIds.has(a))) add('invalid_scope');
    // a scoped role with no department / application would see nothing (ETS-SEC-005): refused, not created empty
    else if (role && !role.full_scope && !dl.length && !al.length) add('scope_required');
    // optional, API only (the template has no such column): same rules as POST /users
    const overrides = row.overrides ?? [];
    try {
      if (!Array.isArray(overrides)) throw bad('invalid_permission');
      assertShapes(undefined, overrides);
      if (role) assertOverridesAllowed(role.id, overrides);
    } catch (e) { add(e.code || 'invalid_permission'); }
    if (errors.length) return { index, username, status: 'error', errors };
    // a full-scope role sees everything: departments / applications given for it are not stored
    const scopes = role.full_scope ? [] : [...dl.map(ref_id => ({ kind: 'department', ref_id })), ...al.map(ref_id => ({ kind: 'application', ref_id }))];
    return { index, username, status: 'ok', errors,
      user: { username, full_name: fullName, email: email || null, role_id: role.id, language: lang || defaultLang || 'ar', scopes,
        overrides: overrides.map(o => ({ permission: o.permission, granted: o.granted })) } };
  });
}

const importSummary = results => ({
  results: results.map(({ index, username, status, errors }) => ({ index, username, status, errors })),
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
  WHERE u.role_id='admin' AND u.is_active AND ${['usr', 'cfg'].map(p => `(EXISTS (SELECT 1 FROM user_permissions o WHERE o.user_id=u.id AND o.permission='${p}' AND o.granted)
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
  const v = await validateCommon(b, { creating: false });
  if (v.username && v.username.toLowerCase() !== before.username.toLowerCase() &&
      (await query('SELECT 1 FROM users WHERE username=$1 AND id<>$2', [v.username, id])).rowCount) throw bad('username_taken');
  if (id === req.user.id && (v.is_active === false || (v.role_id && v.role_id !== before.role_id))) throw bad('cannot_change_own_role');
  assertShapes(b.scopes, b.overrides);
  if (id === req.user.id) await assertNoSelfGrant(before, b, v);
  const nextRole = v.role_id || before.role_id;
  assertOverridesAllowed(nextRole, b.overrides);
  await tx(async c => {
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
    // audit row first, then the auth row: every transaction takes the two log chains in the same order
    if (v.totp_exempt !== undefined && v.totp_exempt !== before.totp_exempt) {
      await logAuth(req, { db: c, userId: id, username: before.username, event: v.totp_exempt ? 'mfa_exempted_by_admin' : 'mfa_exemption_removed',
        success: true, detail: { by: req.user.username } });
    }
  });
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
    await logAuth(req, { db: c, userId: id, username: u.username, event: 'password_reset_by_admin', success: true, detail: { by: req.user.username } });
  });
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
  res.json({ ok: true });
});

r.post('/:id/unlock', async (req, res) => {
  const id = idParam(req.params.id);
  const u = await loadUser(id);
  await tx(async c => {
    await c.query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE id=$1', [id]);
    await logAudit(req, { db: c, action: 'unlock', entity: 'user', entityId: id, summary: u.username });
    await logAuth(req, { db: c, userId: id, username: u.username, event: 'account_unlocked_by_admin', success: true, detail: { by: req.user.username } });
  });
  res.json({ ok: true });
});

r.post('/:id/revoke-sessions', async (req, res) => {
  const id = idParam(req.params.id);
  const u = await loadUser(id);
  const q = await tx(async c => {
    const q = await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='revoked_by_admin'
      WHERE user_id=$1 AND revoked_at IS NULL AND id <> $2`, [id, req.session.id]);
    await logAudit(req, { db: c, action: 'revoke_sessions', entity: 'user', entityId: id, summary: u.username, newValue: { count: q.rowCount } });
    await logAuth(req, { db: c, userId: id, username: u.username, event: 'sessions_revoked_by_admin', success: true,
      detail: { by: req.user.username, count: q.rowCount } });
    return q;
  });
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
      ? await c.query('UPDATE users SET totp_exempt=$1, updated_at=now() WHERE totp_exempt<>$1 AND id<>$2 RETURNING id, username', [exempt, skip])
      : await c.query('UPDATE users SET totp_exempt=$1, updated_at=now() WHERE id = ANY($2) AND totp_exempt<>$1 AND id<>$3 RETURNING id, username', [exempt, user_ids, skip]);
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

export default r;

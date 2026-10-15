import { Router } from 'express';
import { query, tx } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { hashPassword, checkPolicy } from '../services/passwords.js';
import { getSetting } from '../services/settings.js';
import { logAudit, logAuth } from '../services/logs.js';
import { bad, notFound, str } from '../utils/http.js';

const r = Router();
r.use(requireAuth, requirePerm('usr'));

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

r.get('/:id', async (req, res) => {
  res.json({ user: await loadUser(parseInt(req.params.id, 10)) });
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
    if (!(await query('SELECT 1 FROM roles WHERE id=$1', [body.role_id])).rowCount) throw bad('invalid_role');
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

async function writeScopes(c, userId, scopes, overrides) {
  if (Array.isArray(scopes)) {
    await c.query('DELETE FROM user_scopes WHERE user_id=$1', [userId]);
    for (const s of scopes) {
      if (!['department', 'application'].includes(s.kind)) throw bad('invalid_scope');
      const table = s.kind === 'department' ? 'departments' : 'applications';
      if (!(await c.query(`SELECT 1 FROM ${table} WHERE id=$1`, [s.ref_id])).rowCount) throw bad('invalid_scope');
      await c.query('INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, s.kind, s.ref_id]);
    }
  }
  if (Array.isArray(overrides)) {
    await c.query('DELETE FROM user_permissions WHERE user_id=$1', [userId]);
    for (const o of overrides) {
      if (!PERMISSIONS.includes(o.permission) || typeof o.granted !== 'boolean') throw bad('invalid_permission');
      await c.query('INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,$2,$3)', [userId, o.permission, o.granted]);
    }
  }
}

r.post('/', async (req, res) => {
  const b = req.body || {};
  const v = await validateCommon(b, { creating: true });
  await validatePassword(b.password, v.username, v.role_id);
  if ((await query('SELECT 1 FROM users WHERE username=$1', [v.username])).rowCount) throw bad('username_taken');
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

// Prevents locking everybody out: there must always be one active admin.
async function assertAdminRemains(c, userId, next) {
  const cur = (await c.query('SELECT role_id, is_active FROM users WHERE id=$1', [userId])).rows[0];
  const losesAdmin = cur.role_id === 'admin' && cur.is_active && ((next.role_id && next.role_id !== 'admin') || next.is_active === false);
  if (!losesAdmin) return;
  const n = (await c.query(`SELECT count(*)::int AS n FROM users WHERE role_id='admin' AND is_active AND id<>$1`, [userId])).rows[0].n;
  if (!n) throw bad('last_admin');
}

r.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const before = await loadUser(id);
  const b = req.body || {};
  const v = await validateCommon(b, { creating: false });
  if (v.username && v.username.toLowerCase() !== before.username.toLowerCase() &&
      (await query('SELECT 1 FROM users WHERE username=$1 AND id<>$2', [v.username, id])).rowCount) throw bad('username_taken');
  if (id === req.user.id && (v.is_active === false || (v.role_id && v.role_id !== before.role_id))) throw bad('cannot_change_own_role');
  await tx(async c => {
    await assertAdminRemains(c, id, v);
    const keys = Object.keys(v);
    if (keys.length) {
      await c.query(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`,
        [id, ...keys.map(k => v[k])]);
    }
    await writeScopes(c, id, b.scopes, b.overrides);
    if (v.is_active === false) {
      await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='user_deactivated' WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
    }
    await logAudit(req, { db: c, action: 'update', entity: 'user', entityId: id, summary: before.username,
      oldValue: { ...Object.fromEntries(keys.map(k => [k, before[k]])), ...(b.scopes ? { scopes: before.scopes } : {}), ...(b.overrides ? { overrides: before.overrides } : {}) },
      newValue: { ...v, ...(b.scopes ? { scopes: b.scopes } : {}), ...(b.overrides ? { overrides: b.overrides } : {}) } });
  });
  if (v.totp_exempt !== undefined && v.totp_exempt !== before.totp_exempt) {
    await logAuth(req, { userId: id, username: before.username, event: v.totp_exempt ? 'mfa_exempted_by_admin' : 'mfa_exemption_removed', success: true,
      detail: { by: req.user.username } });
  }
  res.json({ user: await loadUser(id) });
});

r.post('/:id/reset-password', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await loadUser(id);
  await validatePassword(req.body?.password, u.username, u.role_id);
  await tx(async c => {
    await c.query(`UPDATE users SET password_hash=$2, must_change_password=$3, failed_attempts=0, locked_until=NULL,
      last_failed_at=NULL, password_changed_at=now(), updated_at=now() WHERE id=$1`, [id, await hashPassword(req.body.password), req.body?.must_change !== false]);
    await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='password_reset' WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
    await logAudit(req, { db: c, action: 'reset_password', entity: 'user', entityId: id, summary: u.username });
  });
  await logAuth(req, { userId: id, username: u.username, event: 'password_reset_by_admin', success: true, detail: { by: req.user.username } });
  res.json({ ok: true });
});

// Removes the user's authenticator; they enrol again on next login if 2FA is required.
r.post('/:id/reset-2fa', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await loadUser(id);
  await tx(async c => {
    await c.query('UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL, totp_enabled_at=NULL WHERE id=$1', [id]);
    await c.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [id]);
    // signed-in sessions passed the removed second factor: they end too (ETS-SEC-018)
    await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='mfa_reset' WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`,
      [id, req.session.id]);
    await logAudit(req, { db: c, action: 'reset_2fa', entity: 'user', entityId: id, summary: u.username });
  });
  await logAuth(req, { userId: id, username: u.username, event: 'mfa_reset_by_admin', success: true, detail: { by: req.user.username } });
  res.json({ ok: true });
});

r.post('/:id/unlock', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await loadUser(id);
  await query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_failed_at=NULL WHERE id=$1', [id]);
  await logAuth(req, { userId: id, username: u.username, event: 'account_unlocked_by_admin', success: true, detail: { by: req.user.username } });
  await logAudit(req, { action: 'unlock', entity: 'user', entityId: id, summary: u.username });
  res.json({ ok: true });
});

r.post('/:id/revoke-sessions', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await loadUser(id);
  const q = await query(`UPDATE sessions SET revoked_at=now(), revoke_reason='revoked_by_admin'
    WHERE user_id=$1 AND revoked_at IS NULL AND id <> $2`, [id, req.session.id]);
  await logAuth(req, { userId: id, username: u.username, event: 'sessions_revoked_by_admin', success: true, detail: { by: req.user.username, count: q.rowCount } });
  res.json({ revoked: q.rowCount });
});

// Turn 2FA off (exempt) or back on for many users at once: { user_ids:[..] | all:true, exempt:true|false }
r.post('/bulk-2fa', async (req, res) => {
  const { user_ids, all, exempt } = req.body || {};
  if (typeof exempt !== 'boolean') throw bad('invalid_value', { field: 'exempt' });
  if (!all && !(Array.isArray(user_ids) && user_ids.length && user_ids.every(Number.isInteger))) throw bad('invalid_value', { field: 'user_ids' });
  const q = all
    ? await query('UPDATE users SET totp_exempt=$1, updated_at=now() WHERE totp_exempt<>$1 RETURNING id, username', [exempt])
    : await query('UPDATE users SET totp_exempt=$1, updated_at=now() WHERE id = ANY($2) AND totp_exempt<>$1 RETURNING id, username', [exempt, user_ids]);
  for (const u of q.rows) {
    await logAuth(req, { userId: u.id, username: u.username, event: exempt ? 'mfa_exempted_by_admin' : 'mfa_exemption_removed', success: true, detail: { by: req.user.username, bulk: true } });
  }
  await logAudit(req, { action: 'bulk_update', entity: 'user', summary: `totp_exempt=${exempt} on ${q.rowCount} users`, newValue: { all: !!all, user_ids: user_ids || null, exempt } });
  res.json({ updated: q.rowCount });
});

export default r;

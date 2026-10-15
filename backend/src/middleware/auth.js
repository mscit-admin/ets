import { config } from '../config.js';
import { query } from '../db/pool.js';
import { sha256, randomToken } from '../services/crypto.js';
import { HttpError } from '../utils/http.js';
import { logAuth } from '../services/logs.js';

export const ADMIN_ROLE = 'admin';

const cookieOpts = () => ({
  httpOnly: true, sameSite: 'strict', secure: config.session.secure, path: '/',
  maxAge: config.session.ttlHours * 3600 * 1000,
});
// With Secure cookies the name carries the __Host- prefix: browsers then accept it only over HTTPS, for
// path=/ and without a Domain, so a neighbouring host cannot plant or overwrite it (ETS-SEC-053).
export const cookieName = () =>
  (config.session.secure && !config.session.cookieName.startsWith('__Host-') ? '__Host-' : '') + config.session.cookieName;
const clearCookie = res => res.clearCookie(cookieName(), { ...cookieOpts(), maxAge: undefined });

// Refuses to start a production server whose session cookie could travel over plain HTTP.
export function assertCookieConfig() {
  if (config.env === 'production' && !config.session.secure && process.env.ALLOW_INSECURE_COOKIES !== 'true') {
    throw new Error('COOKIE_SECURE=false is not allowed with NODE_ENV=production: the session cookie would be sent over ' +
      'plain HTTP. Serve the site over HTTPS (COOKIE_SECURE=true), or set ALLOW_INSECURE_COOKIES=true on a lab system.');
  }
}

// Always issues a new token; the session the browser presented (if any) is revoked, so a token captured
// before sign-in or before 2FA never becomes a full session (ETS-SEC-015).
export async function createSession(res, req, userId, { mfaPassed, mfaStage = null, replaces = 'replaced' }) {
  const old = req.cookies?.[cookieName()];
  if (old) await query('UPDATE sessions SET revoked_at=now(), revoke_reason=$2 WHERE id=$1 AND revoked_at IS NULL', [sha256(old), replaces]);
  const token = randomToken();
  await query(`INSERT INTO sessions(id,user_id,mfa_passed,mfa_stage,ip,user_agent,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)`,
    [sha256(token), userId, mfaPassed, mfaStage, req.ip, req.get('user-agent')?.slice(0, 500) || null, String(config.session.ttlHours)]);
  res.cookie(cookieName(), token, cookieOpts());
}

export async function revokeSession(req, res, reason = 'logout') {
  const t = req.cookies?.[cookieName()];
  if (t) await query('UPDATE sessions SET revoked_at=now(), revoke_reason=$2 WHERE id=$1 AND revoked_at IS NULL', [sha256(t), reason]);
  clearCookie(res);
}

// Exported so that an approved edit request / import can re-check its author's current rights (ETS-SEC-027).
export async function loadUserContext(userId) {
  const r = await query(`SELECT u.id, u.username, u.full_name, u.email, u.role_id, u.language, u.is_active,
      u.must_change_password, u.totp_enabled, u.totp_exempt, r.full_scope, r.permissions AS role_perms,
      r.name_ar AS role_name_ar, r.name_en AS role_name_en,
      COALESCE((SELECT json_agg(json_build_object('p',permission,'g',granted)) FROM user_permissions WHERE user_id=u.id),'[]') AS overrides,
      COALESCE((SELECT json_agg(json_build_object('k',kind,'r',ref_id)) FROM user_scopes WHERE user_id=u.id),'[]') AS scopes
    FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [userId]);
  const u = r.rows[0];
  if (!u) return null;
  const perms = new Set(u.role_perms);
  for (const o of u.overrides) o.g ? perms.add(o.p) : perms.delete(o.p);
  // User administration belongs to system administrators only (ETS-SEC-004): a stray override never grants it.
  if (u.role_id !== ADMIN_ROLE) perms.delete('usr');
  const depts = u.scopes.filter(s => s.k === 'department').map(s => s.r);
  const apps = u.scopes.filter(s => s.k === 'application').map(s => s.r);
  return {
    id: u.id, username: u.username, full_name: u.full_name, email: u.email, role: u.role_id,
    role_name_ar: u.role_name_ar, role_name_en: u.role_name_en, language: u.language,
    is_active: u.is_active, must_change_password: u.must_change_password,
    totp_enabled: u.totp_enabled, totp_exempt: u.totp_exempt,
    // Full scope comes from the role only. A scoped role without scope rows sees nothing (ETS-SEC-005).
    permissions: [...perms], fullScope: !!u.full_scope,
    scope: { departments: depts, applications: apps },
  };
}

// Attaches req.user / req.session when a valid session cookie is present.
export async function sessionMiddleware(req, res, next) {
  const t = req.cookies?.[cookieName()];
  if (!t) return next();
  const id = sha256(t);
  const r = await query(`SELECT id, user_id, mfa_passed, mfa_stage, last_seen_at, expires_at, revoked_at, revoke_reason,
      (SELECT username FROM users WHERE id=sessions.user_id) AS username,
      (last_seen_at < now() - ($2 || ' minutes')::interval) AS idle
    FROM sessions WHERE id=$1`, [id, String(config.session.idleMinutes)]);
  const s = r.rows[0];
  if (!s || s.revoked_at || new Date(s.expires_at) < new Date() || s.idle) {
    // Expiry and the use of an ended session are recorded once per session / cookie (ETS-SEC-050); an unknown
    // token is not (anyone can send one). The cookie is cleared, so a browser sends it only once.
    if (s && !s.revoked_at) {
      const q = await query(`UPDATE sessions SET revoked_at=now(), revoke_reason='expired' WHERE id=$1 AND revoked_at IS NULL`, [id]);
      if (q.rowCount) {
        await logAuth(req, { userId: s.user_id, username: s.username, event: 'session_expired', success: false,
          detail: { reason: s.idle ? 'idle' : 'absolute' } });
      }
    } else if (s) {
      await logAuth(req, { userId: s.user_id, username: s.username, event: 'session_revoked_reuse', success: false,
        detail: { revoke_reason: s.revoke_reason, revoked_at: s.revoked_at } });
    }
    clearCookie(res);
    return next();
  }
  const user = await loadUserContext(s.user_id);
  if (!user || !user.is_active) return next();
  req.session = s;
  req.user = user;
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60_000) {
    query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [id]).catch(() => {});
  }
  next();
}

// Fully authenticated (password + 2FA when required).
function requireFullSession(req) {
  if (!req.user) throw new HttpError(401, 'not_authenticated');
  if (!req.session.mfa_passed) throw new HttpError(401, 'mfa_required', { stage: req.session.mfa_stage });
}
export function requireAuth(req, res, next) {
  requireFullSession(req);
  // A user whose password was set/reset by an admin may only change it (and sign out) until they do;
  // the few endpoints allowed meanwhile use requireAuthDuringPasswordChange explicitly (ETS-SEC-054).
  if (req.user.must_change_password) throw new HttpError(403, 'password_change_required');
  next();
}
export function requireAuthDuringPasswordChange(req, res, next) {
  requireFullSession(req);
  next();
}

// Password accepted, 2FA step still pending (verify or enroll).
export function requirePartial(req, res, next) {
  if (!req.user) throw new HttpError(401, 'not_authenticated');
  next();
}

export const hasPerm = (user, p) => !!user && user.permissions.includes(p);

export const requirePerm = p => (req, res, next) => {
  if (!hasPerm(req.user, p)) throw new HttpError(403, 'forbidden', { permission: p });
  next();
};

// System administrators only (role 'admin'), whatever the overrides say.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== ADMIN_ROLE) throw new HttpError(403, 'forbidden', { permission: 'usr' });
  next();
}

// ---- data scope ----
// No scope rows → nothing is visible (fail closed); full scope comes from the role.
export function canSeeApp(user, app) {
  if (user.fullScope) return true;
  return user.scope.applications.includes(app.id) || user.scope.departments.includes(app.department_id);
}
// True when the user can see at least one application of the department (enough to show the department).
// Never use it to authorise an action on the whole department: see coversDept / canSeeApp.
export function canSeeDept(user, deptId, apps) {
  if (user.fullScope) return true;
  return user.scope.departments.includes(deptId) ||
    apps.some(a => a.department_id === deptId && user.scope.applications.includes(a.id));
}
// The whole department (every application in it, present and future) is in scope.
export function coversDept(user, deptId) {
  return !!user.fullScope || user.scope.departments.includes(deptId);
}

import { Router } from 'express';
import QRCode from 'qrcode';
import { query, tx } from '../db/pool.js';
import { createSession, revokeSession, requireAuth, requireAuthDuringPasswordChange, requirePartial } from '../middleware/auth.js';
import { authLimiter } from '../middleware/ratelimit.js';
import { hashPassword, verifyPassword, needsRehash, getDummyHash, checkPolicy, generateRecoveryCodes,
  hashRecoveryCode, recoveryCodeHashes } from '../services/passwords.js';
import { serialize, accountKey, isDelayed, tooManyAttempts, registerFailure, clearFailures } from '../services/lockout.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { generateSecret, verifyTotp, otpauthUri } from '../services/totp.js';
import { getSetting, allSettings } from '../services/settings.js';
import { logAuth, logAudit, maskUsername } from '../services/logs.js';
import { publishSessionCheck } from '../services/live.js';
import { HttpError, bad, str } from '../utils/http.js';
import { brandingVersions } from './branding.js';

const r = Router();

// What the login screen needs before anyone is signed in.
r.get('/public-info', async (req, res) => {
  const s = await allSettings();
  res.json({ org_name_ar: s['app.org_name_ar'], org_name_en: s['app.org_name_en'], default_language: s['app.default_language'],
    branding: await brandingVersions(), logo_height: s['app.logo_height'], login_logo_height: s['app.login_logo_height'] });
});

// Decides whether this user must pass 2FA, enrol, or neither.
async function mfaStageFor(u) {
  const mode = await getSetting('mfa.mode');
  if (mode === 'off' || u.totp_exempt) return null;
  if (u.totp_enabled) return 'verify';
  if (mode === 'required') return 'enroll';
  return null;
}

const saveRecoveryCodes = async (c, userId, codes) => {
  await c.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [userId]);
  for (const code of codes) await c.query('INSERT INTO user_recovery_codes(user_id,code_hash) VALUES ($1,$2)', [userId, hashRecoveryCode(code)]);
};

// Checks the 2FA code or recovery code in the request body and consumes it.
// Returns 'totp' | 'recovery' on success, 'replay' for an already used code, null otherwise.
async function useSecondFactor(u, body) {
  const recovery = str(body?.recovery_code, 40);
  if (recovery) {
    // used_at IS NULL is re-checked on the row itself, so a code works only once even when sent concurrently.
    const rc = await query(`UPDATE user_recovery_codes SET used_at=now()
      WHERE id = (SELECT id FROM user_recovery_codes WHERE user_id=$1 AND code_hash = ANY($2) AND used_at IS NULL LIMIT 1)
        AND used_at IS NULL RETURNING id`, [u.id, recoveryCodeHashes(recovery)]);
    return rc.rowCount ? 'recovery' : null;
  }
  if (!u.totp_secret) return null;
  const step = verifyTotp(decrypt(u.totp_secret), str(body?.code, 20));
  if (step === null) return null;
  // Conditional update: of several requests with the same code only one moves the step on (ETS-SEC-021).
  const q = await query('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id',
    [u.id, step]);
  return q.rowCount ? 'totp' : 'replay';
}

r.post('/login', authLimiter, async (req, res) => {
  const username = str(req.body?.username, 100);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) throw bad('missing_credentials');

  const stage = await serialize(accountKey(username), async () => {
    const u = (await query('SELECT * FROM users WHERE username=$1', [username])).rows[0];
    // Unknown user, paused account, wrong password and disabled account all get the same answer (ETS-SEC-014);
    // the first two still run a bcrypt check of the same cost, so the timing matches too.
    if (!u) {
      await verifyPassword(password, await getDummyHash());
      // the typed name is masked: it may be a password typed into the wrong field (ETS-SEC-051)
      await logAuth(req, { username: maskUsername(username), event: 'login_unknown_user', success: false });
      throw new HttpError(401, 'invalid_credentials');
    }
    if (isDelayed(u)) {
      await verifyPassword(password, await getDummyHash());
      await logAuth(req, { userId: u.id, username: u.username, event: 'login_while_locked', success: false, detail: { until: u.locked_until } });
      throw new HttpError(401, 'invalid_credentials');
    }
    if (!(await verifyPassword(password, u.password_hash))) {
      await registerFailure(req, u, 'login_bad_password');
      throw new HttpError(401, 'invalid_credentials');
    }
    if (!u.is_active) {
      await logAuth(req, { userId: u.id, username: u.username, event: 'login_inactive_user', success: false });
      throw new HttpError(401, 'invalid_credentials');
    }
    if (needsRehash(u.password_hash)) await query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, await hashPassword(password)]);

    const st = await mfaStageFor(u);
    // The failure counter is cleared only by a complete sign-in: while 2FA is pending it stays as it is,
    // so wrong codes keep adding up across logins (ETS-SEC-001).
    // No session without its auth_log row: the row is written first and a failed write fails the sign-in (ETS-SEC-049).
    await logAuth(req, st
      ? { userId: u.id, username: u.username, event: 'password_ok_mfa_pending', success: true, detail: { stage: st }, strict: true }
      : { userId: u.id, username: u.username, event: 'login', success: true, strict: true });
    if (!st) await clearFailures(u.id);
    await createSession(res, req, u.id, { mfaPassed: !st, mfaStage: st, replaces: 'relogin' });
    if (!st) await query('UPDATE users SET last_login_at=now(), last_login_ip=$2 WHERE id=$1', [u.id, req.ip]);
    return st;
  });
  res.json({ stage: stage || 'done' });
});

// Second step done: the partial session is replaced by a new full one (new token), the failure counter cleared.
async function completeMfa(req, res, event) {
  await tx(async c => {
    await logAuth(req, { db: c, userId: req.user.id, username: req.user.username, event, success: true });
    await logAuth(req, { db: c, userId: req.user.id, username: req.user.username, event: 'login', success: true, detail: { mfa: true } });
  });
  await createSession(res, req, req.user.id, { mfaPassed: true, replaces: 'mfa_completed' });
  await clearFailures(req.user.id);
  await query('UPDATE users SET last_login_at=now(), last_login_ip=$2 WHERE id=$1', [req.user.id, req.ip]);
}

r.post('/2fa/verify', authLimiter, requirePartial, async (req, res) => {
  if (req.session.mfa_stage !== 'verify') throw bad('mfa_not_pending');
  await serialize(accountKey(req.user.username), async () => {
    const u = (await query('SELECT id, username, totp_enabled, totp_secret, locked_until FROM users WHERE id=$1', [req.user.id])).rows[0];
    // 2FA was removed (e.g. admin reset) while this sign-in was pending: sign in again (ETS-SEC-055).
    if (!u.totp_enabled || !u.totp_secret) throw bad('mfa_not_pending');
    if (isDelayed(u)) {
      await logAuth(req, { userId: u.id, username: u.username, event: 'mfa_verify_while_locked', success: false, detail: { until: u.locked_until } });
      throw tooManyAttempts(u);
    }
    const used = await useSecondFactor(u, req.body);
    if (used !== 'totp' && used !== 'recovery') {
      await registerFailure(req, u, req.body?.recovery_code ? 'mfa_bad_recovery_code' : used === 'replay' ? 'mfa_code_replay' : 'mfa_bad_code');
      throw bad('invalid_code');
    }
    await completeMfa(req, res, used === 'recovery' ? 'mfa_recovery_code_used' : 'mfa_verified');
  });
  res.json({ stage: 'done' });
});

// Repeated wrong answers from a signed-in session also end that session: a stolen session must not
// become a way to guess the password or 2FA codes.
async function reauthFailure(req, u, event) {
  const f = await registerFailure(req, u, event);
  if (f.delayed) {
    await query(`UPDATE sessions SET revoked_at=now(), revoke_reason='reauth_failures' WHERE id=$1 AND revoked_at IS NULL`, [req.session.id]);
    publishSessionCheck(req.user.id);
    throw tooManyAttempts(f);
  }
}

// Re-authentication for sensitive changes from a signed-in session: the current password and, with
// secondFactor while 2FA is on, a current authenticator code or an unused recovery code (ETS-SEC-016).
// Failures count towards the account's sign-in pause like failed logins (ETS-SEC-003).
function reauth(req, { password, secondFactor = false, events }) {
  return serialize(accountKey(req.user.username), async () => {
    const u = (await query('SELECT id, username, password_hash, totp_enabled, totp_secret, locked_until FROM users WHERE id=$1',
      [req.user.id])).rows[0];
    if (isDelayed(u)) {
      await logAuth(req, { userId: u.id, username: u.username, event: 'reauth_while_locked', success: false,
        detail: { action: events[0], until: u.locked_until } });
      throw tooManyAttempts(u);
    }
    const needCode = secondFactor && u.totp_enabled;
    if (needCode && !str(req.body?.code, 20) && !str(req.body?.recovery_code, 40)) throw bad('mfa_code_required');
    if (!(await verifyPassword(typeof password === 'string' ? password : '', u.password_hash))) {
      await reauthFailure(req, u, events[0]);
      throw bad('wrong_password');
    }
    if (needCode) {
      const used = await useSecondFactor(u, req.body);
      if (used !== 'totp' && used !== 'recovery') { await reauthFailure(req, u, events[1]); throw bad('invalid_code'); }
    }
    return u;
  });
}

// Start enrolment: generates a new secret (not active until confirmed with /2fa/enable).
// At the login enrol step the password was just checked; from a full session it is asked again.
r.post('/2fa/setup', authLimiter, requirePartial, async (req, res) => {
  const enrolling = req.session.mfa_stage === 'enroll';
  if (!enrolling && !req.session.mfa_passed) throw new HttpError(401, 'mfa_required');
  if (!enrolling && req.user.must_change_password) throw new HttpError(403, 'password_change_required');
  if ((await getSetting('mfa.mode')) === 'off') throw bad('mfa_disabled_globally');
  if (req.user.totp_enabled) throw bad('mfa_already_enabled');
  if (!enrolling) await reauth(req, { password: req.body?.password, events: ['mfa_setup_bad_password'] });
  const secret = generateSecret();
  await tx(async c => {
    await c.query('UPDATE users SET totp_secret=$2 WHERE id=$1 AND NOT totp_enabled', [req.user.id, encrypt(secret)]);
    await logAuth(req, { db: c, userId: req.user.id, username: req.user.username, event: 'mfa_setup_started', success: true });
  });
  const uri = otpauthUri({ secret, account: req.user.username, issuer: await getSetting('mfa.issuer') });
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

r.post('/2fa/enable', authLimiter, requirePartial, async (req, res) => {
  const enrolling = req.session.mfa_stage === 'enroll';
  if (!enrolling && !req.session.mfa_passed) throw new HttpError(401, 'mfa_required');
  if (!enrolling && req.user.must_change_password) throw new HttpError(403, 'password_change_required');
  const codes = await serialize(accountKey(req.user.username), async () => {
    const u = (await query('SELECT id, username, totp_secret, totp_enabled FROM users WHERE id=$1', [req.user.id])).rows[0];
    if (u.totp_enabled) throw bad('mfa_already_enabled');
    if (!u.totp_secret) throw bad('mfa_setup_first');
    const step = verifyTotp(decrypt(u.totp_secret), str(req.body?.code, 20));
    if (step === null) {
      await logAuth(req, { userId: u.id, username: u.username, event: 'mfa_enable_bad_code', success: false });
      throw bad('invalid_code');
    }
    const fresh = generateRecoveryCodes();
    await tx(async c => {
      await c.query('UPDATE users SET totp_enabled=true, totp_enabled_at=now(), totp_last_step=$2 WHERE id=$1', [u.id, step]);
      await saveRecoveryCodes(c, u.id, fresh);
      await logAuth(req, { db: c, userId: u.id, username: u.username, event: 'mfa_enabled', success: true });
    });
    return fresh;
  });
  if (enrolling) await completeMfa(req, res, 'mfa_enrolled_at_login');
  res.json({ recovery_codes: codes, stage: 'done' });
});

// Self-service disable — only when the policy is not "required". Needs the password and a 2FA / recovery code;
// the user's other sessions are signed out.
r.post('/2fa/disable', authLimiter, requireAuth, async (req, res) => {
  if ((await getSetting('mfa.mode')) === 'required' && !req.user.totp_exempt) throw bad('mfa_required_by_policy');
  await reauth(req, { password: req.body?.password, secondFactor: true, events: ['mfa_disable_bad_password', 'mfa_disable_bad_code'] });
  await tx(async c => {
    await c.query('UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL WHERE id=$1', [req.user.id]);
    await c.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [req.user.id]);
    await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='mfa_disabled'
      WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`, [req.user.id, req.session.id]);
    await logAuth(req, { db: c, userId: req.user.id, username: req.user.username, event: 'mfa_disabled_by_user', success: true });
  });
  publishSessionCheck(req.user.id);
  res.json({ ok: true });
});

r.post('/2fa/recovery-codes', authLimiter, requireAuth, async (req, res) => {
  if (!req.user.totp_enabled) throw bad('mfa_not_enabled');
  await reauth(req, { password: req.body?.password, secondFactor: true,
    events: ['mfa_recovery_codes_bad_password', 'mfa_recovery_codes_bad_code'] });
  const codes = generateRecoveryCodes();
  await tx(async c => {
    await saveRecoveryCodes(c, req.user.id, codes);
    await logAuth(req, { db: c, userId: req.user.id, username: req.user.username, event: 'mfa_recovery_codes_regenerated', success: true });
  });
  res.json({ recovery_codes: codes });
});

r.get('/me', async (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  const s = await allSettings();
  const org = { org_name_ar: s['app.org_name_ar'], org_name_en: s['app.org_name_en'], branding: await brandingVersions() };
  // Password accepted but 2FA pending: only what the 2FA screen needs (ETS-SEC-017).
  if (!req.session.mfa_passed) {
    return res.json({ authenticated: true, stage: req.session.mfa_stage,
      user: { username: req.user.username, language: req.user.language }, ...org });
  }
  const codes = req.user.totp_enabled
    ? (await query(`SELECT count(*)::int AS n, (count(*) FILTER (WHERE code_hash NOT LIKE 'h1:%'))::int AS old
        FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL`, [req.user.id])).rows[0]
    : { n: 0, old: 0 };
  res.json({
    authenticated: true,
    stage: 'done',
    // recovery_codes_outdated: unused codes made before 1.0.0 (weaker format); the profile page suggests new ones
    user: { ...req.user, recovery_codes_left: codes.n, recovery_codes_outdated: codes.old > 0 },
    mfa_mode: s['mfa.mode'],
    ...org,
  });
});

// The session is revoked first and always: a failed log write must never keep a session alive. The row is
// therefore written soft (a failure is counted and reported, see services/logs.js).
r.post('/logout', async (req, res) => {
  await revokeSession(req, res, 'logout');
  if (req.user) await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'logout', success: true });
  res.json({ ok: true });
});

r.post('/change-password', authLimiter, requireAuthDuringPasswordChange, async (req, res) => {
  const next = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  const u = await reauth(req, { password: req.body?.current_password, events: ['password_change_bad_current'] });
  const errs = checkPolicy(next, { minLength: await getSetting('security.password_min_length'), username: req.user.username,
    admin: req.user.role === 'admin' });
  const rejected = async (code, detail) => {
    await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'password_change_rejected', success: false, detail: { reason: code, ...detail } });
    return bad(code, detail);
  };
  if (errs.length) throw await rejected('weak_password', { reasons: errs });
  if (await verifyPassword(next, u.password_hash)) throw await rejected('password_reused');
  const hash = await hashPassword(next);
  await tx(async c => {
    await c.query('UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now(), updated_at=now() WHERE id=$1',
      [req.user.id, hash]);
    // sign out every other session of this user
    await c.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='password_changed'
      WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`, [req.user.id, req.session.id]);
    await logAuth(req, { db: c, userId: req.user.id, username: req.user.username, event: 'password_changed', success: true });
  });
  publishSessionCheck(req.user.id);
  res.json({ ok: true });
});

r.put('/language', requireAuthDuringPasswordChange, async (req, res) => {
  const lang = req.body?.language;
  if (!['ar', 'en'].includes(lang)) throw bad('invalid_language');
  await tx(async c => {
    await c.query('UPDATE users SET language=$2 WHERE id=$1', [req.user.id, lang]);
    await logAudit(req, { db: c, action: 'update', entity: 'user', entityId: req.user.id, summary: 'language', newValue: { language: lang } });
  });
  res.json({ ok: true });
});

export default r;

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { query, tx } from '../db/pool.js';
import { createSession, revokeSession, requireAuth, requirePartial } from '../middleware/auth.js';
import { hashPassword, verifyPassword, DUMMY_HASH, checkPolicy, generateRecoveryCodes } from '../services/passwords.js';
import { encrypt, decrypt, sha256 } from '../services/crypto.js';
import { generateSecret, verifyTotp, otpauthUri } from '../services/totp.js';
import { getSetting, allSettings } from '../services/settings.js';
import { logAuth, logAudit } from '../services/logs.js';
import { HttpError, bad, str } from '../utils/http.js';

const r = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => {
    logAuth(req, { username: str(req.body?.username, 100) || null, event: 'rate_limited', success: false });
    res.status(429).json({ error: 'too_many_attempts' });
  },
});

// What the login screen needs before anyone is signed in.
r.get('/public-info', async (req, res) => {
  const s = await allSettings();
  res.json({ org_name_ar: s['app.org_name_ar'], org_name_en: s['app.org_name_en'], default_language: s['app.default_language'] });
});

// Decides whether this user must pass 2FA, enrol, or neither.
async function mfaStageFor(u) {
  const mode = await getSetting('mfa.mode');
  if (mode === 'off' || u.totp_exempt) return null;
  if (u.totp_enabled) return 'verify';
  if (mode === 'required') return 'enroll';
  return null;
}

async function registerFailure(req, u, event) {
  const max = config.security.maxFailedLogins;
  const q = await query(`UPDATE users SET failed_attempts = failed_attempts + 1,
      locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
    WHERE id=$1 RETURNING failed_attempts, locked_until`, [u.id, max, String(config.security.lockMinutes)]);
  await logAuth(req, { userId: u.id, username: u.username, event, success: false, detail: { attempts: q.rows[0].failed_attempts } });
  if (q.rows[0].failed_attempts >= max) {
    await logAuth(req, { userId: u.id, username: u.username, event: 'account_locked', success: false,
      detail: { until: q.rows[0].locked_until } });
  }
}

const isLocked = u => u.locked_until && new Date(u.locked_until) > new Date();

r.post('/login', limiter, async (req, res) => {
  const username = str(req.body?.username, 100);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) throw bad('missing_credentials');

  const u = (await query('SELECT * FROM users WHERE username=$1', [username])).rows[0];
  if (!u) {
    await verifyPassword(password, DUMMY_HASH); // equal timing
    await logAuth(req, { username, event: 'login_unknown_user', success: false });
    throw new HttpError(401, 'invalid_credentials');
  }
  if (isLocked(u)) {
    await logAuth(req, { userId: u.id, username: u.username, event: 'login_while_locked', success: false });
    throw new HttpError(423, 'account_locked', { until: u.locked_until });
  }
  if (!(await verifyPassword(password, u.password_hash))) {
    await registerFailure(req, u, 'login_bad_password');
    throw new HttpError(401, 'invalid_credentials');
  }
  if (!u.is_active) {
    await logAuth(req, { userId: u.id, username: u.username, event: 'login_inactive_user', success: false });
    throw new HttpError(401, 'invalid_credentials');
  }

  await query('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1', [u.id]);
  const stage = await mfaStageFor(u);
  await createSession(res, req, u.id, { mfaPassed: !stage, mfaStage: stage });
  if (stage) {
    await logAuth(req, { userId: u.id, username: u.username, event: 'password_ok_mfa_pending', success: true, detail: { stage } });
  } else {
    await query('UPDATE users SET last_login_at=now(), last_login_ip=$2 WHERE id=$1', [u.id, req.ip]);
    await logAuth(req, { userId: u.id, username: u.username, event: 'login', success: true });
  }
  res.json({ stage: stage || 'done' });
});

async function completeMfa(req, event) {
  await query('UPDATE sessions SET mfa_passed=true, mfa_stage=NULL WHERE id=$1', [req.session.id]);
  await query('UPDATE users SET last_login_at=now(), last_login_ip=$2, failed_attempts=0 WHERE id=$1', [req.user.id, req.ip]);
  await logAuth(req, { userId: req.user.id, username: req.user.username, event, success: true });
  await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'login', success: true, detail: { mfa: true } });
}

r.post('/2fa/verify', limiter, requirePartial, async (req, res) => {
  if (req.session.mfa_stage !== 'verify') throw bad('mfa_not_pending');
  const u = (await query('SELECT id, username, totp_secret, totp_last_step, locked_until FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (isLocked(u)) throw new HttpError(423, 'account_locked', { until: u.locked_until });

  const code = str(req.body?.code, 20);
  const recovery = str(req.body?.recovery_code, 20).toLowerCase();
  if (recovery) {
    const rc = await query(`UPDATE user_recovery_codes SET used_at=now()
      WHERE id = (SELECT id FROM user_recovery_codes WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL LIMIT 1)
      RETURNING id`, [u.id, sha256(recovery)]);
    if (!rc.rowCount) { await registerFailure(req, u, 'mfa_bad_recovery_code'); throw bad('invalid_code'); }
    await completeMfa(req, 'mfa_recovery_code_used');
    return res.json({ stage: 'done' });
  }
  const step = verifyTotp(decrypt(u.totp_secret), code);
  if (step === null || (u.totp_last_step && step <= +u.totp_last_step)) {
    await registerFailure(req, u, step === null ? 'mfa_bad_code' : 'mfa_code_replay');
    throw bad('invalid_code');
  }
  await query('UPDATE users SET totp_last_step=$2 WHERE id=$1', [u.id, step]);
  await completeMfa(req, 'mfa_verified');
  res.json({ stage: 'done' });
});

// Start enrolment: generates a new secret (not active until confirmed with /2fa/enable).
r.post('/2fa/setup', requirePartial, async (req, res) => {
  const enrolling = req.session.mfa_stage === 'enroll';
  if (!enrolling && !req.session.mfa_passed) throw new HttpError(401, 'mfa_required');
  if ((await getSetting('mfa.mode')) === 'off') throw bad('mfa_disabled_globally');
  if (req.user.totp_enabled) throw bad('mfa_already_enabled');
  const secret = generateSecret();
  await query('UPDATE users SET totp_secret=$2 WHERE id=$1', [req.user.id, encrypt(secret)]);
  const uri = otpauthUri({ secret, account: req.user.username, issuer: await getSetting('mfa.issuer') });
  await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'mfa_setup_started', success: true });
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

r.post('/2fa/enable', limiter, requirePartial, async (req, res) => {
  const enrolling = req.session.mfa_stage === 'enroll';
  if (!enrolling && !req.session.mfa_passed) throw new HttpError(401, 'mfa_required');
  const u = (await query('SELECT id, username, totp_secret, totp_enabled FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (u.totp_enabled) throw bad('mfa_already_enabled');
  if (!u.totp_secret) throw bad('mfa_setup_first');
  const step = verifyTotp(decrypt(u.totp_secret), str(req.body?.code, 20));
  if (step === null) {
    await logAuth(req, { userId: u.id, username: u.username, event: 'mfa_enable_bad_code', success: false });
    throw bad('invalid_code');
  }
  const codes = generateRecoveryCodes();
  await tx(async c => {
    await c.query('UPDATE users SET totp_enabled=true, totp_enabled_at=now(), totp_last_step=$2 WHERE id=$1', [u.id, step]);
    await c.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [u.id]);
    for (const code of codes) await c.query('INSERT INTO user_recovery_codes(user_id,code_hash) VALUES ($1,$2)', [u.id, sha256(code)]);
  });
  await logAuth(req, { userId: u.id, username: u.username, event: 'mfa_enabled', success: true });
  if (enrolling) await completeMfa(req, 'mfa_enrolled_at_login');
  res.json({ recovery_codes: codes, stage: 'done' });
});

// Self-service disable — only when the policy is not "required".
r.post('/2fa/disable', requireAuth, async (req, res) => {
  if ((await getSetting('mfa.mode')) === 'required' && !req.user.totp_exempt) throw bad('mfa_required_by_policy');
  const u = (await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await verifyPassword(req.body?.password || '', u.password_hash))) {
    await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'mfa_disable_bad_password', success: false });
    throw bad('wrong_password');
  }
  await query('UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL WHERE id=$1', [req.user.id]);
  await query('DELETE FROM user_recovery_codes WHERE user_id=$1', [req.user.id]);
  await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'mfa_disabled_by_user', success: true });
  res.json({ ok: true });
});

r.post('/2fa/recovery-codes', requireAuth, async (req, res) => {
  if (!req.user.totp_enabled) throw bad('mfa_not_enabled');
  const u = (await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await verifyPassword(req.body?.password || '', u.password_hash))) throw bad('wrong_password');
  const codes = generateRecoveryCodes();
  await tx(async c => {
    await c.query('DELETE FROM user_recovery_codes WHERE user_id=$1', [req.user.id]);
    for (const code of codes) await c.query('INSERT INTO user_recovery_codes(user_id,code_hash) VALUES ($1,$2)', [req.user.id, sha256(code)]);
  });
  await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'mfa_recovery_codes_regenerated', success: true });
  res.json({ recovery_codes: codes });
});

r.get('/me', async (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  const s = await allSettings();
  const remaining = req.user.totp_enabled
    ? +(await query('SELECT count(*) FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [req.user.id])).rows[0].count
    : 0;
  res.json({
    authenticated: true,
    stage: req.session.mfa_passed ? 'done' : req.session.mfa_stage,
    user: { ...req.user, recovery_codes_left: remaining },
    mfa_mode: s['mfa.mode'],
    org_name_ar: s['app.org_name_ar'], org_name_en: s['app.org_name_en'],
  });
});

r.post('/logout', async (req, res) => {
  if (req.user) await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'logout', success: true });
  await revokeSession(req, res, 'logout');
  res.json({ ok: true });
});

r.post('/change-password', requireAuth, async (req, res) => {
  const cur = req.body?.current_password || '';
  const next = req.body?.new_password || '';
  const u = (await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await verifyPassword(cur, u.password_hash))) {
    await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'password_change_bad_current', success: false });
    throw bad('wrong_password');
  }
  const errs = checkPolicy(next, { minLength: await getSetting('security.password_min_length'), username: req.user.username });
  if (errs.length) throw bad('weak_password', { reasons: errs });
  if (await verifyPassword(next, u.password_hash)) throw bad('password_reused');
  await query('UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now(), updated_at=now() WHERE id=$1',
    [req.user.id, await hashPassword(next)]);
  // sign out every other session of this user
  await query(`UPDATE sessions SET revoked_at=now(), revoke_reason='password_changed'
    WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`, [req.user.id, req.session.id]);
  await logAuth(req, { userId: req.user.id, username: req.user.username, event: 'password_changed', success: true });
  res.json({ ok: true });
});

r.put('/language', requireAuth, async (req, res) => {
  const lang = req.body?.language;
  if (!['ar', 'en'].includes(lang)) throw bad('invalid_language');
  await query('UPDATE users SET language=$2 WHERE id=$1', [req.user.id, lang]);
  await logAudit(req, { action: 'update', entity: 'user', entityId: req.user.id, summary: 'language', newValue: { language: lang } });
  res.json({ ok: true });
});

export default r;

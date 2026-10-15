// Request rate limits (in memory; the API runs as one Node process).
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { logAuth } from '../services/logs.js';
import { str } from '../utils/http.js';

const AUTH_WINDOW = 15 * 60 * 1000;
const secondsLeft = (req, windowMs) =>
  Math.max(1, Math.ceil(((req.rateLimit?.resetTime?.getTime() ?? Date.now() + windowMs) - Date.now()) / 1000));
const common = { standardHeaders: 'draft-7', legacyHeaders: false };

const authHandler = scope => (req, res) => {
  logAuth(req, { userId: req.user?.id, username: req.user?.username || str(req.body?.username, 100) || null,
    event: 'rate_limited', success: false, detail: { scope, path: req.originalUrl } });
  res.status(429).json({ error: 'too_many_attempts', retry_after: secondsLeft(req, AUTH_WINDOW) });
};

// Every endpoint that checks a password, 2FA code or recovery code (login, 2FA verify / setup / enable /
// disable, recovery-code regeneration, change password) shares one budget per client IP …
const perIp = rateLimit({ ...common, windowMs: AUTH_WINDOW, limit: config.security.loginRateLimit, handler: authHandler('ip') });
// … and one per account: the signed-in user, or the username typed at login whether or not it exists (so the
// answer reveals nothing). Only failed requests count here, so a user's own successful sign-ins do not.
const perAccount = rateLimit({
  ...common, windowMs: AUTH_WINDOW, limit: config.security.loginRateLimit, skipSuccessfulRequests: true,
  keyGenerator: req => 'acct:' + String(req.path !== '/login' && req.user ? req.user.username : str(req.body?.username, 100)).toLowerCase(),
  handler: authHandler('account'),
});
export const authLimiter = [perIp, perAccount];

// General ceiling on every /api request per client IP (scripted floods, log-table growth).
export const makeApiLimiter = (limit = config.security.apiRateLimit, windowMs = 60_000) => rateLimit({
  ...common, windowMs, limit,
  handler: (req, res) => res.status(429).json({ error: 'too_many_requests', retry_after: secondsLeft(req, windowMs) }),
});
export const apiLimiter = makeApiLimiter();

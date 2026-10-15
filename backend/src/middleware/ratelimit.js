// Request rate limits (in memory; the API runs as one Node process).
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { logAuth, maskUsername } from '../services/logs.js';
import { str } from '../utils/http.js';

const AUTH_WINDOW = 15 * 60 * 1000;
const secondsLeft = (req, windowMs) =>
  Math.max(1, Math.ceil(((req.rateLimit?.resetTime?.getTime() ?? Date.now() + windowMs) - Date.now()) / 1000));
const common = { standardHeaders: 'draft-7', legacyHeaders: false };

// Only the first refused request of a window is written to auth_log, then one row at 1 000, 10 000 … refusals
// with the running count: a flood cannot grow the table row by row (ETS-SEC-077). The name typed by an anonymous
// client is masked like an unknown user (ETS-SEC-051).
const shouldLog = req => {
  const over = (req.rateLimit?.used ?? 0) - (req.rateLimit?.limit ?? 0);
  return over <= 1 || (over >= 1000 && /^10*$/.test(String(over)));
};
const authHandler = scope => (req, res) => {
  if (shouldLog(req)) {
    const typed = str(req.body?.username, 100);
    logAuth(req, { userId: req.user?.id, username: req.user?.username || (typed ? maskUsername(typed) : null),
      event: 'rate_limited', success: false,
      detail: { scope, path: req.originalUrl.slice(0, 200), refused_in_window: Math.max(1, (req.rateLimit?.used ?? 0) - (req.rateLimit?.limit ?? 0)) } });
  }
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

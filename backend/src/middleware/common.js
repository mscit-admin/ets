import { HttpError } from '../utils/http.js';
import { logAccess, logError, logAuth } from '../services/logs.js';

// Records every API request (file + access_log table) once the response is sent. A live-updates stream
// (routes/events.js) records itself when it opens and sets res.locals.accessLogged.
export function accessLog(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (res.locals.accessLogged) return;
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    logAccess(req, res, ms);
  });
  next();
}

// CSRF defence in depth: on top of SameSite=strict cookies, state-changing
// requests must be JSON and carry the X-Requested-With header set by the frontend.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'ets') throw new HttpError(403, 'csrf_rejected');
  next();
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not_found' });
}

const DENIAL_EVENTS = { csrf_rejected: 'csrf_rejected', password_change_required: 'password_change_required' };

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    // an anonymous request refused by the CSRF check concerns no session: not stored, anyone could send many (ETS-SEC-077)
    if (err.status === 403 && (req.user || err.code !== 'csrf_rejected')) {
      // distinct events: a CSRF rejection (a forged cross-site request) is not the same as a missing permission (ETS-SEC-050)
      const event = DENIAL_EVENTS[err.code] || 'access_denied';
      logAuth(req, { userId: req.user?.id, username: req.user?.username, event, success: false,
        detail: { path: req.originalUrl.slice(0, 200), method: req.method, code: err.code, ...err.extra } });
    }
    return res.status(err.status).json({ error: err.code, ...(err.extra || {}) });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  if (err?.type === 'entity.too.deep') return res.status(400).json({ error: 'invalid_json' });
  // other body-parser rejections (unsupported charset/encoding, aborted upload…) are client errors, not server faults
  if (err?.type && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'invalid_request' });
  logError(req, err);
  res.status(500).json({ error: 'server_error' });
}

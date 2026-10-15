import { HttpError } from '../utils/http.js';
import { logAccess, logError, logAuth } from '../services/logs.js';

// Records every API request (file + access_log table) once the response is sent.
export function accessLog(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
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

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    if (err.status === 403) {
      logAuth(req, { userId: req.user?.id, username: req.user?.username, event: 'access_denied', success: false,
        detail: { path: req.originalUrl, method: req.method, code: err.code, ...err.extra } });
    }
    return res.status(err.status).json({ error: err.code, ...(err.extra || {}) });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  logError(req, err);
  res.status(500).json({ error: 'server_error' });
}

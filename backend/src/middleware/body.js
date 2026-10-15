// JSON request bodies (ETS-SEC-008).
// Every API request may carry at most SMALL_LIMIT of JSON, parsed before the session is known.
// The few routes that receive files (team result imports, the full tracker import, branding images)
// take up to LARGE_LIMIT, and the bulk user import (rows read from a spreadsheet in the browser) up to
// IMPORT_LIMIT, but only parse it after authentication, CSRF check and permission check.
// Deeply nested documents are refused by a cheap byte scan before JSON.parse runs.
import express from 'express';
import { HttpError, stripBidi, jsonDepth, MAX_JSON_DEPTH } from '../utils/http.js';

export const SMALL_LIMIT = '100kb';
export const LARGE_LIMIT = '5mb';
export const IMPORT_LIMIT = '1mb';

// Routes (relative to /api) whose body is parsed inside the route, after its auth checks, by largeJson —
// or by userImportJson for the bulk user import (routes/users.js).
const LARGE_ROUTES = [
  ['POST', /^\/imports(\/preview)?\/?$/],
  ['POST', /^\/tracker\/import\/?$/],
  ['PUT', /^\/branding\/[^/]+\/?$/],
  ['POST', /^\/users\/import(\/preview)?\/?$/i],
];
const isLargeRoute = req => LARGE_ROUTES.some(([m, re]) => req.method === m && re.test(req.path));

function checkDepth(req, res, buf) {
  if (jsonDepth(buf) > MAX_JSON_DEPTH) throw Object.assign(new Error('too_deep'), { status: 400, type: 'entity.too.deep' });
}

// Text values lose bidi control characters (ETS-SEC-061); passwords are compared byte for byte, so they are kept.
const KEEP_RAW = new Set(['password', 'current_password', 'new_password']);
const reviver = (k, v) => (typeof v === 'string' && !KEEP_RAW.has(k) ? stripBidi(v) : v);

const parser = limit => express.json({ limit, verify: checkDepth, reviver });
const small = parser(SMALL_LIMIT), large = parser(LARGE_LIMIT), userImport = parser(IMPORT_LIMIT);

function run(p, req, res, next) {
  // Only JSON is accepted as a request body (form posts and text/plain are refused, not silently ignored).
  const len = req.headers['content-length'];
  const hasBody = req.headers['transfer-encoding'] !== undefined || (len !== undefined && len !== '0');
  if (hasBody && !req.is('application/json')) return next(new HttpError(415, 'unsupported_media_type'));
  p(req, res, err => {
    if (err) return next(err);
    if (req.body === undefined) req.body = {};
    next();
  });
}

// Global parser of the /api router.
export const jsonBody = (req, res, next) => (isLargeRoute(req) ? next() : run(small, req, res, next));
// Route-level parser for the routes listed in LARGE_ROUTES; place it after requireAuth/requirePerm.
export const largeJson = (req, res, next) => run(large, req, res, next);
// Route-level parser of POST /users/import and /users/import/preview; place it after requireAdmin.
export const userImportJson = (req, res, next) => run(userImport, req, res, next);

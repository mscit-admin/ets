// All system logging. Every event is written twice:
//   1. to the database (queryable from the Logs screen), and
//   2. to JSON-lines files under LOG_DIR (app.log, error.log, access.log), rotated by logrotate.
// audit_log and auth_log are append-only hash chains (migration 012, services/logchain.js).
// A change and its audit row commit together: pass `db` (the transaction's client) to logAudit/logAuth, or
// leave logAudit strict (the default: a failed write fails the request). Only pure events that must never
// change the outcome of a request (failed sign-ins, denials, reads, system events) are written "soft":
// a failed DB write is then counted (logWriteFailures, shown in Logs → statistics) and reported to the file
// with alert:true, never swallowed silently (ETS-SEC-049).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import pino from 'pino';
import { config } from '../config.js';
import { query } from '../db/pool.js';

fs.mkdirSync(config.logs.dir, { recursive: true });
const dest = name => pino.destination({ dest: path.join(config.logs.dir, name), mkdir: true, sync: true });

export const logger = pino({ level: config.logs.level, base: { app: 'ets' } }, pino.multistream([
  { level: config.logs.level, stream: process.stdout },
  { level: 'info', stream: dest('app.log') },
  { level: 'error', stream: dest('error.log') },
]));
const accessFile = pino({ base: null }, dest('access.log'));

let failures = 0;
export const logWriteFailures = () => failures;
// db: write inside the caller's transaction (throws, rolls back with it); strict: throw on failure; else soft.
function write(sql, params, { db = null, strict = false } = {}) {
  if (db) return db.query(sql, params);
  if (strict) return query(sql, params);
  return query(sql, params).catch(e => {
    failures++;
    logger.error({ alert: true, err: e.message, failures }, 'log write to db failed');
  });
}

// Lengths of values a client chooses (ETS-SEC-077).
const MAX_UA = 300, MAX_PATH = 300;
const reqMeta = req => ({
  ip: req?.ip || null,
  user_agent: req?.get?.('user-agent')?.slice(0, MAX_UA) || null,
});

// A name typed at sign-in that is not a known account is never stored as typed: it may be a password typed
// into the wrong field (ETS-SEC-051). Stored instead: "?" + first character (only when it looks like a
// username) + "***#" + 12 hex of HMAC-SHA-256 (key derived from APP_SECRET), so repeated attempts with the
// same name can still be grouped without revealing it.
let key = null;
const maskKey = () => (key ||= Buffer.from(crypto.hkdfSync('sha256', config.appSecret || 'ets', 'ets-app-secret', 'ets-log-username', 32)));
export function maskUsername(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  const h = crypto.createHmac('sha256', maskKey()).update(s).digest('hex').slice(0, 12);
  return '?' + (/^[a-z0-9._-]{3,60}$/.test(s) ? s[0] : '') + '***#' + h;
}

// Events worth a look straight away: written to the file log at level warn with alert:true, so a journald /
// syslog forwarder or SIEM rule can pick them out (ETS-SEC-075).
export const ALERT_EVENTS = new Set(['account_locked', 'mfa_policy_changed', 'mfa_exempted_by_admin', 'mfa_reset_by_admin',
  'password_reset_by_admin', 'sessions_revoked_by_admin', 'csrf_rejected', 'admin_created_cli', 'mfa_reset_cli']);

// Who ran a command-line script, for the audit rows it writes: "cli:<operating-system user>".
export function cliActor() {
  let name;
  try { name = os.userInfo().username; } catch { name = process.env.USER || 'unknown'; }
  return { id: null, username: 'cli:' + String(name).slice(0, 60) };
}

// Sign-in and security events. db / strict: see write(). Soft by default.
export function logAuth(req, { userId = null, username = null, event, success, detail = null, db = null, strict = false }) {
  const m = reqMeta(req);
  const alert = ALERT_EVENTS.has(event) || undefined;
  logger[alert ? 'warn' : 'info']({ kind: 'auth', alert, event, success, userId, username, ip: m.ip, detail }, 'auth');
  return write(`INSERT INTO auth_log(user_id,username,event,success,ip,user_agent,detail)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [userId, username, event, success, m.ip, m.user_agent, detail && JSON.stringify(detail)], { db, strict });
}

// actor: the person the change is attributed to when it is not req.user (e.g. the employee whose edit
// request a team lead approved); actorIp: that person's own IP (stored with the request), never the IP of
// whoever is signed in now (ETS-SEC-052). context: see migration 007.
// Strict unless soft:true (only for reads such as viewing a record): without `db` a failed write throws.
export function logAudit(req, { action, entity, entityId = null, summary = null, oldValue = null, newValue = null, context = null,
  actor = null, actorIp = null, db = null, soft = false }) {
  const u = actor || req?.user;
  const ip = actor ? actorIp : req?.ip || null;
  logger.info({ kind: 'audit', action, entity, entityId, userId: u?.id, summary }, 'audit');
  const sql = `INSERT INTO audit_log(user_id,username,action,entity,entity_id,summary,old_value,new_value,context,ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  const params = [u?.id || null, u?.username || null, action, entity, entityId == null ? null : String(entityId), summary,
    oldValue === null ? null : JSON.stringify(oldValue), newValue === null ? null : JSON.stringify(newValue),
    context === null ? null : JSON.stringify(context), ip];
  // Inside a transaction the audit row commits/rolls back with the change itself.
  return write(sql, params, { db, strict: !soft });
}

export function logError(req, err, context = null) {
  logger.error({ kind: 'error', err: err?.message, stack: err?.stack, path: req?.originalUrl, userId: req?.user?.id }, 'error');
  return write(`INSERT INTO error_log(user_id,level,message,stack,method,path,context) VALUES ($1,'error',$2,$3,$4,$5,$6)`,
    [req?.user?.id || null, String(err?.message || err).slice(0, 2000), err?.stack || null,
      req?.method || null, req?.originalUrl?.slice(0, 500) || null, context && JSON.stringify(context)]);
}

export function logSystem(event, message = null, detail = null, level = 'info') {
  logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ kind: 'system', event, detail }, message || event);
  return write('INSERT INTO system_log(level,event,message,detail) VALUES ($1,$2,$3,$4)',
    [level, event, message, detail && JSON.stringify(detail)]);
}

// Anonymous 404 / 429 answers go to the file only: anyone could otherwise fill the table (ETS-SEC-077).
export function logAccess(req, res, ms) {
  const m = reqMeta(req);
  const rec = { method: req.method, path: req.originalUrl.slice(0, MAX_PATH), status: res.statusCode, ms, ip: m.ip, userId: req.user?.id || null };
  accessFile.info(rec);
  // presence reports (1.11.0, every minute per open tab) go to the file only: user_presence already holds them
  if (!config.logs.accessToDb || res.locals?.accessFileOnly) return;
  if (!rec.userId && (rec.status === 404 || rec.status === 429)) return;
  return write(`INSERT INTO access_log(user_id,method,path,status,duration_ms,ip,user_agent)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [rec.userId, rec.method, rec.path, rec.status, ms, m.ip, m.user_agent]);
}

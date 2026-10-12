// All system logging. Every event is written twice:
//   1. to the database (queryable from the Logs screen), and
//   2. to JSON-lines files under LOG_DIR (app.log, error.log, access.log), rotated by logrotate.
// Writing a log must never break a request, so DB failures are reported to the file only.
import fs from 'node:fs';
import path from 'node:path';
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

const dbWrite = (sql, params) => query(sql, params).catch(e => logger.error({ err: e.message }, 'log write to db failed'));

const reqMeta = req => ({
  ip: req?.ip || null,
  user_agent: req?.get?.('user-agent')?.slice(0, 500) || null,
});

export function logAuth(req, { userId = null, username = null, event, success, detail = null }) {
  const m = reqMeta(req);
  logger.info({ kind: 'auth', event, success, userId, username, ip: m.ip, detail }, 'auth');
  return dbWrite(`INSERT INTO auth_log(user_id,username,event,success,ip,user_agent,detail)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [userId, username, event, success, m.ip, m.user_agent, detail && JSON.stringify(detail)]);
}

export function logAudit(req, { action, entity, entityId = null, summary = null, oldValue = null, newValue = null, db = null }) {
  const u = req?.user;
  logger.info({ kind: 'audit', action, entity, entityId, userId: u?.id, summary }, 'audit');
  const sql = `INSERT INTO audit_log(user_id,username,action,entity,entity_id,summary,old_value,new_value,ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  const params = [u?.id || null, u?.username || null, action, entity, entityId == null ? null : String(entityId), summary,
    oldValue === null ? null : JSON.stringify(oldValue), newValue === null ? null : JSON.stringify(newValue), req?.ip || null];
  // Inside a transaction the audit row commits/rolls back with the change itself.
  return db ? db.query(sql, params) : dbWrite(sql, params);
}

export function logError(req, err, context = null) {
  logger.error({ kind: 'error', err: err?.message, stack: err?.stack, path: req?.originalUrl, userId: req?.user?.id }, 'error');
  return dbWrite(`INSERT INTO error_log(user_id,level,message,stack,method,path,context) VALUES ($1,'error',$2,$3,$4,$5,$6)`,
    [req?.user?.id || null, String(err?.message || err).slice(0, 2000), err?.stack || null,
      req?.method || null, req?.originalUrl?.slice(0, 500) || null, context && JSON.stringify(context)]);
}

export function logSystem(event, message = null, detail = null, level = 'info') {
  logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ kind: 'system', event, detail }, message || event);
  return dbWrite('INSERT INTO system_log(level,event,message,detail) VALUES ($1,$2,$3,$4)',
    [level, event, message, detail && JSON.stringify(detail)]);
}

export function logAccess(req, res, ms) {
  const m = reqMeta(req);
  const rec = { method: req.method, path: req.originalUrl.slice(0, 500), status: res.statusCode, ms, ip: m.ip, userId: req.user?.id || null };
  accessFile.info(rec);
  if (!config.logs.accessToDb) return;
  return dbWrite(`INSERT INTO access_log(user_id,method,path,status,duration_ms,ip,user_agent)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [rec.userId, rec.method, rec.path, rec.status, ms, m.ip, m.user_agent]);
}

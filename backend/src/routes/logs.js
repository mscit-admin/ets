import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requirePerm, canSeeApp, ADMIN_ROLE } from '../middleware/auth.js';
import { logAudit, logWriteFailures } from '../services/logs.js';
import { verifyAll } from '../services/logchain.js';
import { HttpError, bad, str, own, isDate, isId } from '../utils/http.js';
import { csvCell } from '../utils/csv.js';

const r = Router();
r.use(requireAuth, requirePerm('log'));

// Owner decision (ETS-SEC-047): the security logs (sign-in, requests, errors, system) and every IP address /
// device are for system administrators only. Other holders of 'log' see the change history without them.
const isAdmin = user => user.role === ADMIN_ROLE;
const SECURITY_LOGS = new Set(['auth', 'access', 'error', 'system']);
const requireAdminLog = (req, type) => {
  if (SECURITY_LOGS.has(type) && !isAdmin(req.user)) throw new HttpError(403, 'admin_only', { log: type });
};
// Removes IP addresses and user agents from a row (also inside its context, e.g. approver_ip).
const PRIVATE_KEY = /(^|_)(ip|user_agent)$/;
function stripPrivate(v) {
  if (Array.isArray(v)) return v.map(stripPrivate);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !PRIVATE_KEY.test(k)).map(([k, x]) => [k, stripPrivate(x)]));
  }
  return v;
}
const forReader = (user, rows) => (isAdmin(user) ? rows : rows.map(stripPrivate));

// Columns shown and searched for each log type.
const TYPES = {
  auth: { table: 'auth_log', cols: 'l.id, l.ts, l.user_id, l.username, l.event, l.success, host(l.ip) AS ip, l.user_agent, l.detail',
    search: ['l.username', 'l.event', 'host(l.ip)'], event: 'l.event' },
  // Names of the person, function and application, so each row reads as a sentence in the Logs screen.
  audit: { table: 'audit_log',
    cols: `l.id, l.ts, l.user_id, l.username, u.full_name, l.action, l.entity, l.entity_id, l.summary, l.old_value, l.new_value, l.context,
      f.code AS fn_code, f.name_ar AS fn_name_ar, f.name_en AS fn_name_en, a.id AS app_id, a.name_ar AS app_name_ar, a.name_en AS app_name_en,
      host(l.ip) AS ip`,
    search: ['l.username', 'u.full_name', 'l.entity', 'l.entity_id', 'l.summary', 'l.action', 'f.code', 'f.name_ar', 'f.name_en', 'a.name_ar', 'a.name_en'],
    event: 'l.action',
    join: `LEFT JOIN users u ON u.id=l.user_id
      LEFT JOIN functions f ON l.entity='function' AND f.id::text=l.entity_id
      LEFT JOIN applications a ON a.id = COALESCE(f.app_id, CASE WHEN l.entity IN ('application','report') THEN l.entity_id END, l.context->>'app_id')` },
  access: { table: 'access_log', cols: 'l.id, l.ts, l.user_id, u.username, l.method, l.path, l.status, l.duration_ms, host(l.ip) AS ip, l.user_agent',
    search: ['l.path', 'u.username', 'host(l.ip)'], event: 'l.method', join: 'LEFT JOIN users u ON u.id=l.user_id' },
  error: { table: 'error_log', cols: 'l.id, l.ts, l.user_id, u.username, l.level, l.message, l.stack, l.method, l.path, l.context',
    search: ['l.message', 'l.path'], event: 'l.level', join: 'LEFT JOIN users u ON u.id=l.user_id' },
  system: { table: 'system_log', cols: 'l.id, l.ts, l.level, l.event, l.message, l.detail',
    search: ['l.event', 'l.message'], event: 'l.event' },
};

// Users limited to some departments only see the audit trail of their own applications.
async function scopeFilter(user, type, where, params) {
  if (user.fullScope) return;
  if (type !== 'audit') throw new HttpError(403, 'out_of_scope', { log: type });
  const apps = (await query('SELECT id, department_id FROM applications')).rows.filter(a => canSeeApp(user, a)).map(a => a.id);
  params.push(apps);
  const p = '$' + params.length;
  where.push(`((l.entity='function' AND l.entity_id ~ '^[0-9]+$' AND l.entity_id::int IN (SELECT id FROM functions WHERE app_id = ANY(${p})))
    OR (l.entity IN ('application','report') AND l.entity_id = ANY(${p}))
    OR (l.entity='edit_request' AND l.context->>'app_id' = ANY(${p})))`);
}

function buildQuery(t, qs) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (qs.from) add('l.ts >= ?', qs.from);
  if (qs.to) add('l.ts < (?::date + 1)', qs.to);
  if (qs.user_id) {
    if (!/^[0-9]{1,10}$/.test(qs.user_id) || !isId(+qs.user_id)) throw bad('invalid_value', { field: 'user_id' });
    add('l.user_id = ?', +qs.user_id);
  }
  if (qs.event) add(`${t.event} = ?`, str(qs.event, 100));
  if (t.table === 'auth_log' && (qs.success === 'true' || qs.success === 'false')) add('l.success = ?', qs.success === 'true');
  if (t.table === 'access_log' && qs.status) {
    if (!/^[1-5][0-9]{2}$/.test(qs.status)) throw bad('invalid_value', { field: 'status' });
    add('l.status = ?', +qs.status);
  }
  const q = str(qs.q, 200);
  if (q) {
    params.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    where.push('(' + t.search.map(c => `${c} ILIKE $${params.length}`).join(' OR ') + ')');
  }
  return { where, params };
}

const validDate = d => d === undefined || d === '' || isDate(d);
// Deepest page offered; larger values would only make PostgreSQL skip rows for nothing (ETS-SEC-029).
const MAX_PAGE = 100000;

r.get('/stats', async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'admin_only');
  const one = async sql => (await query(sql)).rows[0];
  res.json({ ...await one(`SELECT
    (SELECT count(*)::int FROM auth_log WHERE event='login' AND success AND ts > now()-interval '24 hours') AS logins_24h,
    (SELECT count(*)::int FROM auth_log WHERE NOT success AND ts > now()-interval '24 hours') AS failed_24h,
    (SELECT count(*)::int FROM audit_log WHERE ts > now()-interval '24 hours') AS changes_24h,
    (SELECT count(*)::int FROM error_log WHERE ts > now()-interval '24 hours') AS errors_24h,
    (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at>now() AND mfa_passed) AS active_sessions,
    (SELECT count(*)::int FROM users WHERE locked_until > now()) AS locked_users`), log_write_failures: logWriteFailures() });
});

// Hash-chain verification of the change history and the sign-in log (ETS-SEC-013); administrators only.
r.get('/integrity', async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'admin_only');
  const result = await verifyAll();
  await logAudit(req, { soft: true, action: 'verify', entity: 'log', entityId: 'integrity', summary: result.ok ? 'intact' : 'BROKEN',
    newValue: { ok: result.ok, tables: result.tables.map(t => ({ table: t.table, rows: t.rows, breaks: t.breaks.length })) } });
  res.json(result);
});

// Looking at a security log is recorded once per reader and log type every 15 minutes (ETS-SEC-050):
// enough to see who browsed whose sign-ins, without one row per page or filter change.
const VIEW_EVERY = 15 * 60 * 1000;
const lastView = new Map();
async function recordView(req, type) {
  if (!SECURITY_LOGS.has(type)) return;
  const k = `${req.user.id}:${type}`;
  if (Date.now() - (lastView.get(k) || 0) < VIEW_EVERY) return;
  lastView.set(k, Date.now());
  if (lastView.size > 10000) lastView.clear();
  await logAudit(req, { soft: true, action: 'view', entity: 'log', entityId: type });
}

r.get('/:type', async (req, res) => {
  const t = own(TYPES, req.params.type);
  if (!t) throw bad('unknown_log');
  if (!validDate(req.query.from) || !validDate(req.query.to)) throw bad('invalid_date');
  requireAdminLog(req, req.params.type);
  const { where, params } = buildQuery(t, req.query);
  await scopeFilter(req.user, req.params.type, where, params);
  await recordView(req, req.params.type);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.min(MAX_PAGE, Math.max(1, parseInt(req.query.page, 10) || 1));
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows, count] = await Promise.all([
    query(`SELECT ${t.cols} FROM ${t.table} l ${t.join || ''} ${w} ORDER BY l.ts DESC, l.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    query(`SELECT count(*)::int AS n FROM ${t.table} l ${t.join || ''} ${w}`, params),
  ]);
  const events = (await query(`SELECT DISTINCT ${t.event.replace('l.', '')} AS e FROM ${t.table} ORDER BY 1 LIMIT 200`)).rows.map(x => x.e);
  res.json({ rows: forReader(req.user, rows.rows), total: count.rows[0].n, page, limit, events });
});

r.get('/:type/export', async (req, res) => {
  const t = own(TYPES, req.params.type);
  if (!t) throw bad('unknown_log');
  if (!validDate(req.query.from) || !validDate(req.query.to)) throw bad('invalid_date');
  requireAdminLog(req, req.params.type);
  const { where, params } = buildQuery(t, req.query);
  await scopeFilter(req.user, req.params.type, where, params);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = forReader(req.user, (await query(`SELECT ${t.cols} FROM ${t.table} l ${t.join || ''} ${w} ORDER BY l.ts DESC LIMIT 100000`, params)).rows);
  // strict: the export is refused when its audit row cannot be written (ETS-SEC-049)
  await logAudit(req, { action: 'export', entity: 'log', entityId: req.params.type, summary: `${rows.length} rows` });
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = '﻿' + [cols.join(','), ...rows.map(x => cols.map(c => csvCell(x[c] instanceof Date ? x[c].toISOString() : x[c])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ets-${req.params.type}-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

export default r;

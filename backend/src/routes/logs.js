import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requirePerm, canSeeApp } from '../middleware/auth.js';
import { logAudit } from '../services/logs.js';
import { HttpError, bad, str } from '../utils/http.js';

const r = Router();
r.use(requireAuth, requirePerm('log'));

// Columns shown and searched for each log type.
const TYPES = {
  auth: { table: 'auth_log', cols: 'l.id, l.ts, l.user_id, l.username, l.event, l.success, host(l.ip) AS ip, l.user_agent, l.detail',
    search: ['l.username', 'l.event', 'host(l.ip)'], event: 'l.event' },
  audit: { table: 'audit_log', cols: 'l.id, l.ts, l.user_id, l.username, l.action, l.entity, l.entity_id, l.summary, l.old_value, l.new_value, host(l.ip) AS ip',
    search: ['l.username', 'l.entity', 'l.entity_id', 'l.summary', 'l.action'], event: 'l.action' },
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
    OR (l.entity IN ('application','report') AND l.entity_id = ANY(${p})))`);
}

function buildQuery(t, qs) {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (qs.from) add('l.ts >= ?', qs.from);
  if (qs.to) add('l.ts < (?::date + 1)', qs.to);
  if (qs.user_id) add('l.user_id = ?', parseInt(qs.user_id, 10));
  if (qs.event) add(`${t.event} = ?`, str(qs.event, 100));
  if (t.table === 'auth_log' && (qs.success === 'true' || qs.success === 'false')) add('l.success = ?', qs.success === 'true');
  if (t.table === 'access_log' && qs.status) add('l.status = ?', parseInt(qs.status, 10));
  const q = str(qs.q, 200);
  if (q) {
    params.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    where.push('(' + t.search.map(c => `${c} ILIKE $${params.length}`).join(' OR ') + ')');
  }
  return { where, params };
}

const validDate = d => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);

r.get('/stats', async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  const one = async sql => (await query(sql)).rows[0];
  res.json(await one(`SELECT
    (SELECT count(*)::int FROM auth_log WHERE event='login' AND success AND ts > now()-interval '24 hours') AS logins_24h,
    (SELECT count(*)::int FROM auth_log WHERE NOT success AND ts > now()-interval '24 hours') AS failed_24h,
    (SELECT count(*)::int FROM audit_log WHERE ts > now()-interval '24 hours') AS changes_24h,
    (SELECT count(*)::int FROM error_log WHERE ts > now()-interval '24 hours') AS errors_24h,
    (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at>now() AND mfa_passed) AS active_sessions,
    (SELECT count(*)::int FROM users WHERE locked_until > now()) AS locked_users`));
});

r.get('/:type', async (req, res) => {
  const t = TYPES[req.params.type];
  if (!t) throw bad('unknown_log');
  if (!validDate(req.query.from) || !validDate(req.query.to)) throw bad('invalid_date');
  const { where, params } = buildQuery(t, req.query);
  await scopeFilter(req.user, req.params.type, where, params);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows, count] = await Promise.all([
    query(`SELECT ${t.cols} FROM ${t.table} l ${t.join || ''} ${w} ORDER BY l.ts DESC, l.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    query(`SELECT count(*)::int AS n FROM ${t.table} l ${t.join || ''} ${w}`, params),
  ]);
  const events = (await query(`SELECT DISTINCT ${t.event.replace('l.', '')} AS e FROM ${t.table} ORDER BY 1 LIMIT 200`)).rows.map(x => x.e);
  res.json({ rows: rows.rows, total: count.rows[0].n, page, limit, events });
});

const csvCell = v => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // neutralise spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
};

r.get('/:type/export', async (req, res) => {
  const t = TYPES[req.params.type];
  if (!t) throw bad('unknown_log');
  if (!validDate(req.query.from) || !validDate(req.query.to)) throw bad('invalid_date');
  const { where, params } = buildQuery(t, req.query);
  await scopeFilter(req.user, req.params.type, where, params);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = (await query(`SELECT ${t.cols} FROM ${t.table} l ${t.join || ''} ${w} ORDER BY l.ts DESC LIMIT 100000`, params)).rows;
  await logAudit(req, { action: 'export', entity: 'log', entityId: req.params.type, summary: `${rows.length} rows` });
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = '﻿' + [cols.join(','), ...rows.map(x => cols.map(c => csvCell(x[c] instanceof Date ? x[c].toISOString() : x[c])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ets-${req.params.type}-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

export default r;

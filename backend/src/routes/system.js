import { Router } from 'express';
import fs from 'node:fs';
import { query } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { HttpError } from '../utils/http.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const started = new Date();

export const health = async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok' });   // no version: this endpoint is public (the version is in /api/system/info)
  } catch {
    res.status(503).json({ status: 'db_unavailable' });
  }
};

const r = Router();
r.use(requireAuth, requirePerm('cfg'));

r.get('/info', async (req, res) => {
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  const db = (await query(`SELECT version() AS version, pg_size_pretty(pg_database_size(current_database())) AS size,
      current_database() AS name,
      (SELECT max(version) FROM schema_migrations) AS migration`)).rows[0];
  const counts = (await query(`SELECT
      (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,
      (SELECT count(*)::int FROM functions) AS functions,
      (SELECT count(*)::int FROM audit_log) AS audit_rows,
      (SELECT count(*)::int FROM access_log) AS access_rows,
      (SELECT count(*)::int FROM auth_log) AS auth_rows`)).rows[0];
  res.json({ app_version: pkg.version, node: process.version, started_at: started, uptime_s: Math.round(process.uptime()),
    database: db, counts });
});

export default r;

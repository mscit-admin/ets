import { query } from '../db/pool.js';
import { allSettings } from './settings.js';
import { logSystem } from './logs.js';

// Deletes log rows older than the configured retention (Settings → Logs).
export async function purgeLogs() {
  const s = await allSettings();
  const days = +s['logs.retention_days'] || 365;
  const accessDays = +s['logs.access_retention_days'] || 90;
  const out = {};
  for (const t of ['auth_log', 'audit_log', 'error_log', 'system_log']) {
    out[t] = (await query(`DELETE FROM ${t} WHERE ts < now() - ($1 || ' days')::interval`, [String(days)])).rowCount;
  }
  out.access_log = (await query(`DELETE FROM access_log WHERE ts < now() - ($1 || ' days')::interval`, [String(accessDays)])).rowCount;
  out.sessions = (await query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`)).rowCount;
  await logSystem('log_purge', 'log retention purge', { retention_days: days, access_retention_days: accessDays, deleted: out });
  return out;
}

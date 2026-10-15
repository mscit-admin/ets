import { query, tx } from '../db/pool.js';
import { allSettings } from './settings.js';
import { logAudit, logSystem, logger } from './logs.js';
import { verifyAll, chainHeads } from './logchain.js';

// Deletes log rows older than the configured retention (Settings → Logs) (ETS-SEC-048):
//   - audit_log (change history): logs.audit_retention_days, at least 365 days
//   - auth_log, error_log, system_log: logs.retention_days
//   - access_log: logs.access_retention_days
// audit_log and auth_log are append-only chains: their old rows are removed only through ets_purge_log()
// (migration 012), which refuses rows younger than 365 / 30 days whatever the setting says and leaves an anchor.
// Every purge is itself recorded in the change history (with who ran it and the rows deleted per table), and the
// chains are verified first; the chain heads go to the file log / journald as an outside reference.
// actor: 'system' (daily run of the server) or 'cli:<user>' (npm run purge-logs).
export async function purgeLogs({ actor = 'system' } = {}) {
  const s = await allSettings();
  const days = Math.max(30, +s['logs.retention_days'] || 365);
  const auditDays = Math.max(365, +s['logs.audit_retention_days'] || 365);
  const accessDays = Math.max(7, +s['logs.access_retention_days'] || 90);
  const integrity = await verifyAll();
  if (!integrity.ok) {
    logger.error({ alert: true, kind: 'integrity', tables: integrity.tables.filter(t => !t.ok) }, 'log hash chain broken');
    await logSystem('log_chain_broken', 'audit/auth log hash chain verification failed', integrity, 'error');
  }
  // the plain tables first (no lock on the chains meanwhile), then the two chains with the purge's own audit row
  const out = {};
  for (const t of ['error_log', 'system_log']) {
    out[t] = (await query(`DELETE FROM ${t} WHERE ts < now() - make_interval(days => $1)`, [days])).rowCount;
  }
  out.access_log = (await query('DELETE FROM access_log WHERE ts < now() - make_interval(days => $1)', [accessDays])).rowCount;
  out.sessions = (await query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`)).rowCount;
  await tx(async c => {
    out.audit_log = Number((await c.query('SELECT ets_purge_log($1,$2,$3) AS n', ['audit_log', auditDays, actor])).rows[0].n);
    out.auth_log = Number((await c.query('SELECT ets_purge_log($1,$2,$3) AS n', ['auth_log', days, actor])).rows[0].n);
    // the purge's own record, in the change history (kept at least 365 days) and in the same transaction
    await logAudit(null, { db: c, actor: { id: null, username: actor }, action: 'purge', entity: 'log', summary: 'log retention purge',
      newValue: { deleted: out, retention_days: days, audit_retention_days: auditDays, access_retention_days: accessDays,
        chains_intact_before: integrity.ok } });
  });
  const heads = await chainHeads();
  await logSystem('log_purge', 'log retention purge', { actor, retention_days: days, audit_retention_days: auditDays,
    access_retention_days: accessDays, deleted: out, chain_heads: heads, integrity_ok: integrity.ok });
  return out;
}


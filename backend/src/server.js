import { config, assertConfig } from './config.js';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { logger, logSystem } from './services/logs.js';
import { purgeLogs } from './services/retention.js';
import { takeSnapshot } from './services/snapshots.js';
import { getDummyHash } from './services/passwords.js';
import { assertCookieConfig } from './middleware/auth.js';
import { closeAllStreams } from './services/live.js';

assertConfig();
assertCookieConfig();

// Bring the schema and catalog up to date on every start (both are idempotent).
await migrate({ log: m => logger.info(m) });
await seed({ log: m => logger.info(m) });
// Build the login dummy hash now so the first unknown-username login is not slower than the rest.
await getDummyHash();

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  logger.info(`ETS API listening on http://${config.host}:${config.port} (${config.env})`);
  logSystem('startup', `ETS API started on ${config.host}:${config.port}`, { env: config.env, node: process.version, pid: process.pid });
});

// Daily log retention purge (also available as `npm run purge-logs`).
const day = 24 * 3600 * 1000;
const purge = () => purgeLogs().catch(e => logger.error({ err: e.message }, 'log purge failed'));
setTimeout(purge, 60_000).unref();
setInterval(purge, day).unref();
// Daily progress snapshot (hourly refresh of today's row).
const snap = () => takeSnapshot().catch(e => logger.error({ err: e.message }, 'progress snapshot failed'));
setTimeout(snap, 15_000).unref();
setInterval(snap, 3600_000).unref();
// Remove expired sessions hourly.
setInterval(() => pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`).catch(() => {}), 3600_000).unref();

process.on('unhandledRejection', e => { logger.error({ err: e?.message, stack: e?.stack }, 'unhandledRejection'); });

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  logger.info(`${sig} received, shutting down`);
  await logSystem('shutdown', `ETS API stopping (${sig})`);
  await closeAllStreams();            // live-updates streams would otherwise hold server.close() open
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

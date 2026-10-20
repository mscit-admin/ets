import pg from 'pg';
import { dbPoolConfig } from '../config.js';

// numeric → JS number (values here are percentages/weights, well within double precision)
pg.types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(1231, v => (v === null ? null : pg.types.arrayParser.create(v, parseFloat).parse()));

// date → 'YYYY-MM-DD' as stored (a JS Date would shift by the server's time-zone offset)
pg.types.setTypeParser(1082, v => v);

// TLS settings from PGSSLMODE / PGSSLROOTCERT or the sslmode/ssl parameters of DATABASE_URL (config.js);
// the same effective mode that assertConfig checked, never a parameter left inside the URL.
export const pool = new pg.Pool(dbPoolConfig());

export const query = (text, params) => pool.query(text, params);

// Runs fn(client) inside a transaction. Work registered with onCommit(client, fn) runs after COMMIT (and is
// dropped on ROLLBACK): notifications and live-update hints about the transaction's changes.
export async function tx(fn) {
  const client = await pool.connect();
  const after = [];
  client.etsAfterCommit = after;
  let r;
  try {
    await client.query('BEGIN');
    r = await fn(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.etsAfterCommit = null;
    client.release();
  }
  // after the connection is back in the pool: these tasks use their own queries
  for (const f of after) {
    try { await f(); } catch (e) { afterCommitError(e); }
  }
  return r;
}

// Runs fn after the transaction of client c commits; outside a transaction (c = pool / { query }) right away.
// A failure is reported, never thrown: the change it follows is already saved.
let afterCommitError = e => console.error('after-commit task failed:', e?.message);
export const setAfterCommitErrorHandler = fn => { afterCommitError = fn; };
export function onCommit(c, fn) {
  if (Array.isArray(c?.etsAfterCommit)) { c.etsAfterCommit.push(fn); return; }
  Promise.resolve().then(fn).catch(e => afterCommitError(e));
}

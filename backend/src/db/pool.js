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

// Runs fn(client) inside a transaction.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

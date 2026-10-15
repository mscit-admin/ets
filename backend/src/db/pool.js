import pg from 'pg';
import { config, dbSslOptions } from '../config.js';

// numeric → JS number (values here are percentages/weights, well within double precision)
pg.types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(1231, v => (v === null ? null : pg.types.arrayParser.create(v, parseFloat).parse()));

// date → 'YYYY-MM-DD' as stored (a JS Date would shift by the server's time-zone offset)
pg.types.setTypeParser(1082, v => v);

const c = config.db;
// TLS settings from PGSSLMODE / PGSSLROOTCERT (config.js); an sslmode inside DATABASE_URL still wins.
const ssl = dbSslOptions(c);
export const pool = new pg.Pool(c.connectionString
  ? { connectionString: c.connectionString, max: c.max, ssl }
  : { host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, max: c.max, ssl });

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

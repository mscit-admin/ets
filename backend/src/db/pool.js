import pg from 'pg';
import { config } from '../config.js';

// numeric → JS number (values here are percentages/weights, well within double precision)
pg.types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(1231, v => (v === null ? null : pg.types.arrayParser.create(v, parseFloat).parse()));

const c = config.db;
export const pool = new pg.Pool(c.connectionString
  ? { connectionString: c.connectionString, max: c.max }
  : { host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, max: c.max });

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

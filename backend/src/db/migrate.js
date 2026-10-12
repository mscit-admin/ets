// Applies pending SQL migrations from ./migrations in filename order.
// Each file runs in its own transaction and is recorded in schema_migrations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [f]);
        await client.query(`INSERT INTO system_log(event, message) VALUES ('migration', $1)`, [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${e.message}`);
      }
    }
    if (!applied.length) log('database is up to date');
    return applied;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch(e => { console.error(e.message); process.exit(1); });
}

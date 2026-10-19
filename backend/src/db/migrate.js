// Applies pending SQL migrations from ./migrations in filename order.
// Each file runs in its own transaction and is recorded in schema_migrations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  // A migration's own notices ("ETS: …", e.g. 014 skipping an index on existing data) are shown to whoever runs it;
  // PostgreSQL's "already exists, skipping" notices are not.
  const onNotice = n => { if (String(n.message).startsWith('ETS:')) log(`notice: ${n.message}`); };
  client.on('notice', onNotice);
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
    // The unique e-mail index of migration 014 is skipped while several accounts share an address; every later run
    // creates it once the duplicates are gone (a no-op when it exists).
    if (!applied.includes('014_login_email.sql') &&
        (await client.query(`SELECT to_regprocedure('ets_ensure_email_unique_index()') IS NOT NULL AS ok`)).rows[0].ok) {
      const made = (await client.query(`SELECT to_regclass('users_email_lower_uniq') IS NULL AS missing`)).rows[0].missing &&
        (await client.query('SELECT ets_ensure_email_unique_index() AS ok')).rows[0].ok;
      if (made) log('created the unique e-mail index (users_email_lower_uniq)');
    }
    return applied;
  } finally {
    client.off('notice', onNotice);
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch(e => { console.error(e.message); process.exit(1); });
}

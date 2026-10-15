#!/usr/bin/env node
// Verifies the hash chains of the change history (audit_log) and the sign-in log (auth_log) (ETS-SEC-013).
//   npm run verify-audit            → report; exit code 0 = intact, 2 = broken
//   npm run verify-audit -- --json  → the full report as JSON
// Also prints the head (last seq + hash) of each chain: keep it outside the server (ticket, mail, paper) and
// compare it later with the head of that day in the file log / journald ("log_purge" entries).
import { pool } from '../src/db/pool.js';
import { verifyAll } from '../src/services/logchain.js';
import { logSystem } from '../src/services/logs.js';

const r = await verifyAll();
if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
else {
  for (const t of r.tables) {
    console.log(`${t.table}: ${t.ok ? 'OK' : 'BROKEN'} — ${t.rows} rows (seq ${t.first_seq ?? '-'}…${t.last_seq ?? '-'}), ` +
      `${t.purges} retention purge(s), head ${t.head.seq}:${t.head.hash}`);
    for (const b of t.breaks) console.log('  ' + JSON.stringify(b));
  }
}
await logSystem('log_chain_verified', `audit/auth log chains ${r.ok ? 'intact' : 'BROKEN'} (CLI)`,
  { ok: r.ok, tables: r.tables.map(t => ({ table: t.table, ok: t.ok, rows: t.rows, head: t.head, breaks: t.breaks.length })) },
  r.ok ? 'info' : 'error');
await pool.end();
process.exit(r.ok ? 0 : 2);

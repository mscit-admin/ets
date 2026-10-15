#!/usr/bin/env node
// Applies the log retention policy now (the server also does this daily). The purge is recorded in the
// change history in the name of "cli:<operating-system user>".
// When the audit/auth hash chains do not verify, nothing is deleted and the script exits with status 2 (see
// docs/handover/07). After investigating, an administrator may run it with --acknowledge-broken-chain: the
// acknowledgement (who, which tables) is recorded in the change history, then the purge runs.
import { pool } from '../src/db/pool.js';
import { purgeLogs } from '../src/services/retention.js';
import { cliActor } from '../src/services/logs.js';

const args = process.argv.slice(2);
const unknown = args.filter(a => a !== '--acknowledge-broken-chain');
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(' ')}\nUsage: npm run purge-logs [-- --acknowledge-broken-chain]`);
  process.exit(64);
}
const out = await purgeLogs({ actor: cliActor().username, acknowledgeBrokenChain: args.includes('--acknowledge-broken-chain') });
await pool.end();
if (out.skipped) {
  console.error(`Purge skipped, nothing deleted: the hash chain of ${out.tables.join(', ')} is broken.\n` +
    'Check it with `npm run verify-audit`; after investigating, run `npm run purge-logs -- --acknowledge-broken-chain`.');
  process.exit(2);
}
console.log('Deleted rows:', out);

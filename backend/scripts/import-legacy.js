#!/usr/bin/env node
// Imports progress data from the original tracker page — either its JSON export
// or a standalone HTML copy (window.__SAVED) — into the database.
//   npm run import-legacy -- ../reference/erp-tracker-original.html
import fs from 'node:fs';
import { pool, tx } from '../src/db/pool.js';
import { parseLegacy, applyLegacy } from '../src/services/legacy.js';
import { logSystem } from '../src/services/logs.js';

const file = process.argv[2];
if (!file) { console.error('usage: npm run import-legacy -- <file.html|file.json>'); process.exit(1); }
const payload = parseLegacy(fs.readFileSync(file, 'utf8'));
let counts;
try { counts = await tx(c => applyLegacy(c, payload, null)); }
catch (e) {
  // «نجح» needs 100 % (1.8.1): nothing is imported while a row of the file breaks it
  if (e.code === 'import_has_row_errors') {
    console.error(`Nothing imported: ${e.extra.count} row(s) set «نجح» (pass) below 100 % or lower a passed item below 100 %: ${e.extra.list}`);
    await pool.end();
    process.exit(1);
  }
  throw e;
}
await logSystem('import', `legacy data imported from CLI: ${file}`, counts);
console.log('Imported:', counts);
await pool.end();

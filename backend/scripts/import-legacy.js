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
const counts = await tx(c => applyLegacy(c, payload, null));
await logSystem('import', `legacy data imported from CLI: ${file}`, counts);
console.log('Imported:', counts);
await pool.end();

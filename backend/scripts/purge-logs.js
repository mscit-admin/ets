#!/usr/bin/env node
// Applies the log retention policy now (the server also does this daily).
import { pool } from '../src/db/pool.js';
import { purgeLogs } from '../src/services/retention.js';

console.log('Deleted rows:', await purgeLogs());
await pool.end();

#!/usr/bin/env node
// Applies the log retention policy now (the server also does this daily). The purge is recorded in the
// change history in the name of "cli:<operating-system user>".
import { pool } from '../src/db/pool.js';
import { purgeLogs } from '../src/services/retention.js';
import { cliActor } from '../src/services/logs.js';

console.log('Deleted rows:', await purgeLogs({ actor: cliActor().username }));
await pool.end();

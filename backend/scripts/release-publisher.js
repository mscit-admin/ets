#!/usr/bin/env node
// ETS release publisher (1.12.19, PHASE 2) — runs as ROOT on the TEST server (ets-release-publisher.service, started
// every 60 s by ets-release-publisher.timer and at once by ets-release-publisher.path when the API touches
// /var/lib/ets/inbox/.release-wake). Installed as /usr/local/sbin/ets-release-publisher. The web application never
// runs this: it only records a signed promotion INTENT (backend/src/routes/release.js); this program re-reads the
// row, re-verifies the signature, creates/pushes the signed tag, pushes the signed manifest, and pulls the status
// back. See backend/src/release/publisher.js.
//   ets-release-publisher [run]
import { pool } from '../src/db/pool.js';
import { cycle } from '../src/release/publisher.js';

const cmd = process.argv[2] || 'run';
try {
  if (cmd === 'run') console.log(JSON.stringify(await cycle()));
  else { console.error('usage: ets-release-publisher [run]'); process.exitCode = 2; }
} catch (e) {
  console.error('ets-release-publisher:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

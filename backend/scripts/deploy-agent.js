#!/usr/bin/env node
// ETS deploy agent (1.12.19, PHASE 2) — runs as ROOT on the PRODUCTION server (ets-deploy-agent.service, started
// every 30 s by ets-deploy-agent.timer and at once by ets-deploy-agent.path when the repo working copy's signal file
// changes after a fetch). Installed by the operator as /usr/local/sbin/ets-deploy-agent. It PULLS the signed signal
// from git, verifies it (all §3.1 checks, including the real ancestor check), backs up, checks out, runs update.sh,
// health-gates and writes/signs/pushes the status back. See backend/src/release/deploy-agent.js.
//   ets-deploy-agent [run|dry-run]     dry-run verifies the signal but does not deploy
import { pool } from '../src/db/pool.js';
import { cycle } from '../src/release/deploy-agent.js';

const cmd = process.argv[2] || 'run';
try {
  if (cmd === 'run') console.log(JSON.stringify(await cycle()));
  else if (cmd === 'dry-run' || cmd === '--dry-run') console.log(JSON.stringify(await cycle({ dryRun: true })));
  else { console.error('usage: ets-deploy-agent [run|dry-run]'); process.exitCode = 2; }
} catch (e) {
  console.error('ets-deploy-agent:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

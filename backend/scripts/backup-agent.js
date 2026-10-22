#!/usr/bin/env node
// ETS backup agent (1.12.0) — runs as ROOT (ets-backup-agent.service, started every 30 s by ets-backup-agent.timer and
// at once by ets-backup-agent.path when the API queues a job). Installed as /usr/local/sbin/ets-backup-agent.
//   ets-backup-agent [run]     one cycle: import (once), apply the configuration, run queued jobs, write the status
//   ets-backup-agent import    only the one-time import of /etc/ets/backup.conf into the database (update.sh)
//   ets-backup-agent apply     only render /etc/ets/backup.conf, rclone.conf and the timer schedules
// The web application never runs this: it only writes the desired configuration and jobs into the database
// (backend/src/routes/backups.js); this program validates both again (backend/src/backup/config.js).
import { pool } from '../src/db/pool.js';
import { cycle, importOnce, applyConfig } from '../src/backup/agent.js';

const cmd = process.argv[2] || 'run';
try {
  if (cmd === 'run') console.log(JSON.stringify(await cycle()));
  else if (cmd === 'import') { await importOnce(); console.log(JSON.stringify(await applyConfig())); }
  else if (cmd === 'apply') console.log(JSON.stringify(await applyConfig()));
  else { console.error('usage: ets-backup-agent [run|import|apply]'); process.exitCode = 2; }
} catch (e) {
  console.error('ets-backup-agent:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

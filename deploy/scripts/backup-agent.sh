#!/usr/bin/env bash
# ETS backup agent (installed as /usr/local/sbin/ets-backup-agent; run by ets-backup-agent.service as root).
#   ets-backup-agent [run|import|apply]      see backend/scripts/backup-agent.js
set -euo pipefail
umask 077
export ETS_ENV_FILE=${ETS_ENV_FILE:-/etc/ets/ets.env}
APP=${ETS_APP_DIR:-/opt/ets}
cd "$APP/backend"
exec node "$APP/backend/scripts/backup-agent.js" "$@"

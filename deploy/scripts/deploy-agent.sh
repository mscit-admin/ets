#!/usr/bin/env bash
# ETS deploy agent (installed as /usr/local/sbin/ets-deploy-agent; run by ets-deploy-agent.service as root on the
# PRODUCTION server). See backend/scripts/deploy-agent.js and backend/src/release/deploy-agent.js.
#   ets-deploy-agent [run|dry-run]
set -euo pipefail
umask 077
export ETS_ENV_FILE=${ETS_ENV_FILE:-/etc/ets/ets.env}
APP=${ETS_APP_DIR:-/opt/ets}
cd "$APP/backend"
exec node "$APP/backend/scripts/deploy-agent.js" "$@"

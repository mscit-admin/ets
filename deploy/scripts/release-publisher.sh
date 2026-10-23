#!/usr/bin/env bash
# ETS release publisher (installed as /usr/local/sbin/ets-release-publisher; run by ets-release-publisher.service as
# root on the TEST server). See backend/scripts/release-publisher.js and backend/src/release/publisher.js.
#   ets-release-publisher [run]
set -euo pipefail
umask 077
export ETS_ENV_FILE=${ETS_ENV_FILE:-/etc/ets/ets.env}
APP=${ETS_APP_DIR:-/opt/ets}
cd "$APP/backend"
exec node "$APP/backend/scripts/release-publisher.js" "$@"

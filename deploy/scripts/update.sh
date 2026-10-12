#!/usr/bin/env bash
# Update an installed ETS to the version in this repository copy.
#   cd /path/to/new/ets && sudo bash deploy/scripts/update.sh
# Takes a backup first, then copies, installs, migrates and restarts.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP=/opt/ets
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
/usr/local/bin/ets-backup
rsync -a --delete --exclude node_modules --exclude .git --exclude 'backend/.env' --exclude 'backend/logs*' --exclude 'frontend/dist' "$SRC/" "$APP/"
cd "$APP/backend" && npm ci --omit=dev --no-audit --no-fund
cd "$APP/frontend" && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules
chown -R root:root "$APP"; chmod -R a+rX "$APP"
# migrations run automatically when the service starts
systemctl restart ets-backend
sleep 3
curl -fsS http://127.0.0.1:3000/api/health && echo && echo "update ok"

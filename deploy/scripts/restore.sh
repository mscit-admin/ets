#!/usr/bin/env bash
# ETS database restore (installed as /usr/local/bin/ets-restore).
#   sudo ets-restore /var/backups/ets/ets-20261012-0130.dump
# Stops the service, replaces the database with the dump, starts the service.
set -euo pipefail
F="${1:-}"
[[ -f "$F" ]] || { echo "usage: ets-restore <file.dump>"; ls -1t /var/backups/ets/*.dump 2>/dev/null | head; exit 1; }
DB="${PGDATABASE:-ets}"
read -rp "This REPLACES database '$DB' with $F. Type YES to continue: " ok
[[ "$ok" == "YES" ]] || exit 1
systemctl stop ets-backend
sudo -u postgres pg_restore --clean --if-exists --no-owner --role=ets -d "$DB" "$F"
systemctl start ets-backend
sudo -u postgres psql -d "$DB" -qc "INSERT INTO system_log(event,message,detail) VALUES ('restore','database restored from backup', jsonb_build_object('file','$F'))" || true
echo "Restore finished. Check: systemctl status ets-backend"

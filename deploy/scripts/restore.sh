#!/usr/bin/env bash
# ETS database restore (installed as /usr/local/bin/ets-restore).
#   sudo ets-restore /var/backups/ets/ets-20261012-0130.dump
# Stops the service, replaces the database content with the dump, starts the service.
set -euo pipefail
ENVF="${ETS_ENV_FILE:-/etc/ets/ets.env}"
set -a; . "$ENVF"; set +a
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
F="${1:-}"
[[ -f "$F" ]] || { echo "usage: ets-restore <file.dump>"; ls -1t "${ETS_BACKUP_DIR:-/var/backups/ets}"/*.dump 2>/dev/null | head; exit 1; }
read -rp "This REPLACES all data in database '$PGDATABASE' on $PGHOST with $F. Type YES to continue: " ok
[[ "$ok" == "YES" ]] || exit 1
systemctl stop ets-backend
if [[ "$PGHOST" == "127.0.0.1" || "$PGHOST" == "localhost" ]] && id postgres >/dev/null 2>&1; then
  # local server: restore as the postgres superuser, objects owned by the application role
  sudo -u postgres pg_restore -p "$PGPORT" --clean --if-exists --no-owner --role="$PGUSER" -d "$PGDATABASE" "$F"
else
  # remote server: restore with the application credentials (extension ownership warnings are harmless)
  pg_restore --clean --if-exists --no-owner -d "$PGDATABASE" "$F" || echo "pg_restore reported warnings (see above)"
fi
systemctl start ets-backend
psql -qc "INSERT INTO system_log(event,message,detail) VALUES ('restore','database restored from backup', jsonb_build_object('file','$F'))" >/dev/null || true
echo "Restore finished. Check: systemctl status ets-backend"

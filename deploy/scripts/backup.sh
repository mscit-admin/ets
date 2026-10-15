#!/usr/bin/env bash
# ETS database backup (installed as /usr/local/bin/ets-backup; runs daily from /etc/cron.d/ets-backup).
# Uses the database settings in /etc/ets/ets.env, so it works with any DB name/user and a remote server.
# Produces <dir>/ets-YYYYmmdd-HHMM.dump (pg_dump custom format) and keeps ETS_BACKUP_KEEP_DAYS days.
set -euo pipefail
ENVF="${ETS_ENV_FILE:-/etc/ets/ets.env}"
set -a; . "$ENVF"; set +a
DIR="${ETS_BACKUP_DIR:-/var/backups/ets}"
KEEP_DAYS="${ETS_BACKUP_KEEP_DAYS:-30}"
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
mkdir -p "$DIR"
F="$DIR/ets-$(date +%Y%m%d-%H%M).dump"
pg_dump --format=custom --compress=9 --file="$F.part"
mv "$F.part" "$F"
chmod 640 "$F"
# keep the configuration with the dumps (APP_SECRET is needed to read 2FA keys after a restore)
cp "$ENVF" "$DIR/ets.env.backup" && chmod 600 "$DIR/ets.env.backup"
find "$DIR" -name 'ets-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $F ($(du -h "$F" | cut -f1))"
psql -qc "INSERT INTO system_log(event,message,detail) VALUES ('backup','database backup created', jsonb_build_object('file','$F'))" >/dev/null || true

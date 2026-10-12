#!/usr/bin/env bash
# ETS database backup (installed as /usr/local/bin/ets-backup; runs daily from /etc/cron.d/ets-backup).
# Produces /var/backups/ets/ets-YYYYmmdd-HHMM.dump (pg_dump custom format) and keeps KEEP_DAYS days.
set -euo pipefail
DIR="${ETS_BACKUP_DIR:-/var/backups/ets}"
KEEP_DAYS="${ETS_BACKUP_KEEP_DAYS:-30}"
DB="${PGDATABASE:-ets}"
mkdir -p "$DIR"
F="$DIR/ets-$(date +%Y%m%d-%H%M).dump"
sudo -u postgres pg_dump --format=custom --compress=9 --file="$F.part" "$DB"
mv "$F.part" "$F"
chmod 640 "$F"
# keep the configuration (APP_SECRET is needed to read 2FA keys after a restore)
cp /etc/ets/ets.env "$DIR/ets.env.backup" 2>/dev/null && chmod 600 "$DIR/ets.env.backup" || true
find "$DIR" -name 'ets-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $F ($(du -h "$F" | cut -f1))"
sudo -u postgres psql -d "$DB" -qc "INSERT INTO system_log(event,message,detail) VALUES ('backup','database backup created', jsonb_build_object('file','$F'))" || true

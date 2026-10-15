#!/usr/bin/env bash
# ETS database backup (installed as /usr/local/bin/ets-backup; runs daily from /etc/cron.d/ets-backup,
# output in /var/log/ets-backup.log).
# Uses the database settings in /etc/ets/ets.env, so it works with any DB name/user and a remote server
# (over TLS: PGSSLMODE / PGSSLROOTCERT from ets.env, "require" by default for a remote host).
# Produces <dir>/ets-YYYYmmdd-HHMMSS.dump.gpg — a pg_dump custom-format dump encrypted with gpg (AES-256,
# tamper-evident) using the backup key /etc/ets/backup.key — and <file>.sha256; keeps ETS_BACKUP_KEEP_DAYS days.
# Neither the backup key nor ets.env (APP_SECRET, DB password) is stored with the dumps: keep copies of
# both in a separate safe place (docs/handover/08-Backup-and-Recovery.md).
set -euo pipefail
umask 077
ENVF="${ETS_ENV_FILE:-/etc/ets/ets.env}"
[[ -r "$ENVF" ]] || { echo "cannot read $ENVF" >&2; exit 1; }
# KEY=value from the env file, read without executing it
env_get() { local v; v=$(sed -n "s/^$1=//p" "$ENVF" | tail -n 1); v=${v%\'}; v=${v#\'}; v=${v%\"}; v=${v#\"}; printf '%s' "$v"; }
for k in PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do
  v=$(env_get "$k"); if [[ -n "$v" ]]; then export "$k=$v"; fi
done
case "${PGHOST:-}" in ''|127.0.0.1|localhost|::1|/*) ;; *) export PGSSLMODE="${PGSSLMODE:-require}" ;; esac
PW=$(env_get PGPASSWORD)
DIR=$(env_get ETS_BACKUP_DIR); DIR=${DIR:-/var/backups/ets}
KEEP_DAYS=$(env_get ETS_BACKUP_KEEP_DAYS); KEEP_DAYS=${KEEP_DAYS:-30}
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || { echo "ETS_BACKUP_KEEP_DAYS must be a number" >&2; exit 1; }
KEY=${ETS_BACKUP_KEY:-$(env_get ETS_BACKUP_KEY)}; KEY=${KEY:-/etc/ets/backup.key}
[[ -s "$KEY" && -r "$KEY" ]] || { echo "backup key $KEY is missing — create it with: sudo bash deploy/scripts/update.sh (or: (umask 077; openssl rand -base64 48 > $KEY))" >&2; exit 1; }

mkdir -p "$DIR"
GNUPGHOME=$(mktemp -d); export GNUPGHOME
F="$DIR/ets-$(date +%Y%m%d-%H%M%S).dump.gpg"
[[ ! -e "$F" ]] || { echo "$F already exists" >&2; exit 1; }   # never overwrite an earlier backup
trap 'rm -rf "$GNUPGHOME"; rm -f "$F.part"' EXIT
encrypt() {   # stdin → $1
  gpg --batch --quiet --yes --pinentry-mode loopback --passphrase-file "$KEY" \
    --symmetric --cipher-algo AES256 --compress-algo none --output "$1"
}

PGPASSWORD="$PW" pg_dump --format=custom --compress=9 | encrypt "$F.part"
mv "$F.part" "$F"
( cd "$DIR" && sha256sum "$(basename "$F")" >"$(basename "$F").sha256" )

# Older versions left an unencrypted copy of ets.env and plain dumps here: remove / encrypt them.
if [[ -e "$DIR/ets.env.backup" ]]; then shred -u "$DIR/ets.env.backup" 2>/dev/null || rm -f "$DIR/ets.env.backup"; fi
while IFS= read -r -d '' old; do
  encrypt "$old.gpg" <"$old"
  ( cd "$DIR" && sha256sum "$(basename "$old").gpg" >"$(basename "$old").gpg.sha256" )
  touch -r "$old" "$old.gpg" "$old.gpg.sha256"   # keeps its age for the retention below
  shred -u "$old" 2>/dev/null || rm -f "$old"
  echo "encrypted older backup $old.gpg"
done < <(find "$DIR" -maxdepth 1 -name 'ets-*.dump' -type f -print0)

find "$DIR" -maxdepth 1 -name 'ets-*.dump.gpg*' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $F ($(du -h "$F" | cut -f1))"
PGPASSWORD="$PW" psql -X -q -v ON_ERROR_STOP=1 -v f="$F" >/dev/null <<'SQL' || echo "warning: could not record the backup in system_log" >&2
INSERT INTO system_log(event,message,detail) VALUES ('backup','database backup created', jsonb_build_object('file', :'f'));
SQL

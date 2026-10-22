#!/usr/bin/env bash
# ETS database restore from the command line (installed as /usr/local/bin/ets-restore). Since 1.12.0 a restore is
# normally started from Settings → «النسخ الاحتياطي» → «استرجاع من نسخة» (password, 2FA code and backup key); this
# command is the fallback when the web UI is not available.
#
#   sudo ets-restore /var/backups/ets/ets-20261012-013000.dump.gpg
#   sudo ets-restore --yes --key /root/old-backup.key FILE      non-interactive, with another key / passphrase
#     --yes                 do not ask for YES (scripts, ets-restore-server)
#     --key FILE            key / passphrase that encrypted FILE (default /etc/ets/backup.key)
#     --no-safety-backup    skip the backup of the current data (a fresh installation with nothing to keep)
#
# 1. checks the file: checksum (<file>.sha256), decryption, archive contents — nothing is changed yet;
# 2. takes a fresh backup of the current data (ets-backup --no-offsite);
# 3. stops the service, restores in ONE transaction (all or nothing), revokes every session;
# 4. applies the migrations of the installed version (a backup of an older version is brought up to date);
# 5. checks the audit chains (npm run verify-audit), starts the service.
# The log tables are owned by a separate role (ETS-SEC-013), so the application role cannot replace them: when
# the PostgreSQL superuser is reachable (local database, or a DBA connection in ETS_SU_CONNINFO) the restore runs
# through ets-log-protect, which restores as the application role inside a superuser transaction and protects
# the audit trail again before COMMIT. Without it a protected database is not touched (instructions are printed).
set -euo pipefail
umask 077
CONF_DIR=${ETS_CONF_DIR:-/etc/ets}
ENVF="${ETS_ENV_FILE:-$CONF_DIR/ets.env}"
APP=${ETS_APP_DIR:-/opt/ets}
SYSTEMCTL=${ETS_SYSTEMCTL:-systemctl}
LOCK=${ETS_BACKUP_LOCK:-/run/lock/ets-backup.lock}
[[ -r "$ENVF" ]] || { echo "cannot read $ENVF" >&2; exit 1; }
env_get() { local v; v=$(sed -n "s/^$1=//p" "$ENVF" | tail -n 1); v=${v%\'}; v=${v#\'}; v=${v%\"}; v=${v#\"}; printf '%s' "$v"; }
for k in PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do
  v=$(env_get "$k"); if [[ -n "$v" ]]; then export "$k=$v"; fi
done
case "${PGHOST:-}" in ''|127.0.0.1|localhost|::1|/*) ;; *) export PGSSLMODE="${PGSSLMODE:-require}" ;; esac
PW=$(env_get PGPASSWORD)
DIR=${ETS_BACKUP_DIR:-$(env_get ETS_BACKUP_DIR)}; DIR=${DIR:-/var/backups/ets}
KEY=${ETS_BACKUP_KEY:-$(env_get ETS_BACKUP_KEY)}; KEY=${KEY:-$CONF_DIR/backup.key}
SERVICE=${ETS_SERVICE:-ets-backend}
fail() { echo "xx  $*" >&2; exit 1; }

YES=0 SAFETY=1 F=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --key) shift; KEY=${1:-}; [[ -r "$KEY" ]] || fail "cannot read the key file ${KEY:-?}" ;;
    --no-safety-backup) SAFETY=0 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) fail "unknown option $1 (see --help)" ;;
    *) F=$1 ;;
  esac
  shift
done
if [[ ! -f "$F" ]]; then
  echo "usage: ets-restore [--yes] [--key FILE] [--no-safety-backup] <file.dump.gpg>"
  find "$DIR" -maxdepth 1 -name 'ets-*.dump*' ! -name '*.sha256' ! -name '*.meta' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head | cut -d' ' -f2-
  exit 1
fi

WORK=$(mktemp -d); export GNUPGHOME="$WORK/gnupg"; mkdir -m 700 "$GNUPGHOME"
STOPPED=0
cleanup() {
  rm -rf "$WORK"
  if [[ $STOPPED == 1 ]]; then echo "starting $SERVICE again"; $SYSTEMCTL start "$SERVICE" || true; fi
}
trap cleanup EXIT
run_node() {   # a backend script as the service user (ETS_RUN_AS), against the live database of ets.env
  local as=${ETS_RUN_AS:-ets}
  if [[ $EUID == 0 && "$as" != root ]] && id -u "$as" >/dev/null 2>&1; then
    (cd "$APP/backend" && runuser -u "$as" -- env ETS_ENV_FILE="$ENVF" PATH="$PATH" node "$@")
  else (cd "$APP/backend" && env ETS_ENV_FILE="$ENVF" node "$@"); fi
}

# 1. checks — nothing is changed yet
if [[ -f "$F.sha256" ]]; then
  [[ "$(cut -d' ' -f1 "$F.sha256")" == "$(sha256sum "$F" | cut -d' ' -f1)" ]] || fail "checksum mismatch: $F does not match $F.sha256 (damaged or altered)"
  echo "checksum ok"
else
  echo "warning: no checksum file $F.sha256"
fi
case "$F" in
  *.gpg)
    [[ -s "$KEY" && -r "$KEY" ]] || fail "backup key $KEY is missing (restore it from your safe copy first, or give it with --key)"
    gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$KEY" --decrypt --output "$WORK/db.dump" "$F" 2>/dev/null \
      || fail "cannot decrypt $F with $KEY (wrong key or passphrase, or the file was damaged/altered) — nothing was changed" ;;
  *)
    echo "warning: $F is not encrypted (backup from an older version)"
    cp -- "$F" "$WORK/db.dump" ;;
esac
pg_restore --list "$WORK/db.dump" >"$WORK/all.list" || fail "$F is not a valid pg_dump archive"
# extensions (citext) belong to the database administrator and already exist: leave them alone
grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (EXTENSION|COMMENT - EXTENSION) ' "$WORK/all.list" >"$WORK/restore.list"
# a backup of a NEWER version cannot be restored by this one (its migrations are unknown here)
if grep -qE ' TABLE DATA public schema_migrations ' "$WORK/restore.list"; then
  pg_restore --data-only --table=schema_migrations --file=- "$WORK/db.dump" 2>/dev/null | grep -oE '^[0-9]{3}_[a-z0-9_]+\.sql' | LC_ALL=C sort >"$WORK/in.mig" || true
  find "$APP/backend/src/db/migrations" -maxdepth 1 -name '*.sql' -printf '%f\n' 2>/dev/null | LC_ALL=C sort >"$WORK/app.mig" || true
  if [[ -s "$WORK/app.mig" ]]; then
    newer=$(comm -23 "$WORK/in.mig" "$WORK/app.mig" | paste -sd' ' -)
    [[ -z "$newer" ]] || fail "$F comes from a NEWER version of ETS (migrations $newer): install that version first — nothing was changed"
  fi
fi

# who may replace the log tables? (protected = owned by another role than the application role)
PROTECT=${ETS_LOG_PROTECT_CMD:-/usr/local/sbin/ets-log-protect}
PROTECTED=$(PGPASSWORD="$PW" psql -X -qtA -c "SELECT pg_get_userbyid(relowner) <> current_user FROM pg_class WHERE oid = to_regclass('public.audit_log')") \
  || fail "cannot connect to the database — nothing was changed"
VIA_SU=0
if [[ -x "$PROTECT" ]] && "$PROTECT" check; then
  VIA_SU=1
elif [[ "$PROTECTED" == t ]]; then
  fail "the audit trail is protected (log tables owned by another role): the restore needs the PostgreSQL superuser.
    Local database: run ets-restore as root on the database server (sudo -u postgres must work).
    Remote database: the DBA gives a superuser connection:
      sudo ETS_SU_CONNINFO='host=<db server> user=<superuser> sslmode=verify-full' ets-restore $F
    Nothing was changed."
fi

if [[ $YES != 1 ]]; then
  read -rp "This REPLACES all data in database '${PGDATABASE:-?}' on ${PGHOST:-localhost} with $F and signs every user out. Type YES to continue: " ok
  [[ "$ok" == "YES" ]] || exit 1
fi

# 2. safety copy of the current data (not copied offsite)
if [[ $SAFETY == 1 ]]; then
  echo "Backing up the current data first"
  "${ETS_BACKUP_CMD:-/usr/local/bin/ets-backup}" --no-offsite || fail "the pre-restore backup failed — nothing was changed"
fi
# no scheduled backup while the data is being replaced
exec 9>"$LOCK"; flock -w 3600 9 || fail "a backup is running — try again later"

# 3. restore (single transaction: on any error everything is rolled back)
$SYSTEMCTL stop "$SERVICE"; STOPPED=1
if [[ $VIA_SU == 1 ]]; then
  "$PROTECT" restore "$WORK/db.dump" "$WORK/restore.list" >/dev/null \
    || fail "RESTORE FAILED — the transaction was rolled back; the database still holds the previous data"
  # 4. a backup of an older version: its migrations are applied now, then the protection is checked again
  "$PROTECT" migrate || echo "warning: migrating the restored database failed — see the message above" >&2
  "$PROTECT" status || echo "warning: the audit trail is not protected — run: sudo ets-log-protect apply" >&2
else
  # --no-acl: privileges are re-applied by the installation (a backup of a protected database names other roles).
  # One transaction: schema public emptied (deploy/db/wipe-public.sql — pg_restore --clean would fail on tables a
  # newer version added), then the backup.
  pg_restore --no-owner --no-acl --use-list="$WORK/restore.list" --file="$WORK/restore.sql" "$WORK/db.dump" \
    || fail "pg_restore could not read the backup — nothing was changed"
  { echo 'BEGIN;'; cat "${ETS_WIPE_SQL:-$APP/deploy/db/wipe-public.sql}"; cat "$WORK/restore.sql"; echo 'COMMIT;'; } \
    | PGPASSWORD="$PW" psql -X -q -v ON_ERROR_STOP=1 --dbname="$PGDATABASE" >/dev/null \
    || fail "RESTORE FAILED — the transaction was rolled back; the database still holds the previous data"
  # 4. the application role owns every table here (not protected), so it can apply the migrations itself
  run_node src/db/migrate.js || echo "warning: migrating the restored database failed — see the message above" >&2
fi
PGPASSWORD="$PW" psql -X -q -v ON_ERROR_STOP=1 -v f="$F" >/dev/null <<'SQL' || echo "warning: could not record the restore in system_log" >&2
-- every session of the backup's time ends: everybody signs in again with the restored accounts
UPDATE sessions SET revoked_at = now(), revoke_reason = 'restore' WHERE revoked_at IS NULL;
INSERT INTO system_log(event,message,detail) VALUES ('restore','database restored from backup', jsonb_build_object('file', :'f', 'via', 'cli'));
-- the change history continues from the backup: say so in it (the data before the restore is in the safety backup)
INSERT INTO audit_log(username,action,entity,summary,new_value)
VALUES ('cli:ets-restore','restore','database','database restored from backup', jsonb_build_object('file', :'f', 'items', jsonb_build_array('db'), 'source', 'cli'));
SQL
# 5. the audit chains of the restored data
AUDIT=ok
if ! run_node scripts/verify-audit.js; then
  AUDIT=broken
  echo "!! the audit-chain check FAILED on the restored data (see above) — docs/handover/07-Logging-and-Audit.md" >&2
fi
$SYSTEMCTL start "$SERVICE"; STOPPED=0
echo "Restore finished (audit chains: $AUDIT). Every user must sign in again. Check: systemctl status $SERVICE"
[[ $AUDIT == ok ]] || exit 4

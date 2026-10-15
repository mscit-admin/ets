#!/usr/bin/env bash
# ETS database restore (installed as /usr/local/bin/ets-restore).
#   sudo ets-restore /var/backups/ets/ets-20261012-013000.dump.gpg
# 1. checks the file: checksum (<file>.sha256), decryption with /etc/ets/backup.key, archive contents;
# 2. takes a fresh backup of the current data (ets-backup);
# 3. stops the service, restores in ONE transaction (all or nothing), starts the service.
# The change history (audit_log) is replaced by the backup's copy too: the copy made in step 2 keeps the rows
# written since that backup, and the restore itself is recorded in the restored change history.
# If anything fails the database is left as it was and the service is started again.
# The log tables are owned by a separate role (ETS-SEC-013), so the application role cannot replace them: when
# the PostgreSQL superuser is reachable (local database, or a DBA connection in ETS_SU_CONNINFO) the restore runs
# through ets-log-protect, which restores as the application role inside a superuser transaction and protects
# the audit trail again before COMMIT. Without it a protected database is not touched (instructions are printed).
set -euo pipefail
umask 077
ENVF="${ETS_ENV_FILE:-/etc/ets/ets.env}"
[[ -r "$ENVF" ]] || { echo "cannot read $ENVF" >&2; exit 1; }
env_get() { local v; v=$(sed -n "s/^$1=//p" "$ENVF" | tail -n 1); v=${v%\'}; v=${v#\'}; v=${v%\"}; v=${v#\"}; printf '%s' "$v"; }
for k in PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do
  v=$(env_get "$k"); if [[ -n "$v" ]]; then export "$k=$v"; fi
done
case "${PGHOST:-}" in ''|127.0.0.1|localhost|::1|/*) ;; *) export PGSSLMODE="${PGSSLMODE:-require}" ;; esac
PW=$(env_get PGPASSWORD)
DIR=$(env_get ETS_BACKUP_DIR); DIR=${DIR:-/var/backups/ets}
KEY=${ETS_BACKUP_KEY:-$(env_get ETS_BACKUP_KEY)}; KEY=${KEY:-/etc/ets/backup.key}
SERVICE=ets-backend
fail() { echo "xx  $*" >&2; exit 1; }

F="${1:-}"
if [[ ! -f "$F" ]]; then
  echo "usage: ets-restore <file.dump.gpg>"
  find "$DIR" -maxdepth 1 -name 'ets-*.dump*' ! -name '*.sha256' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head | cut -d' ' -f2-
  exit 1
fi

WORK=$(mktemp -d); export GNUPGHOME="$WORK/gnupg"; mkdir -m 700 "$GNUPGHOME"
STOPPED=0
cleanup() {
  rm -rf "$WORK"
  if [[ $STOPPED == 1 ]]; then echo "starting $SERVICE again"; systemctl start "$SERVICE" || true; fi
}
trap cleanup EXIT

# 1. checks — nothing is changed yet
if [[ -f "$F.sha256" ]]; then
  [[ "$(cut -d' ' -f1 "$F.sha256")" == "$(sha256sum "$F" | cut -d' ' -f1)" ]] || fail "checksum mismatch: $F does not match $F.sha256 (damaged or altered)"
  echo "checksum ok"
else
  echo "warning: no checksum file $F.sha256"
fi
case "$F" in
  *.gpg)
    [[ -s "$KEY" && -r "$KEY" ]] || fail "backup key $KEY is missing (restore it from your safe copy first)"
    gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$KEY" --decrypt --output "$WORK/db.dump" "$F" \
      || fail "cannot decrypt $F with $KEY (wrong key, or the file was damaged/altered)" ;;
  *)
    echo "warning: $F is not encrypted (backup from an older version)"
    cp -- "$F" "$WORK/db.dump" ;;
esac
pg_restore --list "$WORK/db.dump" >"$WORK/all.list" || fail "$F is not a valid pg_dump archive"
# extensions (citext) belong to the database administrator and already exist: leave them alone
grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (EXTENSION|COMMENT - EXTENSION) ' "$WORK/all.list" >"$WORK/restore.list"

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

read -rp "This REPLACES all data in database '${PGDATABASE:-?}' on ${PGHOST:-localhost} with $F. Type YES to continue: " ok
[[ "$ok" == "YES" ]] || exit 1

# 2. safety copy of the current data
echo "Backing up the current data first"
"${ETS_BACKUP_CMD:-/usr/local/bin/ets-backup}" || fail "the pre-restore backup failed — nothing was changed"

# 3. restore (single transaction: on any error everything is rolled back)
systemctl stop "$SERVICE"; STOPPED=1
if [[ $VIA_SU == 1 ]]; then
  "$PROTECT" restore "$WORK/db.dump" "$WORK/restore.list" >/dev/null \
    || fail "RESTORE FAILED — the transaction was rolled back; the database still holds the previous data"
  # a backup of an older version: its migrations are applied now, then the protection is checked again
  "$PROTECT" migrate || echo "warning: migrating the restored database failed — see the message above" >&2
  "$PROTECT" status || echo "warning: the audit trail is not protected — run: sudo ets-log-protect apply" >&2
else
  # --no-acl: privileges are re-applied by the installation (a backup of a protected database names other roles)
  PGPASSWORD="$PW" pg_restore --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error \
    --use-list="$WORK/restore.list" --dbname="$PGDATABASE" "$WORK/db.dump" \
    || fail "RESTORE FAILED — the transaction was rolled back; the database still holds the previous data"
fi
systemctl start "$SERVICE"; STOPPED=0
PGPASSWORD="$PW" psql -X -q -v ON_ERROR_STOP=1 -v f="$F" >/dev/null <<'SQL' || echo "warning: could not record the restore in system_log" >&2
INSERT INTO system_log(event,message,detail) VALUES ('restore','database restored from backup', jsonb_build_object('file', :'f'));
-- the change history continues from the backup: say so in it (the data before the restore is in the safety backup)
INSERT INTO audit_log(username,action,entity,summary,new_value)
VALUES ('cli:ets-restore','restore','database','database restored from backup', jsonb_build_object('file', :'f'));
SQL
echo "Restore finished. Check: systemctl status $SERVICE"

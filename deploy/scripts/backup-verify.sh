#!/usr/bin/env bash
# ETS test restore (installed as /usr/local/bin/ets-backup-verify; run weekly by ets-backup-verify.timer, by the
# backup agent for «تحقق الآن», and by the restore wizard to inspect a backup before it is restored).
#
#   ets-backup-verify                         the newest local database backup
#   ets-backup-verify --file F.dump.gpg       that file
#     [--key FILE]       key / passphrase file (default: the server's backup key)
#     [--json OUT]       write the result as JSON
#     [--no-log]         do not record it in system_log (inspection by the restore wizard)
#
# Decrypts the dump, restores it into a TEMPORARY database (ets_restore_check), applies the migrations of this
# version to it, runs the audit-chain check (verify-audit) on it, compares the row counts of key tables with the live
# database, then drops the temporary database. The live database is never written (it is only read for the counts
# and the system_log row). Exit 0 = ok, 1 = failed, 10 = wrong key / not decryptable.
#
# Creating the temporary database needs one of: the PostgreSQL superuser (local database: as root through the postgres
# account; remote: ETS_SU_CONNINFO), the CREATEDB right of the application role, or an empty database
# ets_restore_check owned by the application role that the DBA created once (it is emptied instead of dropped).
set -euo pipefail
umask 077
CONF_DIR=${ETS_CONF_DIR:-/etc/ets}
BK_CONF_DIR=$CONF_DIR
ENVF=${ETS_ENV_FILE:-$CONF_DIR/ets.env}
BCONF=${ETS_BACKUP_CONF:-$CONF_DIR/backup.conf}
APP=${ETS_APP_DIR:-/opt/ets}
LOCK=${ETS_BACKUP_LOCK:-/run/lock/ets-backup.lock}
TMPDB=${ETS_VERIFY_DB:-ets_restore_check}
LIB=${ETS_BACKUP_LIB:-}
if [[ -z "$LIB" ]]; then
  for c in "$(dirname "$(readlink -f "$0")")/backup-lib.sh" /usr/local/lib/ets/backup-lib.sh; do [[ -r "$c" ]] && { LIB=$c; break; }; done
fi
# shellcheck source=deploy/scripts/backup-lib.sh
. "${LIB:?backup-lib.sh not found}"

FILE='' KEYF='' JSON='' NOLOG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) shift; FILE=${1:-} ;;
    --key) shift; KEYF=${1:-} ;;
    --json) shift; JSON=${1:-} ;;
    --no-log) NOLOG=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -r "$ENVF" ]] || { echo "cannot read $ENVF" >&2; exit 1; }
for k in PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do
  v=$(bk_env_get "$ENVF" "$k"); if [[ -n "$v" ]]; then export "$k=$v"; fi
done
case "${PGHOST:-}" in ''|127.0.0.1|localhost|::1|/*) DB_LOCAL=1 ;; *) DB_LOCAL=0; export PGSSLMODE="${PGSSLMODE:-require}" ;; esac
PW=$(bk_env_get "$ENVF" PGPASSWORD)
LIVE=${PGDATABASE:-ets}
DIR=${ETS_BACKUP_DIR:-$(bk_env_get "$ENVF" ETS_BACKUP_DIR)}; DIR=${DIR:-/var/backups/ets}
BK_KEY=${KEYF:-${ETS_BACKUP_KEY:-$(bk_env_get "$ENVF" ETS_BACKUP_KEY)}}; BK_KEY=${BK_KEY:-$CONF_DIR/backup.key}
bk_load_conf "$BCONF" || exit 1
if [[ "${ETS_VERIFY_SCHEDULED:-0}" == 1 && "$BACKUP_VERIFY_ENABLED" == no ]]; then echo "weekly test restore is switched off (Settings → «النسخ الاحتياطي»)"; exit 0; fi
[[ "$TMPDB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "invalid ETS_VERIFY_DB" >&2; exit 2; }
# never the live database
[[ "$TMPDB" != "$LIVE" ]] || { echo "the temporary database must not be the live database ($LIVE)" >&2; exit 2; }

WORK=$(mktemp -d); GNUPGHOME=$WORK/gnupg; mkdir -m 700 "$GNUPGHOME"; export GNUPGHOME
T0=$(date +%s) DETAILS=() OK=1 ERR='' STAGE=start CREATED=''
declare -A RESTORED=() LIVEC=()
note() { echo "$*"; DETAILS+=("$*"); }
fail() { OK=0; ERR=$1; note "FAILED: $1"; }
psql_app() { PGPASSWORD="$PW" psql -X -q -v ON_ERROR_STOP=1 "$@"; }
su_psql() {   # superuser connection (local: the postgres account over the socket; remote: ETS_SU_CONNINFO)
  if [[ -n "${ETS_SU_CONNINFO:-}" ]]; then psql -X -q -v ON_ERROR_STOP=1 --dbname="$ETS_SU_CONNINFO dbname=${1}" "${@:2}"
  else (cd / && runuser -u postgres -- env -i PATH="$PATH" psql -X -q -w -v ON_ERROR_STOP=1 -h "${ETS_SU_PGHOST:-/var/run/postgresql}" -p "${PGPORT:-5432}" -d "$1" "${@:2}"); fi
}
su_ok() { [[ -n "${ETS_SU_CONNINFO:-}" ]] || { (( DB_LOCAL )) && [[ $EUID == 0 ]] && id -u postgres >/dev/null 2>&1; } || return 1
          [[ "$(su_psql postgres -tAc 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user' 2>/dev/null)" == t ]]; }
run_node() {   # node script of the backend, as the service user, against the temporary database
  local as=${ETS_RUN_AS:-ets}
  if [[ $EUID == 0 && "$as" != root ]] && id -u "$as" >/dev/null 2>&1; then
    (cd "$APP/backend" && runuser -u "$as" -- env ETS_ENV_FILE="$ENVF" PGDATABASE="$TMPDB" PATH="$PATH" node "$@")
  else
    (cd "$APP/backend" && env ETS_ENV_FILE="$ENVF" PGDATABASE="$TMPDB" node "$@")
  fi
}
drop_tmp() {
  case "$CREATED" in
    su) su_psql postgres -c "DROP DATABASE IF EXISTS \"$TMPDB\" WITH (FORCE)" >/dev/null 2>&1 || true ;;
    app) psql_app -d "${LIVE}" -c "DROP DATABASE IF EXISTS \"$TMPDB\" WITH (FORCE)" >/dev/null 2>&1 || true ;;
    reuse) psql_app -d "$TMPDB" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public' >/dev/null 2>&1 || true ;;
  esac
  CREATED=''
}
# shellcheck disable=SC2317  # called by the EXIT trap
finish() {
  local rc=$?
  if (( rc != 0 && rc != 10 && OK )); then OK=0; ERR="unexpected error at step $STAGE (exit $rc)"; DETAILS+=("FAILED: $ERR"); fi
  drop_tmp
  local secs=$(( $(date +%s) - T0 )) counts='' t
  for t in "${!RESTORED[@]}"; do counts+="${counts:+,}\"$t\":{\"restored\":${RESTORED[$t]},\"live\":${LIVEC[$t]:-null}}"; done
  local j
  j="{\"ok\":$( ((OK)) && echo true || echo false),\"file\":$(bk_json_str "$FILE"),\"error\":$( [[ -n "$ERR" ]] && bk_json_str "$ERR" || echo null),\"stage\":$(bk_json_str "$STAGE"),\"seconds\":$secs,\"counts\":{${counts}},${EXTRA:-}\"details\":$(bk_json_arr "${DETAILS[@]}")}"
  [[ -n "$JSON" ]] && printf '%s\n' "$j" >"$JSON"
  if (( ! NOLOG )); then
    psql_app -d "$LIVE" -v d="$j" -v l="$( ((OK)) && echo info || echo error)" >/dev/null <<'SQL' || echo "warning: could not record the result in system_log" >&2
INSERT INTO system_log(level,event,message,detail) VALUES (:'l','backup_verify','weekly test restore', CAST(:'d' AS jsonb));
SQL
  fi
  rm -rf "$WORK"
  if (( rc == 10 )); then exit 10; fi
  (( OK )) || exit 1
  exit "$rc"
}
trap finish EXIT
EXTRA=''

# 1) the file and the key — copied under the backup lock so the retention cannot delete it meanwhile
STAGE=select
if [[ -z "$FILE" ]]; then
  exec 9>"$LOCK"; flock -w 3600 9 || { fail "the backup lock is busy"; exit 1; }
  FILE=$(find "$DIR" -maxdepth 1 -type f -printf '%f\n' | bk_latest dump) || true
  [[ -n "$FILE" ]] || { fail "no database backup in $DIR"; exit 1; }
  FILE=$DIR/$FILE
fi
[[ -f "$FILE" ]] || { fail "file not found: $FILE"; exit 1; }
[[ -s "$BK_KEY" && -r "$BK_KEY" ]] || { fail "backup key $BK_KEY is missing"; exit 1; }
note "file $(basename "$FILE") ($(stat -c %s "$FILE") bytes)"
STAGE=checksum
set +e; bk_sha_ok "$FILE"; rc=$?; set -e
case $rc in 0) note "checksum ok" ;; 2) note "no checksum file" ;; *) fail "checksum mismatch (damaged or altered file)"; exit 1 ;; esac
STAGE=decrypt
if [[ "$FILE" == *.gpg ]]; then
  if ! bk_decrypt "$FILE" "$WORK/db.dump" 2>"$WORK/gpg.err"; then
    fail "cannot decrypt with the given key (wrong key or passphrase, or a damaged file)"; EXTRA='"wrong_key":true,'; exit 10
  fi
else cp -- "$FILE" "$WORK/db.dump"; fi
exec 9>&-   # backup lock released
note "decrypted ($(stat -c %s "$WORK/db.dump") bytes)"
STAGE=list
pg_restore --list "$WORK/db.dump" >"$WORK/all.list" 2>"$WORK/l.err" || { fail "not a valid pg_dump archive"; exit 1; }
grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (EXTENSION|COMMENT - EXTENSION) ' "$WORK/all.list" >"$WORK/restore.list"
TOC=$(grep -cE '^[0-9]+;' "$WORK/restore.list" || true); TDATA=$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ' "$WORK/restore.list" || true)
note "archive: $TOC entries, $TDATA tables with data"

# 2) the temporary database
STAGE=createdb
if su_ok; then
  su_psql postgres -c "DROP DATABASE IF EXISTS \"$TMPDB\" WITH (FORCE)" >/dev/null
  su_psql postgres -c "CREATE DATABASE \"$TMPDB\" OWNER \"${PGUSER:-ets}\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null
  CREATED=su
  su_psql "$TMPDB" -c "CREATE EXTENSION IF NOT EXISTS citext; ALTER SCHEMA public OWNER TO \"${PGUSER:-ets}\"" >/dev/null
elif [[ "$(psql_app -d "$LIVE" -tAc "SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user")" == t ]]; then
  psql_app -d "$LIVE" -c "DROP DATABASE IF EXISTS \"$TMPDB\"" >/dev/null 2>&1 || true
  psql_app -d "$LIVE" -c "CREATE DATABASE \"$TMPDB\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null
  CREATED=app
  psql_app -d "$TMPDB" -c 'CREATE EXTENSION IF NOT EXISTS citext' >/dev/null
elif [[ "$(psql_app -d "$TMPDB" -tAc "SELECT pg_get_userbyid(datdba) = current_user FROM pg_database WHERE datname = current_database()" 2>/dev/null)" == t ]]; then
  CREATED=reuse
  psql_app -d "$TMPDB" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext' >/dev/null
else
  fail "cannot create the temporary database $TMPDB: run as root on the database server, give the application role CREATEDB, or ask the DBA once: CREATE DATABASE $TMPDB OWNER ${PGUSER:-ets}; (docs/handover/08-Backup-and-Recovery.md)"
  exit 1
fi
note "temporary database $TMPDB ready ($CREATED)"

# 3) restore, migrations, audit chain, counts
STAGE=restore
if ! PGPASSWORD="$PW" pg_restore --no-owner --no-acl --single-transaction --exit-on-error --use-list="$WORK/restore.list" \
     --dbname="$TMPDB" "$WORK/db.dump" 2>"$WORK/r.err"; then
  fail "restore into the temporary database failed: $(tail -n 2 "$WORK/r.err" | tr '\n' ' ')"; exit 1
fi
note "restored into $TMPDB"
STAGE=migrations
MIGDIR=$APP/backend/src/db/migrations
psql_app -d "$TMPDB" -tAc "SELECT version FROM schema_migrations ORDER BY 1" >"$WORK/in.mig" 2>/dev/null || : >"$WORK/in.mig"
find "$MIGDIR" -maxdepth 1 -name '*.sql' -printf '%f\n' | LC_ALL=C sort >"$WORK/app.mig"
UNKNOWN=$(comm -23 <(LC_ALL=C sort "$WORK/in.mig") "$WORK/app.mig" | paste -sd' ' -)
PENDING=$(comm -13 <(LC_ALL=C sort "$WORK/in.mig") "$WORK/app.mig" | paste -sd' ' -)
APPFP=$(psql_app -d "$TMPDB" -tAc "SELECT value #>> '{}' FROM settings WHERE key='system.app_secret_fp'" 2>/dev/null || true)
LASTMIG=$(tail -n 1 "$WORK/in.mig")
EXTRA="\"toc_entries\":$TOC,\"data_tables\":$TDATA,\"migrations\":{\"last\":$(bk_json_str "$LASTMIG"),\"pending\":$(bk_json_str "$PENDING"),\"unknown\":$(bk_json_str "$UNKNOWN")},\"newer_than_app\":$([[ -n "$UNKNOWN" ]] && echo true || echo false),\"app_secret_fp\":$(bk_json_str "$APPFP"),"
if [[ -n "$UNKNOWN" ]]; then
  fail "the backup is from a NEWER version of ETS (unknown migrations: $UNKNOWN) — install that version first"; exit 1
fi
if [[ -n "$PENDING" ]]; then
  run_node src/db/migrate.js >"$WORK/m.out" 2>&1 || { fail "migrations of this version fail on the backup: $(tail -n 2 "$WORK/m.out" | tr '\n' ' ')"; exit 1; }
  note "migrations applied to the copy: $PENDING"
else note "schema up to date ($LASTMIG)"; fi
STAGE=verify_audit
if run_node scripts/verify-audit.js --json >"$WORK/va.json" 2>"$WORK/va.err"; then note "audit chains intact (verify-audit)"; AUD=true
else AUD=false; fail "audit chain check failed on the backup: $(head -c 300 "$WORK/va.err")"; fi
STAGE=counts
# statistics of the restored copy (pg_restore does not analyze): rows and sizes per table drive the restore progress
psql_app -d "$TMPDB" -c 'ANALYZE' >/dev/null 2>&1 || true
psql_app -d "$TMPDB" -tA -F $'\t' -c "SELECT c.relname, GREATEST(c.reltuples,0)::bigint, pg_total_relation_size(c.oid) FROM pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') ORDER BY 1" >"$WORK/stats" 2>/dev/null || : >"$WORK/stats"
DBSIZE=$(psql_app -d "$TMPDB" -tAc 'SELECT pg_database_size(current_database())')
for t in users functions applications departments audit_log auth_log edit_requests import_batches settings; do
  r=$(psql_app -d "$TMPDB" -tAc "SELECT count(*) FROM $t" 2>/dev/null) || continue
  RESTORED[$t]=$r
  l=$(psql_app -d "$LIVE" -tAc "SELECT count(*) FROM $t" 2>/dev/null) && LIVEC[$t]=$l
done
for t in users functions applications departments; do
  if [[ "${RESTORED[$t]:-0}" == 0 && "${LIVEC[$t]:-0}" != 0 ]]; then fail "table $t is empty in the backup but not in the live database"; fi
done
# the change history only grows (purges keep at least a year): far fewer rows in the backup is suspicious
if [[ -n "${RESTORED[audit_log]:-}" && -n "${LIVEC[audit_log]:-}" ]] && (( RESTORED[audit_log] > LIVEC[audit_log] )); then
  note "note: the backup has more audit rows than the live database (${RESTORED[audit_log]} > ${LIVEC[audit_log]})"
fi
note "counts: $(for t in "${!RESTORED[@]}"; do printf '%s=%s/%s ' "$t" "${RESTORED[$t]}" "${LIVEC[$t]:-?}"; done)"
tables_json=$(awk -F'\t' 'NF==3{printf "%s{\"table\":\"%s\",\"rows\":%s,\"bytes\":%s}", (n++?",":""), $1, $2, $3}' "$WORK/stats")
EXTRA+="\"audit_ok\":$AUD,\"db_size\":${DBSIZE:-0},\"tables\":[${tables_json}],"
STAGE=complete
note "test restore $( ((OK)) && echo ok || echo FAILED) in $(( $(date +%s) - T0 )) s"

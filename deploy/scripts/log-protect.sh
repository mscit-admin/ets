#!/usr/bin/env bash
# ETS — protection of the audit trail in the database (ETS-SEC-013). Installed as /usr/local/sbin/ets-log-protect;
# deploy/install.sh and deploy/scripts/update.sh run it for a local database, ets-restore uses it when needed.
#
# The change history (audit_log) and the sign-in log (auth_log) are owned by a role without login
# (ets_log_owner): the application role may only read and append (deploy/db/harden-log-tables.sql).
# Work that needs the owner's rights is therefore done here, as the PostgreSQL superuser, in ONE transaction:
# the log objects are lent to the application role, the work runs AS the application role (SET ROLE), and the
# protection is applied again before COMMIT. Other sessions never see the unprotected state; on any error
# everything is rolled back.
#
#   ets-log-protect apply                  apply / re-apply the protection (idempotent)
#   ets-log-protect migrate                apply pending application migrations, then the protection
#   ets-log-protect restore DUMP [LIST]    pg_restore --clean of a decrypted custom-format dump (used by ets-restore)
#   ets-log-protect status                 owner of the log tables; exit 0 = protected, 3 = not protected
#   ets-log-protect check                  exit 0 when the superuser connection works
#
# Connection: local database → `sudo -u postgres psql` over the socket (/var/run/postgresql, or ETS_SU_PGHOST).
# Database on another server → the DBA runs it with a superuser connection, for example
#   sudo ETS_SU_CONNINFO='host=db.example.org user=postgres sslmode=verify-full sslrootcert=/etc/ets/db-ca.crt' ets-log-protect migrate
# Database name, port and application role come from /etc/ets/ets.env (ETS_ENV_FILE).
set -euo pipefail
umask 077
ENVF="${ETS_ENV_FILE:-/etc/ets/ets.env}"
APPDIR="${ETS_APP_DIR:-/opt/ets}"
SQL="${ETS_HARDEN_SQL:-$APPDIR/deploy/db/harden-log-tables.sql}"
MIGDIR="${ETS_MIGRATIONS_DIR:-$APPDIR/backend/src/db/migrations}"
LOG_OWNER="${ETS_LOG_OWNER:-ets_log_owner}"
fail() { echo "xx  ets-log-protect: $*" >&2; exit 1; }
[[ -r "$ENVF" ]] || fail "cannot read $ENVF"
env_get() { local v; v=$(sed -n "s/^$1=//p" "$ENVF" | tail -n 1); v=${v%\'}; v=${v#\'}; v=${v%\"}; v=${v#\"}; printf '%s' "$v"; }
DB=$(env_get PGDATABASE); DB=${DB:-ets}
APPROLE=$(env_get PGUSER); APPROLE=${APPROLE:-ets}
PORT=$(env_get PGPORT); PORT=${PORT:-5432}
[[ "$PORT" =~ ^[0-9]+$ ]] || fail "PGPORT in $ENVF is not a number"
[[ -r "$SQL" ]] || fail "missing $SQL"
cd /   # the postgres user may not be allowed to enter the current directory

# psql as the superuser; the SQL always comes on stdin (the postgres user cannot read /opt/ets or /etc/ets)
su_psql() {
  if [[ -n "${ETS_SU_CONNINFO:-}" ]]; then
    psql -X -q -v ON_ERROR_STOP=1 -v db_user="$APPROLE" -v log_owner="$LOG_OWNER" --dbname="$ETS_SU_CONNINFO dbname=$DB" "$@"
  else
    sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -v db_user="$APPROLE" -v log_owner="$LOG_OWNER" \
      -h "${ETS_SU_PGHOST:-/var/run/postgresql}" -p "$PORT" -d "$DB" "$@"
  fi
}
not_superuser_help() {
  cat >&2 <<EOF
xx  ets-log-protect: no superuser connection to database '$DB'.
    Local database: run as root on the database server (sudo -u postgres must work).
    Database on another server: ask the DBA to run this command with a superuser connection, e.g.
      sudo ETS_SU_CONNINFO='host=<db server> user=postgres sslmode=verify-full sslrootcert=/etc/ets/db-ca.crt' ets-log-protect ${1:-apply}
    or to run deploy/db/harden-log-tables.sql as described in docs/handover/07-Logging-and-Audit.md §3.
EOF
  exit 1
}
check() { [[ "$(su_psql -tAc 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user' 2>/dev/null)" == t ]]; }

# Lend everything the log owner holds in schema public to the application role (inside the transaction only),
# then continue as the application role.
prelude() {
  cat <<'EOF'
BEGIN;
SET LOCAL client_min_messages = warning;
SET LOCAL ets.lp_app = :'db_user';
SET LOCAL ets.lp_owner = :'log_owner';
DO $$
DECLARE app text := current_setting('ets.lp_app'); lo oid; r record;
BEGIN
  SELECT oid INTO lo FROM pg_roles WHERE rolname = current_setting('ets.lp_owner');
  IF lo IS NULL THEN RETURN; END IF;
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'public') = lo THEN
    EXECUTE format('ALTER SCHEMA public OWNER TO %I', app);
  END IF;
  FOR r IN SELECT c.oid::regclass AS n FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relowner = lo AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO %I', r.n, app);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proowner = lo LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.f, app);
  END LOOP;
END $$;
SET LOCAL ROLE :"db_user";
EOF
}
# Back to the superuser, protection applied again, COMMIT.
postlude() {
  printf 'RESET ROLE;\nSET LOCAL search_path = public, pg_catalog;\n\\set ets_wrapped 1\n'
  cat "$SQL"
  printf 'COMMIT;\n'
}

# SQL of the pending migrations, in file-name order, recorded like backend/src/db/migrate.js does
pending_migrations() {
  local applied f n=0
  applied=
  if [[ "$(su_psql -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" == t ]]; then
    applied=$(su_psql -tAc "SELECT version FROM schema_migrations")
  fi
  echo "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
  while IFS= read -r f; do
    [[ "$f" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]] || fail "unexpected migration file name: $f"
    grep -qxF "$f" <<<"$applied" && continue
    n=$((n+1))
    printf -- '-- migration %s\n' "$f"
    cat "$MIGDIR/$f"
    printf "\n;\nINSERT INTO schema_migrations(version) VALUES ('%s');\nINSERT INTO system_log(event, message) VALUES ('migration', '%s');\n" "$f" "$f"
    echo "applying $f" >&2
  done < <(find "$MIGDIR" -maxdepth 1 -name '*.sql' -printf '%f\n' | LC_ALL=C sort)
  (( n > 0 )) || echo "database is up to date" >&2
}

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cmd=${1:-}
case "$cmd" in
  check) check ;;
  status)
    check || not_superuser_help status
    owner=$(su_psql -tAc "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.audit_log')")
    echo "database $DB: audit_log owner '${owner:-?}', application role '$APPROLE', log owner '$LOG_OWNER'"
    [[ "$owner" == "$LOG_OWNER" ]] || { echo "NOT protected"; exit 3; }
    echo "protected" ;;
  apply)
    check || not_superuser_help apply
    su_psql <"$SQL" ;;
  migrate)
    check || not_superuser_help migrate
    [[ -d "$MIGDIR" ]] || fail "missing $MIGDIR"
    # the whole script is built first: nothing is sent unless it is complete
    { prelude; pending_migrations; postlude; } >"$WORK/run.sql"
    su_psql <"$WORK/run.sql" ;;
  restore)
    DUMP=${2:-}; LIST=${3:-}
    [[ -r "$DUMP" ]] || fail "usage: ets-log-protect restore <file.dump> [<list>]"
    check || not_superuser_help restore
    # --no-owner/--no-acl: objects belong to the application role; the protection is applied before COMMIT
    pg_restore --clean --if-exists --no-owner --no-acl ${LIST:+--use-list="$LIST"} --file="$WORK/restore.sql" "$DUMP" \
      || fail "pg_restore could not read $DUMP — nothing was changed"
    { prelude; cat "$WORK/restore.sql"; postlude; } | su_psql ;;
  *) sed -n '2,20p' "$0" >&2; exit 2 ;;
esac

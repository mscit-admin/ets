# shellcheck shell=bash
# ETS — functions shared by deploy/install.sh and deploy/scripts/update.sh (sourced, never run directly).
# Callers set: SRC (source tree), APP (/opt/ets), CONF (/etc/ets), ENVF, BACKUPS, and the ETS_* answers.

BUILD_USER=ets-build                 # unprivileged user that runs npm ci / vite build
BUILD_HOME=/var/lib/ets-build
BACKUP_KEY=${CONF:-/etc/ets}/backup.key
BACKUP_LOG=/var/log/ets-backup.log  # root-owned, outside the ets-writable /var/log/ets
NODE_MAJOR=22
# NodeSource repository signing key (https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key).
# The installer refuses the key if its fingerprint differs. Confirm this value against NodeSource's
# published documentation when it changes (docs/handover/02-Installation-Guide.md).
NODESOURCE_FPR=6F71F525282841EEDAF851B42F59B5F99B1BE0B4

is_ip() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && for o in ${1//./ }; do ((o<=255)) || return 1; done; }

# ---------------------------------------------------------------- reading configuration safely
# read_kv FILE NAME_REGEX — reads KEY=value lines WITHOUT executing them (answers files, install.conf).
# Values may be unquoted (a trailing "  # comment" is dropped), "double-quoted" or 'single-quoted'
# (no escapes, no variable expansion). Only names matching NAME_REGEX are set; nothing is exported.
read_kv() {
  local file=$1 allow=$2 line k v n=0
  local re_dq='^"([^"]*)"[[:space:]]*(#.*)?$' re_sq="^'([^']*)'[[:space:]]*(#.*)?\$" re_plain="^([^[:space:]\"']*)([[:space:]]+#.*|[[:space:]]*)\$"
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n+1)); line=${line%$'\r'}
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if ! [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "$file:$n: not a KEY=value line" >&2; return 1
    fi
    k=${BASH_REMATCH[1]}; v=${BASH_REMATCH[2]}
    if [[ "$v" =~ $re_dq || "$v" =~ $re_sq || "$v" =~ $re_plain ]]; then v=${BASH_REMATCH[1]}
    else echo "$file:$n: put a value containing spaces or quotes in double quotes ($k)" >&2; return 1; fi
    if [[ "$k" =~ $allow ]]; then printf -v "$k" '%s' "$v"; else echo "$file:$n: unknown setting $k — ignored" >&2; fi
  done <"$file"
}
# env_get FILE KEY — value of KEY in an env file written by the installer (quotes removed)
env_get() {
  local v; v=$(sed -n "s/^$2=//p" "$1" | tail -n 1)
  v=${v%\'}; v=${v#\'}; v=${v%\"}; v=${v#\"}; printf '%s' "$v"
}
# escape a value for the replacement part of sed s|...|...|
sed_esc() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }

# ---------------------------------------------------------------- Node.js
# Supported runtime: Node 22 (>= 22.12) or 24+ — same as "engines" in backend/package.json.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v maj min; v=$(node -v); v=${v#v}; maj=${v%%.*}; min=${v#*.}; min=${min%%.*}
  [[ "$maj" =~ ^[0-9]+$ && "$min" =~ ^[0-9]+$ ]] || return 1
  (( (maj == 22 && min >= 12) || maj >= 24 ))
}
# Adds the NodeSource apt repository with a pinned, fingerprint-checked signing key (no curl | bash).
install_node() {
  local tmp fpr arch keyring=/usr/share/keyrings/nodesource.gpg
  tmp=$(mktemp -d)
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmp/key.asc"
  fpr=$(GNUPGHOME="$tmp" gpg --batch --show-keys --with-colons "$tmp/key.asc" | awk -F: '/^fpr:/{print $10; exit}')
  if [[ "$fpr" != "$NODESOURCE_FPR" ]]; then
    rm -rf "$tmp"
    die "the NodeSource signing key has fingerprint '${fpr:-?}', expected $NODESOURCE_FPR — not installing. Install Node.js ${NODE_MAJOR} yourself (see docs/handover/02-Installation-Guide.md) and run the installer again."
  fi
  GNUPGHOME="$tmp" gpg --batch --yes --dearmor -o "$keyring" "$tmp/key.asc"; chmod 644 "$keyring"; rm -rf "$tmp"
  arch=$(dpkg --print-architecture)
  echo "deb [arch=$arch signed-by=$keyring] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' >/etc/apt/preferences.d/nodejs
  apt-get update -y
  apt-get install -y nodejs
}

# ---------------------------------------------------------------- application files
# Only what the server needs is copied (no docs, tests, reference data, examples, tools).
copy_allowlist() {   # $1 = source tree, $2 = destination
  rsync -a --delete --prune-empty-dirs --exclude 'node_modules' \
    --include '/backend/' --include '/backend/src/***' --include '/backend/scripts/***' --include '/backend/package*.json' --include '/backend/.npmrc' \
    --include '/frontend/' --include '/frontend/src/***' --include '/frontend/public/***' --include '/frontend/index.html' \
    --include '/frontend/vite.config.js' --include '/frontend/package*.json' --include '/frontend/.npmrc' \
    --include '/deploy/' --include '/deploy/db/***' --include '/deploy/nginx/***' --include '/deploy/systemd/***' \
    --include '/deploy/logrotate/***' --include '/deploy/scripts/***' \
    --exclude '*' "$1/" "$2/"
}
# Installs the packages and builds the frontend as the unprivileged $BUILD_USER in a staging copy
# (package install scripts disabled), then copies the result to $APP owned by root.
build_and_deploy_app() {
  local stage=$BUILD_HOME/stage
  id -u "$BUILD_USER" >/dev/null 2>&1 || useradd --system --home-dir "$BUILD_HOME" --shell /usr/sbin/nologin "$BUILD_USER"
  install -d -m 700 -o "$BUILD_USER" -g "$BUILD_USER" "$BUILD_HOME"
  rm -rf "$stage"
  copy_allowlist "$SRC" "$stage"
  chown -R "$BUILD_USER:$BUILD_USER" "$stage"
  local as_build=(sudo -u "$BUILD_USER" -H env)
  "${as_build[@]}" --chdir="$stage/backend" npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  "${as_build[@]}" --chdir="$stage/frontend" npm ci --ignore-scripts --no-audit --no-fund
  "${as_build[@]}" --chdir="$stage/frontend" npm run build
  # known vulnerabilities in the production packages (needs internet access to the npm registry)
  for d in backend frontend; do
    "${as_build[@]}" --chdir="$stage/$d" npm audit --omit=dev --audit-level=high \
      || warn "npm audit reported problems in $d (or could not reach the registry) — review: cd $SRC/$d && npm audit"
  done
  mkdir -p "$APP"
  rsync -a --delete --chown=root:root --exclude '/frontend/node_modules' "$stage/" "$APP/"
  rm -rf "$stage"
  set_app_permissions
}
# root owns the code; the service (group ets) reads the backend; nginx reads only the built frontend.
set_app_permissions() {
  chown -R root:root "$APP"; chmod 755 "$APP"
  chmod -R u=rwX,go= "$APP/deploy" "$APP/frontend"
  chmod 755 "$APP/frontend"; chmod -R a+rX "$APP/frontend/dist"
  chown -R root:ets "$APP/backend"; chmod -R u=rwX,g=rX,o= "$APP/backend"
}

# ---------------------------------------------------------------- backups
# Separate key for the encrypted backups (gpg AES-256). Root-only; NOT stored with the backups.
ensure_backup_key() {
  if [[ -s "$BACKUP_KEY" ]]; then chown root:root "$BACKUP_KEY"; chmod 600 "$BACKUP_KEY"; return 0; fi
  (umask 077; openssl rand -base64 48 >"$BACKUP_KEY")
  # shellcheck disable=SC2034  # read by update.sh
  BACKUP_KEY_CREATED=1
  echo "Created the backup encryption key $BACKUP_KEY — copy it to a safe place away from the backups."
}
# Keeps the 5 newest ets.env.bak-* copies (they hold old passwords), root-only.
prune_env_backups() {
  local f n=0
  while IFS= read -r f; do
    n=$((n+1))
    if (( n > 5 )); then rm -f -- "$f"; else chown root:root "$f"; chmod 600 "$f"; fi
  done < <(find "$CONF" -maxdepth 1 -name 'ets.env.bak-*' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}

# ---------------------------------------------------------------- service, cron, logrotate
# install_runtime_files DB_MODE DB_HOST — systemd unit, logrotate, backup/restore commands, cron.
install_runtime_files() {
  local mode=$1 dbhost=$2 unit=/etc/systemd/system/ets-backend.service
  install -m 644 "$APP/deploy/systemd/ets-backend.service" "$unit"
  if [[ $mode == local ]]; then
    sed -i 's/^After=.*/After=network-online.target postgresql.service/; s/^#\?Requires=.*/Requires=postgresql.service/' "$unit"
  else
    sed -i 's/^After=.*/After=network-online.target/; /^Requires=postgresql.service/d' "$unit"
    if is_ip "$dbhost"; then
      sed -i "s|^IPAddressAllow=localhost\$|IPAddressAllow=localhost $dbhost|" "$unit"
    else   # a host name can resolve to any address: no IP allow-list then
      sed -i '/^IPAddressAllow=/d; /^IPAddressDeny=/d' "$unit"
    fi
  fi
  install -m 644 "$APP/deploy/logrotate/ets" /etc/logrotate.d/ets
  install -m 755 "$APP/deploy/scripts/backup.sh" /usr/local/bin/ets-backup
  install -m 755 "$APP/deploy/scripts/restore.sh" /usr/local/bin/ets-restore
  install -m 750 "$APP/deploy/scripts/log-protect.sh" /usr/local/sbin/ets-log-protect
  touch "$BACKUP_LOG"; chown root:root "$BACKUP_LOG"; chmod 600 "$BACKUP_LOG"
  echo "30 1 * * * root /usr/local/bin/ets-backup >> $BACKUP_LOG 2>&1" >/etc/cron.d/ets-backup
  ensure_backup_key
  # earlier versions kept a copy of ets.env (APP_SECRET, DB password) next to the dumps
  if [[ -e "$BACKUPS/ets.env.backup" ]]; then
    shred -u "$BACKUPS/ets.env.backup" 2>/dev/null || rm -f "$BACKUPS/ets.env.backup"
    echo "Removed the old configuration copy $BACKUPS/ets.env.backup"
  fi
  prune_env_backups
}

# ---------------------------------------------------------------- database migrations and audit-trail protection
# psql as the application role, with the connection settings of ets.env (password only in this call's environment)
app_psql() {
  (
    for k in PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do
      v=$(env_get "$ENVF" "$k"); if [[ -n "$v" ]]; then export "$k=$v"; fi
    done
    psql -X "$@"
  )
}
# t when the change history is owned by another role than the application role (deploy/db/harden-log-tables.sql)
logs_protected() {
  app_psql -qtAc "SELECT pg_get_userbyid(relowner) <> current_user FROM pg_class WHERE oid = to_regclass('public.audit_log')" 2>/dev/null || true
}
# migrate_db DB_MODE — applies the pending migrations (ETS-SEC-013):
#  - local database (or a DBA's superuser connection in ETS_SU_CONNINFO): through ets-log-protect, as the
#    PostgreSQL superuser in one transaction, then the audit trail is protected (again) — every install/update;
#  - database on another server: as the application role (each migration all-or-nothing). If the DBA has
#    protected the log tables and a migration needs to change them, it fails without changing anything and the
#    DBA must apply it (instructions printed); if they are not protected, the DBA is told how to do it.
migrate_db() {
  local protect="$APP/deploy/scripts/log-protect.sh"
  if [[ $1 == local || -n "${ETS_SU_CONNINFO:-}" ]]; then
    ETS_ENV_FILE="$ENVF" ETS_APP_DIR="$APP" bash "$protect" migrate
    ETS_ENV_FILE="$ENVF" ETS_APP_DIR="$APP" bash "$protect" status \
      || die "the audit trail could not be protected (see the messages above)"
    return
  fi
  if ! (cd "$APP/backend" && sudo -u ets env ETS_ENV_FILE="$ENVF" node src/db/migrate.js); then
    [[ "$(logs_protected)" == t ]] && warn "the log tables are protected by the DBA: a migration that changes them needs the owner's rights."
    die "the database migration failed and was rolled back (nothing of that migration was applied). If the message says
    'must be owner', ask the DBA to apply it with a superuser connection from this server:
      sudo ETS_SU_CONNINFO='host=<db server> user=<superuser> sslmode=verify-full sslrootcert=$CONF/db-ca.crt' bash $protect migrate
    then run this command again."
  fi
  remote_protection_note
}
remote_protection_note() {
  if [[ "$(logs_protected)" == t ]]; then
    echo "The audit trail is protected in the database (log tables not owned by the application role)."
  else
    warn "The audit trail is NOT protected in the database server yet (ETS-SEC-013). Ask the DBA to run once,
    as a superuser, from this server (and again after each restore):
      sudo ETS_SU_CONNINFO='host=<db server> user=<superuser> sslmode=verify-full sslrootcert=$CONF/db-ca.crt' ets-log-protect apply
    or with psql anywhere: psql -v db_user=<app role> -v log_owner=ets_log_owner -d <db> -f deploy/db/harden-log-tables.sql
    (docs/handover/07-Logging-and-Audit.md §3). Until then the hash chain still detects changes (npm run verify-audit)."
  fi
}

# ---------------------------------------------------------------- certificate
# Self-signed server certificate: an end-entity certificate (CA:FALSE, serverAuth) for this address
# only — it can never act as a certificate authority, even if a client trusts it.
make_selfsigned() {   # $1 = address, $2 = cert file, $3 = key file
  local san="DNS:$1"; is_ip "$1" && san="IP:$1"
  (umask 077; openssl req -x509 -nodes -newkey rsa:3072 -sha256 -days 825 -subj "/CN=$1" \
    -addext "subjectAltName=$san" -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" -addext "extendedKeyUsage=serverAuth" \
    -keyout "$3" -out "$2")
  chmod 600 "$3"; chmod 644 "$2"
}
# true when the self-signed certificate must be (re)created: missing, expiring within 30 days, for
# another address, or made by an older installer as a CA certificate (CA:TRUE)
selfsigned_needs_renewal() {   # $1 = address, $2 = cert file
  [[ -f "$2" ]] || return 0
  openssl x509 -in "$2" -noout -checkend 2592000 >/dev/null || return 0
  openssl x509 -in "$2" -noout -ext basicConstraints 2>/dev/null | grep -q 'CA:TRUE' && return 0
  openssl x509 -in "$2" -noout -ext subjectAltName 2>/dev/null | grep -Eq "(DNS|IP Address):${1//./\\.}(,|\$)" || return 0
  return 1
}

# ---------------------------------------------------------------- phones (Android app, 1.9.0)
# SHA-256 fingerprint of a certificate file (DER), 64 lower-case hex digits — what the app pins.
cert_sha256() { openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f'; }
# set_env_kv FILE KEY VALUE — replaces KEY=… in the env file, or appends it (the file keeps its owner and mode).
set_env_kv() {
  local f=$1 k=$2 v=$3
  if grep -q "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$(sed_esc "$v")|" "$f"; else printf '%s=%s\n' "$k" "$v" >>"$f"; fi
}
# Writes PUBLIC_BASE_URL (https://ADDRESS[:port], the address in the pairing QR code) and TLS_CERT_SHA256 (the nginx
# certificate's fingerprint, which the app pins) into ets.env. A Let's Encrypt certificate is renewed every few
# months and is publicly trusted: TLS_CERT_SHA256 is left empty (null in the QR, the phone checks the CA chain).
# A PUBLIC_BASE_URL already set by hand (e.g. the VPN name of the server) is kept.
# Uses: ETS_ADDRESS, ETS_HTTPS_PORT, ETS_TLS, ETS_CERT; $1 = env file.
set_mobile_env() {
  local f=$1 url fp=''
  url="https://$ETS_ADDRESS$( [[ ${ETS_HTTPS_PORT:-443} == 443 ]] || echo ":$ETS_HTTPS_PORT")"
  if ! grep -q '^PUBLIC_BASE_URL=.\+' "$f"; then
    { grep -q '^# Phones (Android app)' "$f" || printf '\n# Phones (Android app): address in the pairing QR code, server certificate fingerprint (set by install.sh / update.sh)\n'; } >>"$f"
    set_env_kv "$f" PUBLIC_BASE_URL "$url"
  fi
  if [[ ${ETS_TLS:-} != letsencrypt && -r "${ETS_CERT:-}" ]]; then fp=$(cert_sha256 "$ETS_CERT"); fi
  set_env_kv "$f" TLS_CERT_SHA256 "$fp"
  echo "Phones: PUBLIC_BASE_URL=$(env_get "$f" PUBLIC_BASE_URL), TLS_CERT_SHA256=${fp:-(empty: publicly trusted certificate)}"
}

# ---------------------------------------------------------------- nginx
# render_nginx SITE SNIPPET [1 = temporary port-80 site for the Let's Encrypt challenge]
# Also writes the security-headers snippet next to SNIPPET.
render_nginx() {
  local t="$SRC/deploy/nginx" target name cert key
  name=$(sed_esc "$ETS_ADDRESS"); cert=$(sed_esc "$ETS_CERT"); key=$(sed_esc "$ETS_KEY")
  sed "s|__API_PORT__|$ETS_API_PORT|g" "$t/ets-app.conf.tpl" >"$2"
  install -m 644 "$t/ets-headers.conf" "$(dirname "$2")/ets-headers.conf"
  target="https://\$host$( [[ $ETS_HTTPS_PORT == 443 ]] || echo ":$ETS_HTTPS_PORT")"
  if [[ "${3:-0}" == 1 ]]; then
    sed -e "s|__SERVER_NAME__|$name|g" -e "s|__HTTP_PORT__|$ETS_HTTP_PORT|g" -e "s|__REDIRECT_TARGET__|$target|g" \
      "$t/ets-redirect.conf.tpl" >"$1"
    no_ipv6 "$1"; return
  fi
  sed -e "s|__SERVER_NAME__|$name|g" -e "s|__HTTPS_PORT__|$ETS_HTTPS_PORT|g" -e "s|__API_PORT__|$ETS_API_PORT|g" \
    -e "s|__SSL_CERT__|$cert|g" -e "s|__SSL_KEY__|$key|g" "$t/ets-https.conf.tpl" >"$1"
  if [[ $ETS_HTTP_PORT != 0 ]]; then
    { echo; sed -e "s|__SERVER_NAME__|$name|g" -e "s|__HTTP_PORT__|$ETS_HTTP_PORT|g" -e "s|__REDIRECT_TARGET__|$target|g" \
        "$t/ets-redirect.conf.tpl" | grep -v '^# Placeholders'; } >>"$1"
  fi
  no_ipv6 "$1"
}
# servers with IPv6 disabled cannot bind [::] — drop those listen lines there
no_ipv6() { [[ -s /proc/net/if_inet6 ]] || sed -i '/listen \[::\]/d' "$1"; }

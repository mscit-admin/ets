# shellcheck shell=bash
# ETS — functions shared by deploy/install.sh and deploy/scripts/update.sh (sourced, never run directly).
# Callers set: SRC (source tree), APP (/opt/ets), CONF (/etc/ets), ENVF, BACKUPS, and the ETS_* answers.

BUILD_USER=ets-build                 # unprivileged user that runs npm ci / vite build
BUILD_HOME=/var/lib/ets-build
BACKUP_KEY=${CONF:-/etc/ets}/backup.key
# shellcheck disable=SC2034  # BACKUP_LOG: used by install.sh
BACKUP_LOG=/var/log/ets-backup.log  # root-owned, outside the ets-writable /var/log/ets
BACKUP_CONF=${CONF:-/etc/ets}/backup.conf
STATE_DIR=/var/lib/ets               # backup agent: inbox (API → agent), upload, restore status (1.12.0)
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
  # version and commit of this build (in each configuration backup's manifest.json)
  printf 'version=%s\ncommit=%s\nbuilt=%s\n' "$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$APP/backend/package.json" | head -1)" \
    "$(git -c safe.directory="$SRC" -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)" "$(date -Is)" >"$APP/BUILD-INFO"
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

# /etc/ets/backup.conf when it does not exist yet (first installation, or an update from 1.11.0): local backups only,
# hourly, tiers 48 h / 30 days / 12 weeks / 12 months; the daily tier keeps at least ETS_BACKUP_KEEP_DAYS of 1.11.0 so
# the existing dailies are not deleted earlier than before. Offsite destinations from the installer's answers
# (ETS_BACKUP_SSH_TARGET, ETS_BACKUP_NAS_DIR, ETS_BACKUP_RCLONE_REMOTE). From then on the settings live in the database
# (Settings → «النسخ الاحتياطي»): ets-backup-agent imports this file once and rewrites it.
ensure_backup_conf() {
  [[ -f "$BACKUP_CONF" ]] && { chown root:root "$BACKUP_CONF"; chmod 600 "$BACKUP_CONF"; return 0; }
  local kd; kd=$(env_get "$ENVF" ETS_BACKUP_KEEP_DAYS 2>/dev/null || true); [[ "$kd" =~ ^[0-9]+$ ]] || kd=30; (( kd < 30 )) && kd=30
  (umask 077; cat >"$BACKUP_CONF" <<CONF
# /etc/ets/backup.conf — created by $(basename "$0") on $(date -Is). Imported once into the database; afterwards it is
# written by ets-backup-agent from Settings → «النسخ الاحتياطي» (do not edit by hand). Read as data, never executed.
BACKUP_FREQUENCY_HOURS=1
BACKUP_LOGS_TIME='00:45'
BACKUP_KEEP_HOURLY=48
BACKUP_KEEP_DAILY=$kd
BACKUP_KEEP_WEEKLY=12
BACKUP_KEEP_MONTHLY=12
BACKUP_VERIFY_ENABLED=yes
BACKUP_SSH_TARGET='${ETS_BACKUP_SSH_TARGET:-}'
BACKUP_SSH_PORT=${ETS_BACKUP_SSH_PORT:-22}
BACKUP_NAS_DIR='${ETS_BACKUP_NAS_DIR:-}'
BACKUP_RCLONE_REMOTE='${ETS_BACKUP_RCLONE_REMOTE:-}'
CONF
  )
  echo "Created $BACKUP_CONF (backups every hour; daily copies kept $kd days)"
}

# ---------------------------------------------------------------- service, timers, logrotate
# install_runtime_files DB_MODE DB_HOST — systemd units, logrotate, backup/restore commands and timers, backup agent.
install_runtime_files() {
  local mode=$1 dbhost=$2 unit=/etc/systemd/system/ets-backend.service u
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
  install -d -m 755 /usr/local/lib/ets
  install -m 644 "$APP/deploy/scripts/backup-lib.sh" /usr/local/lib/ets/backup-lib.sh
  install -m 755 "$APP/deploy/scripts/backup.sh" /usr/local/bin/ets-backup
  install -m 755 "$APP/deploy/scripts/backup-verify.sh" /usr/local/bin/ets-backup-verify
  install -m 755 "$APP/deploy/scripts/restore.sh" /usr/local/bin/ets-restore
  install -m 755 "$APP/deploy/scripts/restore-server.sh" /usr/local/bin/ets-restore-server
  install -m 750 "$APP/deploy/scripts/log-protect.sh" /usr/local/sbin/ets-log-protect
  install -m 750 "$APP/deploy/scripts/backup-agent.sh" /usr/local/sbin/ets-backup-agent
  for u in /var/log/ets-backup.log /var/log/ets-offsite.log /var/log/ets-backup-verify.log /var/log/ets-backup-agent.log; do
    touch "$u"; chown root:root "$u"; chmod 600 "$u"
  done
  # backup agent directories: the API (ets) writes the inbox and the upload area; only root reads the staging area;
  # the restore status (no secrets) is readable by nginx for the maintenance page
  install -d -m 755 -o root -g root "$STATE_DIR" "$STATE_DIR/restore"
  install -d -m 700 -o ets -g ets "$STATE_DIR/inbox" "$STATE_DIR/upload"
  install -d -m 700 -o root -g root "$STATE_DIR/restore/work"
  ensure_backup_key
  ensure_backup_conf
  # 1.11.0 and earlier: a daily cron job — replaced by the systemd timer (hourly, Persistent=true, no overlap)
  if [[ -e /etc/cron.d/ets-backup ]]; then rm -f /etc/cron.d/ets-backup; echo "Removed /etc/cron.d/ets-backup (backups now run from ets-backup.timer)"; fi
  for u in ets-backup.service ets-backup.timer ets-backup-verify.service ets-backup-verify.timer ets-backup-agent.service ets-backup-agent.timer ets-backup-agent.path; do
    install -m 644 "$APP/deploy/systemd/$u" "/etc/systemd/system/$u"
  done
  systemctl daemon-reload
  systemctl enable --now ets-backup.timer ets-backup-verify.timer ets-backup-agent.timer ets-backup-agent.path >/dev/null
  # earlier versions kept a copy of ets.env (APP_SECRET, DB password) next to the dumps
  if [[ -e "$BACKUPS/ets.env.backup" ]]; then
    shred -u "$BACKUPS/ets.env.backup" 2>/dev/null || rm -f "$BACKUPS/ets.env.backup"
    echo "Removed the old configuration copy $BACKUPS/ets.env.backup"
  fi
  prune_env_backups
}
# After the migrations (table backup_config exists): /etc/ets/backup.conf → database, once; then the agent renders the
# configuration and the timer schedule from the database.
backup_agent_import() {
  ETS_ENV_FILE="$ENVF" /usr/local/sbin/ets-backup-agent import >/dev/null \
    || warn "the backup agent could not import $BACKUP_CONF — see /var/log/ets-backup-agent.log (Settings → «النسخ الاحتياطي» shows the state)"
}
# The SSH destination's key (ed25519, /etc/ets/backup_ssh_key): created when missing; prints the public key and the
# restricted authorized_keys line for the backup server.
show_backup_ssh_key() {
  [[ -n "${ETS_BACKUP_SSH_TARGET:-}" ]] || return 0
  /usr/local/bin/ets-backup --ssh-key | grep -v '^RESULT '
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

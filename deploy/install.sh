#!/usr/bin/env bash
# ============================================================================
#  ETS — ERP Tracking System : interactive installer for Ubuntu Server 22.04 / 24.04
#
#      sudo bash deploy/install.sh                 # wizard: asks every question, then installs
#      sudo bash deploy/install.sh --dry-run       # asks the questions, writes the config files to
#                                                  # ./ets-dry-run/ and changes nothing on the server
#      sudo bash deploy/install.sh --answers FILE  # take answers from a file (see deploy/answers.example)
#      sudo bash deploy/install.sh --answers FILE --yes   # fully unattended
#
#  Every question can also be pre-answered with an environment variable (ETS_ADDRESS, ETS_TLS, ...).
#  Re-running is safe: previous answers are offered as defaults, the database, APP_SECRET and users
#  are kept, and the administrator password is reset to the one you type.
# ============================================================================
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/ets
CONF=/etc/ets
ENVF=$CONF/ets.env
ANSF=$CONF/install.conf          # non-secret answers, reused as defaults next time
LOGDIR=/var/log/ets
BACKUPS=/var/backups/ets
NODE_MAJOR=22
DRY_RUN=0; ASSUME_YES=0

# ---------------------------------------------------------------- output helpers
B=$'\033[1m'; N=$'\033[0m'; BL=$'\033[1;34m'; YE=$'\033[1;33m'; RE=$'\033[1;31m'; GR=$'\033[1;32m'
say()     { printf '\n%s==> %s%s\n' "$BL" "$*" "$N"; }
step()    { STEP=$((STEP+1)); printf '\n%s[%d/%d] %s%s\n' "$BL" "$STEP" "$STEPS" "$*" "$N"; }
warn()    { printf '%s!!  %s%s\n' "$YE" "$*" "$N" >&2; }
die()     { printf '%sxx  %s%s\n' "$RE" "$*" "$N" >&2; exit 1; }
section() { printf '\n%s── %s ──%s\n' "$B" "$*" "$N"; }
mask()    { [[ -n "${1:-}" ]] && printf '%s' "********" || printf '(generated)'; }

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --answers) shift; [[ -f "${1:-}" ]] || die "answers file not found: ${1:-}"; set -a; . "$1"; set +a ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[[ $EUID -eq 0 || $DRY_RUN -eq 1 ]] || die "Run as root:  sudo bash deploy/install.sh"
if { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; else TTY=/dev/stdin; fi

# ---------------------------------------------------------------- validators
is_ip()       { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && for o in ${1//./ }; do ((o<=255)) || return 1; done; }
is_domain()   { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; }
is_address()  { is_ip "$1" || is_domain "$1" || [[ "$1" == "localhost" ]]; }
is_port()     { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
is_port0()    { [[ "$1" == "0" ]] || is_port "$1"; }
is_ident()    { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }
is_user()     { [[ "$1" =~ ^[A-Za-z0-9._-]{3,60}$ ]]; }
is_email()    { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }
is_email0()   { [[ -z "$1" ]] || is_email "$1"; }
is_name()     { [[ -n "$1" && ${#1} -le 120 ]]; }
is_any()      { true; }
is_file()     { [[ -f "$1" ]]; }
is_file0()    { [[ -z "$1" || -f "$1" ]]; }
is_days()     { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 3650 )); }
is_tz()       { [[ -f "/usr/share/zoneinfo/$1" ]]; }
# DB password: written to env files, so no spaces, quotes, backslash, $ or # (min 12 chars)
is_dbpass()   { [[ ${#1} -ge 12 && ! "$1" =~ [[:space:]\'\"\`\\\$#] ]]; }
is_dbpass0()  { [[ -z "$1" ]] || is_dbpass "$1"; }
# Admin password: same policy as the application (10+ chars, letters and digits, not the username)
is_adminpass() {
  [[ ${#1} -ge 10 && "$1" =~ [A-Za-z] && "$1" =~ [0-9] ]] || return 1
  [[ "${1,,}" != *"${ETS_ADMIN_USER,,}"* ]]
}

# ---------------------------------------------------------------- question helpers
# ask VAR "question" "default" validator "error message"
# If VAR is already set (environment / answers file) it is validated and used without asking.
ask() {
  local var=$1 q=$2 def=${3:-} val=${4:-is_any} err=${5:-invalid value} ans pre="${!1-}" isset=0
  [[ -n "${!1+x}" ]] && isset=1      # pre-answered (an empty value counts as an answer)
  while true; do
    if [[ $isset == 1 ]]; then ans=$pre; isset=0
    else read -rp "  $q${def:+ [$def]}: " ans <"$TTY" || die "no input"; ans=${ans:-$def}; fi
    if $val "$ans"; then printf -v "$var" '%s' "$ans"; return 0; fi
    warn "$err"
    [[ $ASSUME_YES -eq 1 ]] && die "invalid pre-set answer for $var"
  done
}
# ask_secret VAR "question" validator "error" [allow_empty]
ask_secret() {
  local var=$1 q=$2 val=$3 err=$4 empty=${5:-0} a b pre="${!1-}"
  if [[ -n "$pre" ]]; then $val "$pre" || die "$var: $err"; return 0; fi
  [[ $ASSUME_YES -eq 1 && $empty -eq 1 ]] && { printf -v "$var" '%s' ""; return 0; }
  while true; do
    read -rsp "  $q: " a <"$TTY"; echo
    if [[ -z "$a" && $empty -eq 1 ]]; then printf -v "$var" '%s' ""; return 0; fi
    if ! $val "$a"; then warn "$err"; continue; fi
    read -rsp "  Repeat to confirm: " b <"$TTY"; echo
    [[ "$a" == "$b" ]] || { warn "the two entries do not match — try again"; continue; }
    printf -v "$var" '%s' "$a"; return 0
  done
}
# ask_choice VAR "question" default_key "key|label" ...
ask_choice() {
  local var=$1 q=$2 def=$3; shift 3
  local keys=() i=1 n ans pre="${!var-}"
  for o in "$@"; do keys+=("${o%%|*}"); done
  if [[ -n "$pre" ]]; then
    for k in "${keys[@]}"; do [[ "$k" == "$pre" ]] && return 0; done
    die "$var must be one of: ${keys[*]}"
  fi
  echo "  $q"
  for o in "$@"; do printf '    %d) %s\n' "$i" "${o#*|}"; [[ "${o%%|*}" == "$def" ]] && n=$i; i=$((i+1)); done
  while true; do
    read -rp "  Choose [${n:-1}]: " ans <"$TTY"; ans=${ans:-${n:-1}}
    if [[ "$ans" =~ ^[0-9]+$ ]] && (( ans >= 1 && ans <= ${#keys[@]} )); then printf -v "$var" '%s' "${keys[ans-1]}"; return 0; fi
    warn "type a number between 1 and ${#keys[@]}"
  done
}
port_owner() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2; }
check_port_free() {   # warn if another program (not nginx/node/postgres of a previous install) uses the port
  local owner; owner=$(port_owner "$1")
  if [[ -n "$owner" && ! "$owner" =~ ^(nginx|node|postgres)$ ]]; then
    warn "port $1 is already used by '$owner' on this server"
    [[ $ASSUME_YES -eq 1 ]] && die "port $1 busy"
    local c; read -rp "  Use it anyway? [y/N]: " c <"$TTY"; [[ "$c" =~ ^[Yy] ]] || return 1
  fi
  return 0
}

# ---------------------------------------------------------------- defaults from a previous run
DEF_ADDRESS=$(hostname -I 2>/dev/null | awk '{print $1}'); DEF_ADDRESS=${DEF_ADDRESS:-localhost}
DEF_TLS=selfsigned DEF_HTTPS_PORT=443 DEF_HTTP_PORT=80 DEF_API_PORT=3000
DEF_DB_MODE=local DEF_DB_HOST=127.0.0.1 DEF_DB_PORT=5432 DEF_DB_NAME=ets DEF_DB_USER=ets
DEF_ADMIN_USER=admin DEF_ADMIN_NAME="System Administrator" DEF_MFA_MODE=optional
DEF_ORG_NAME_AR="مركز متابعة إنجاز ERP" DEF_ORG_NAME_EN="ERP Implementation Tracking Center"
DEF_TIMEZONE=$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC); DEF_BACKUP_KEEP_DAYS=30 DEF_FIREWALL=yes
DEF_LE_EMAIL="" DEF_CERT="" DEF_KEY=""
OLD_APP_SECRET=""; OLD_DB_PASSWORD=""
if [[ -f "$ANSF" ]]; then . "$ANSF"; say "Previous installation found — its answers are offered as defaults"; fi
if [[ -f "$ENVF" ]]; then
  OLD_APP_SECRET=$(sed -n "s/^APP_SECRET=//p" "$ENVF" | tr -d "'\"")
  OLD_DB_PASSWORD=$(sed -n "s/^PGPASSWORD=//p" "$ENVF" | tr -d "'\"")
fi

# ================================================================= QUESTIONS
cat <<EOF

${B}ETS — ERP Tracking System · installation wizard${N}
Answer the questions below. Press Enter to accept the value in [brackets].
Nothing is changed on the server until you confirm the summary at the end.
EOF

section "1. Address"
echo "  How will users reach the system? Enter a domain name (e.g. ets.company.ly)"
echo "  or the server's IP address (e.g. 10.0.0.15)."
ask ETS_ADDRESS "Domain name or IP address" "$DEF_ADDRESS" is_address "enter a valid domain name (ets.example.ly) or IPv4 address (10.0.0.15)"
if is_ip "$ETS_ADDRESS" || [[ "$ETS_ADDRESS" == localhost ]]; then ADDR_TYPE=ip; else ADDR_TYPE=domain; fi
echo "  → detected: $ADDR_TYPE"

section "2. Security (HTTPS) and ports"
TLS_OPTS=("selfsigned|HTTPS with a self-signed certificate (internal network; browsers warn once)")
[[ $ADDR_TYPE == domain ]] && TLS_OPTS+=("letsencrypt|HTTPS with a free Let's Encrypt certificate (public domain, port 80 reachable from the internet)")
TLS_OPTS+=("existing|HTTPS with my own certificate files (from my organisation / CA)")
TLS_OPTS+=("none|Plain HTTP, no encryption (testing / closed network only — not recommended)")
[[ $ADDR_TYPE == ip && "$DEF_TLS" == letsencrypt ]] && DEF_TLS=selfsigned
ask_choice ETS_TLS "Certificate:" "$DEF_TLS" "${TLS_OPTS[@]}"
[[ $ADDR_TYPE == ip && $ETS_TLS == letsencrypt ]] && die "Let's Encrypt needs a domain name, not an IP address"

if [[ $ETS_TLS == none ]]; then
  until ask ETS_HTTP_PORT "Web port users will open (HTTP)" "$DEF_HTTP_PORT" is_port "port must be 1–65535"; check_port_free "$ETS_HTTP_PORT"; do unset ETS_HTTP_PORT; done
  ETS_HTTPS_PORT=0
else
  until ask ETS_HTTPS_PORT "HTTPS port users will open" "$DEF_HTTPS_PORT" is_port "port must be 1–65535"; check_port_free "$ETS_HTTPS_PORT"; do unset ETS_HTTPS_PORT; done
  if [[ $ETS_TLS == letsencrypt ]]; then
    ETS_HTTP_PORT=80; echo "  HTTP port 80 is used to obtain/renew the certificate and redirect to HTTPS."
  else
    echo "  Optional HTTP port that only redirects to HTTPS (0 = none)."
    until ask ETS_HTTP_PORT "HTTP redirect port" "$DEF_HTTP_PORT" is_port0 "port must be 0–65535"; [[ $ETS_HTTP_PORT == 0 ]] || check_port_free "$ETS_HTTP_PORT"; do unset ETS_HTTP_PORT; done
  fi
  [[ "$ETS_HTTP_PORT" != "$ETS_HTTPS_PORT" ]] || die "HTTP and HTTPS ports must be different"
fi
case $ETS_TLS in
  letsencrypt) ask ETS_LE_EMAIL "E-mail for Let's Encrypt expiry notices" "$DEF_LE_EMAIL" is_email "enter a valid e-mail address" ;;
  existing)
    ask ETS_CERT "Path of the certificate file (fullchain .crt/.pem)" "$DEF_CERT" is_file "file not found"
    ask ETS_KEY  "Path of the private key file (.key/.pem)" "$DEF_KEY" is_file "file not found" ;;
esac
echo "  Internal port of the application service (only nginx talks to it; not opened in the firewall)."
until ask ETS_API_PORT "Internal application port" "$DEF_API_PORT" is_port "port must be 1–65535"; [[ "$ETS_API_PORT" != "$ETS_HTTPS_PORT" && "$ETS_API_PORT" != "$ETS_HTTP_PORT" ]] && check_port_free "$ETS_API_PORT"; do warn "choose a free port different from the web ports"; unset ETS_API_PORT; done

section "3. Database (PostgreSQL)"
ask_choice ETS_DB_MODE "Where should the database run?" "$DEF_DB_MODE" \
  "local|On this server (PostgreSQL is installed and the database is created for you)" \
  "remote|On another, existing PostgreSQL server (the database and user must already exist)"
if [[ $ETS_DB_MODE == local ]]; then
  ETS_DB_HOST=127.0.0.1
else
  ask ETS_DB_HOST "Database server host name or IP" "$( [[ $DEF_DB_HOST == 127.0.0.1 ]] || echo "$DEF_DB_HOST")" is_address "enter a valid host name or IPv4 address"
fi
ask ETS_DB_PORT "Database port" "$DEF_DB_PORT" is_port "port must be 1–65535"
ask ETS_DB_NAME "Database name" "$DEF_DB_NAME" is_ident "lowercase letters, digits and _ only, starting with a letter"
ask ETS_DB_USER "Database user" "$DEF_DB_USER" is_ident "lowercase letters, digits and _ only, starting with a letter"
DBPASS_RULE="at least 12 characters; no spaces, quotes, backslash, \$ or #"
if [[ $ETS_DB_MODE == local ]]; then
  if [[ -n "$OLD_DB_PASSWORD" && -z "${ETS_DB_PASSWORD-}" ]]; then
    echo "  Press Enter to keep the current database password, or type a new one ($DBPASS_RULE)."
  else
    echo "  Type a password for the database user ($DBPASS_RULE), or press Enter to generate a strong one."
  fi
  ask_secret ETS_DB_PASSWORD "Database password" is_dbpass0 "$DBPASS_RULE" 1
  if [[ -z "$ETS_DB_PASSWORD" ]]; then
    if [[ -n "$OLD_DB_PASSWORD" ]]; then ETS_DB_PASSWORD=$OLD_DB_PASSWORD; DB_PW_SOURCE=kept
    else ETS_DB_PASSWORD=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 28); DB_PW_SOURCE=generated; fi
  else DB_PW_SOURCE=entered; fi
else
  ask_secret ETS_DB_PASSWORD "Password of database user '$ETS_DB_USER'" is_dbpass "$DBPASS_RULE" 0
  DB_PW_SOURCE=entered
fi

section "4. First system administrator"
ask ETS_ADMIN_USER  "Administrator username" "$DEF_ADMIN_USER" is_user "3–60 characters: Latin letters, digits, . _ -"
ask ETS_ADMIN_NAME  "Administrator full name" "$DEF_ADMIN_NAME" is_name "enter a name (max 120 characters)"
ask ETS_ADMIN_EMAIL "Administrator e-mail (optional)" "" is_email0 "enter a valid e-mail address or leave empty"
echo "  Password: at least 10 characters with letters and digits, not containing the username."
ask_secret ETS_ADMIN_PASSWORD "Administrator password" is_adminpass "at least 10 characters, letters and digits, must not contain the username" 0

section "5. System options"
ask_choice ETS_MFA_MODE "Two-step verification (2FA) policy:" "$DEF_MFA_MODE" \
  "off|Disabled for all users" \
  "optional|Optional — each user may enable it" \
  "required|Required for all users (each user enrols at first login)"
ask ETS_ORG_NAME_AR "System name in Arabic" "$DEF_ORG_NAME_AR" is_name "enter a name"
ask ETS_ORG_NAME_EN "System name in English" "$DEF_ORG_NAME_EN" is_name "enter a name"
ask ETS_TIMEZONE "Server time zone (e.g. Africa/Tripoli)" "$DEF_TIMEZONE" is_tz "unknown time zone (see: timedatectl list-timezones)"
ask ETS_BACKUP_KEEP_DAYS "Keep daily backups for how many days" "$DEF_BACKUP_KEEP_DAYS" is_days "a number between 1 and 3650"
ask ETS_IMPORT_FILE "Original tracker file to import now (HTML/JSON path, Enter to skip)" "" is_file0 "file not found"
ask_choice ETS_FIREWALL "Configure the firewall (ufw) to allow only SSH and the web ports?" "$DEF_FIREWALL" \
  "yes|Yes (recommended)" "no|No, I manage the firewall myself"

# ---------------------------------------------------------------- derived values
: "${ETS_LE_EMAIL:=}" "${ETS_CERT:=}" "${ETS_KEY:=}"
COOKIE_SECURE=true; [[ $ETS_TLS == none ]] && COOKIE_SECURE=false
if [[ $ETS_TLS == none ]]; then
  URL="http://$ETS_ADDRESS$( [[ $ETS_HTTP_PORT == 80 ]] || echo ":$ETS_HTTP_PORT")"
else
  URL="https://$ETS_ADDRESS$( [[ $ETS_HTTPS_PORT == 443 ]] || echo ":$ETS_HTTPS_PORT")"
fi
case $ETS_TLS in
  selfsigned)  ETS_CERT=/etc/ssl/certs/ets-selfsigned.crt; ETS_KEY=/etc/ssl/private/ets-selfsigned.key ;;
  letsencrypt) ETS_CERT=/etc/letsencrypt/live/$ETS_ADDRESS/fullchain.pem; ETS_KEY=/etc/letsencrypt/live/$ETS_ADDRESS/privkey.pem ;;
  none)        ETS_CERT=""; ETS_KEY="" ;;
esac
SSH_PORT=$( (sshd -T 2>/dev/null || true) | awk '/^port /{print $2; exit}'); SSH_PORT=${SSH_PORT:-22}

# ================================================================= SUMMARY
section "Summary"
cat <<EOF
  Address ............... $ETS_ADDRESS ($ADDR_TYPE)
  Web address ........... ${B}$URL${N}
  Certificate ........... $ETS_TLS${ETS_CERT:+  ($ETS_CERT)}
  HTTPS port ............ $( [[ $ETS_TLS == none ]] && echo "— (HTTP only)" || echo "$ETS_HTTPS_PORT")
  HTTP port ............. $( [[ $ETS_HTTP_PORT == 0 ]] && echo "none" || echo "$ETS_HTTP_PORT$( [[ $ETS_TLS == none ]] || echo " (redirects to HTTPS)")")
  Internal app port ..... $ETS_API_PORT (localhost only)
  Database .............. $ETS_DB_MODE · $ETS_DB_HOST:$ETS_DB_PORT · db "$ETS_DB_NAME" · user "$ETS_DB_USER" · password $DB_PW_SOURCE
  Administrator ......... $ETS_ADMIN_USER ($ETS_ADMIN_NAME)${ETS_ADMIN_EMAIL:+ <$ETS_ADMIN_EMAIL>} · password ********
  2FA policy ............ $ETS_MFA_MODE
  System names .......... $ETS_ORG_NAME_AR / $ETS_ORG_NAME_EN
  Time zone ............. $ETS_TIMEZONE
  Backups ............... daily 01:30, kept $ETS_BACKUP_KEEP_DAYS days in $BACKUPS
  Import data from ...... ${ETS_IMPORT_FILE:-(nothing)}
  Firewall .............. $ETS_FIREWALL$( [[ $ETS_FIREWALL == yes ]] && echo " (SSH $SSH_PORT + web ports)")
EOF
[[ $ETS_TLS == none ]] && warn "Plain HTTP: passwords and 2FA codes travel unencrypted. Use only on a closed network."
if [[ $ASSUME_YES -ne 1 ]]; then
  read -rp "  Proceed with these settings? [y/N]: " ok <"$TTY"
  [[ "$ok" =~ ^([Yy]|[Yy][Ee][Ss]|نعم)$ ]] || die "cancelled — nothing was changed"
fi

# ================================================================= RENDER CONFIG FILES
APP_SECRET=${OLD_APP_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}
render_env() {   # $1 = output file, $2 = 1 to mask secrets
  local pw=$ETS_DB_PASSWORD sec=$APP_SECRET
  [[ "${2:-0}" == 1 ]] && { pw='********'; sec='********'; }
  cat >"$1" <<EOF
# ETS configuration — generated by deploy/install.sh on $(date -Is)
# Keep a copy of this file in a safe place: APP_SECRET is required to read users' 2FA keys.
NODE_ENV=production
HOST=127.0.0.1
PORT=$ETS_API_PORT
APP_SECRET='$sec'

PGHOST=$ETS_DB_HOST
PGPORT=$ETS_DB_PORT
PGDATABASE=$ETS_DB_NAME
PGUSER=$ETS_DB_USER
PGPASSWORD='$pw'
PGPOOL_MAX=10

SESSION_TTL_HOURS=12
SESSION_IDLE_MINUTES=60
COOKIE_SECURE=$COOKIE_SECURE

MAX_FAILED_LOGINS=5
LOCK_MINUTES=15
BCRYPT_ROUNDS=12
TRUST_PROXY=loopback

LOG_DIR=$LOGDIR
LOG_LEVEL=info
ACCESS_LOG_DB=true

ETS_BACKUP_DIR=$BACKUPS
ETS_BACKUP_KEEP_DAYS=$ETS_BACKUP_KEEP_DAYS
EOF
}
render_answers() {
  cat >"$1" <<EOF
# Answers of the last ETS installation (no secrets) — used as defaults when install.sh runs again.
DEF_ADDRESS='$ETS_ADDRESS'
DEF_TLS='$ETS_TLS'
DEF_HTTPS_PORT='$( [[ $ETS_HTTPS_PORT == 0 ]] && echo 443 || echo "$ETS_HTTPS_PORT")'
DEF_HTTP_PORT='$ETS_HTTP_PORT'
DEF_API_PORT='$ETS_API_PORT'
DEF_LE_EMAIL='$ETS_LE_EMAIL'
DEF_CERT='$( [[ $ETS_TLS == existing ]] && echo "$ETS_CERT")'
DEF_KEY='$( [[ $ETS_TLS == existing ]] && echo "$ETS_KEY")'
DEF_DB_MODE='$ETS_DB_MODE'
DEF_DB_HOST='$ETS_DB_HOST'
DEF_DB_PORT='$ETS_DB_PORT'
DEF_DB_NAME='$ETS_DB_NAME'
DEF_DB_USER='$ETS_DB_USER'
DEF_ADMIN_USER='$ETS_ADMIN_USER'
DEF_ADMIN_NAME='${ETS_ADMIN_NAME//\'/}'
DEF_MFA_MODE='$ETS_MFA_MODE'
DEF_ORG_NAME_AR='${ETS_ORG_NAME_AR//\'/}'
DEF_ORG_NAME_EN='${ETS_ORG_NAME_EN//\'/}'
DEF_TIMEZONE='$ETS_TIMEZONE'
DEF_BACKUP_KEEP_DAYS='$ETS_BACKUP_KEEP_DAYS'
DEF_FIREWALL='$ETS_FIREWALL'
EOF
}
render_nginx() {   # $1 = site file, $2 = snippet file, $3 = 1 for the temporary ACME-only site
  local t="$SRC/deploy/nginx" target
  sed "s|__API_PORT__|$ETS_API_PORT|g" "$t/ets-app.conf.tpl" >"$2"
  target="https://\$host$( [[ $ETS_HTTPS_PORT == 443 ]] || echo ":$ETS_HTTPS_PORT")"
  if [[ "${3:-0}" == 1 ]]; then
    sed -e "s|__SERVER_NAME__|$ETS_ADDRESS|g" -e "s|__HTTP_PORT__|$ETS_HTTP_PORT|g" -e "s|__REDIRECT_TARGET__|$target|g" \
      "$t/ets-redirect.conf.tpl" >"$1"
    no_ipv6 "$1"; return
  fi
  if [[ $ETS_TLS == none ]]; then
    sed -e "s|__SERVER_NAME__|$ETS_ADDRESS|g" -e "s|__HTTP_PORT__|$ETS_HTTP_PORT|g" -e "s|__API_PORT__|$ETS_API_PORT|g" \
      "$t/ets-http.conf.tpl" >"$1"
  else
    sed -e "s|__SERVER_NAME__|$ETS_ADDRESS|g" -e "s|__HTTPS_PORT__|$ETS_HTTPS_PORT|g" -e "s|__API_PORT__|$ETS_API_PORT|g" \
      -e "s|__SSL_CERT__|$ETS_CERT|g" -e "s|__SSL_KEY__|$ETS_KEY|g" "$t/ets-https.conf.tpl" >"$1"
    if [[ $ETS_HTTP_PORT != 0 ]]; then
      { echo; sed -e "s|__SERVER_NAME__|$ETS_ADDRESS|g" -e "s|__HTTP_PORT__|$ETS_HTTP_PORT|g" -e "s|__REDIRECT_TARGET__|$target|g" \
          "$t/ets-redirect.conf.tpl" | grep -v '^# Placeholders'; } >>"$1"
    fi
  fi
  no_ipv6 "$1"
}
# servers with IPv6 disabled cannot bind [::] — drop those listen lines there
no_ipv6() { [[ -s /proc/net/if_inet6 ]] || sed -i '/listen \[::\]/d' "$1"; }

if [[ $DRY_RUN -eq 1 ]]; then
  OUT="$PWD/ets-dry-run"; mkdir -p "$OUT"
  render_env "$OUT/ets.env" 1
  render_answers "$OUT/install.conf"
  render_nginx "$OUT/nginx-site-ets" "$OUT/nginx-snippet-ets-app.conf"
  say "Dry run finished — nothing was installed. Files that would be written (secrets masked):"
  ls -1 "$OUT" | sed "s|^|  $OUT/|"
  exit 0
fi

# ================================================================= INSTALL
touch /var/log/ets-install.log && chmod 600 /var/log/ets-install.log
exec > >(tee -a /var/log/ets-install.log) 2>&1
STEP=0; STEPS=13
export DEBIAN_FRONTEND=noninteractive

step "System packages"
PKGS=(ca-certificates curl gnupg rsync openssl nginx logrotate cron)
[[ $ETS_DB_MODE == local ]] && PKGS+=(postgresql postgresql-contrib) || PKGS+=(postgresql-client)
[[ $ETS_FIREWALL == yes ]] && PKGS+=(ufw)
[[ $ETS_TLS == letsencrypt ]] && PKGS+=(certbot)
apt-get update -y
apt-get install -y "${PKGS[@]}"
if ! command -v node >/dev/null || (( $(node -v | sed 's/v\([0-9]*\).*/\1/') < 20 )); then
  echo "Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "node $(node -v), npm $(npm -v)"

step "Time zone and clock (2FA codes need the correct time)"
timedatectl set-timezone "$ETS_TIMEZONE" || warn "could not set the time zone"
timedatectl set-ntp true 2>/dev/null || warn "could not enable NTP — make sure the clock is synchronised"

step "System user and directories"
id -u ets >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin ets
mkdir -p "$APP" "$CONF" "$LOGDIR" "$BACKUPS"
# the ets service user must be able to enter /etc/ets to read ets.env (the file itself stays 640 root:ets)
chown root:ets "$CONF"; chown ets:ets "$LOGDIR"; chown root:root "$BACKUPS"
chmod 750 "$CONF" "$LOGDIR" "$BACKUPS"

step "Copying the application to $APP"
rsync -a --delete --exclude node_modules --exclude .git --exclude 'backend/.env' --exclude 'backend/logs*' \
  --exclude 'frontend/dist' --exclude 'ets-dry-run' "$SRC/" "$APP/"

step "Database"
export PGHOST=$ETS_DB_HOST PGPORT=$ETS_DB_PORT PGDATABASE=$ETS_DB_NAME PGUSER=$ETS_DB_USER PGPASSWORD=$ETS_DB_PASSWORD
if [[ $ETS_DB_MODE == local ]]; then
  systemctl enable --now postgresql
  CLUSTER=$(pg_lsclusters -h | awk 'NR==1{print $1" "$2}')
  CUR_PORT=$(pg_lsclusters -h | awk 'NR==1{print $3}')
  if [[ "$CUR_PORT" != "$ETS_DB_PORT" ]]; then
    echo "Moving PostgreSQL cluster $CLUSTER from port $CUR_PORT to $ETS_DB_PORT"
    pg_conftool $CLUSTER set port "$ETS_DB_PORT"
    systemctl restart postgresql
  fi
  PSQL_SU=(sudo -u postgres psql -p "$ETS_DB_PORT" -v ON_ERROR_STOP=1 -qtA)
  if "${PSQL_SU[@]}" -c "SELECT 1 FROM pg_roles WHERE rolname='$ETS_DB_USER'" | grep -q 1; then
    echo "Role '$ETS_DB_USER' exists — setting its password"
    "${PSQL_SU[@]}" -v u="$ETS_DB_USER" -v p="$ETS_DB_PASSWORD" <<<'ALTER ROLE :"u" WITH LOGIN PASSWORD :'"'"'p'"'"';'
    if ! "${PSQL_SU[@]}" -c "SELECT 1 FROM pg_database WHERE datname='$ETS_DB_NAME'" | grep -q 1; then
      "${PSQL_SU[@]}" -v d="$ETS_DB_NAME" -v u="$ETS_DB_USER" <<<'CREATE DATABASE :"d" OWNER :"u" ENCODING '"'UTF8'"' TEMPLATE template0;'
      "${PSQL_SU[@]}" -d "$ETS_DB_NAME" -v u="$ETS_DB_USER" <<<'CREATE EXTENSION IF NOT EXISTS citext; ALTER SCHEMA public OWNER TO :"u";'
    fi
  else
    "${PSQL_SU[@]}" -v db_name="$ETS_DB_NAME" -v db_user="$ETS_DB_USER" -v db_password="$ETS_DB_PASSWORD" \
      -f "$APP/deploy/db/create-database.sql"
  fi
fi
echo "Testing the connection to $ETS_DB_HOST:$ETS_DB_PORT/$ETS_DB_NAME as $ETS_DB_USER"
psql -qtAc "SELECT version()" || die "cannot connect to the database with the given host/port/name/user/password"
if ! psql -qtAc "CREATE EXTENSION IF NOT EXISTS citext" >/dev/null 2>&1; then
  psql -qtAc "SELECT 1 FROM pg_extension WHERE extname='citext'" | grep -q 1 || \
    die "the 'citext' extension is missing; ask the DBA to run in database $ETS_DB_NAME:  CREATE EXTENSION citext;"
fi

step "Configuration ($ENVF)"
[[ -f "$ENVF" ]] && cp -p "$ENVF" "$ENVF.bak-$(date +%Y%m%d%H%M%S)"
render_env "$ENVF"; chown root:ets "$ENVF"; chmod 640 "$ENVF"
sudo -u ets test -r "$ENVF" || die "the 'ets' user cannot read $ENVF — check the permissions of $CONF"
render_answers "$ANSF"; chmod 644 "$ANSF"
[[ -n "$OLD_APP_SECRET" ]] && echo "Kept the existing APP_SECRET" || echo "Generated a new APP_SECRET"

step "Installing the application (backend packages, frontend build)"
cd "$APP/backend" && npm ci --omit=dev --no-audit --no-fund
cd "$APP/frontend" && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules
chown -R root:root "$APP"; chmod -R a+rX "$APP"

step "Database tables, catalog, administrator and settings"
RUN=(sudo -u ets env ETS_ENV_FILE="$ENVF")
cd "$APP/backend"
"${RUN[@]}" node src/db/migrate.js
"${RUN[@]}" node src/db/seed.js
# password passed through the environment (not the command line, so it never shows in `ps`)
ETS_ADMIN_PASSWORD="$ETS_ADMIN_PASSWORD" sudo --preserve-env=ETS_ADMIN_PASSWORD -u ets env ETS_ENV_FILE="$ENVF" node scripts/create-admin.js \
  --username "$ETS_ADMIN_USER" --name "$ETS_ADMIN_NAME" ${ETS_ADMIN_EMAIL:+--email "$ETS_ADMIN_EMAIL"}
"${RUN[@]}" node scripts/set-setting.js mfa.mode "$ETS_MFA_MODE"
"${RUN[@]}" node scripts/set-setting.js app.org_name_ar "$ETS_ORG_NAME_AR"
"${RUN[@]}" node scripts/set-setting.js app.org_name_en "$ETS_ORG_NAME_EN"
if [[ -n "$ETS_IMPORT_FILE" ]]; then
  cp "$ETS_IMPORT_FILE" /tmp/ets-import.$$ && chmod 644 /tmp/ets-import.$$
  "${RUN[@]}" node scripts/import-legacy.js /tmp/ets-import.$$; rm -f /tmp/ets-import.$$
fi

step "Certificate ($ETS_TLS)"
NGX_SITE=/etc/nginx/sites-available/ets; NGX_SNIP=/etc/nginx/snippets/ets-app.conf
mkdir -p /etc/nginx/snippets /var/www/letsencrypt
rm -f /etc/nginx/sites-enabled/default
ln -sf "$NGX_SITE" /etc/nginx/sites-enabled/ets
case $ETS_TLS in
  selfsigned)
    if [[ ! -f "$ETS_CERT" ]] || ! openssl x509 -in "$ETS_CERT" -noout -checkend 2592000 >/dev/null; then
      SAN="DNS:$ETS_ADDRESS"; is_ip "$ETS_ADDRESS" && SAN="IP:$ETS_ADDRESS"
      openssl req -x509 -nodes -newkey rsa:2048 -days 1095 -subj "/CN=$ETS_ADDRESS" \
        -addext "subjectAltName=$SAN" -keyout "$ETS_KEY" -out "$ETS_CERT"
      chmod 600 "$ETS_KEY"
    fi
    echo "Self-signed certificate: $ETS_CERT (valid 3 years). Import it on client PCs to avoid the browser warning." ;;
  existing)
    openssl x509 -in "$ETS_CERT" -noout -subject -enddate || die "the certificate file is not valid" ;;
  letsencrypt)
    if [[ ! -f "$ETS_CERT" ]]; then
      render_nginx "$NGX_SITE" "$NGX_SNIP" 1          # temporary port-80 site for the challenge
      nginx -t && systemctl restart nginx
      certbot certonly --webroot -w /var/www/letsencrypt -d "$ETS_ADDRESS" --non-interactive --agree-tos \
        -m "$ETS_LE_EMAIL" --deploy-hook "systemctl reload nginx" \
        || die "Let's Encrypt failed: check that $ETS_ADDRESS points to this server and port 80 is reachable from the internet"
    fi ;;
esac

step "Web server (nginx)"
render_nginx "$NGX_SITE" "$NGX_SNIP"
nginx -t
systemctl enable nginx && systemctl restart nginx

step "Application service, log rotation and backups"
install -m 644 "$APP/deploy/systemd/ets-backend.service" /etc/systemd/system/ets-backend.service
install -m 644 "$APP/deploy/logrotate/ets" /etc/logrotate.d/ets
install -m 755 "$APP/deploy/scripts/backup.sh" /usr/local/bin/ets-backup
install -m 755 "$APP/deploy/scripts/restore.sh" /usr/local/bin/ets-restore
echo "30 1 * * * root /usr/local/bin/ets-backup >> $LOGDIR/backup.log 2>&1" > /etc/cron.d/ets-backup
if [[ $ETS_DB_MODE == local ]]; then
  sed -i 's/^After=.*/After=network-online.target postgresql.service/; s/^#\?Requires=.*/Requires=postgresql.service/' /etc/systemd/system/ets-backend.service
else
  sed -i 's/^After=.*/After=network-online.target/; /^Requires=postgresql.service/d' /etc/systemd/system/ets-backend.service
fi
systemctl daemon-reload
systemctl enable ets-backend
systemctl restart ets-backend

step "Firewall"
if [[ $ETS_FIREWALL == yes ]]; then
  ufw allow "$SSH_PORT/tcp" comment 'SSH' >/dev/null
  [[ $ETS_TLS != none ]] && ufw allow "$ETS_HTTPS_PORT/tcp" comment 'ETS HTTPS' >/dev/null
  [[ $ETS_HTTP_PORT != 0 ]] && ufw allow "$ETS_HTTP_PORT/tcp" comment 'ETS HTTP' >/dev/null
  ufw --force enable >/dev/null
  ufw status verbose | sed -n '1,20p'
else
  echo "Skipped — open these ports yourself: $( [[ $ETS_TLS != none ]] && echo "$ETS_HTTPS_PORT ")$( [[ $ETS_HTTP_PORT != 0 ]] && echo "$ETS_HTTP_PORT")"
fi

step "Checks and first backup"
ok=0
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$ETS_API_PORT/api/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
[[ $ok == 1 ]] && echo "✓ application service answers on port $ETS_API_PORT" || warn "application not answering — see: journalctl -u ets-backend -n 50"
if [[ $ETS_TLS == none ]]; then CHECK="http://127.0.0.1:$ETS_HTTP_PORT/api/health"; else CHECK="https://127.0.0.1:$ETS_HTTPS_PORT/api/health"; fi
curl -fsSk "$CHECK" >/dev/null && echo "✓ web server answers on $CHECK" || warn "web server check failed: $CHECK"
/usr/local/bin/ets-backup >> "$LOGDIR/backup.log" 2>&1 && echo "✓ first backup created in $BACKUPS" || warn "first backup failed — see $LOGDIR/backup.log"

# ================================================================= DONE
cat <<EOF

${GR}════════════════════════════════════════════════════════════════════${N}
${GR}  ETS is installed${N}

  Open:            ${B}$URL${N}
  Administrator:   $ETS_ADMIN_USER  (the password you entered)
  2FA policy:      $ETS_MFA_MODE
  Database:        $ETS_DB_NAME on $ETS_DB_HOST:$ETS_DB_PORT, user $ETS_DB_USER
EOF
# shown on the terminal only, never written to the install log
[[ $DB_PW_SOURCE == generated ]] && printf '  DB password:     %s   (generated — also stored in %s)\n' "$ETS_DB_PASSWORD" "$ENVF" >"$TTY" 2>/dev/null || true
cat <<EOF

  Configuration:   $ENVF        ${YE}← copy it to a safe place (contains APP_SECRET)${N}
  Logs:            $LOGDIR/  ·  journalctl -u ets-backend
  Backups:         $BACKUPS/ (daily 01:30, $ETS_BACKUP_KEEP_DAYS days)  ·  sudo ets-backup  ·  sudo ets-restore <file>
  Install log:     /var/log/ets-install.log
  Service:         sudo systemctl status|restart ets-backend
${GR}════════════════════════════════════════════════════════════════════${N}
EOF
[[ $ETS_TLS == selfsigned ]] && echo "Note: browsers will warn about the self-signed certificate until it is trusted on the client PCs."
exit 0

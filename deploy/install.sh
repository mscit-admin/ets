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
#  The site is always served over HTTPS (self-signed, Let's Encrypt or your own certificate).
# ============================================================================
set -euo pipefail
umask 022

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/ets
CONF=/etc/ets
ENVF=$CONF/ets.env
ANSF=$CONF/install.conf          # non-secret answers, reused as defaults next time
LOGDIR=/var/log/ets
BACKUPS=/var/backups/ets
DB_CA=$CONF/db-ca.crt            # copy of the remote database server's CA certificate (verify-ca/full)
DRY_RUN=0; ASSUME_YES=0

# ---------------------------------------------------------------- output helpers
B=$'\033[1m'; N=$'\033[0m'; BL=$'\033[1;34m'; YE=$'\033[1;33m'; RE=$'\033[1;31m'; GR=$'\033[1;32m'
say()     { printf '\n%s==> %s%s\n' "$BL" "$*" "$N"; }
step()    { STEP=$((STEP+1)); printf '\n%s[%d/%d] %s%s\n' "$BL" "$STEP" "$STEPS" "$*" "$N"; }
warn()    { printf '%s!!  %s%s\n' "$YE" "$*" "$N" >&2; }
die()     { printf '%sxx  %s%s\n' "$RE" "$*" "$N" >&2; exit 1; }
section() { printf '\n%s── %s ──%s\n' "$B" "$*" "$N"; }
mask()    { [[ -n "${1:-}" ]] && printf '%s' "********" || printf '(generated)'; }
# shellcheck source=deploy/scripts/deploy-lib.sh
. "$SRC/deploy/scripts/deploy-lib.sh"

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    # the answers file is read as KEY=value data (never executed); only ETS_* names are used
    --answers) shift; [[ -f "${1:-}" ]] || die "answers file not found: ${1:-}"
               read_kv "$1" '^ETS_[A-Z0-9_]+$' || die "fix the answers file $1"; ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[[ $EUID -eq 0 || $DRY_RUN -eq 1 ]] || die "Run as root:  sudo bash deploy/install.sh"
if { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; else TTY=/dev/stdin; fi

# ---------------------------------------------------------------- validators (is_ip: deploy-lib.sh)
is_domain()   { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; }
is_address()  { is_ip "$1" || is_domain "$1" || [[ "$1" == "localhost" ]]; }
is_port()     { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
is_port0()    { [[ "$1" == "0" ]] || is_port "$1"; }
is_ident()    { [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }
is_user()     { [[ "$1" =~ ^[A-Za-z0-9._-]{3,60}$ ]]; }
is_email()    { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
is_email0()   { [[ -z "$1" ]] || is_email "$1"; }
is_name()     { [[ -n "$1" && ${#1} -le 120 ]]; }
is_any()      { true; }
# file paths end up in nginx / env files: plain characters only
is_safepath() { [[ "$1" =~ ^/[A-Za-z0-9._/@+-]+$ ]]; }
is_file()     { is_safepath "$1" && [[ -f "$1" ]]; }
is_file0()    { [[ -z "$1" ]] || is_file "$1"; }
is_days()     { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 3650 )); }
is_tz()       { [[ -f "/usr/share/zoneinfo/$1" ]]; }
# example / placeholder passwords (deploy/answers.example, docs) are never accepted
not_example() { [[ ! "${1,,}" =~ change.?me|example|placeholder|password|passw0rd|secret|devpass ]]; }
# DB password: printable ASCII, written to env files, so no spaces, quotes, backslash, $ or # (min 12 chars)
is_dbpass()   { local LC_ALL=C; [[ ${#1} -ge 12 && "$1" =~ ^[!-~]+$ && ! "$1" =~ [\'\"\`\\\$#] ]] && not_example "$1"; }
is_dbpass0()  { [[ -z "$1" ]] || is_dbpass "$1"; }
# Admin password: same policy as the application for administrators (12+ characters, at most 72 bytes,
# letters and digits, not the username, not a common/example password — create-admin checks it again)
is_adminpass() {
  [[ ${#1} -ge 12 && "$1" =~ [A-Za-z] && "$1" =~ [0-9] ]] || return 1
  (( $(printf '%s' "$1" | wc -c) <= 72 )) || return 1
  [[ "${1,,}" != *"${ETS_ADMIN_USER,,}"* ]] && not_example "$1"
}
is_sslmode()  { [[ "$1" =~ ^(require|verify-ca|verify-full)$ ]]; }
# offsite backup destinations (1.12.0) — the same strict rules as deploy/scripts/backup-lib.sh and the web UI
is_ssh_target0() { [[ -z "$1" ]] || { [[ "$1" =~ ^[a-z_][a-z0-9_.-]{0,31}@[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?:[A-Za-z0-9._/+-]{0,200}$ ]] && [[ ! "${1#*:}" =~ (^|/)\.\.(/|$) && "${1#*:}" != -* ]]; }; }
is_nas_dir0()    { [[ -z "$1" ]] || { is_safepath "$1" && [[ "$1" =~ ^/(mnt|media|srv)/[A-Za-z0-9._@+-] && ! "$1" =~ (^|/)\.\.(/|$) ]]; }; }
is_remote0()     { [[ -z "$1" ]] || { [[ "$1" =~ ^[A-Za-z0-9_-]{1,40}:[A-Za-z0-9._/-]{0,200}$ ]] && [[ ! "${1#*:}" =~ (^|/)\.\.(/|$) ]]; }; }

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
    read -rsp "  $q: " a <"$TTY" || die "no input for $var"; echo
    if [[ -z "$a" && $empty -eq 1 ]]; then printf -v "$var" '%s' ""; return 0; fi
    if ! $val "$a"; then warn "$err"; continue; fi
    read -rsp "  Repeat to confirm: " b <"$TTY" || die "no input"; echo
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
DEF_LE_EMAIL="" DEF_CERT="" DEF_KEY="" DEF_DB_SSLMODE="" DEF_DB_SSLROOTCERT=""
OLD_APP_SECRET=""; OLD_DB_PASSWORD=""
# previous answers are read as data (never executed)
if [[ -f "$ANSF" ]]; then
  read_kv "$ANSF" '^DEF_[A-Z0-9_]+$' || die "cannot read $ANSF"
  say "Previous installation found — its answers are offered as defaults"
fi
if [[ "$DEF_TLS" == none ]]; then
  warn "The previous installation used plain HTTP, which is no longer offered: choose a certificate now."
  DEF_TLS=selfsigned
fi
if [[ -f "$ENVF" ]]; then
  OLD_APP_SECRET=$(env_get "$ENVF" APP_SECRET)
  OLD_DB_PASSWORD=$(env_get "$ENVF" PGPASSWORD)
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
[[ $ADDR_TYPE == ip && "$DEF_TLS" == letsencrypt ]] && DEF_TLS=selfsigned
# plain HTTP (passwords, 2FA codes and session cookies in clear text) is not offered any more
[[ "${ETS_TLS-}" == none ]] && die "ETS_TLS=none (plain HTTP) is no longer supported: use selfsigned, letsencrypt or existing"
ask_choice ETS_TLS "Certificate:" "$DEF_TLS" "${TLS_OPTS[@]}"
[[ $ADDR_TYPE == ip && $ETS_TLS == letsencrypt ]] && die "Let's Encrypt needs a domain name, not an IP address"

until ask ETS_HTTPS_PORT "HTTPS port users will open" "$DEF_HTTPS_PORT" is_port "port must be 1–65535"; check_port_free "$ETS_HTTPS_PORT"; do unset ETS_HTTPS_PORT; done
if [[ $ETS_TLS == letsencrypt ]]; then
  ETS_HTTP_PORT=80; echo "  HTTP port 80 is used to obtain/renew the certificate and redirect to HTTPS."
else
  echo "  Optional HTTP port that only redirects to HTTPS (0 = none)."
  until ask ETS_HTTP_PORT "HTTP redirect port" "$DEF_HTTP_PORT" is_port0 "port must be 0–65535"; [[ $ETS_HTTP_PORT == 0 ]] || check_port_free "$ETS_HTTP_PORT"; do unset ETS_HTTP_PORT; done
fi
[[ "$ETS_HTTP_PORT" != "$ETS_HTTPS_PORT" ]] || die "HTTP and HTTPS ports must be different"
case $ETS_TLS in
  letsencrypt) ask ETS_LE_EMAIL "E-mail for Let's Encrypt expiry notices" "$DEF_LE_EMAIL" is_email "enter a valid e-mail address" ;;
  existing)
    ask ETS_CERT "Path of the certificate file (fullchain .crt/.pem)" "$DEF_CERT" is_file "file not found"
    ask ETS_KEY  "Path of the private key file (.key/.pem)" "$DEF_KEY" is_file "file not found" ;;
esac
# letters, digits and . _ / @ + - only in the certificate paths (they are written into the nginx site)
for f in "${ETS_CERT:-}" "${ETS_KEY:-}"; do [[ -z "$f" ]] || is_safepath "$f" || die "unsupported characters in the path $f"; done
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
DBPASS_RULE="at least 12 printable characters; no spaces, quotes, backslash, \$ or #; not an example value"
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
  # A remote database is always reached over TLS (the application refuses an unencrypted remote connection).
  echo "  The connection to the database server is encrypted (TLS). To also verify the server's certificate,"
  echo "  give the CA certificate (PEM) that signed it; press Enter to encrypt without verification."
  [[ $ASSUME_YES -eq 1 ]] && : "${ETS_DB_SSLROOTCERT=$DEF_DB_SSLROOTCERT}"   # unattended: no CA unless given
  ask ETS_DB_SSLROOTCERT "CA certificate of the database server (path, optional)" "$DEF_DB_SSLROOTCERT" is_file0 "file not found (letters, digits and . _ / @ + - only)"
  if [[ -n "$ETS_DB_SSLROOTCERT" ]]; then
    openssl x509 -in "$ETS_DB_SSLROOTCERT" -noout >/dev/null 2>&1 || die "$ETS_DB_SSLROOTCERT is not a PEM certificate"
    def=verify-full; [[ "$DEF_DB_SSLMODE" == verify-ca ]] && def=verify-ca
    [[ $ASSUME_YES -eq 1 ]] && : "${ETS_DB_SSLMODE=$def}"
    ask ETS_DB_SSLMODE "TLS mode: verify-full (certificate and host name) or verify-ca (certificate only)" "$def" is_sslmode "verify-full or verify-ca"
    [[ $ETS_DB_SSLMODE != require ]] || ETS_DB_SSLMODE=verify-full
  else
    ETS_DB_SSLMODE=require
    warn "TLS without certificate verification protects against eavesdropping, not against an active man-in-the-middle."
  fi
fi
: "${ETS_DB_SSLMODE:=}" "${ETS_DB_SSLROOTCERT:=}"

section "4. First system administrator"
ask ETS_ADMIN_USER  "Administrator username" "$DEF_ADMIN_USER" is_user "3–60 characters: Latin letters, digits, . _ -"
ask ETS_ADMIN_NAME  "Administrator full name" "$DEF_ADMIN_NAME" is_name "enter a name (max 120 characters)"
ask ETS_ADMIN_EMAIL "Administrator e-mail (optional)" "" is_email0 "enter a valid e-mail address or leave empty"
echo "  Password: at least 12 characters with letters and digits, not containing the username, not a common word."
# a password written in an answers file / environment variable is temporary: it must be changed at first sign-in
ADMIN_PW_PRESET=0; [[ -n "${ETS_ADMIN_PASSWORD-}" ]] && ADMIN_PW_PRESET=1
ask_secret ETS_ADMIN_PASSWORD "Administrator password" is_adminpass "at least 12 characters (max 72 bytes), letters and digits, must not contain the username or an example/common word" 0

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

section "6. Offsite copies of the backups (optional — can also be set later in Settings → «النسخ الاحتياطي»)"
echo "  Backups run every hour and stay on this server. Copies elsewhere protect against losing the server."
echo "  Any combination; press Enter to skip a destination. Used only at the first installation (then the web UI)."
[[ $ASSUME_YES -eq 1 ]] && : "${ETS_BACKUP_SSH_TARGET=}" "${ETS_BACKUP_NAS_DIR=}" "${ETS_BACKUP_RCLONE_REMOTE=}"
ask ETS_BACKUP_SSH_TARGET "Another server over SSH (user@host:/path, e.g. etsbackup@10.0.0.30:/srv/backups/ets)" "" is_ssh_target0 "user@host:/path — letters, digits and . _ / + - only"
ask ETS_BACKUP_NAS_DIR "Mounted NAS directory (NFS / SMB mount point under /mnt, /media or /srv)" "" is_nas_dir0 "an absolute path under /mnt, /media or /srv"
ask ETS_BACKUP_RCLONE_REMOTE "rclone remote of /etc/ets/rclone.conf (name:bucket/path; S3 keys can be entered in the web UI instead)" "" is_remote0 "name:bucket/path"


# ---------------------------------------------------------------- derived values
: "${ETS_LE_EMAIL:=}" "${ETS_CERT:=}" "${ETS_KEY:=}"
URL="https://$ETS_ADDRESS$( [[ $ETS_HTTPS_PORT == 443 ]] || echo ":$ETS_HTTPS_PORT")"
case $ETS_TLS in
  selfsigned)  ETS_CERT=/etc/ssl/certs/ets-selfsigned.crt; ETS_KEY=/etc/ssl/private/ets-selfsigned.key ;;
  letsencrypt) ETS_CERT=/etc/letsencrypt/live/$ETS_ADDRESS/fullchain.pem; ETS_KEY=/etc/letsencrypt/live/$ETS_ADDRESS/privkey.pem ;;
esac
SSH_PORT=$( (sshd -T 2>/dev/null || true) | awk '/^port /{print $2; exit}'); SSH_PORT=${SSH_PORT:-22}

# ================================================================= SUMMARY
section "Summary"
cat <<EOF
  Address ............... $ETS_ADDRESS ($ADDR_TYPE)
  Web address ........... ${B}$URL${N}
  Certificate ........... $ETS_TLS${ETS_CERT:+  ($ETS_CERT)}
  HTTPS port ............ $ETS_HTTPS_PORT
  HTTP port ............. $( [[ $ETS_HTTP_PORT == 0 ]] && echo "none" || echo "$ETS_HTTP_PORT (redirects to HTTPS)")
  Internal app port ..... $ETS_API_PORT (localhost only)
  Database .............. $ETS_DB_MODE · $ETS_DB_HOST:$ETS_DB_PORT · db "$ETS_DB_NAME" · user "$ETS_DB_USER" · password $DB_PW_SOURCE${ETS_DB_SSLMODE:+ · TLS $ETS_DB_SSLMODE}
  Administrator ......... $ETS_ADMIN_USER ($ETS_ADMIN_NAME)${ETS_ADMIN_EMAIL:+ <$ETS_ADMIN_EMAIL>} · password ********$( [[ $ADMIN_PW_PRESET == 1 ]] && echo " (must be changed at first sign-in)")
  2FA policy ............ $ETS_MFA_MODE
  System names .......... $ETS_ORG_NAME_AR / $ETS_ORG_NAME_EN
  Time zone ............. $ETS_TIMEZONE
  Backups ............... every hour, encrypted, in $BACKUPS (48 h hourly, ${ETS_BACKUP_KEEP_DAYS} days daily, 12 weeks, 12 months)
  Offsite copies ........ ${ETS_BACKUP_SSH_TARGET:+SSH $ETS_BACKUP_SSH_TARGET  }${ETS_BACKUP_NAS_DIR:+NAS $ETS_BACKUP_NAS_DIR  }${ETS_BACKUP_RCLONE_REMOTE:+cloud $ETS_BACKUP_RCLONE_REMOTE}$( [[ -z "$ETS_BACKUP_SSH_TARGET$ETS_BACKUP_NAS_DIR$ETS_BACKUP_RCLONE_REMOTE" ]] && echo "none (set them later in Settings → «النسخ الاحتياطي»)")
  Import data from ...... ${ETS_IMPORT_FILE:-(nothing)}
  Firewall .............. $ETS_FIREWALL$( [[ $ETS_FIREWALL == yes ]] && echo " (SSH $SSH_PORT + web ports)")
EOF
if [[ $ASSUME_YES -ne 1 ]]; then
  read -rp "  Proceed with these settings? [y/N]: " ok <"$TTY"
  [[ "$ok" =~ ^([Yy]|[Yy][Ee][Ss]|نعم)$ ]] || die "cancelled — nothing was changed"
fi

# ================================================================= RENDER CONFIG FILES
APP_SECRET=${OLD_APP_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}
if [[ ${#APP_SECRET} -lt 32 ]] || ! not_example "$APP_SECRET"; then
  warn "the APP_SECRET in $ENVF looks like a placeholder: the application will refuse to start."
  warn "See docs/handover/06-Security.md (APP_SECRET rotation) to replace it."
fi
OLD_APP_SECRET_OLD=$( [[ -f "$ENVF" ]] && env_get "$ENVF" APP_SECRET_OLD || true)   # a rotation in progress
render_env() {   # $1 = output file, $2 = 1 to mask secrets
  local pw=$ETS_DB_PASSWORD sec=$APP_SECRET old=$OLD_APP_SECRET_OLD
  [[ "${2:-0}" == 1 ]] && { pw='********'; sec='********'; [[ -z "$old" ]] || old='********'; }
  cat >"$1" <<EOF
# ETS configuration — generated by deploy/install.sh on $(date -Is)
# Keep a copy of this file in a safe place (NOT with the backups): APP_SECRET is required to read users' 2FA keys.
NODE_ENV=production
HOST=127.0.0.1
PORT=$ETS_API_PORT
APP_SECRET='$sec'${old:+
APP_SECRET_OLD='$old'}

PGHOST=$ETS_DB_HOST
PGPORT=$ETS_DB_PORT
PGDATABASE=$ETS_DB_NAME
PGUSER=$ETS_DB_USER
PGPASSWORD='$pw'
PGPOOL_MAX=10${ETS_DB_SSLMODE:+
# TLS to the database server
PGSSLMODE=$ETS_DB_SSLMODE}${ETS_DB_SSLROOTCERT:+
PGSSLROOTCERT=$DB_CA}

SESSION_TTL_HOURS=12
SESSION_IDLE_MINUTES=60
COOKIE_SECURE=true

MAX_FAILED_LOGINS=5
LOCK_MINUTES=15
LOCKOUT_RESET_MINUTES=60
LOGIN_RATE_LIMIT=30
API_RATE_LIMIT=600
BCRYPT_ROUNDS=12
TRUST_PROXY=loopback

LOG_DIR=$LOGDIR
LOG_LEVEL=info
ACCESS_LOG_DB=true

ETS_BACKUP_DIR=$BACKUPS
ETS_BACKUP_KEEP_DAYS=$ETS_BACKUP_KEEP_DAYS
ETS_BACKUP_KEY=$BACKUP_KEY
EOF
}
q() { printf "'%s'" "${1//\'/}"; }   # single-quoted value for install.conf (read back by read_kv)
render_answers() {
  cat >"$1" <<EOF
# Answers of the last ETS installation (no secrets) — used as defaults when install.sh runs again.
DEF_ADDRESS=$(q "$ETS_ADDRESS")
DEF_TLS=$(q "$ETS_TLS")
DEF_HTTPS_PORT=$(q "$ETS_HTTPS_PORT")
DEF_HTTP_PORT=$(q "$ETS_HTTP_PORT")
DEF_API_PORT=$(q "$ETS_API_PORT")
DEF_LE_EMAIL=$(q "$ETS_LE_EMAIL")
DEF_CERT=$(q "$( [[ $ETS_TLS == existing ]] && echo "$ETS_CERT")")
DEF_KEY=$(q "$( [[ $ETS_TLS == existing ]] && echo "$ETS_KEY")")
DEF_DB_MODE=$(q "$ETS_DB_MODE")
DEF_DB_HOST=$(q "$ETS_DB_HOST")
DEF_DB_PORT=$(q "$ETS_DB_PORT")
DEF_DB_NAME=$(q "$ETS_DB_NAME")
DEF_DB_USER=$(q "$ETS_DB_USER")
DEF_DB_SSLMODE=$(q "$ETS_DB_SSLMODE")
DEF_DB_SSLROOTCERT=$(q "$ETS_DB_SSLROOTCERT")
DEF_ADMIN_USER=$(q "$ETS_ADMIN_USER")
DEF_ADMIN_NAME=$(q "$ETS_ADMIN_NAME")
DEF_MFA_MODE=$(q "$ETS_MFA_MODE")
DEF_ORG_NAME_AR=$(q "$ETS_ORG_NAME_AR")
DEF_ORG_NAME_EN=$(q "$ETS_ORG_NAME_EN")
DEF_TIMEZONE=$(q "$ETS_TIMEZONE")
DEF_BACKUP_KEEP_DAYS=$(q "$ETS_BACKUP_KEEP_DAYS")
DEF_FIREWALL=$(q "$ETS_FIREWALL")
EOF
}
# render_nginx: deploy/scripts/deploy-lib.sh

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
STEP=0; STEPS=12
export DEBIAN_FRONTEND=noninteractive

step "System packages"
# rclone: offsite copies to cloud storage can be switched on later from the web UI, which cannot install packages
PKGS=(ca-certificates curl gnupg rsync openssl nginx logrotate rclone)
[[ $ETS_DB_MODE == local ]] && PKGS+=(postgresql postgresql-contrib) || PKGS+=(postgresql-client)
[[ $ETS_FIREWALL == yes ]] && PKGS+=(ufw)
[[ $ETS_TLS == letsencrypt ]] && PKGS+=(certbot)
apt-get update -y
apt-get install -y "${PKGS[@]}"
# Node.js 22.12+ or 24+ (older/odd versions are replaced); NodeSource repository with a pinned signing key
if ! node_ok; then
  echo "Installing Node.js ${NODE_MAJOR}.x (NodeSource apt repository, signing key checked)"
  install_node
fi
node_ok || die "Node.js $(node -v 2>/dev/null) is not supported — Node.js 22.12+ or 24+ is required"
echo "node $(node -v), npm $(npm -v)"

step "Time zone and clock (2FA codes need the correct time)"
timedatectl set-timezone "$ETS_TIMEZONE" || warn "could not set the time zone"
timedatectl set-ntp true 2>/dev/null || warn "could not enable NTP — make sure the clock is synchronised"

step "System user and directories"
id -u ets >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin ets
mkdir -p "$APP" "$CONF" "$LOGDIR" "$BACKUPS"
# the ets service user must be able to enter /etc/ets to read ets.env (the file itself stays 640 root:ets)
# the backup directory is root-owned but group ets, so the API (Settings → «النسخ الاحتياطي») can read and stream the
# encrypted artifacts for download; the artifacts are written 640 root:ets by ets-backup — the API never gains write/root
chown root:ets "$CONF"; chown ets:ets "$LOGDIR"; chown root:ets "$BACKUPS"
chmod 750 "$CONF" "$LOGDIR" "$BACKUPS"

step "Building the application (as the unprivileged user $BUILD_USER) and copying it to $APP"
# only the runtime files are copied (no docs, tests, reference data); packages installed with scripts disabled
build_and_deploy_app

step "Database"
# connection settings for psql; the password is given only to the psql calls that need it (dbpsql)
export PGHOST=$ETS_DB_HOST PGPORT=$ETS_DB_PORT PGDATABASE=$ETS_DB_NAME PGUSER=$ETS_DB_USER
if [[ -n "$ETS_DB_SSLMODE" ]]; then export PGSSLMODE=$ETS_DB_SSLMODE; fi
if [[ -n "$ETS_DB_SSLROOTCERT" ]]; then
  install -m 640 -o root -g ets "$ETS_DB_SSLROOTCERT" "$DB_CA"; export PGSSLROOTCERT=$DB_CA
fi
dbpsql() { PGPASSWORD="$ETS_DB_PASSWORD" psql -X "$@"; }
# the role password is sent as a SCRAM verifier on stdin: never in a process argument or the server log
db_verifier() { ETS_DB_PASSWORD="$ETS_DB_PASSWORD" node "$SRC/deploy/db/scram-verifier.mjs"; }
if [[ $ETS_DB_MODE == local ]]; then
  systemctl enable --now postgresql
  CLUSTER=$(pg_lsclusters -h | awk 'NR==1{print $1" "$2}')
  CUR_PORT=$(pg_lsclusters -h | awk 'NR==1{print $3}')
  if [[ "$CUR_PORT" != "$ETS_DB_PORT" ]]; then
    echo "Moving PostgreSQL cluster $CLUSTER from port $CUR_PORT to $ETS_DB_PORT"
    pg_conftool $CLUSTER set port "$ETS_DB_PORT"
    systemctl restart postgresql
  fi
  PSQL_SU=(sudo -u postgres psql -X -p "$ETS_DB_PORT" -v ON_ERROR_STOP=1 -qtA)
  if "${PSQL_SU[@]}" -c "SELECT 1 FROM pg_roles WHERE rolname='$ETS_DB_USER'" | grep -q 1; then
    echo "Role '$ETS_DB_USER' exists — setting its password"
    if ! "${PSQL_SU[@]}" -c "SELECT 1 FROM pg_database WHERE datname='$ETS_DB_NAME'" | grep -q 1; then
      "${PSQL_SU[@]}" -v d="$ETS_DB_NAME" -v u="$ETS_DB_USER" <<<'CREATE DATABASE :"d" OWNER :"u" ENCODING '"'UTF8'"' TEMPLATE template0;'
      "${PSQL_SU[@]}" -d "$ETS_DB_NAME" -v u="$ETS_DB_USER" <<<'CREATE EXTENSION IF NOT EXISTS citext; ALTER SCHEMA public OWNER TO :"u";'
    fi
  else
    # on stdin: the postgres user may not be able to read the source tree
    "${PSQL_SU[@]}" -v db_name="$ETS_DB_NAME" -v db_user="$ETS_DB_USER" <"$SRC/deploy/db/create-database.sql"
  fi
  VERIFIER=$(db_verifier) || die "cannot compute the password verifier"
  printf 'ALTER ROLE :"u" WITH LOGIN PASSWORD %s;\n' "'$VERIFIER'" | "${PSQL_SU[@]}" -v u="$ETS_DB_USER"
  unset VERIFIER
  # only the application role may connect; PUBLIC may not create objects in its schema (also for older installs)
  "${PSQL_SU[@]}" -d "$ETS_DB_NAME" -v d="$ETS_DB_NAME" -v u="$ETS_DB_USER" <<<'REVOKE ALL ON DATABASE :"d" FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE :"d" TO :"u"; REVOKE CREATE ON SCHEMA public FROM PUBLIC;'
  # local server: must listen only on this machine and must not trust network connections without a password
  LISTEN=$("${PSQL_SU[@]}" -c "SHOW listen_addresses")
  [[ "$LISTEN" =~ ^(localhost|127\.0\.0\.1|::1|localhost,\ ?127\.0\.0\.1|)$ ]] \
    || warn "PostgreSQL listens on '$LISTEN' — set listen_addresses = 'localhost' unless other servers need it"
  TRUSTED=$("${PSQL_SU[@]}" -c "SELECT count(*) FROM pg_hba_file_rules WHERE type LIKE 'host%' AND auth_method IN ('trust','password','md5')")
  [[ "$TRUSTED" == 0 ]] || warn "pg_hba.conf has $TRUSTED network rule(s) with trust/password/md5 — use scram-sha-256"
fi
echo "Testing the connection to $ETS_DB_HOST:$ETS_DB_PORT/$ETS_DB_NAME as $ETS_DB_USER${PGSSLMODE:+ (TLS: $PGSSLMODE)}"
dbpsql -qtAc "SELECT version()" || die "cannot connect to the database with the given host/port/name/user/password${PGSSLMODE:+ over TLS ($PGSSLMODE) — the server must accept TLS (hostssl in pg_hba.conf, ssl = on)}"
if [[ $ETS_DB_MODE == remote ]]; then
  [[ "$(dbpsql -qtAc "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")" == t ]] || die "the connection to the database server is not encrypted"
fi
if ! dbpsql -qtAc "CREATE EXTENSION IF NOT EXISTS citext" >/dev/null 2>&1; then
  dbpsql -qtAc "SELECT 1 FROM pg_extension WHERE extname='citext'" | grep -q 1 || \
    die "the 'citext' extension is missing; ask the DBA to run in database $ETS_DB_NAME:  CREATE EXTENSION citext;"
fi

step "Configuration ($ENVF)"
# previous versions are kept root-only (they hold passwords); only the 5 newest are kept
if [[ -f "$ENVF" ]]; then install -m 600 -o root -g root "$ENVF" "$ENVF.bak-$(date +%Y%m%d%H%M%S)"; fi
prune_env_backups
NEWENV=$(mktemp "$CONF/.ets.env.XXXXXX")
render_env "$NEWENV"; chown root:ets "$NEWENV"; chmod 640 "$NEWENV"; mv -f "$NEWENV" "$ENVF"
sudo -u ets test -r "$ENVF" || die "the 'ets' user cannot read $ENVF — check the permissions of $CONF"
render_answers "$ANSF"; chmod 644 "$ANSF"
[[ -n "$OLD_APP_SECRET" ]] && echo "Kept the existing APP_SECRET" || echo "Generated a new APP_SECRET"

step "Database tables, catalog, administrator and settings"
RUN=(sudo -u ets env ETS_ENV_FILE="$ENVF")
cd "$APP/backend"
# local database: migrations as the PostgreSQL superuser, then the audit trail is protected (the application role
# may only read and append audit_log / auth_log — ETS-SEC-013); remote database: as the application role
migrate_db "$ETS_DB_MODE"
"${RUN[@]}" node src/db/seed.js
# password passed through the environment (not the command line, so it never shows in `ps`);
# a password that came from an answers file / environment variable must be changed at first sign-in
MUST_CHANGE=(); [[ $ADMIN_PW_PRESET == 1 ]] && MUST_CHANGE=(--must-change-password)
ETS_ADMIN_PASSWORD="$ETS_ADMIN_PASSWORD" sudo --preserve-env=ETS_ADMIN_PASSWORD -u ets env ETS_ENV_FILE="$ENVF" node scripts/create-admin.js \
  --username "$ETS_ADMIN_USER" --name "$ETS_ADMIN_NAME" ${ETS_ADMIN_EMAIL:+--email "$ETS_ADMIN_EMAIL"} "${MUST_CHANGE[@]}" \
  || die "the administrator could not be created (see the message above) — run the installer again with another password"
unset ETS_ADMIN_PASSWORD
"${RUN[@]}" node scripts/set-setting.js mfa.mode "$ETS_MFA_MODE"
"${RUN[@]}" node scripts/set-setting.js app.org_name_ar "$ETS_ORG_NAME_AR"
"${RUN[@]}" node scripts/set-setting.js app.org_name_en "$ETS_ORG_NAME_EN"
if [[ -n "$ETS_IMPORT_FILE" ]]; then
  # private copy readable only by root and the service user, removed afterwards
  IMPORT_DIR=$(mktemp -d); trap 'rm -rf "$IMPORT_DIR"' EXIT
  chown root:ets "$IMPORT_DIR"; chmod 750 "$IMPORT_DIR"
  install -m 640 -o root -g ets "$ETS_IMPORT_FILE" "$IMPORT_DIR/import"
  "${RUN[@]}" node scripts/import-legacy.js "$IMPORT_DIR/import"
  rm -rf "$IMPORT_DIR"
fi

step "Certificate ($ETS_TLS)"
NGX_SITE=/etc/nginx/sites-available/ets; NGX_SNIP=/etc/nginx/snippets/ets-app.conf
mkdir -p /etc/nginx/snippets /var/www/letsencrypt
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  warn "disabling nginx's default site (/etc/nginx/sites-enabled/default) — it would answer on the same ports"
  rm -f /etc/nginx/sites-enabled/default
fi
ln -sf "$NGX_SITE" /etc/nginx/sites-enabled/ets
case $ETS_TLS in
  selfsigned)
    if [[ "${ETS_KEEP_CERT:-0}" == 1 && -f "$ETS_CERT" && -f "$ETS_KEY" ]]; then
      # a certificate put back from a backup (ets-restore-server): kept even when it would be renewed, because the
      # phones pin its fingerprint — renew it later on purpose (and re-pair the phones)
      selfsigned_needs_renewal "$ETS_ADDRESS" "$ETS_CERT" && warn "the restored certificate expires within 30 days or does not name $ETS_ADDRESS — kept anyway (phones pin it)"
    elif selfsigned_needs_renewal "$ETS_ADDRESS" "$ETS_CERT"; then
      make_selfsigned "$ETS_ADDRESS" "$ETS_CERT" "$ETS_KEY"
    fi
    echo "Self-signed certificate: $ETS_CERT (server certificate for $ETS_ADDRESS only, CA:FALSE, valid 825 days)."
    echo "Do NOT import it as a trusted root CA; prefer a certificate from your organisation's CA (option 'existing')." ;;
  existing)
    openssl x509 -in "$ETS_CERT" -noout -subject -enddate || die "the certificate file is not valid"
    # the private key must be readable only by root (and the ssl-cert group)
    read -r KMODE KOWNER KGROUP < <(stat -L -c '%a %U %G' "$ETS_KEY")
    if (( 8#$KMODE & 8#007 )) || { (( 8#$KMODE & 8#070 )) && [[ ! "$KGROUP" =~ ^(root|ssl-cert)$ ]]; } || [[ "$KOWNER" != root ]]; then
      warn "the private key $ETS_KEY is $KMODE $KOWNER:$KGROUP — it should be readable only by root (e.g. chmod 600, chown root:root)"
    fi ;;
  letsencrypt)
    if [[ ! -f "$ETS_CERT" ]]; then
      render_nginx "$NGX_SITE" "$NGX_SNIP" 1          # temporary port-80 site for the challenge
      nginx -t && systemctl restart nginx
      certbot certonly --webroot -w /var/www/letsencrypt -d "$ETS_ADDRESS" --non-interactive --agree-tos \
        -m "$ETS_LE_EMAIL" --deploy-hook "systemctl reload nginx" \
        || die "Let's Encrypt failed: check that $ETS_ADDRESS points to this server and port 80 is reachable from the internet"
    fi ;;
esac

# phones (1.9.0): the address and certificate fingerprint written into the pairing QR code
set_mobile_env "$ENVF"

step "Web server (nginx)"
render_nginx "$NGX_SITE" "$NGX_SNIP"
nginx -t
systemctl enable nginx && systemctl restart nginx

step "Application service, log rotation and backups (encrypted with $BACKUP_KEY)"
install_runtime_files "$ETS_DB_MODE" "$ETS_DB_HOST"
backup_agent_import
show_backup_ssh_key
systemctl daemon-reload
systemctl enable ets-backend
systemctl restart ets-backend

step "Firewall"
if [[ $ETS_FIREWALL == yes ]]; then
  ufw allow "$SSH_PORT/tcp" comment 'SSH' >/dev/null
  ufw allow "$ETS_HTTPS_PORT/tcp" comment 'ETS HTTPS' >/dev/null
  [[ $ETS_HTTP_PORT != 0 ]] && ufw allow "$ETS_HTTP_PORT/tcp" comment 'ETS HTTP' >/dev/null
  ufw --force enable >/dev/null
  ufw status verbose | sed -n '1,20p'
else
  echo "Skipped — open these ports yourself: $ETS_HTTPS_PORT $( [[ $ETS_HTTP_PORT != 0 ]] && echo "$ETS_HTTP_PORT")"
fi

step "Checks and first backup"
ok=0
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$ETS_API_PORT/api/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
[[ $ok == 1 ]] && echo "✓ application service answers on port $ETS_API_PORT" || warn "application not answering — see: journalctl -u ets-backend -n 50"
CHECK="https://127.0.0.1:$ETS_HTTPS_PORT/api/health"
curl -fsSk "$CHECK" >/dev/null && echo "✓ web server answers on $CHECK" || warn "web server check failed: $CHECK"
if [[ "${ETS_SKIP_FIRST_BACKUP:-0}" == 1 ]]; then echo "first backup skipped (a restore follows)"
else /usr/local/bin/ets-backup >> "$BACKUP_LOG" 2>&1 && echo "✓ first (encrypted) backup created in $BACKUPS" || warn "first backup failed — see $BACKUP_LOG"; fi

# ================================================================= DONE
cat <<EOF

${GR}════════════════════════════════════════════════════════════════════${N}
${GR}  ETS is installed${N}

  Open:            ${B}$URL${N}
  Administrator:   $ETS_ADMIN_USER${ETS_ADMIN_EMAIL:+ or $ETS_ADMIN_EMAIL (either signs in)}  (the password you entered$( [[ $ADMIN_PW_PRESET == 1 ]] && echo " — must be changed at first sign-in"))
  2FA policy:      $ETS_MFA_MODE
  Database:        $ETS_DB_NAME on $ETS_DB_HOST:$ETS_DB_PORT, user $ETS_DB_USER
  Audit trail:     $( [[ $ETS_DB_MODE == local ]] && echo "protected in the database (read/append only for $ETS_DB_USER) · sudo ets-log-protect status" || echo "see the note above about the DBA protecting the log tables" )
EOF
# shown on the terminal only, never written to the install log
[[ $DB_PW_SOURCE == generated ]] && printf '  DB password:     %s   (generated — also stored in %s)\n' "$ETS_DB_PASSWORD" "$ENVF" >"$TTY" 2>/dev/null || true
cat <<EOF

  Configuration:   $ENVF        ${YE}← copy it to a safe place (contains APP_SECRET)${N}
  Backup key:      $BACKUP_KEY  ${RE}← ESCROW IT NOW: copy it to a safe place, NOT with the backups. Without it no backup
                   can ever be restored. Then confirm it in Settings → «النسخ الاحتياطي» (docs/handover/08 §4)${N}
  Logs:            $LOGDIR/  ·  journalctl -u ets-backend  ·  backups: $BACKUP_LOG
  Backups:         $BACKUPS/ (every hour, encrypted)  ·  Settings → «النسخ الاحتياطي»  ·  sudo ets-backup  ·  sudo ets-restore <file.dump.gpg>
  Install log:     /var/log/ets-install.log
  Service:         sudo systemctl status|restart ets-backend
${GR}════════════════════════════════════════════════════════════════════${N}
EOF
[[ $ETS_TLS == selfsigned ]] && echo "Note: browsers warn about the self-signed certificate. Check its fingerprint and accept it for this site only
      (never install it as a trusted root CA), or use a certificate from your organisation's CA:
      $(openssl x509 -in "$ETS_CERT" -noout -fingerprint -sha256)"
exit 0

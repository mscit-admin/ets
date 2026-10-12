#!/usr/bin/env bash
# ============================================================================
#  ETS — ERP Tracking System : one-shot installer for Ubuntu Server 22.04 / 24.04
#
#  Run from the root of the repository copy on the server:
#      sudo bash deploy/install.sh
#
#  Optional environment variables (otherwise you are asked):
#      ETS_DOMAIN=ets.example.ly     server name / IP used in nginx
#      ETS_HTTPS=selfsigned|certbot|existing
#      ETS_CERT=/path/fullchain.pem  ETS_KEY=/path/privkey.pem   (for "existing")
#      ETS_ADMIN_USER=admin          first administrator username
#
#  Safe to re-run: existing database, secrets and users are kept.
# ============================================================================
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/ets
CONF=/etc/ets
ENVF=$CONF/ets.env
LOGDIR=/var/log/ets
BACKUPS=/var/backups/ets
NODE_MAJOR=22

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash deploy/install.sh"
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "This installer is tested on Ubuntu; detected ${PRETTY_NAME:-unknown}"

DOMAIN="${ETS_DOMAIN:-}"
if [[ -z "$DOMAIN" ]]; then
  read -rp "Server name or IP address for the site [$(hostname -I | awk '{print $1}')]: " DOMAIN
  DOMAIN="${DOMAIN:-$(hostname -I | awk '{print $1}')}"
fi
HTTPS="${ETS_HTTPS:-}"
if [[ -z "$HTTPS" ]]; then
  echo "HTTPS certificate:  1) self-signed (internal network)  2) Let's Encrypt / certbot (public domain)  3) existing certificate files"
  read -rp "Choose [1]: " c
  case "${c:-1}" in 2) HTTPS=certbot ;; 3) HTTPS=existing ;; *) HTTPS=selfsigned ;; esac
fi

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg rsync openssl nginx postgresql postgresql-contrib ufw logrotate
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  say "Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v

say "Creating system user and directories"
id -u ets >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin ets
mkdir -p "$APP" "$CONF" "$LOGDIR" "$BACKUPS"
chown ets:ets "$LOGDIR" "$BACKUPS"
chmod 750 "$CONF" "$LOGDIR" "$BACKUPS"

say "Copying application to $APP"
rsync -a --delete --exclude node_modules --exclude .git --exclude 'backend/.env' --exclude 'backend/logs*' \
  --exclude 'frontend/dist' "$SRC/" "$APP/"

say "Preparing PostgreSQL"
systemctl enable --now postgresql
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='ets'" | grep -q 1; then
  DBPASS="$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 32)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -v ets_password="'$DBPASS'" -f "$APP/deploy/db/create-database.sql"
  NEW_DB=1
else
  NEW_DB=0
  echo "PostgreSQL role 'ets' already exists — keeping it."
fi

if [[ ! -f "$ENVF" ]]; then
  say "Writing configuration $ENVF"
  [[ "$NEW_DB" == 1 ]] || die "Role 'ets' exists but $ENVF is missing; restore $ENVF from backup or set PGPASSWORD manually."
  sed -e "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" \
      -e "s|^PGPASSWORD=.*|PGPASSWORD=$DBPASS|" \
      -e "s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" \
      "$APP/backend/.env.example" > "$ENVF"
  chown root:ets "$ENVF"; chmod 640 "$ENVF"
  warn "Back up $ENVF somewhere safe: APP_SECRET is required to read users' 2FA keys."
else
  echo "Keeping existing $ENVF"
fi

say "Installing backend dependencies"
cd "$APP/backend" && npm ci --omit=dev --no-audit --no-fund
say "Building frontend"
cd "$APP/frontend" && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules
chown -R root:root "$APP"; chmod -R a+rX "$APP"

say "Database migrations and catalog"
cd "$APP/backend"
sudo -u ets env ETS_ENV_FILE="$ENVF" LOG_DIR="$LOGDIR" node src/db/migrate.js
sudo -u ets env ETS_ENV_FILE="$ENVF" LOG_DIR="$LOGDIR" node src/db/seed.js

if ! sudo -u ets env ETS_ENV_FILE="$ENVF" node --input-type=module -e "
  import {pool} from './src/db/pool.js';
  const r = await pool.query(\"SELECT count(*)::int n FROM users WHERE role_id='admin' AND is_active\");
  await pool.end(); process.exit(r.rows[0].n ? 0 : 1);" 2>/dev/null; then
  say "Create the first system administrator"
  ADMIN="${ETS_ADMIN_USER:-}"
  [[ -n "$ADMIN" ]] || read -rp "Administrator username [admin]: " ADMIN
  read -rp "Administrator full name [System Administrator]: " ANAME
  sudo -u ets env ETS_ENV_FILE="$ENVF" LOG_DIR="$LOGDIR" node scripts/create-admin.js --username "${ADMIN:-admin}" --name "${ANAME:-System Administrator}"
fi

say "TLS certificate ($HTTPS)"
case "$HTTPS" in
  selfsigned)
    CERT=/etc/ssl/certs/ets-selfsigned.crt; KEY=/etc/ssl/private/ets-selfsigned.key
    if [[ ! -f "$CERT" ]]; then
      SAN="DNS:$DOMAIN"; [[ "$DOMAIN" =~ ^[0-9.]+$ ]] && SAN="IP:$DOMAIN"
      openssl req -x509 -nodes -newkey rsa:2048 -days 1095 -subj "/CN=$DOMAIN" \
        -addext "subjectAltName=$SAN" -keyout "$KEY" -out "$CERT"
      chmod 600 "$KEY"
    fi ;;
  existing)
    CERT="${ETS_CERT:-}"; KEY="${ETS_KEY:-}"
    [[ -n "$CERT" ]] || read -rp "Path to certificate (fullchain): " CERT
    [[ -n "$KEY" ]]  || read -rp "Path to private key: " KEY
    [[ -f "$CERT" && -f "$KEY" ]] || die "Certificate files not found" ;;
  certbot)
    apt-get install -y certbot python3-certbot-nginx
    CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem; KEY=/etc/letsencrypt/live/$DOMAIN/privkey.pem
    if [[ ! -f "$CERT" ]]; then
      systemctl stop nginx || true
      certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
    fi ;;
esac

say "Configuring nginx"
sed -e "s|__SERVER_NAME__|$DOMAIN|g" -e "s|__SSL_CERT__|$CERT|" -e "s|__SSL_KEY__|$KEY|" \
  "$APP/deploy/nginx/ets.conf" > /etc/nginx/sites-available/ets
ln -sf /etc/nginx/sites-available/ets /etc/nginx/sites-enabled/ets
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx && systemctl restart nginx

say "Installing systemd service, logrotate and backups"
install -m 644 "$APP/deploy/systemd/ets-backend.service" /etc/systemd/system/ets-backend.service
install -m 644 "$APP/deploy/logrotate/ets" /etc/logrotate.d/ets
install -m 755 "$APP/deploy/scripts/backup.sh" /usr/local/bin/ets-backup
install -m 755 "$APP/deploy/scripts/restore.sh" /usr/local/bin/ets-restore
echo "30 1 * * * root /usr/local/bin/ets-backup >> $LOGDIR/backup.log 2>&1" > /etc/cron.d/ets-backup
systemctl daemon-reload
systemctl enable ets-backend
systemctl restart ets-backend

say "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | head -5

sleep 3
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
  say "ETS is running:  https://$DOMAIN"
else
  warn "The API did not answer yet. Check:  journalctl -u ets-backend -n 50"
fi
echo "Logs: $LOGDIR   Config: $ENVF   Backups: $BACKUPS (daily 01:30)"

#!/usr/bin/env bash
# Update an installed ETS to the version in this repository copy.
#   cd /path/to/new/ets && sudo bash deploy/scripts/update.sh
# Takes an encrypted backup first, builds the new version as the unprivileged ets-build user, copies it to
# /opt/ets, re-deploys the service unit, nginx site and headers, logrotate, backup/restore commands and
# cron job from the answers of the installation (/etc/ets/install.conf), applies the database migrations and
# (local database) the audit-trail protection as the PostgreSQL superuser, then restarts and checks.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC2034  # APP is used by deploy-lib.sh
APP=/opt/ets
CONF=/etc/ets
ENVF=$CONF/ets.env
ANSF=$CONF/install.conf
BACKUPS=/var/backups/ets
warn() { printf '!!  %s\n' "$*" >&2; }
die()  { printf 'xx  %s\n' "$*" >&2; exit 1; }
# shellcheck source=deploy/scripts/deploy-lib.sh
. "$SRC/deploy/scripts/deploy-lib.sh"

[[ $EUID -eq 0 ]] || die "run as root"
[[ -f "$ENVF" && -f "$ANSF" ]] || die "no installation found ($ENVF, $ANSF) — use deploy/install.sh"
read_kv "$ANSF" '^DEF_[A-Z0-9_]+$' || die "cannot read $ANSF"
[[ "${DEF_TLS:-}" != none ]] || die "this installation uses plain HTTP, which is no longer supported — run: sudo bash deploy/install.sh (choose a certificate)"
node_ok || die "Node.js $(node -v 2>/dev/null || echo '(missing)') is not supported (need 22.12+ or 24+) — run deploy/install.sh to upgrade it"
PORT=$(env_get "$ENVF" PORT); PORT=${PORT:-3000}
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT in $ENVF is not a number"

# A remote database must be reached over TLS (the application refuses to start otherwise).
if [[ "${DEF_DB_MODE:-local}" == remote && -z "$(env_get "$ENVF" PGSSLMODE)" ]]; then
  printf '\n# TLS to the database server (added by update.sh; verify-full + PGSSLROOTCERT is stronger)\nPGSSLMODE=require\n' >>"$ENVF"
  echo "Added PGSSLMODE=require to $ENVF (the database server must accept TLS connections)"
fi

# New backup script and key first, so the pre-update backup is already encrypted.
ensure_backup_key
install -m 755 "$SRC/deploy/scripts/backup.sh" /usr/local/bin/ets-backup
/usr/local/bin/ets-backup
PRE=$(find "$BACKUPS" -maxdepth 1 -name 'ets-*.dump.gpg' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
trap 'warn "update failed. The data before the update is in $PRE. To roll back: run deploy/scripts/update.sh from the previous release copy, and if the database was changed: sudo ets-restore $PRE"' ERR

build_and_deploy_app
install_runtime_files "${DEF_DB_MODE:-local}" "${DEF_DB_HOST:-127.0.0.1}"

# nginx site, app snippet and security headers, re-rendered from the installation answers
ETS_ADDRESS=$DEF_ADDRESS ETS_TLS=$DEF_TLS ETS_HTTPS_PORT=${DEF_HTTPS_PORT:-443} ETS_HTTP_PORT=${DEF_HTTP_PORT:-0} ETS_API_PORT=$PORT
case $ETS_TLS in
  selfsigned)
    ETS_CERT=/etc/ssl/certs/ets-selfsigned.crt; ETS_KEY=/etc/ssl/private/ets-selfsigned.key
    if selfsigned_needs_renewal "$ETS_ADDRESS" "$ETS_CERT"; then
      make_selfsigned "$ETS_ADDRESS" "$ETS_CERT" "$ETS_KEY"
      warn "a new self-signed certificate was created (the old one was a CA certificate or expiring)."
      warn "Remove the old ETS certificate from the client PCs' trusted root store if it was imported there."
    fi ;;
  letsencrypt) ETS_CERT=/etc/letsencrypt/live/$ETS_ADDRESS/fullchain.pem; ETS_KEY=/etc/letsencrypt/live/$ETS_ADDRESS/privkey.pem ;;
  existing)    ETS_CERT=$DEF_CERT; ETS_KEY=$DEF_KEY ;;
  *) die "unknown certificate mode '$ETS_TLS' in $ANSF" ;;
esac
render_nginx /etc/nginx/sites-available/ets /etc/nginx/snippets/ets-app.conf
nginx -t
# phones (1.9.0): the address and certificate fingerprint written into the pairing QR code
set_mobile_env "$ENVF"

systemctl daemon-reload
systemctl reload nginx
# Migrations before the new version starts: for a local database as the PostgreSQL superuser through
# ets-log-protect, which then protects the audit trail again (ETS-SEC-013); remote: see migrate_db.
systemctl stop ets-backend
migrate_db "${DEF_DB_MODE:-local}"
systemctl restart ets-backend
ok=0
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
[[ $ok == 1 ]] || die "the application does not answer on port $PORT — see: journalctl -u ets-backend -n 50"
trap - ERR
echo "update ok"
[[ "${BACKUP_KEY_CREATED:-0}" == 1 ]] && warn "NEW backup key $BACKUP_KEY: copy it to a safe place now (without it the backups cannot be restored)."
exit 0

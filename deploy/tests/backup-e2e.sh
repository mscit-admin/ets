#!/usr/bin/env bash
# End-to-end test of the backup commands on a scratch "server" (as root, on a test machine — never on a real server):
#   ets-backup: dump, configuration bundle and its de-duplication, logs bundle, retention
#   offsite: NAS (a tmpfs mount; refused while not mounted), SSH to localhost through rrsync, rclone (local remote);
#            each verified, the same retention applied on the destinations
#   ets-backup --test, ets-restore --yes into a scratch database, ets-restore-server --dry-run (local / SSH / rclone).
#
#   sudo E2E_PG=postgres://ets:pw@127.0.0.1:56452 E2E_TEMPLATE_DB=ets_e2e_presence bash deploy/tests/backup-e2e.sh
# Needs: root, PostgreSQL client tools, gpg, rsync (with rrsync), openssh-server, rclone, mount -t tmpfs.
# shellcheck disable=SC2016,SC2034,SC2010,SC2012  # conditions are eval-ed by t(); ls is fine on these known file names
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
PG=${E2E_PG:?set E2E_PG=postgres://user:password@host:port}
TPL=${E2E_TEMPLATE_DB:-}
DB=ets_bk_e2e
R=$(mktemp -d /tmp/ets-bk-e2e-XXXX)
NAS=/mnt/ets-e2e-nas SSHDIR=/srv/ets-e2e-ssh SSHPORT=${E2E_SSH_PORT:-2222}
PASS=0 FAIL=0
ok()  { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '     %s\n' "${2:0:600}"; }
t()   { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
U=$(sed -E 's|^postgres://([^:]+):.*|\1|' <<<"$PG"); P=$(sed -E 's|^postgres://[^:]+:([^@]+)@.*|\1|' <<<"$PG")
H=$(sed -E 's|.*@([^:/]+).*|\1|' <<<"$PG"); PORT=$(sed -E 's|.*:([0-9]+)/?$|\1|' <<<"$PG")
q() { PGPASSWORD=$P psql -X -qtA -h "$H" -p "$PORT" -U "$U" -d "${2:-$DB}" -c "$1"; }
cleanup() {
  [[ -f "$R/sshd.pid" ]] && kill "$(cat "$R/sshd.pid")" 2>/dev/null
  mountpoint -q "$NAS" && umount "$NAS"; rmdir "$NAS" 2>/dev/null
  rm -rf "$SSHDIR"; q "DROP DATABASE IF EXISTS $DB WITH (FORCE)" postgres >/dev/null 2>&1
  [[ -n "${E2E_KEEP:-}" ]] || rm -rf "$R"
}
trap cleanup EXIT

# ---------------------------------------------------------------- scratch server
mkdir -p "$R"/{etc/ets,backups,log/ets,varlog,ssl,nginx/sites-available,cloud,bin}
q "DROP DATABASE IF EXISTS $DB WITH (FORCE)" postgres >/dev/null
if [[ -n "$TPL" ]]; then q "CREATE DATABASE $DB TEMPLATE $TPL" postgres >/dev/null
else q "CREATE DATABASE $DB" postgres >/dev/null; q 'CREATE EXTENSION IF NOT EXISTS citext' >/dev/null; fi
openssl req -x509 -nodes -newkey rsa:2048 -days 400 -subj /CN=10.0.0.15 -addext subjectAltName=IP:10.0.0.15 \
  -keyout "$R/ssl/ets.key" -out "$R/ssl/ets.crt" 2>/dev/null
cat >"$R/etc/ets/ets.env" <<EOF
PORT=3999
APP_SECRET='$(openssl rand -base64 48 | tr -d '\n')'
PGHOST=$H
PGPORT=$PORT
PGDATABASE=$DB
PGUSER=$U
PGPASSWORD='$P'
ETS_BACKUP_DIR=$R/backups
ETS_BACKUP_KEY=$R/etc/ets/backup.key
PUBLIC_BASE_URL=https://10.0.0.15
EOF
printf "DEF_ADDRESS='10.0.0.15'\nDEF_TLS='existing'\nDEF_CERT='%s'\nDEF_KEY='%s'\nDEF_DB_MODE='local'\nDEF_DB_NAME='%s'\nDEF_DB_USER='%s'\n" \
  "$R/ssl/ets.crt" "$R/ssl/ets.key" "$DB" "$U" >"$R/etc/ets/install.conf"
(umask 077; openssl rand -base64 48 >"$R/etc/ets/backup.key")
echo "app log" >"$R/log/ets/app.log"; echo "old" | gzip >"$R/log/ets/app.log-20261020.gz"; echo "not ours" >"$R/varlog/syslog"
export ETS_CONF_DIR=$R/etc/ets ETS_ENV_FILE=$R/etc/ets/ets.env ETS_APP_DIR=$REPO ETS_LOG_DIR=$R/log/ets ETS_SYSLOG_DIR=$R/varlog \
  ETS_NGINX_DIR=$R/nginx ETS_BACKUP_LOCK=$R/lock ETS_RUN_AS=root ETS_SYSTEMCTL=true ETS_LOG_PROTECT_CMD=/bin/false \
  ETS_BACKUP_CMD=$REPO/deploy/scripts/backup.sh ETS_VERIFY_DB=ets_bk_e2e_check
BK=$REPO/deploy/scripts/backup.sh
conf() {   # the destinations (what ets-backup-agent would render)
  cat >"$R/etc/ets/backup.conf" <<EOF
BACKUP_KEEP_HOURLY=48
BACKUP_KEEP_DAILY=30
BACKUP_KEEP_WEEKLY=12
BACKUP_KEEP_MONTHLY=12
BACKUP_SSH_TARGET='${1:-}'
BACKUP_SSH_PORT=$SSHPORT
BACKUP_NAS_DIR='${2:-}'
BACKUP_RCLONE_REMOTE='${3:-}'
EOF
}

# ---------------------------------------------------------------- 1. local backup, bundles, dedupe
conf
out=$(bash "$BK" 2>&1); rc=$?
t "ets-backup runs (local only)" '[[ $rc == 0 ]]' "$out"
t "dump, configuration and logs bundles with .sha256 and .meta" \
  '[[ $(ls "$R/backups" | grep -cE "^ets-(config-|logs-)?[0-9-]+\.(dump|tar)\.gpg$") == 3 && $(ls "$R/backups" | grep -c "\.sha256$") == 3 && $(ls "$R/backups" | grep -c "\.meta$") == 3 ]]' "$(ls "$R/backups")"
G=$(mktemp -d); CFG=$(ls "$R/backups"/ets-config-*.tar.gpg | head -1)
GNUPGHOME=$G gpg --batch -q --pinentry-mode loopback --passphrase-file "$R/etc/ets/backup.key" -d "$CFG" >"$R/cfg.tar" 2>/dev/null
t "configuration bundle: ets.env, install.conf, certificate + key, manifest, roles; never the backup key" \
  'tar -tf "$R/cfg.tar" | grep -q "etc/ets/ets.env$" && tar -tf "$R/cfg.tar" | grep -q "ssl/ets.key$" && tar -tf "$R/cfg.tar" | grep -q "manifest.json" && tar -tf "$R/cfg.tar" | grep -q globals.sql && ! tar -tf "$R/cfg.tar" | grep -q backup.key'
LOGS=$(ls "$R/backups"/ets-logs-*.tar.gpg | head -1)
GNUPGHOME=$G gpg --batch -q --pinentry-mode loopback --passphrase-file "$R/etc/ets/backup.key" -d "$LOGS" 2>/dev/null | tar -tf - >"$R/logs.lst"
t "logs bundle: ETS logs (incl. rotated .gz), nothing else" 'grep -q "app.log$" "$R/logs.lst" && grep -q "app.log-20261020.gz$" "$R/logs.lst" && ! grep -q syslog "$R/logs.lst"' "$(cat "$R/logs.lst")"
sleep 1; out=$(bash "$BK" 2>&1)
t "unchanged configuration: no new bundle (dedupe by content)" '[[ $(ls "$R/backups" | grep -c "^ets-config-.*gpg$") == 1 ]] && grep -q "configuration unchanged" <<<"$out"'
t "logs bundle only once a day" '[[ $(ls "$R/backups" | grep -c "^ets-logs-.*gpg$") == 1 ]]'
echo "# changed" >>"$R/etc/ets/install.conf"; sleep 1; bash "$BK" >/dev/null 2>&1
t "changed configuration: a new bundle" '[[ $(ls "$R/backups" | grep -c "^ets-config-.*gpg$") == 2 ]]'
t "system_log rows written" '[[ $(q "SELECT count(*) FROM system_log WHERE event=\$\$backup\$\$") -ge 3 ]]'

# ---------------------------------------------------------------- 2. destinations
# NAS: refused while not mounted (nothing written to the root disk), copied once mounted
conf '' "$NAS" ''
out=$(bash "$BK" 2>&1)
t "NAS not mounted: refused, directory not created" 'grep -q "offsite nas .*FAILED.*not a mounted file system" <<<"$out" && [[ ! -e "$NAS" ]]' "$out"
mkdir -p "$NAS" && mount -t tmpfs -o size=64m tmpfs "$NAS"
# SSH: a dedicated user, rrsync-restricted key, sshd on localhost
id -u etsbackup >/dev/null 2>&1 || useradd -m -s /bin/sh etsbackup
mkdir -p "$SSHDIR" && chown etsbackup "$SSHDIR"
ssh-keygen -A >/dev/null 2>&1
conf "etsbackup@127.0.0.1:/" "$NAS" "e2e:$R/cloud"
out=$(bash "$BK" --ssh-key); line=$(grep '^RESULT ' <<<"$out" | sed 's/^RESULT //' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).authorized_keys_line))')
line=${line/rrsync \/srv\/backups\/ets/rrsync $SSHDIR}
install -d -m 700 -o etsbackup /home/etsbackup/.ssh; echo "$line" >/home/etsbackup/.ssh/authorized_keys
chown etsbackup /home/etsbackup/.ssh/authorized_keys; chmod 600 /home/etsbackup/.ssh/authorized_keys
t "SSH key: ed25519, restricted authorized_keys line (restrict + rrsync)" '[[ "$line" == restrict,command=\"rrsync\ $SSHDIR\"\ ssh-ed25519\ * ]]' "$line"
/usr/sbin/sshd -p "$SSHPORT" -o PidFile="$R/sshd.pid" -o PasswordAuthentication=no -o ListenAddress=127.0.0.1
printf '[e2e]\ntype = local\n' >"$R/etc/ets/rclone.conf"; chmod 600 "$R/etc/ets/rclone.conf"
for d in ssh nas cloud; do
  out=$(bash "$BK" --test $d 2>&1)
  t "--test $d: write, read back, delete" 'grep -q "^RESULT {\"ok\":true" <<<"$out"' "$out"
done
t "--test ssh: host key fingerprint recorded (accept-new)" 'grep -q "host_fingerprint\":\"SHA256:" <<<"$(bash "$BK" --test ssh 2>&1)"'
out=$(bash "$BK" 2>&1)
t "three destinations copied" '[[ $(grep -c "offsite .*: ok" <<<"$out") == 3 ]]' "$out"
n_local=$(ls "$R/backups" | grep -cE '^ets-.*(gpg|sha256|meta)$')
t "SSH copy (through rrsync) = local set" '[[ $(ls "$SSHDIR" | grep -cE "^ets-") == "$n_local" ]]' "$(ls "$SSHDIR")"
t "NAS copy = local set, checksums ok" '[[ $(ls "$NAS" | grep -cE "^ets-") == "$n_local" ]] && (cd "$NAS" && sha256sum -c --quiet ./*.sha256)'
t "cloud copy (rclone) = local set, no temporary names left" '[[ $(ls "$R/cloud" | grep -cE "^ets-") == "$n_local" ]] && ! ls -a "$R/cloud" | grep -q partial'
t "backup_offsite rows: three ok" '[[ $(q "SELECT count(*) FROM system_log WHERE event=\$\$backup_offsite\$\$ AND (detail->>\$\$ok\$\$)::boolean") -ge 3 ]]'
out=$(bash "$BK" 2>&1)
t "next run copies only the new files" 'grep -q "offsite nas .*: ok, [3-5] file(s) copied" <<<"$out"' "$(grep offsite <<<"$out")"
# retention on the destinations: old synthetic backups are pruned with the same tiers; an unknown file is kept
for dst in "$SSHDIR" "$NAS" "$R/cloud"; do
  for d in 400 200 45 44 3; do
    ts=$(date -d "-$d days" +%Y%m%d)-013000; echo x >"$dst/ets-$ts.dump.gpg"; echo x >"$dst/ets-$ts.dump.gpg.sha256"
  done
  echo keep >"$dst/README.txt"
done
chown -R etsbackup "$SSHDIR"
bash "$BK" >/dev/null 2>&1
for dst in "$SSHDIR" "$NAS" "$R/cloud"; do
  t "retention on $(basename "$dst"): 400-day-old gone, 3-day-old kept, other files kept" \
    '[[ ! -e "$dst/ets-$(date -d "-400 days" +%Y%m%d)-013000.dump.gpg" && -e "$dst/ets-$(date -d "-3 days" +%Y%m%d)-013000.dump.gpg" && -e "$dst/README.txt" ]]' "$(ls "$dst")"
done
# a broken destination does not stop the others
conf "etsbackup@127.0.0.1:/" "$NAS" "nosuchremote:x"
out=$(bash "$BK" 2>&1); rc=$?
t "one destination failing: the others still copied, the run succeeds" '[[ $rc == 0 ]] && grep -q "offsite cloud .*FAILED" <<<"$out" && grep -q "offsite ssh .*: ok" <<<"$out" && grep -q "offsite nas .*: ok" <<<"$out"' "$out"
conf "etsbackup@127.0.0.1:/" "$NAS" "e2e:$R/cloud"

# ---------------------------------------------------------------- 3. test restore, restore.sh --yes, restore-server --dry-run
out=$(bash "$REPO/deploy/scripts/backup-verify.sh" --json "$R/v.json" 2>&1); rc=$?
t "ets-backup-verify: restore into a temporary database, verify-audit ok" '[[ $rc == 0 ]] && grep -q "\"ok\":true" "$R/v.json" && grep -q "\"audit_ok\":true" "$R/v.json"' "$out"
t "ets-backup-verify never leaves the temporary database behind" '[[ -z "$(q "SELECT 1 FROM pg_database WHERE datname=$$ets_bk_e2e_check$$" postgres)" ]]'
DUMP=$(ls "$R/backups"/ets-2*.dump.gpg | tail -1)
q "INSERT INTO settings(key,value) VALUES ('e2e.marker','\"after-backup\"') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value" >/dev/null
out=$(bash "$REPO/deploy/scripts/restore.sh" --yes "$DUMP" 2>&1); rc=$?
t "ets-restore --yes: restored (marker gone), audit chains ok, safety backup taken" \
  '[[ $rc == 0 ]] && [[ -z "$(q "SELECT 1 FROM settings WHERE key=$$e2e.marker$$")" ]] && grep -q "audit chains: ok" <<<"$out" && grep -q "Backing up the current data first" <<<"$out"' "$out"
t "ets-restore: sessions ended, restore recorded" '[[ $(q "SELECT count(*) FROM sessions WHERE revoked_at IS NULL") == 0 && $(q "SELECT count(*) FROM audit_log WHERE action=\$\$restore\$\$") -ge 1 ]]'
echo wrong-key-123456789 >"$R/wrong.key"
out=$(bash "$REPO/deploy/scripts/restore.sh" --yes --key "$R/wrong.key" "$DUMP" 2>&1); rc=$?
t "ets-restore with a wrong key: refused before anything is changed" '[[ $rc != 0 ]] && grep -q "nothing was changed" <<<"$out"' "$out"
out=$(bash "$REPO/deploy/scripts/restore-server.sh" --dry-run --yes --from "$R/backups" --key "$R/etc/ets/backup.key" 2>&1); rc=$?
t "ets-restore-server --dry-run --from DIR: checks pass, nothing installed" '[[ $rc == 0 ]] && grep -q "Dry run finished" <<<"$out" && grep -q "certificate and key match" <<<"$out"' "$out"
out=$(bash "$REPO/deploy/scripts/restore-server.sh" --dry-run --yes --from "ssh:etsbackup@127.0.0.1:/" --ssh-port "$SSHPORT" --ssh-key "$R/etc/ets/backup_ssh_key" --key "$R/etc/ets/backup.key" 2>&1 <<<"" ); rc=$?
t "ets-restore-server --dry-run --from ssh: (rrsync)" '[[ $rc == 0 ]] && grep -q "Dry run finished" <<<"$out"' "$out"
out=$(bash "$REPO/deploy/scripts/restore-server.sh" --dry-run --yes --from "rclone:e2e:$R/cloud" --rclone-config "$R/etc/ets/rclone.conf" --key "$R/etc/ets/backup.key" 2>&1); rc=$?
t "ets-restore-server --dry-run --from rclone:" '[[ $rc == 0 ]] && grep -q "Dry run finished" <<<"$out"' "$out"
out=$(bash "$REPO/deploy/scripts/restore-server.sh" --dry-run --yes --from "$R/backups" --key "$R/wrong.key" 2>&1); rc=$?
t "ets-restore-server with a wrong key: refused" '[[ $rc != 0 ]] && grep -q "wrong key" <<<"$out"' "$out"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))

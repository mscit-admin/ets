#!/usr/bin/env bash
# ETS disaster recovery onto a NEW server from the command line (installed as /usr/local/bin/ets-restore-server; run it
# from a copy of the repository of the same version or newer). Since 1.12.0 the usual way is: install ETS on the new
# server, then Settings → «النسخ الاحتياطي» → «استرجاع من نسخة» with the OLD backup key. This command is the
# fallback when the web UI cannot be used.
#
#   sudo bash deploy/scripts/restore-server.sh --from /mnt/usb/ets-backups --key /root/old-backup.key
#   sudo bash deploy/scripts/restore-server.sh --config ets-config-….tar.gpg --dump ets-….dump.gpg      (key asked)
#   sudo bash deploy/scripts/restore-server.sh --from ssh:etsbackup@10.0.0.30:/srv/backups/ets --ssh-key /root/id_ed25519 [--ssh-port 22]
#   sudo bash deploy/scripts/restore-server.sh --from rclone:ets-cloud:bucket/ets --rclone-config /root/rclone.conf
#     --from SRC        directory (also a mounted NAS), ssh:user@host:/path or rclone:remote:path — the newest dump and
#                       the configuration bundle in force at its time are fetched
#     --config / --dump the two files directly
#     --key FILE        the backup key / passphrase of those backups (asked when missing; never written to a log)
#     --dry-run         everything up to the restore, as checks only: nothing is installed or changed
#     --yes             no question (the key must then be given with --key)
#     --skip-db         the database is on another server and was not lost: only the configuration is put back
#
# Steps: 1 decrypt the configuration bundle (checksums, manifest) · 2 put ets.env, install.conf, db-ca.crt, the TLS
# certificate and key back with their modes · 3 install.sh non-interactively with the same answers and the SAME
# certificate (ETS_KEEP_CERT=1: no new self-signed certificate) · 4 ets-restore --yes (database, one transaction) ·
# 5 migrations · 6 verify-audit · 7 /api/health · 8 summary, including whether the phones keep working (same
# certificate fingerprint and the same address / IP as before).
set -euo pipefail
umask 077
SRC="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." 2>/dev/null && pwd)"
CONF=${ETS_CONF_DIR:-/etc/ets}
LIB=${ETS_BACKUP_LIB:-}
if [[ -z "$LIB" ]]; then
  for c in "$SRC/deploy/scripts/backup-lib.sh" /usr/local/lib/ets/backup-lib.sh; do [[ -r "$c" ]] && { LIB=$c; break; }; done
fi
# shellcheck source=deploy/scripts/backup-lib.sh
. "${LIB:?backup-lib.sh not found}"
B=$'\033[1m'; N=$'\033[0m'; YE=$'\033[1;33m'; RE=$'\033[1;31m'; GR=$'\033[1;32m'
say()  { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '%s ✓  %s%s\n' "$GR" "$*" "$N"; }
warn() { printf '%s!!  %s%s\n' "$YE" "$*" "$N" >&2; }
die()  { printf '%sxx  %s%s\n' "$RE" "$*" "$N" >&2; exit 1; }

FROM='' CFG='' DUMP='' KEYF='' DRY=0 YES=0 SKIPDB=0 SSHKEY='' SSHPORT=22 RCONF=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) shift; FROM=${1:-} ;;
    --config) shift; CFG=${1:-} ;;
    --dump) shift; DUMP=${1:-} ;;
    --key) shift; KEYF=${1:-} ;;
    --ssh-key) shift; SSHKEY=${1:-} ;;
    --ssh-port) shift; SSHPORT=${1:-}; [[ "$SSHPORT" =~ ^[0-9]{1,5}$ ]] || die "--ssh-port: a number" ;;
    --rclone-config) shift; RCONF=${1:-} ;;
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    --skip-db) SKIPDB=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
[[ $EUID -eq 0 || $DRY -eq 1 ]] || die "run as root"
[[ -n "$FROM" || -n "$CFG" ]] || die "give --from SRC, or --config FILE (and --dump FILE)"
WORK=$(mktemp -d); GNUPGHOME=$WORK/gnupg; mkdir -m 700 "$GNUPGHOME"; export GNUPGHOME
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- the key (file or typed; kept only in $WORK)
BK_KEY=$WORK/backup.key
if [[ -n "$KEYF" ]]; then
  [[ -r "$KEYF" ]] || die "cannot read $KEYF"
  head -n 1 "$KEYF" >"$BK_KEY"
else
  [[ $YES -eq 0 ]] || die "--yes needs --key FILE"
  read -rsp "Backup key or passphrase of these backups: " k </dev/tty; echo
  [[ -n "$k" ]] || die "no key given"
  printf '%s\n' "$k" >"$BK_KEY"; unset k
fi

# ---------------------------------------------------------------- 1. fetch / find the files
say "1. Backup files"
mkdir -p "$WORK/in"
fetch_latest() {   # lister fetcher
  local list=$WORK/list
  "$1" | bk_artifacts >"$list" || die "cannot list $FROM"
  DUMP=$(bk_latest dump <"$list") || true
  [[ -n "$DUMP" || $SKIPDB -eq 1 ]] || die "no database backup in $FROM"
  CFG=$(bk_latest config "${DUMP:+$(bk_parse "$DUMP" | cut -d' ' -f2)}" <"$list") || true
  [[ -n "$CFG" ]] || die "no configuration bundle at or before $DUMP in $FROM"
  local n; for n in "$CFG" "$CFG.sha256" ${DUMP:+"$DUMP" "$DUMP.sha256"}; do grep -qx "$n" "$list" && "$2" "$n"; done
  CFG=$WORK/in/$CFG; [[ -n "$DUMP" ]] && DUMP=$WORK/in/$DUMP
  return 0
}
case "$FROM" in
  '') ;;
  ssh:*)
    T=${FROM#ssh:}; bk_valid_ssh_target "$T" || die "invalid SSH source $T (user@host:/path)"
    SSHC="ssh -p $SSHPORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new${SSHKEY:+ -i $SSHKEY -o IdentitiesOnly=yes}"
    l_ssh() { rsync -e "$SSHC" --list-only --no-human-readable "${T%/}/" | awk '{print $NF}'; }
    f_ssh() { rsync -t -e "$SSHC" "${T%/}/$1" "$WORK/in/" ; }
    fetch_latest l_ssh f_ssh ;;
  rclone:*)
    T=${FROM#rclone:}; bk_valid_rclone_remote "$T" || die "invalid rclone source $T"
    command -v rclone >/dev/null || die "rclone is not installed (apt-get install rclone)"
    RC=(rclone ${RCONF:+--config "$RCONF"})
    l_rc() { "${RC[@]}" lsf --files-only "$T"; }
    f_rc() { "${RC[@]}" copyto "$T/$1" "$WORK/in/$1"; }
    fetch_latest l_rc f_rc ;;
  *)
    [[ -d "$FROM" ]] || die "$FROM is not a directory"
    l_dir() { find "$FROM" -maxdepth 1 -type f -printf '%f\n'; }
    f_dir() { cp -- "$FROM/$1" "$WORK/in/"; }
    fetch_latest l_dir f_dir ;;
esac
[[ -f "$CFG" ]] || die "configuration bundle not found: $CFG"
[[ $SKIPDB -eq 1 || -f "$DUMP" ]] || die "database backup not found (--dump FILE, or --skip-db)"
for f in "$CFG" ${DUMP:+"$DUMP"}; do
  set +e; bk_sha_ok "$f"; rc=$?; set -e
  case $rc in 0) ok "checksum $(basename "$f")" ;; 2) warn "no checksum file for $(basename "$f")" ;; *) die "checksum mismatch: $f (damaged or altered)" ;; esac
done

# ---------------------------------------------------------------- 2. decrypt and check the bundle
say "2. Configuration bundle"
bk_decrypt "$CFG" "$WORK/cfg.tar" 2>/dev/null || die "cannot decrypt $(basename "$CFG"): wrong key or passphrase (nothing was changed)"
mkdir -p "$WORK/cfg"; tar -C "$WORK/cfg" -xf "$WORK/cfg.tar" --no-same-owner
M=$WORK/cfg/manifest.json
[[ -f "$M" ]] || die "the bundle has no manifest.json"
mj() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],m);process.stdout.write(v==null?"":Array.isArray(v)?v.join(" "):String(v))' "$M" "$1"; }
node -e '
  const fs=require("fs"),c=require("crypto"),m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  for (const f of m.files||[]) if (f.type==="file") { const h=c.createHash("sha256").update(fs.readFileSync(process.argv[2]+f.path)).digest("hex"); if (h!==f.sha256) { console.error("checksum mismatch in the bundle: "+f.path); process.exit(1); } }' \
  "$M" "$WORK/cfg/files" || die "the bundle's files do not match its manifest"
OLD_HOST=$(mj hostname) OLD_IPS=$(mj ips) OLD_ADDR=$(mj address) OLD_URL=$(mj public_base_url) OLD_FP=$(mj tls.sha256) OLD_VER=$(mj app_version)
cat <<EOF
  made ............ $(mj created) on $OLD_HOST ($OLD_IPS), ETS $OLD_VER ($(mj git_commit))
  address ......... $OLD_ADDR · $OLD_URL
  certificate ..... $(mj tls.mode) · SHA-256 $OLD_FP · valid until $(mj tls.not_after)
  database ........ $(mj db.name) as $(mj db.user) on $(mj db.host):$(mj db.port) · PostgreSQL $(mj postgres_version)
  items ........... $(mj items)
EOF
NEW_VER=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$SRC/backend/package.json" 2>/dev/null | head -1)
[[ -f "$SRC/deploy/install.sh" ]] || die "run this from a copy of the ETS repository (deploy/install.sh not found under $SRC)"
if [[ -n "$OLD_VER" && -n "$NEW_VER" ]] && [[ "$(printf '%s\n%s\n' "$OLD_VER" "$NEW_VER" | sort -V | tail -1)" != "$NEW_VER" ]]; then
  die "the backup comes from ETS $OLD_VER, this copy is $NEW_VER: use a copy of version $OLD_VER or newer"
fi
ok "ETS $NEW_VER will be installed (backup: $OLD_VER)"
fileof() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const f of m.files||[]) if(f.item===process.argv[2]&&f.type==="file") console.log(f.path)' "$M" "$1"; }
ENV_OLD=$(fileof env | head -1); ANS_OLD=$(fileof install_conf | head -1)
[[ -n "$ENV_OLD" && -n "$ANS_OLD" ]] || die "ets.env or install.conf missing from the bundle"
CERT=$(mj tls.cert) KEY=$(mj tls.key) TLSMODE=$(mj tls.mode)
if [[ $TLSMODE != letsencrypt ]]; then
  [[ -f "$WORK/cfg/files$CERT" && -f "$WORK/cfg/files$KEY" ]] || die "the certificate or its key is missing from the bundle"
  [[ "$(openssl x509 -in "$WORK/cfg/files$CERT" -noout -pubkey | sha256sum)" == "$(openssl pkey -in "$WORK/cfg/files$KEY" -pubout | sha256sum)" ]] \
    || die "the certificate and the key in the bundle do not belong together"
  openssl x509 -in "$WORK/cfg/files$CERT" -noout -checkend 2592000 >/dev/null || warn "the certificate expires within 30 days — renew it after the restore (phones must then be paired again)"
  ok "certificate and key match"
fi
if [[ -n "$DUMP" ]]; then
  bk_decrypt "$DUMP" "$WORK/db.dump" 2>/dev/null || die "cannot decrypt $(basename "$DUMP") with this key"
  pg_restore --list "$WORK/db.dump" >/dev/null || die "$(basename "$DUMP") is not a valid database backup"
  ok "database backup $(basename "$DUMP") decrypted and readable ($(stat -c %s "$WORK/db.dump") bytes)"
  rm -f "$WORK/db.dump"
fi
read -r -a MYIPS <<<"$(hostname -I 2>/dev/null || true)"
SAME_ADDR=no
for ip in "${MYIPS[@]}"; do [[ "$ip" == "$OLD_ADDR" ]] && SAME_ADDR=yes; done
if [[ $SAME_ADDR == no && ! "$OLD_ADDR" =~ ^[0-9.]+$ ]]; then   # a DNS name: does it point here?
  getent hosts "$OLD_ADDR" | awk '{print $1}' | grep -qxF -f <(printf '%s\n' "${MYIPS[@]}") 2>/dev/null && SAME_ADDR=yes
fi
if [[ $SAME_ADDR == yes ]]; then ok "this server has the address $OLD_ADDR"
else warn "this server does not have the address $OLD_ADDR (it has: ${MYIPS[*]:-?}) — the phones and browsers use that address: give this server the same IP (or move the DNS name) before users come back"; fi
if [[ $DRY -eq 1 ]]; then
  say "Dry run finished: the files decrypt, match their checksums and belong together. Nothing was installed or changed."
  exit 0
fi

# ---------------------------------------------------------------- 3. files back in place, installation
if [[ $YES -eq 0 ]]; then
  read -rp "Install ETS on THIS server with the configuration of $OLD_HOST${DUMP:+ and restore its database}? Type YES: " a </dev/tty
  [[ "$a" == YES ]] || die "cancelled — nothing was changed"
fi
say "3. Configuration files"
install -d -m 750 "$CONF"
install -m 600 -o root -g root "$WORK/cfg/files$ENV_OLD" "$CONF/ets.env"
install -m 644 -o root -g root "$WORK/cfg/files$ANS_OLD" "$CONF/install.conf"
DBCA=$(fileof db_ca | head -1); [[ -n "$DBCA" ]] && install -m 640 -o root -g root "$WORK/cfg/files$DBCA" "$CONF/db-ca.crt"
if [[ $TLSMODE == letsencrypt ]]; then
  while IFS= read -r p; do mkdir -p "$(dirname "$p")"; cp -a "$WORK/cfg/files$p" "$p"; done < <(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const f of m.files||[]) if(f.item==="tls_tree") console.log(f.path)' "$M")
else
  install -d "$(dirname "$CERT")" "$(dirname "$KEY")"
  install -m 644 -o root -g root "$WORK/cfg/files$CERT" "$CERT"
  install -m 600 -o root -g root "$WORK/cfg/files$KEY" "$KEY"
fi
# the old server's backup key stays the key of this server: the old and the new backups need the same escrowed key
install -m 600 -o root -g root "$BK_KEY" "$CONF/backup.key"
ok "ets.env, install.conf${DBCA:+, db-ca.crt}, certificate and key, backup key in place"

say "4. Installation (same answers, same certificate)"
bk_read_kv "$CONF/install.conf" '^DEF_[A-Z0-9_]+$'
ANS=$WORK/answers
{
  for k in ADDRESS TLS HTTPS_PORT HTTP_PORT API_PORT LE_EMAIL CERT KEY DB_MODE DB_HOST DB_PORT DB_NAME DB_USER DB_SSLMODE \
           ADMIN_USER ADMIN_NAME MFA_MODE ORG_NAME_AR ORG_NAME_EN TIMEZONE BACKUP_KEEP_DAYS FIREWALL; do
    v="DEF_$k"; printf 'ETS_%s="%s"\n' "$k" "${!v:-}"
  done
  if [[ -n "$DBCA" ]]; then cp "$CONF/db-ca.crt" "$WORK/db-ca.crt"; printf 'ETS_DB_SSLROOTCERT="%s"\n' "$WORK/db-ca.crt"; fi
  # remote database: the role's password from the restored ets.env (local: empty = keep the one in ets.env)
  [[ "${DEF_DB_MODE:-local}" == remote ]] && printf "ETS_DB_PASSWORD='%s'\n" "$(bk_env_get "$CONF/ets.env" PGPASSWORD)"
  printf 'ETS_ADMIN_EMAIL=""\nETS_IMPORT_FILE=""\n'
} >"$ANS"
[[ "${DEF_DB_MODE:-local}" == local ]] && echo 'ETS_DB_PASSWORD=""' >>"$ANS"
# a temporary administrator password: the restored database replaces the users anyway
ADMINPW="Restore-$(openssl rand -hex 12)-9"
printf "ETS_ADMIN_PASSWORD='%s'\n" "$ADMINPW" >>"$ANS"
ETS_KEEP_CERT=1 ETS_SKIP_FIRST_BACKUP=1 bash "$SRC/deploy/install.sh" --answers "$ANS" --yes
shred -u "$ANS" 2>/dev/null || rm -f "$ANS"

AUDIT=skipped
if [[ -n "$DUMP" && $SKIPDB -eq 0 ]]; then
  say "5. Database, migrations, audit chains"
  set +e; /usr/local/bin/ets-restore --yes --no-safety-backup --key "$BK_KEY" "$DUMP"; rc=$?; set -e
  case $rc in 0) AUDIT=ok ;; 4) AUDIT=broken ;; *) die "the database restore failed (see above)" ;; esac
fi

say "6. Checks"
PORT=$(bk_env_get "$CONF/ets.env" PORT); PORT=${PORT:-3000}
up=0; for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { up=1; break; }; sleep 1; done
if [[ $up == 1 ]]; then ok "the application answers (/api/health)"; else warn "the application does not answer — journalctl -u ets-backend -n 50"; fi
NOW_FP=''
CUR=$(bk_env_get "$CONF/install.conf" DEF_TLS)
case "$CUR" in selfsigned) NOW_FP=$(openssl x509 -in /etc/ssl/certs/ets-selfsigned.crt -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f') ;;
  existing) NOW_FP=$(openssl x509 -in "$(bk_env_get "$CONF/install.conf" DEF_CERT)" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f') ;; esac
PHONES=no; REASON=''
if [[ $TLSMODE == letsencrypt ]]; then PHONES=yes; REASON="publicly trusted certificate"
elif [[ -n "$NOW_FP" && "$NOW_FP" == "$OLD_FP" && $SAME_ADDR == yes ]]; then PHONES=yes; REASON="same certificate fingerprint and same address"
else REASON="$( [[ "$NOW_FP" != "$OLD_FP" ]] && echo "the certificate changed (phones pin it: pair them again)")$( [[ $SAME_ADDR != yes ]] && echo " this server does not have $OLD_ADDR yet")"; fi
cat <<EOF

${B}Restore summary${N}
  From ............. $OLD_HOST (ETS $OLD_VER) → $(hostname) (ETS $NEW_VER)
  Database ......... $( [[ $SKIPDB -eq 1 || -z "$DUMP" ]] && echo "not restored" || echo "$(basename "$DUMP") · audit chains: $AUDIT")
  Address .......... $OLD_URL · on this server: $SAME_ADDR
  Certificate ...... before $OLD_FP
                     now    ${NOW_FP:-?}
  Phones keep working without pairing again: ${B}$PHONES${N} ($REASON)
  Users ............ sign in with their old passwords and 2FA (APP_SECRET restored)
  Next ............. confirm the backup key escrow and the offsite destinations in Settings → «النسخ الاحتياطي»
EOF

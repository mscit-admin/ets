#!/usr/bin/env bash
# ETS backup (installed as /usr/local/bin/ets-backup; run by ets-backup.timer — hourly by default — and by the
# backup agent for «نسخ احتياطي الآن»; output in /var/log/ets-backup.log, offsite copies also in /var/log/ets-offsite.log).
#
#   ets-backup                  one run: database dump, configuration bundle (when changed), the day's logs bundle
#                               (once a day), retention, then the offsite copies
#   ets-backup --no-offsite     the same without the offsite copies (safety backup before a restore)
#   ets-backup --test ssh|nas|cloud    checks one destination (connect, write, read back, delete a test file)
#   ets-backup --ssh-key [--rotate]    creates the SSH key of the SSH destination (ed25519) and prints the public key
#
# Settings: /etc/ets/backup.conf (written by ets-backup-agent from Settings → «النسخ الاحتياطي»; read as data,
# never executed), database connection from /etc/ets/ets.env (any DB name/user, remote over TLS).
# Every artifact is encrypted with gpg (AES-256, tamper-evident) using the backup key /etc/ets/backup.key, which is
# NEVER put in a backup: keep it in escrow (docs/handover/08-Backup-and-Recovery.md).
# Next to each artifact: <file>.sha256 and <file>.meta (not secret: key id, kind, time, version, server, items) so a
# restore can tell which key it needs and what it holds before the key is typed.
set -euo pipefail
umask 077
CONF_DIR=${ETS_CONF_DIR:-/etc/ets}
BK_CONF_DIR=$CONF_DIR
ENVF=${ETS_ENV_FILE:-$CONF_DIR/ets.env}
ANSF=${ETS_INSTALL_CONF:-$CONF_DIR/install.conf}
BCONF=${ETS_BACKUP_CONF:-$CONF_DIR/backup.conf}
APP=${ETS_APP_DIR:-/opt/ets}
LOG_DIR_ETS=${ETS_LOG_DIR:-/var/log/ets}
SYSLOG_DIR=${ETS_SYSLOG_DIR:-/var/log}
NGINX_DIR=${ETS_NGINX_DIR:-/etc/nginx}
OFFSITE_LOG=${ETS_OFFSITE_LOG:-$SYSLOG_DIR/ets-offsite.log}
LOCK=${ETS_BACKUP_LOCK:-/run/lock/ets-backup.lock}
LIB=${ETS_BACKUP_LIB:-}
if [[ -z "$LIB" ]]; then
  for c in "$(dirname "$(readlink -f "$0")")/backup-lib.sh" /usr/local/lib/ets/backup-lib.sh; do [[ -r "$c" ]] && { LIB=$c; break; }; done
fi
# shellcheck source=deploy/scripts/backup-lib.sh
. "${LIB:?backup-lib.sh not found}"

MODE=run OFFSITE=1 TEST_DEST='' ROTATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-offsite) OFFSITE=0 ;;
    --test) shift; TEST_DEST=${1:-}; MODE='test'; [[ "$TEST_DEST" =~ ^(ssh|nas|cloud)$ ]] || { echo "usage: ets-backup --test ssh|nas|cloud" >&2; exit 2; } ;;
    --ssh-key) MODE=sshkey ;;
    --rotate) ROTATE=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[[ "${ETS_BACKUP_NO_OFFSITE:-0}" == 1 ]] && OFFSITE=0

[[ -r "$ENVF" ]] || { echo "cannot read $ENVF" >&2; exit 1; }
for k in PGHOST PGPORT PGDATABASE PGUSER PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do
  v=$(bk_env_get "$ENVF" "$k"); if [[ -n "$v" ]]; then export "$k=$v"; fi
done
case "${PGHOST:-}" in ''|127.0.0.1|localhost|::1|/*) DB_LOCAL=1 ;; *) DB_LOCAL=0; export PGSSLMODE="${PGSSLMODE:-require}" ;; esac
PW=$(bk_env_get "$ENVF" PGPASSWORD)
DIR=${ETS_BACKUP_DIR:-$(bk_env_get "$ENVF" ETS_BACKUP_DIR)}; DIR=${DIR:-/var/backups/ets}
BK_KEY=${ETS_BACKUP_KEY:-$(bk_env_get "$ENVF" ETS_BACKUP_KEY)}; BK_KEY=${BK_KEY:-$CONF_DIR/backup.key}
bk_load_conf "$BCONF" || exit 1
# 1.11.0 and earlier: ETS_BACKUP_KEEP_DAYS in ets.env (used only when backup.conf does not exist yet)
if [[ ! -f "$BCONF" ]]; then
  kd=$(bk_env_get "$ENVF" ETS_BACKUP_KEEP_DAYS); [[ "$kd" =~ ^[0-9]+$ ]] && (( kd > BACKUP_KEEP_DAILY )) && BACKUP_KEEP_DAILY=$kd
fi
SSH_KNOWN=$CONF_DIR/backup_known_hosts
olog() { local m; m="$(date -Is) $*"; echo "$m"; echo "$m" >>"$OFFSITE_LOG" 2>/dev/null || true; }
psql_app() { PGPASSWORD="$PW" psql -X -q -v ON_ERROR_STOP=1 "$@"; }
log_event() {   # event message json [level]
  psql_app -v e="$1" -v m="$2" -v d="$3" -v l="${4:-info}" >/dev/null <<'SQL' || echo "warning: could not record '$1' in system_log" >&2
INSERT INTO system_log(level,event,message,detail) VALUES (:'l', :'e', :'m', CAST(:'d' AS jsonb));
SQL
}
key_id() {   # id of the key that encrypts the backups (cached next to the key, recomputed when the key changes)
  local f=$BK_KEY.id
  if [[ ! -s "$f" || "$f" -ot "$BK_KEY" ]]; then
    if node "$APP/backend/scripts/backup-key-id.js" key "$BK_KEY" >"$f.tmp" 2>/dev/null; then mv -f "$f.tmp" "$f"
    else rm -f "$f.tmp"; echo unknown; return; fi
  fi
  cat "$f"
}

# ================================================================= destinations (SSH, NAS: rsync — cloud: rclone)
ssh_cmd() {
  printf 'ssh -i %s -p %s -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=%s -o ConnectTimeout=20 -o ServerAliveInterval=15' \
    "$BACKUP_SSH_KEY" "$BACKUP_SSH_PORT" "$SSH_KNOWN"
}
# rsync target of a destination (SSH: user@host:path; NAS: the mounted directory)
rs_target() { if [[ $1 == ssh ]]; then printf '%s' "${BACKUP_SSH_TARGET%/}/"; else printf '%s/' "${BACKUP_NAS_DIR%/}"; fi; }
rs() { local d=$1; shift; if [[ $d == ssh ]]; then rsync -e "$(ssh_cmd)" "$@"; else rsync "$@"; fi; }
rs_list() { rs "$1" --list-only --no-human-readable "$(rs_target "$1")" | awk '{print $NF}' | bk_artifacts; }
rclone_() { rclone --config "$BACKUP_RCLONE_CONFIG" --contimeout 20s --timeout 5m --retries 3 --low-level-retries 5 "$@"; }
rc_atomic() {   # object stores write an object only when its upload completes: no temporary name needed
  local name=${BACKUP_RCLONE_REMOTE%%:*} t
  t=$(rclone_ config show "$name" 2>/dev/null | sed -n 's/^type *= *//p' | head -1)
  [[ "$t" =~ ^(s3|gcs|google\ cloud\ storage|azureblob|b2|swift)$ ]]
}
dest_ready() {   # $1 → 0 / message on stderr
  case $1 in
    ssh) [[ -r "$BACKUP_SSH_KEY" ]] || { echo "SSH key $BACKUP_SSH_KEY is missing (create it: ets-backup --ssh-key)" >&2; return 1; } ;;
    nas)
      # never write into the root disk when the NAS is not mounted
      mountpoint -q "$BACKUP_NAS_DIR" || { echo "$BACKUP_NAS_DIR is not a mounted file system (NAS not mounted?) — nothing copied" >&2; return 1; }
      [[ -w "$BACKUP_NAS_DIR" ]] || { echo "$BACKUP_NAS_DIR is not writable" >&2; return 1; } ;;
    cloud)
      command -v rclone >/dev/null || { echo "rclone is not installed (apt-get install rclone)" >&2; return 1; }
      [[ -r "$BACKUP_RCLONE_CONFIG" ]] || { echo "rclone configuration $BACKUP_RCLONE_CONFIG is missing" >&2; return 1; } ;;
  esac
}
dest_list() { if [[ $1 == cloud ]]; then rclone_ lsf --files-only "$BACKUP_RCLONE_REMOTE" | bk_artifacts; else rs_list "$1"; fi; }

# replicate DEST WORKDIR → prints "copied deleted"; fails with a message on stderr. Called inside "if": errexit does not
# apply there, so every step checks its own result.
replicate() {
  local d=$1 w=$2 now
  dest_ready "$d" || return 1
  if [[ $d == cloud ]]; then rclone_ mkdir "$BACKUP_RCLONE_REMOTE" >/dev/null 2>&1 || true; fi
  dest_list "$d" >"$w/remote" || { echo "cannot list the destination" >&2; return 1; }
  find "$DIR" -maxdepth 1 -type f -printf '%f\n' | bk_artifacts | LC_ALL=C sort >"$w/local"
  now=$(date +%s)
  # one retention plan for local ∪ remote: what would be deleted anyway is neither uploaded nor kept
  sort -u "$w/local" "$w/remote" | bk_retention_plan "$now" "$BACKUP_KEEP_HOURLY" "$BACKUP_KEEP_DAILY" "$BACKUP_KEEP_WEEKLY" "$BACKUP_KEEP_MONTHLY" | LC_ALL=C sort >"$w/plan"
  LC_ALL=C sort "$w/remote" >"$w/remote.s"
  comm -23 "$w/local" "$w/remote.s" | comm -23 - "$w/plan" >"$w/copy"
  # artifacts first, checksums and key ids after them: a file listed on the destination is complete
  { grep -Ev '\.(sha256|keyid)$' "$w/copy" || true; grep -E '\.(sha256|keyid)$' "$w/copy" || true; } >"$w/copy.o"
  local n; n=$(wc -l <"$w/copy.o")
  if (( n > 0 )); then
    case $d in
      ssh|nas)
        # rsync writes each file under a temporary name and renames it when complete (--delay-updates: all at the end)
        rs "$d" -t --chmod=F600 --delay-updates --files-from="$w/copy.o" "$DIR/" "$(rs_target "$d")" >/dev/null || return 1
        # read back: checksums of the destination's files against the local files (-c), nothing may differ
        if [[ -n "$(rs "$d" -tcn -i --files-from="$w/copy.o" "$DIR/" "$(rs_target "$d")")" ]]; then
          echo "verification after the copy failed (size / checksum differ)" >&2; return 1
        fi ;;
      cloud)
        if rc_atomic; then
          rclone_ copy --files-from-raw "$w/copy.o" --no-traverse "$DIR" "$BACKUP_RCLONE_REMOTE" >/dev/null || return 1
        else
          local f
          while IFS= read -r f; do
            { rclone_ copyto "$DIR/$f" "$BACKUP_RCLONE_REMOTE/.$f.partial" && rclone_ moveto "$BACKUP_RCLONE_REMOTE/.$f.partial" "$BACKUP_RCLONE_REMOTE/$f"; } || return 1
          done <"$w/copy.o"
        fi
        # size and hash of each uploaded object against the local file
        rclone_ check --one-way --files-from-raw "$w/copy.o" "$DIR" "$BACKUP_RCLONE_REMOTE" >/dev/null 2>"$w/check.err" \
          || { tail -n 3 "$w/check.err" >&2; echo "verification after the upload failed" >&2; return 1; } ;;
    esac
  fi
  # retention on the destination (same tiers as locally)
  local prune=BACKUP_${d^^}_PRUNE; [[ $d == cloud ]] && prune=BACKUP_RCLONE_PRUNE
  local del=0
  comm -12 "$w/plan" "$w/remote.s" >"$w/delete"
  if [[ "${!prune}" == yes && -s "$w/delete" ]]; then
    del=$(wc -l <"$w/delete")
    case $d in
      ssh|nas)
        # rsync --delete from an empty directory, restricted to exactly these names (works through rrsync too)
        mkdir -p "$w/empty"
        sed 's|^|+ /|' "$w/delete" >"$w/filter"; echo '- *' >>"$w/filter"
        rs "$d" -r --delete --filter="merge $w/filter" "$w/empty/" "$(rs_target "$d")" >/dev/null || { echo "retention on the destination failed" >&2; return 1; } ;;
      cloud) rclone_ delete --files-from-raw "$w/delete" "$BACKUP_RCLONE_REMOTE" >/dev/null || { echo "retention on the destination failed" >&2; return 1; } ;;
    esac
  fi
  # what the destination holds now (shown in Settings → «النسخ الاحتياطي»)
  mkdir -p "$DIR/.offsite"
  dest_list "$d" >"$DIR/.offsite/$d.list.tmp" 2>/dev/null && mv -f "$DIR/.offsite/$d.list.tmp" "$DIR/.offsite/$d.list"
  echo "$n $del"
}
dest_label() { case $1 in ssh) echo "$BACKUP_SSH_TARGET" ;; nas) echo "$BACKUP_NAS_DIR" ;; cloud) echo "$BACKUP_RCLONE_REMOTE" ;; esac; }
configured_dests() {
  [[ -n "$BACKUP_SSH_TARGET" ]] && echo ssh
  [[ -n "$BACKUP_NAS_DIR" ]] && echo nas
  [[ -n "$BACKUP_RCLONE_REMOTE" ]] && echo cloud
  return 0
}

# ================================================================= --ssh-key / --test
if [[ $MODE == sshkey ]]; then
  if [[ -s "$BACKUP_SSH_KEY" && $ROTATE == 1 ]]; then mv -f "$BACKUP_SSH_KEY" "$BACKUP_SSH_KEY.old-$(date +%Y%m%d%H%M%S)"; rm -f "$BACKUP_SSH_KEY.pub"; fi
  if [[ ! -s "$BACKUP_SSH_KEY" ]]; then
    ssh-keygen -q -t ed25519 -N '' -C "ets-backup@$(hostname -s 2>/dev/null || echo ets)" -f "$BACKUP_SSH_KEY"
    chmod 600 "$BACKUP_SSH_KEY"; chmod 644 "$BACKUP_SSH_KEY.pub"
  fi
  [[ -s "$BACKUP_SSH_KEY.pub" ]] || ssh-keygen -y -f "$BACKUP_SSH_KEY" >"$BACKUP_SSH_KEY.pub"
  pub=$(cat "$BACKUP_SSH_KEY.pub"); fp=$(ssh-keygen -l -f "$BACKUP_SSH_KEY.pub" | awk '{print $2}')
  dir=${BACKUP_SSH_TARGET#*:}; [[ -n "$BACKUP_SSH_TARGET" && "${dir:0:1}" == / ]] || dir=/srv/backups/ets
  line="restrict,command=\"rrsync ${dir%/}\" $pub"
  echo "Public key ($fp) — on the backup server, for a dedicated user (e.g. etsbackup), add this line to ~etsbackup/.ssh/authorized_keys:"
  echo "  $line"
  echo "RESULT {\"ok\":true,\"public_key\":$(bk_json_str "$pub"),\"fingerprint\":$(bk_json_str "$fp"),\"authorized_keys_line\":$(bk_json_str "$line")}"
  exit 0
fi
if [[ $MODE == test ]]; then
  d=$TEST_DEST W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
  case $d in ssh) [[ -n "$BACKUP_SSH_TARGET" ]] ;; nas) [[ -n "$BACKUP_NAS_DIR" ]] ;; cloud) [[ -n "$BACKUP_RCLONE_REMOTE" ]] ;; esac \
    || { echo "RESULT {\"ok\":false,\"dest\":\"$d\",\"error\":\"not_configured\"}"; exit 1; }
  t=".ets-write-test-$(date +%s)"; echo "ETS write test $(date -Is)" >"$W/$t"
  extra=''
  test_dest() {   # every step must succeed (a function: errexit does not apply inside an if condition)
    dest_ready "$d" || return 1
    local n; n=$(dest_list "$d" | grep -cEv '\.(sha256|meta)$') || true
    case $d in
      ssh|nas)
        rs "$d" -t "$W/$t" "$(rs_target "$d")" >/dev/null || return 1
        if rs "$d" -tcn -i "$W/$t" "$(rs_target "$d")" | grep -q .; then echo "the test file read back differs" >&2; return 1; fi
        mkdir -p "$W/empty"; printf '+ /%s\n- *\n' "$t" >"$W/f"
        rs "$d" -r --delete --filter="merge $W/f" "$W/empty/" "$(rs_target "$d")" >/dev/null || return 1 ;;
      cloud)
        rclone_ mkdir "$BACKUP_RCLONE_REMOTE" >/dev/null 2>&1 || true
        rclone_ copyto "$W/$t" "$BACKUP_RCLONE_REMOTE/$t" >/dev/null || return 1
        rclone_ check --one-way --include "/$t" "$W" "$BACKUP_RCLONE_REMOTE" >/dev/null 2>&1 || { echo "the test object read back differs" >&2; return 1; }
        rclone_ deletefile "$BACKUP_RCLONE_REMOTE/$t" >/dev/null || return 1 ;;
    esac
    echo "files=${n:-0}" >"$W/n"
    if [[ $d == nas ]]; then df -Pk "$BACKUP_NAS_DIR" | awk 'NR==2{print "free_kb="$4}' >>"$W/n"; fi
  }
  if ! test_dest >/dev/null 2>"$W/err"; then
    echo "RESULT {\"ok\":false,\"dest\":\"$d\",\"error\":$(bk_json_str "$(grep -v '^$' "$W/err" | tail -n 3)")}"; exit 1
  fi
  files=$(sed -n 's/^files=//p' "$W/n"); free=$(sed -n 's/^free_kb=//p' "$W/n")
  [[ -n "$free" ]] && extra+=",\"free_kb\":$free"
  if [[ $d == ssh ]]; then
    h=${BACKUP_SSH_TARGET#*@}; h=${h%%:*}; [[ "$BACKUP_SSH_PORT" == 22 ]] || h="[$h]:$BACKUP_SSH_PORT"
    hfp=$(ssh-keygen -l -F "$h" -f "$SSH_KNOWN" 2>/dev/null | awk '!/^#/{print $2" ("$NF")"}' | head -3 | paste -sd ' ' -)
    extra+=",\"host_fingerprint\":$(bk_json_str "$hfp")"
  fi
  echo "RESULT {\"ok\":true,\"dest\":\"$d\",\"files\":${files:-0}$extra}"
  exit 0
fi

# ================================================================= one backup run
[[ -s "$BK_KEY" && -r "$BK_KEY" ]] || { echo "backup key $BK_KEY is missing — create it with: sudo bash deploy/scripts/update.sh (or: (umask 077; openssl rand -base64 48 > $BK_KEY))" >&2; exit 1; }
mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
flock -w "${ETS_BACKUP_LOCK_WAIT:-3600}" 9 || { echo "$(date -Is) another backup or restore is still running — skipped" >&2; exit 75; }
mkdir -p "$DIR"; chmod 700 "$DIR"
WORK=$(mktemp -d); GNUPGHOME=$WORK/gnupg; mkdir -m 700 "$GNUPGHOME"; export GNUPGHOME
STEP=start T0=$(date +%s)
TS=$(date +%Y%m%d-%H%M%S)
F="$DIR/ets-$TS.dump.gpg"
# shellcheck disable=SC2317  # called by the EXIT trap
on_exit() {
  local rc=$?
  rm -rf "$WORK"; rm -f "$DIR"/*.part
  if (( rc != 0 )) && [[ $STEP != finished ]]; then
    log_event backup_failed "backup failed at step $STEP" "{\"step\":$(bk_json_str "$STEP"),\"exit\":$rc}" error
  fi
}
trap on_exit EXIT
[[ ! -e "$F" ]] || { echo "$F already exists" >&2; exit 1; }   # never overwrite an earlier backup
KID=$(key_id)
APPVER=$( (sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$APP/backend/package.json" 2>/dev/null || true) | head -1)
COMMIT=$( (sed -n 's/^commit=//p' "$APP/BUILD-INFO" 2>/dev/null || true) | head -1)
PGVER=$(PGPASSWORD="$PW" psql -X -qtAc 'SHOW server_version' 2>/dev/null || true)
APPFP=$(node "$APP/backend/scripts/backup-key-id.js" app-secret "$ENVF" 2>/dev/null || true)
read -r -a IPS <<<"$(hostname -I 2>/dev/null || true)"
HOSTN=$(hostname -f 2>/dev/null || hostname)
seal() {   # FILE.part KIND [EXTRA_JSON] → FILE + FILE.sha256 + FILE.meta
  mv -f "$1.part" "$1"
  ( cd "$DIR" && sha256sum "$(basename "$1")" >"$(basename "$1").sha256" )
  printf '{"format":1,"kind":"%s","key_id":%s,"created":%s,"size":%s,"app_version":%s,"hostname":%s,"app_secret_fp":%s%s}\n' \
    "$2" "$(bk_json_str "$KID")" "$(bk_json_str "$(date -Is)")" "$(stat -c %s "$1")" "$(bk_json_str "$APPVER")" \
    "$(bk_json_str "$HOSTN")" "$(bk_json_str "$APPFP")" "${3:+,$3}" >"$1.meta"
}

# 1) database — with its size and row estimates (per table in the configuration manifest; totals in <dump>.meta)
STEP=dump
STATS=$(PGPASSWORD="$PW" psql -X -qtA -F $'\t' -c "SELECT c.relname, GREATEST(c.reltuples,0)::bigint, pg_total_relation_size(c.oid)
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') ORDER BY 1" 2>/dev/null || true)
DBSIZE=$(PGPASSWORD="$PW" psql -X -qtAc 'SELECT pg_database_size(current_database())' 2>/dev/null || echo 0)
NTAB=$(grep -c . <<<"$STATS" || true); NROWS=$(awk -F'\t' '{s+=$2} END {print s+0}' <<<"$STATS")
PGPASSWORD="$PW" pg_dump --format=custom --compress=9 | bk_encrypt "$F.part"
seal "$F" dump "\"db_size\":${DBSIZE:-0},\"tables\":${NTAB:-0},\"rows\":${NROWS:-0}"
SIZE=$(stat -c %s "$F")

# Older versions left an unencrypted copy of ets.env and plain dumps here: remove / encrypt them.
if [[ -e "$DIR/ets.env.backup" ]]; then shred -u "$DIR/ets.env.backup" 2>/dev/null || rm -f "$DIR/ets.env.backup"; fi
while IFS= read -r -d '' old; do
  bk_encrypt "$old.gpg.part" <"$old"; seal "$old.gpg" dump
  touch -r "$old" "$old.gpg" "$old.gpg.sha256"
  shred -u "$old" 2>/dev/null || rm -f "$old"
  echo "encrypted older backup $old.gpg"
done < <(find "$DIR" -maxdepth 1 -name 'ets-*.dump' -type f -print0)

# 2) configuration bundle — taken every run, kept only when its content changed
STEP=config
S=$WORK/config; mkdir -p "$S/files"; : >"$WORK/files.tsv"
# add PATH ITEM — ITEM: env | install_conf | db_ca | tls (restorable) or ref (for reference only)
add() {
  local p=$1 item=$2 dst="$S/files$1"
  [[ "$(readlink -f "$p")" != "$(readlink -f "$BK_KEY")" ]] || { echo "refusing to put the backup key in a backup" >&2; return 1; }
  if [[ -d "$p" && ! -L "$p" ]]; then
    local f; while IFS= read -r -d '' f; do add "$f" "$item"; done < <(find "$p" -mindepth 1 \( -type f -o -type l \) -print0 | sort -z)
    return 0
  fi
  [[ -e "$p" || -L "$p" ]] || return 0
  mkdir -p "$(dirname "$dst")"
  if [[ -L "$p" && "$item" == tls_tree ]]; then
    cp -P "$p" "$dst"; printf '%s\tlink\t%s\t%s\n' "$p" "$item" "$(readlink "$p")" >>"$WORK/files.tsv"; return 0
  fi
  cp -L "$p" "$dst"
  printf '%s\tfile\t%s\t%s\t%s\t%s\n' "$p" "$item" "$(sha256sum <"$dst" | cut -d' ' -f1)" "$(stat -L -c '%a:%U:%G' "$p")" "$(stat -c %s "$dst")" >>"$WORK/files.tsv"
}
DEF_TLS='' DEF_ADDRESS='' DEF_CERT='' DEF_KEY=''
if [[ -r "$ANSF" ]]; then bk_read_kv "$ANSF" '^DEF_[A-Z0-9_]+$' 2>/dev/null || true; fi
case "$DEF_TLS" in
  selfsigned)  CERT=${ETS_TLS_CERT:-/etc/ssl/certs/ets-selfsigned.crt}; CKEY=${ETS_TLS_KEY:-/etc/ssl/private/ets-selfsigned.key} ;;
  letsencrypt) CERT=/etc/letsencrypt/live/$DEF_ADDRESS/fullchain.pem; CKEY=/etc/letsencrypt/live/$DEF_ADDRESS/privkey.pem ;;
  existing)    CERT=$DEF_CERT; CKEY=$DEF_KEY ;;
  *)           CERT=''; CKEY='' ;;
esac
add "$ENVF" env
add "$ANSF" install_conf
add "$CONF_DIR/db-ca.crt" db_ca
if [[ "$DEF_TLS" == letsencrypt ]]; then add /etc/letsencrypt tls_tree; elif [[ -n "$CERT" ]]; then add "$CERT" tls; add "$CKEY" tls; fi
add "$BCONF" ref
add "$NGINX_DIR/sites-available/ets" ref
add "$NGINX_DIR/snippets/ets-app.conf" ref
add "$NGINX_DIR/snippets/ets-headers.conf" ref
# roles of the cluster (no data). Superuser over the local socket: with password hashes; otherwise as the
# application role without passwords (pg_dumpall --no-role-passwords reads pg_roles, not pg_authid).
GLOBALS=unavailable GLOBALS_NOTE=''
if (( DB_LOCAL )) && [[ $EUID == 0 ]] && id -u postgres >/dev/null 2>&1 && \
   runuser -u postgres -- env -i PATH="$PATH" pg_dumpall -w --globals-only -h "${ETS_SU_PGHOST:-/var/run/postgresql}" -p "${PGPORT:-5432}" >"$S/globals.sql" 2>"$WORK/g.err"; then
  GLOBALS=full
elif PGPASSWORD="$PW" pg_dumpall -w --globals-only --no-role-passwords -l "${PGDATABASE:-ets}" >"$S/globals.sql" 2>"$WORK/g.err"; then
  GLOBALS=no_passwords
else
  rm -f "$S/globals.sql"; GLOBALS_NOTE=$(head -c 300 "$WORK/g.err")
  echo "note: roles not included (pg_dumpall: $GLOBALS_NOTE)" >&2
fi
CERT_SHA=''; CERT_SAN=''; CERT_END=''
if [[ -n "$CERT" && -r "$CERT" ]]; then
  CERT_SHA=$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')
  CERT_SAN=$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ' | paste -sd, -)
  CERT_END=$(date -d "$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)" -Is 2>/dev/null || true)
fi
# (pg_dump 16.10+ writes a random \restrict key into each dump: left out of the comparison)
GSHA=''; [[ -f "$S/globals.sql" ]] && GSHA=$( (grep -Ev '^\\(un)?restrict ' "$S/globals.sql" || true) | sha256sum | cut -d' ' -f1)
# what makes two bundles "the same": file contents and modes, roles, and the identity of the server and key
STABLE="v=$APPVER|c=$COMMIT|h=$HOSTN|ip=${IPS[*]:-}|a=$DEF_ADDRESS|u=$(bk_env_get "$ENVF" PUBLIC_BASE_URL)|t=$CERT_SHA|k=$KID|pg=$PGVER|g=$GSHA|fp=$APPFP"
CONTENT=$( { LC_ALL=C sort "$WORK/files.tsv"; echo "$STABLE"; } | sha256sum | cut -d' ' -f1)
STATE=$DIR/.ets-config.state
LASTC=$(sed -n 's/^content=//p' "$STATE" 2>/dev/null || true); LASTF=$(sed -n 's/^file=//p' "$STATE" 2>/dev/null || true)
CFG_FILE='' CFG_SKIPPED=0
if [[ "$CONTENT" == "$LASTC" && -n "$LASTF" && -f "$DIR/$LASTF" ]]; then
  CFG_SKIPPED=1; CFG_FILE=$LASTF
  echo "configuration unchanged since $LASTF — no new bundle"
else
  files_json=$(awk -F'\t' '{
      gsub(/\\/,"\\\\"); gsub(/"/,"\\\"");
      if ($2=="link") printf "%s{\"path\":\"%s\",\"type\":\"link\",\"item\":\"%s\",\"target\":\"%s\"}", (NR>1?",":""), $1, $3, $4;
      else { split($5,m,":"); printf "%s{\"path\":\"%s\",\"type\":\"file\",\"item\":\"%s\",\"sha256\":\"%s\",\"mode\":\"%s\",\"owner\":\"%s\",\"group\":\"%s\",\"size\":%s}", (NR>1?",":""), $1, $3, $4, m[1], m[2], m[3], $6 }
    }' "$WORK/files.tsv")
  items=$(cut -f3 "$WORK/files.tsv" | sed 's/^tls_tree$/tls/' | grep -v '^ref$' | sort -u | paste -sd' ' -)
  # shellcheck disable=SC2086  # items: word list
  cat >"$S/manifest.json" <<EOF
{
  "format": 1,
  "created": $(bk_json_str "$(date -Is)"),
  "app_version": $(bk_json_str "$APPVER"),
  "git_commit": $(bk_json_str "$COMMIT"),
  "postgres_version": $(bk_json_str "$PGVER"),
  "db": {"name": $(bk_json_str "${PGDATABASE:-}"), "user": $(bk_json_str "${PGUSER:-}"), "host": $(bk_json_str "${PGHOST:-}"), "port": $(bk_json_str "${PGPORT:-5432}")},
  "hostname": $(bk_json_str "$HOSTN"),
  "ips": $(bk_json_arr "${IPS[@]}"),
  "address": $(bk_json_str "$DEF_ADDRESS"),
  "public_base_url": $(bk_json_str "$(bk_env_get "$ENVF" PUBLIC_BASE_URL)"),
  "tls_cert_sha256": $(bk_json_str "$(bk_env_get "$ENVF" TLS_CERT_SHA256)"),
  "tls": {"mode": $(bk_json_str "$DEF_TLS"), "cert": $(bk_json_str "$CERT"), "key": $(bk_json_str "$CKEY"), "sha256": $(bk_json_str "$CERT_SHA"), "san": $(bk_json_str "$CERT_SAN"), "not_after": $(bk_json_str "$CERT_END")},
  "app_secret_fp": $(bk_json_str "$APPFP"),
  "backup_key_id": $(bk_json_str "$KID"),
  "globals": {"mode": $(bk_json_str "$GLOBALS"), "note": $(bk_json_str "$GLOBALS_NOTE")},
  "items": $(bk_json_arr $items),
  "db_stats": {"db_size": ${DBSIZE:-0}, "tables": [$(awk -F'\t' 'NF==3{printf "%s{\"table\":\"%s\",\"rows\":%s,\"bytes\":%s}", (n++?",":""), $1, $2, $3}' <<<"$STATS")]},
  "content_sha256": $(bk_json_str "$CONTENT"),
  "files": [$files_json]
}
EOF
  CFG_FILE="ets-config-$TS.tar.gpg"
  tar -C "$S" -cf - . | bk_encrypt "$DIR/$CFG_FILE.part"
  # shellcheck disable=SC2086  # items: word list
  seal "$DIR/$CFG_FILE" config "\"items\":$(bk_json_arr $items),\"tls_san\":$(bk_json_str "$CERT_SAN"),\"tls_sha256\":$(bk_json_str "$CERT_SHA"),\"address\":$(bk_json_str "$DEF_ADDRESS"),\"ips\":$(bk_json_arr "${IPS[@]}")"
  printf 'content=%s\nfile=%s\n' "$CONTENT" "$CFG_FILE" >"$STATE"
  echo "configuration bundle $CFG_FILE"
fi

# 3) the day's logs bundle — ETS's own text logs only, once a day (the first run at or after BACKUP_LOGS_TIME)
STEP=logs
LOGS_FILE=''
TODAY=$(date +%Y%m%d)
if [[ ! -f "$DIR/ets-logs-$TODAY.tar.gpg" ]] && { [[ "$(date +%H:%M)" > "$BACKUP_LOGS_TIME" || "$(date +%H:%M)" == "$BACKUP_LOGS_TIME" ]] || (( BACKUP_FREQUENCY_HOURS >= 24 )); }; then
  : >"$WORK/logs.lst"
  find "$LOG_DIR_ETS" -maxdepth 1 -type f -regextype posix-extended -regex '.*/[A-Za-z0-9._-]+\.log([.-][0-9A-Za-z.-]+)?' -print 2>/dev/null >>"$WORK/logs.lst" || true
  find "$SYSLOG_DIR" -maxdepth 1 -type f -regextype posix-extended \
    -regex '.*/ets-(backup|offsite|backup-verify|backup-agent|restore|install)\.log([.-][0-9A-Za-z.-]+)?' -print 2>/dev/null >>"$WORK/logs.lst" || true
  if [[ -s "$WORK/logs.lst" ]]; then
    LOGS_FILE="ets-logs-$TODAY.tar.gpg"
    set +o pipefail
    sed 's|^/||' "$WORK/logs.lst" | LC_ALL=C sort | tar -C / --warning=no-file-changed -cf - -T - | bk_encrypt "$DIR/$LOGS_FILE.part" zlib
    rc=("${PIPESTATUS[@]}"); set -o pipefail
    (( rc[2] <= 1 && rc[3] == 0 )) || { echo "logs bundle failed (tar ${rc[2]}, gpg ${rc[3]})" >&2; exit 1; }
    seal "$DIR/$LOGS_FILE" logs "\"date\":\"$TODAY\",\"files\":$(wc -l <"$WORK/logs.lst")"
    echo "logs bundle $LOGS_FILE ($(wc -l <"$WORK/logs.lst") files)"
  fi
fi

# 4) local retention (tiers by the timestamp in the name)
STEP=retention
DELETED=0
while IFS= read -r n; do rm -f -- "${DIR:?}/$n"; DELETED=$((DELETED+1)); done < <(
  find "$DIR" -maxdepth 1 -type f -printf '%f\n' | bk_retention_plan "$(date +%s)" "$BACKUP_KEEP_HOURLY" "$BACKUP_KEEP_DAILY" "$BACKUP_KEEP_WEEKLY" "$BACKUP_KEEP_MONTHLY")
(( DELETED )) && echo "retention: deleted $DELETED old file(s)"

STEP=record
mapfile -t DESTS < <(configured_dests)
(( OFFSITE )) || DESTS=()
NEXT=$( (systemctl show ets-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null || true) | head -1)
[[ -n "$NEXT" && "$NEXT" != n/a ]] && NEXT=$(date -d "$NEXT" -Is 2>/dev/null || true) || NEXT=''
echo "$(date -Is) backup ok: $F ($(du -h "$F" | cut -f1))"
log_event backup 'database backup created' "{\"file\":$(bk_json_str "$F"),\"size\":$SIZE,\"key_id\":$(bk_json_str "$KID"),\"config\":{\"file\":$(bk_json_str "$CFG_FILE"),\"unchanged\":$( ((CFG_SKIPPED)) && echo true || echo false)},\"logs\":$(bk_json_str "$LOGS_FILE"),\"globals\":$(bk_json_str "$GLOBALS"),\"offsite\":$(bk_json_arr "${DESTS[@]}"),\"deleted\":$DELETED,\"frequency_hours\":$BACKUP_FREQUENCY_HOURS,\"next_run\":$(bk_json_str "$NEXT"),\"seconds\":$(( $(date +%s) - T0 ))}"
STEP=finished

# 5) offsite copies — each destination on its own: a failure of one does not stop the others
for d in "${DESTS[@]}"; do
  w=$WORK/off-$d; mkdir -p "$w"
  t1=$(date +%s)
  if out=$(replicate "$d" "$w" 2>"$w/err"); then
    read -r nc nd <<<"$out"
    olog "offsite $d ($(dest_label "$d")): ok, $nc file(s) copied, $nd deleted"
    log_event backup_offsite "offsite copy $d ok" "{\"dest\":\"$d\",\"ok\":true,\"target\":$(bk_json_str "$(dest_label "$d")"),\"files\":$nc,\"deleted\":$nd,\"error\":null,\"seconds\":$(( $(date +%s) - t1 ))}"
  else
    e=$(grep -v '^$' "$w/err" | tail -n 3 | head -c 400); e=${e:-failed}
    olog "offsite $d ($(dest_label "$d")): FAILED — $e"
    log_event backup_offsite "offsite copy $d failed" "{\"dest\":\"$d\",\"ok\":false,\"target\":$(bk_json_str "$(dest_label "$d")"),\"files\":0,\"error\":$(bk_json_str "$e"),\"seconds\":$(( $(date +%s) - t1 ))}" error
  fi
done
if [[ -n "${ETS_BACKUP_RESULT_FILE:-}" ]]; then printf '%s\n' "$F" >"$ETS_BACKUP_RESULT_FILE"; fi
exit 0

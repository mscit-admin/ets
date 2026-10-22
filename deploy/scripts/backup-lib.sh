# shellcheck shell=bash
# ETS — functions shared by the backup commands (sourced, never run directly):
#   ets-backup (backup.sh), ets-backup-verify (backup-verify.sh), ets-restore-server (restore-server.sh)
#   and the unit test deploy/tests/backup-retention.test.sh.
# Installed as /usr/local/lib/ets/backup-lib.sh.
#
# Artifacts (one hourly run; <ts> = local time YYYYmmdd-HHMMSS, <date> = YYYYmmdd):
#   ets-<ts>.dump.gpg            database (pg_dump custom format), gpg AES-256 with the backup key
#   ets-config-<ts>.tar.gpg      configuration bundle (only when the configuration changed)
#   ets-logs-<date>.tar.gpg      ETS's own text logs (once a day)
#   <artifact>.sha256            checksum of each artifact
#   <artifact>.meta              JSON, not secret: id of the key that encrypted it, kind, time, app version, server
#                                name, APP_SECRET fingerprint, available items / database size — read by the restore
#                                wizard before the key is typed (backend/src/backup/config.js)

# ---------------------------------------------------------------- reading configuration (never executed)
# bk_env_get FILE KEY — value of KEY in an env file (quotes removed)
bk_env_get() {
  local v; v=$(sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1)
  v=${v%\'}; v=${v#\'}; v=${v%\"}; v=${v#\"}; printf '%s' "$v"
}
# bk_read_kv FILE NAME_REGEX — KEY=value lines (unquoted, "double" or 'single' quoted; no expansion), like
# read_kv in deploy-lib.sh. Only names matching NAME_REGEX are set (as globals); others are reported and ignored.
bk_read_kv() {
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

# Defaults of /etc/ets/backup.conf (written by ets-backup-agent from the settings of the web UI).
# shellcheck disable=SC2034  # read by the scripts that source this file
bk_conf_defaults() {
  BACKUP_FREQUENCY_HOURS=1 BACKUP_LOGS_TIME=00:45
  BACKUP_KEEP_HOURLY=48 BACKUP_KEEP_DAILY=30 BACKUP_KEEP_WEEKLY=12 BACKUP_KEEP_MONTHLY=12
  BACKUP_VERIFY_ENABLED=yes
  BACKUP_SSH_TARGET='' BACKUP_SSH_PORT=22 BACKUP_SSH_KEY='' BACKUP_SSH_PRUNE=yes
  BACKUP_NAS_DIR='' BACKUP_NAS_PRUNE=yes
  BACKUP_RCLONE_REMOTE='' BACKUP_RCLONE_CONFIG='' BACKUP_RCLONE_PRUNE=yes
}
# bk_load_conf FILE — defaults, then the file when it exists; every value is checked again here (the file is
# root-only, but nothing from it reaches a shell unchecked).
bk_load_conf() {
  bk_conf_defaults
  if [[ -f "$1" ]]; then bk_read_kv "$1" '^BACKUP_[A-Z0-9_]+$' || return 1; fi
  : "${BACKUP_SSH_KEY:=$BK_CONF_DIR/backup_ssh_key}" "${BACKUP_RCLONE_CONFIG:=$BK_CONF_DIR/rclone.conf}"
  local k
  for k in BACKUP_KEEP_HOURLY BACKUP_KEEP_DAILY BACKUP_KEEP_WEEKLY BACKUP_KEEP_MONTHLY BACKUP_FREQUENCY_HOURS BACKUP_SSH_PORT; do
    [[ "${!k}" =~ ^[0-9]{1,5}$ ]] || { echo "$1: $k must be a number" >&2; return 1; }
  done
  [[ "$BACKUP_LOGS_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo "$1: BACKUP_LOGS_TIME must be HH:MM" >&2; return 1; }
  [[ -z "$BACKUP_SSH_TARGET" ]] || bk_valid_ssh_target "$BACKUP_SSH_TARGET" || { echo "$1: invalid BACKUP_SSH_TARGET" >&2; return 1; }
  [[ -z "$BACKUP_NAS_DIR" ]] || bk_valid_nas_dir "$BACKUP_NAS_DIR" || { echo "$1: invalid BACKUP_NAS_DIR (an absolute path under /mnt, /media or /srv)" >&2; return 1; }
  [[ -z "$BACKUP_RCLONE_REMOTE" ]] || bk_valid_rclone_remote "$BACKUP_RCLONE_REMOTE" || { echo "$1: invalid BACKUP_RCLONE_REMOTE (name:bucket/path)" >&2; return 1; }
  { bk_safe_path "$BACKUP_SSH_KEY" && bk_safe_path "$BACKUP_RCLONE_CONFIG"; } || { echo "$1: invalid key / rclone config path" >&2; return 1; }
}

# ---------------------------------------------------------------- strict validation (same rules as services/backup-config.js)
bk_safe_path() { [[ "$1" =~ ^/[A-Za-z0-9._/@+-]+$ && ! "$1" =~ (^|/)\.\.(/|$) ]]; }
# user@host:path — user: letters, digits . _ -; host: IPv4 or DNS name; path: letters, digits . _ / + - (no "..").
bk_valid_ssh_target() {
  local re='^([a-z_][a-z0-9_.-]{0,31})@([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([A-Za-z0-9._/+-]{0,200})$'
  [[ "$1" =~ $re ]] || return 1
  local p=${BASH_REMATCH[4]}
  [[ ! "$p" =~ (^|/)\.\.(/|$) && "${p:0:1}" != - ]]
}
bk_valid_nas_dir() { bk_safe_path "$1" && [[ "$1" =~ ^/(mnt|media|srv)/[A-Za-z0-9._@+-] ]]; }
bk_valid_rclone_remote() {
  [[ "$1" =~ ^[A-Za-z0-9_-]{1,40}:([A-Za-z0-9._/-]{0,200})$ ]] && [[ ! "${BASH_REMATCH[1]}" =~ (^|/)\.\.(/|$) ]]
}

# ---------------------------------------------------------------- artifacts and retention
# bk_parse NAME → "kind ts" (kind: dump | config | logs; ts: YYYYmmdd-HHMMSS) or nothing
bk_parse() {
  if [[ $1 =~ ^ets-([0-9]{8}-[0-9]{6})\.dump(\.gpg)?$ ]]; then echo "dump ${BASH_REMATCH[1]}"
  elif [[ $1 =~ ^ets-config-([0-9]{8}-[0-9]{6})\.tar\.gpg$ ]]; then echo "config ${BASH_REMATCH[1]}"
  # a day's logs bundle counts as the end of that day
  elif [[ $1 =~ ^ets-logs-([0-9]{8})\.tar\.gpg$ ]]; then echo "logs ${BASH_REMATCH[1]}-235959"
  fi
}
# bk_ts_lines: "YYYYmmdd-HHMMSS" lines on stdin → "epoch ISOyear-ISOweek" lines (local time; "x x" when invalid)
bk_ts_lines() {
  local -a t; local x out
  mapfile -t t
  ((${#t[@]})) || return 0
  # one date process for the whole list; one per line only when a name holds an impossible date
  if out=$(for x in "${t[@]}"; do printf '%s-%s-%s %s:%s:%s\n' "${x:0:4}" "${x:4:2}" "${x:6:2}" "${x:9:2}" "${x:11:2}" "${x:13:2}"; done \
      | date -f - '+%s %G-%V' 2>/dev/null) && (( $(wc -l <<<"$out") == ${#t[@]} )); then
    printf '%s\n' "$out"; return 0
  fi
  for x in "${t[@]}"; do
    date -d "${x:0:4}-${x:4:2}-${x:6:2} ${x:9:2}:${x:11:2}:${x:13:2}" '+%s %G-%V' 2>/dev/null || echo 'x x'
  done
}
# _bk_gfs NOW H D W M — "ts name" lines of ONE kind on stdin (any order) → names to keep.
# Tiers (time-based, by the timestamp in the name, never by mtime):
#   every artifact younger than H hours; the newest of each day for D days; of each ISO week for W weeks; of
#   each calendar month for M months (the current month counts as one); always the newest artifact; an
#   artifact dated in the future (clock change) is kept.
_bk_gfs() {
  local now=$1 H=$2 D=$3 W=$4 M=$5
  local -a ts=() names=() info=() lines=()
  local line i age ep wk mon nowmon keep
  mapfile -t lines < <(LC_ALL=C sort -r)
  ((${#lines[@]})) || return 0
  for line in "${lines[@]}"; do ts+=("${line%% *}"); names+=("${line#* }"); done
  mapfile -t info < <(printf '%s\n' "${ts[@]}" | bk_ts_lines)
  nowmon=$(( $(date -d "@$now" +%Y) * 12 + 10#$(date -d "@$now" +%m) ))
  local -A day=() week=() month=()
  for i in "${!ts[@]}"; do
    ep=${info[i]%% *}; wk=${info[i]#* }
    if [[ ! "$ep" =~ ^[0-9]+$ ]]; then echo "${names[i]}"; continue; fi   # unreadable date: never deleted
    age=$(( now - ep )); keep=0
    (( i == 0 || age < 0 || age < H * 3600 )) && keep=1
    if (( age < D * 86400 )) && [[ -z "${day[${ts[i]:0:8}]:-}" ]]; then day[${ts[i]:0:8}]=1; keep=1; fi
    if (( age < W * 7 * 86400 )) && [[ -z "${week[$wk]:-}" ]]; then week[$wk]=1; keep=1; fi
    mon=$(( 10#${ts[i]:0:4} * 12 + 10#${ts[i]:4:2} ))
    if (( nowmon - mon < M )) && [[ -z "${month[$mon]:-}" ]]; then month[$mon]=1; keep=1; fi
    (( keep )) && echo "${names[i]}"
  done
  return 0
}

# bk_retention_plan NOW H D W M — file names on stdin (a backup directory or a destination's listing) →
# the names to delete on stdout. Shared by the local directory and every destination (SSH, NAS, cloud).
#   dumps and logs bundles: the tiers above, each kind on its own;
#   configuration bundles (made only when the configuration changes): the newest one, and for each kept dump
#   the bundle that was in force when it was made;
#   <name>.sha256 / <name>.meta go with their artifact (deleted when it is gone); other files are never touched.
bk_retention_plan() {
  local now=$1 H=$2 D=$3 W=$4 M=$5 n p kind ts
  local -a all=() dumps=() logs=() configs=()
  local -A present=() keep=()
  mapfile -t all
  for n in "${all[@]}"; do
    [[ -n "$n" ]] || continue
    present[$n]=1
    p=$(bk_parse "$n") || true
    [[ -n "$p" ]] || continue
    kind=${p%% *}; ts=${p#* }
    case $kind in dump) dumps+=("$ts $n") ;; logs) logs+=("$ts $n") ;; config) configs+=("$ts $n") ;; esac
  done
  local k kept_dump_ts=()
  if ((${#dumps[@]})); then
    while IFS= read -r k; do keep[$k]=1; done < <(printf '%s\n' "${dumps[@]}" | _bk_gfs "$now" "$H" "$D" "$W" "$M")
  fi
  if ((${#logs[@]})); then
    while IFS= read -r k; do keep[$k]=1; done < <(printf '%s\n' "${logs[@]}" | _bk_gfs "$now" "$H" "$D" "$W" "$M")
  fi
  for k in "${dumps[@]}"; do [[ -n "${keep[${k#* }]:-}" ]] && kept_dump_ts+=("${k%% *}"); done
  if ((${#configs[@]})); then
    local -a cs; mapfile -t cs < <(printf '%s\n' "${configs[@]}" | LC_ALL=C sort)
    keep[${cs[-1]#* }]=1                                   # the newest bundle
    local d c best
    for d in "${kept_dump_ts[@]}"; do                      # the bundle in force when each kept dump was made
      best=''
      for c in "${cs[@]}"; do [[ "${c%% *}" > "$d" ]] && break; best=$c; done
      [[ -n "$best" ]] && keep[${best#* }]=1
    done
  fi
  for n in "${all[@]}"; do
    [[ -n "$n" ]] || continue
    if [[ "$n" == *.sha256 || "$n" == *.meta ]]; then
      local base=${n%.*}
      p=$(bk_parse "$base") || true
      [[ -n "$p" ]] || continue
      if [[ -z "${present[$base]:-}" || -z "${keep[$base]:-}" ]]; then echo "$n"; fi
      continue
    fi
    p=$(bk_parse "$n") || true
    [[ -n "$p" && -z "${keep[$n]:-}" ]] && echo "$n"
  done
  return 0
}

# bk_artifacts — artifact and checksum names of a directory listing on stdin (other files left out)
bk_artifacts() { grep -E '^ets-(config-[0-9]{8}-[0-9]{6}\.tar\.gpg|logs-[0-9]{8}\.tar\.gpg|[0-9]{8}-[0-9]{6}\.dump(\.gpg)?)(\.sha256|\.meta)?$' || true; }

# bk_latest KIND [MAX_TS] — names on stdin → newest artifact of KIND (dump | config | logs), optionally not newer than MAX_TS
bk_latest() {
  local n p best='' bts=''
  while IFS= read -r n; do
    p=$(bk_parse "$n") || true
    [[ -n "$p" && "${p%% *}" == "$1" ]] || continue
    [[ -n "${2:-}" && "${p#* }" > "$2" ]] && continue
    if [[ -z "$bts" || "${p#* }" > "$bts" ]]; then bts=${p#* }; best=$n; fi
  done
  [[ -n "$best" ]] && printf '%s\n' "$best"
}

# ---------------------------------------------------------------- JSON (system_log details, manifests, job results)
bk_json_str() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  s=$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\037')
  printf '"%s"' "$s"
}
# bk_json_arr a b c → ["a","b","c"]
bk_json_arr() { local out='' x; for x in "$@"; do out+="${out:+,}$(bk_json_str "$x")"; done; printf '[%s]' "$out"; }

# ---------------------------------------------------------------- gpg with the backup key
bk_encrypt() {   # stdin → $1; $2 = compress (zlib) or none
  gpg --batch --quiet --yes --pinentry-mode loopback --passphrase-file "$BK_KEY" \
    --symmetric --cipher-algo AES256 --compress-algo "${2:-none}" --output "$1"
}
bk_decrypt() {   # $1 → $2
  gpg --batch --quiet --yes --pinentry-mode loopback --passphrase-file "$BK_KEY" --decrypt --output "$2" "$1"
}
# bk_sha_ok FILE — true when FILE.sha256 exists and matches (or 2 when there is no checksum file)
bk_sha_ok() {
  [[ -f "$1.sha256" ]] || return 2
  [[ "$(cut -d' ' -f1 "$1.sha256")" == "$(sha256sum "$1" | cut -d' ' -f1)" ]]
}

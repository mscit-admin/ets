#!/usr/bin/env bash
# Unit test of the backup retention (bk_retention_plan in deploy/scripts/backup-lib.sh) and of the strict validation
# of destinations, on synthetic file lists. No database, no root:   bash deploy/tests/backup-retention.test.sh
# shellcheck disable=SC2178,SC2128,SC2016  # loop variables share names with the library's locals; literal injection strings
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/backup-lib.sh
. "$HERE/../scripts/backup-lib.sh"
export TZ=UTC
PASS=0 FAIL=0
ok()   { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '     %s\n' "$2"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
ts() { date -u -d "@$1" +%Y%m%d-%H%M%S; }
NOW=$(date -u -d '2026-10-22 12:30:00' +%s)
H=48 D=30 W=12 M=12

# 1) hourly backups for 400 days (+ checksums), one config bundle per month, daily logs bundles
LIST=$(
  for ((h=0; h<400*24; h++)); do t=$(ts $((NOW - h*3600 - 23*60))); echo "ets-$t.dump.gpg"; echo "ets-$t.dump.gpg.sha256"; done
  for ((m=0; m<14; m++)); do t=$(ts $((NOW - m*30*86400 - 3600))); echo "ets-config-$t.tar.gpg"; echo "ets-config-$t.tar.gpg.sha256"; done
  for ((d=0; d<120; d++)); do t=$(date -u -d "@$((NOW - d*86400))" +%Y%m%d); echo "ets-logs-$t.tar.gpg"; echo "ets-logs-$t.tar.gpg.sha256"; done
  echo "README.txt"; echo ".ets-config.state"
)
DEL=$(bk_retention_plan "$NOW" $H $D $W $M <<<"$LIST")
KEEP=$(comm -23 <(sort <<<"$LIST") <(sort <<<"$DEL"))
kd=$(grep -cE '^ets-[0-9]{8}-[0-9]{6}\.dump\.gpg$' <<<"$KEEP")
# 48 hourly (the newest 48 within 48 h) + 28 more days (30 days: 2 of them inside the 48 h) + weeks beyond 30 days
# (12 weeks = 84 days → ~7–8 more) + months beyond (12 months → ~9 more); the exact count depends on the calendar
if (( kd >= 48+28+6 && kd <= 48+28+8+10 )); then ok "dumps kept by the tiers: $kd"; else bad "dumps kept by the tiers" "got $kd"; fi
within48=$(grep -cE '^ets-[0-9]{8}-[0-9]{6}\.dump\.gpg$' <<<"$(for ((h=0; h<48; h++)); do echo "ets-$(ts $((NOW - h*3600 - 23*60))).dump.gpg"; done)")
miss=0; for ((h=0; h<48; h++)); do grep -qx "ets-$(ts $((NOW - h*3600 - 23*60))).dump.gpg" <<<"$KEEP" || miss=1; done
check "every backup of the last 48 h is kept ($within48)" "$miss" 0
miss=0
for ((d=0; d<30; d++)); do
  day=$(date -u -d "@$((NOW - d*86400))" +%Y%m%d)
  n=$(grep -cE "^ets-$day-[0-9]{6}\.dump\.gpg$" <<<"$KEEP"); (( n >= 1 )) || miss=1
done
check "one backup of each of the last 30 days is kept" "$miss" 0
d1=$(date -u -d "@$((NOW - 5*86400))" +%Y%m%d)
check "a day older than 48 h keeps exactly its newest backup" "$(grep -E "^ets-$d1-[0-9]{6}\.dump\.gpg$" <<<"$KEEP")" "ets-$d1-230700.dump.gpg"
old=$(grep -E '^ets-[0-9]{8}-[0-9]{6}\.dump\.gpg$' <<<"$KEEP" | sort | head -1)
oldest_ok=$(( NOW - $(date -u -d "${old:4:4}-${old:8:2}-${old:10:2} ${old:13:2}:${old:15:2}:${old:17:2}" +%s) < 366*86400 ))
check "nothing older than the monthly window is kept ($old)" "$oldest_ok" 1
miss=0; while IFS= read -r f; do grep -qx "$f.sha256" <<<"$KEEP" || miss=1; done < <(grep -E '\.gpg$' <<<"$KEEP")
check "each kept artifact keeps its checksum" "$miss" 0
orph=0; while IFS= read -r f; do grep -qx "${f%.sha256}" <<<"$KEEP" || orph=1; done < <(grep -E '\.sha256$' <<<"$KEEP")
check "no checksum is kept without its artifact" "$orph" 0
check "other files are never deleted" "$(grep -cE '^(README.txt|\.ets-config\.state)$' <<<"$DEL")" 0
kl=$(grep -cE '^ets-logs-' <<<"$KEEP"); kl=$((kl/2))
if (( kl >= 30 && kl <= 30+8+4 )); then ok "logs bundles follow the same tiers: $kl"; else bad "logs bundles tiers" "got $kl"; fi
# every kept dump has the configuration bundle in force at that time
miss=0
while IFS= read -r f; do
  t=${f:4:15}; best=$(grep -E '^ets-config-[0-9]{8}-[0-9]{6}\.tar\.gpg$' <<<"$LIST" | sort | awk -v t="$t" '{ if (substr($0,12,15) <= t) b=$0 } END { print b }')
  [[ -z "$best" ]] || grep -qx "$best" <<<"$KEEP" || { miss=1; echo "     missing $best for $f"; }
done < <(grep -E '^ets-[0-9]{8}-[0-9]{6}\.dump\.gpg$' <<<"$KEEP")
check "the configuration in force for each kept dump is kept" "$miss" 0
check "the newest configuration bundle is kept" "$(grep -c "^ets-config-$(ts $((NOW - 3600))).tar.gpg$" <<<"$KEEP")" 1

# 2) migration from 1.11.0: 30 daily backups at 01:30 (plus a pre-update backup): none of the dailies is deleted
LIST2=$(for ((d=0; d<30; d++)); do t=$(date -u -d "@$((NOW - d*86400))" +%Y%m%d); echo "ets-$t-013000.dump.gpg"; echo "ets-$t-013000.dump.gpg.sha256"; done
        echo "ets-$(ts $((NOW - 600))).dump.gpg")
DEL2=$(bk_retention_plan "$NOW" $H $D $W $M <<<"$LIST2")
check "1.11.0 dailies younger than 30 days survive the first run" "$DEL2" ""
# a customised ETS_BACKUP_KEEP_DAYS=60 migrated to BACKUP_KEEP_DAILY=60 keeps 60 dailies
LIST3=$(for ((d=0; d<60; d++)); do echo "ets-$(date -u -d "@$((NOW - d*86400))" +%Y%m%d)-013000.dump.gpg"; done)
check "60 dailies kept with BACKUP_KEEP_DAILY=60" "$(bk_retention_plan "$NOW" $H 60 $W $M <<<"$LIST3")" ""

# 3) edge cases
check "a single old backup is always kept" "$(bk_retention_plan "$NOW" 1 1 0 0 <<<"ets-20200101-010000.dump.gpg")" ""
check "a future-dated backup is kept" "$(bk_retention_plan "$NOW" 1 1 0 0 <<<$'ets-20300101-010000.dump.gpg\nets-20261022-120000.dump.gpg')" ""
check "an invalid date in a name is never deleted" "$(bk_retention_plan "$NOW" 1 1 0 0 <<<$'ets-20261399-010000.dump.gpg\nets-20261022-120000.dump.gpg')" ""
check "an orphan checksum is deleted" "$(bk_retention_plan "$NOW" $H $D $W $M <<<$'ets-20261022-120000.dump.gpg\nets-20261001-010000.dump.gpg.sha256')" "ets-20261001-010000.dump.gpg.sha256"
check "a 1.0 plain dump name is recognised" "$(bk_parse ets-20261001-013000.dump)" "dump 20261001-013000"
check "bk_latest picks the newest dump" "$(printf '%s\n' ets-20261001-013000.dump.gpg ets-20261021-013000.dump.gpg ets-config-20261022-000000.tar.gpg | bk_latest dump)" "ets-20261021-013000.dump.gpg"
check "bk_latest config not newer than a dump" "$(printf '%s\n' ets-config-20261001-000000.tar.gpg ets-config-20261022-000000.tar.gpg | bk_latest config 20261021-013000)" "ets-config-20261001-000000.tar.gpg"

# 4) strict validation of destinations (the same rules as backend/src/services/backup-config.js)
for t in 'ets@10.0.0.5:/srv/backups/ets' 'backup@nas.example.org:ets' 'u_1@host:' ; do
  if bk_valid_ssh_target "$t"; then ok "accepts SSH target $t"; else bad "accepts SSH target $t"; fi
done
for t in 'ets@host:/srv;rm -rf /' 'ets@host:$(id)' 'ets@-oProxyCommand=x:/p' 'ets@host:/a/../etc' 'root@host:/p b' 'ets@host:-e' "ets@host:/p'" 'ets@ho\`st:/p' 'ets@host' ; do
  if bk_valid_ssh_target "$t"; then bad "rejects SSH target $t"; else ok "rejects SSH target $t"; fi
done
for d in /mnt/ets-backup /media/nas/ets /srv/backup; do if bk_valid_nas_dir "$d"; then ok "accepts NAS dir $d"; else bad "accepts NAS dir $d"; fi; done
for d in / /etc/ets /var/backups/ets /mnt /mnt/../etc '/mnt/a b' '/mnt/$(id)' mnt/x /mnt/x/../../etc; do
  if bk_valid_nas_dir "$d"; then bad "rejects NAS dir $d"; else ok "rejects NAS dir $d"; fi
done
for r in 'ets-cloud:bucket/ets' 's3:my.bucket' ; do if bk_valid_rclone_remote "$r"; then ok "accepts remote $r"; else bad "accepts remote $r"; fi; done
for r in 'x:b;ls' 'x:b/../c' ':b' 'x y:b' 'x:$(id)' '--config=/tmp/x:b'; do
  if bk_valid_rclone_remote "$r"; then bad "rejects remote $r"; else ok "rejects remote $r"; fi
done
check "JSON strings are escaped" "$(bk_json_str $'a"b\\c\nd\001')" '"a\"b\\c\nd"'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))

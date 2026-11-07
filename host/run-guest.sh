#!/bin/bash
# run-guest.sh INSTANCE: relaunch one line instance, one 3600 s admission after another (from guest/run-mini.sh). Before each
# launch it switches to the newest guest release approved on GuestEscrow (guest-update.sh) and, under the laptop profile, waits
# until the Mac is on AC power, below thermal pressure, has MIN_FREE_MIB to spare and (PAUSE_WHEN_ACTIVE) has been idle.
# A running guest is never paused; a closed lid takes it offline and the broker marks it unreachable.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd) LH=${LAYOVER_HOME:-$HOME/layover}
N=$1 I=$LH/instances/$1
source "$LH/host.env"; source "$HERE/profiles/$PROFILE.env"; source "$I/launch.env"
: "${AGENT_ID:?}" "${DAILY_BYTES:?}" "${OPERATOR:?}" "${ESCROW:?}" "${GUEST_ESCROW:?}" "${CHAIN_ID:?}"
[ -s "$I/instructions.txt" ]
log() { echo "$(date -u +%FT%TZ) $*" >> "$I/loop.log"; }
blocked() {  # prints why a launch must wait; a gate that cannot read its value waits too
  local batt therm vm ps free idle
  if [ "$REQUIRE_AC" = 1 ]; then
    batt=$(pmset -g batt) || { echo "power source unreadable"; return; }
    grep -q "'AC Power'" <<<"$batt" || { echo "on battery"; return; }
  fi
  if [ "$PAUSE_ON_THERMAL" = 1 ]; then
    therm=$(pmset -g therm) || { echo "thermal state unreadable"; return; }
    grep -qE 'CPU_Speed_Limit[[:space:]]*=[[:space:]]*([0-9]|[1-9][0-9])$' <<<"$therm" && { echo "thermal limit"; return; }
    grep -qiE 'thermal warning level set to [1-9]' <<<"$therm" && { echo "thermal warning"; return; }
  fi
  vm=$(vm_stat) && ps=$(pagesize) || { echo "memory unreadable"; return; }
  free=$(awk '/^Pages (free|inactive|speculative):/{gsub("\\.","",$NF);s+=$NF;n++}END{if(n==3)print s}' <<<"$vm")
  [[ $free =~ ^[0-9]+$ && $ps =~ ^[0-9]+$ ]] || { echo "memory unreadable"; return; }
  free=$((free * ps / 1048576))
  [ "$free" -ge $((4096 + MIN_FREE_MIB)) ] || { echo "free memory ${free} MiB"; return; }
  if [ "$PAUSE_WHEN_ACTIVE" = 1 ]; then
    idle=$(ioreg -c IOHIDSystem) || { echo "idle time unreadable"; return; }
    idle=$(awk '/HIDIdleTime/{print $NF; exit}' <<<"$idle")
    [[ $idle =~ ^[0-9]+$ ]] || { echo "idle time unreadable"; return; }
    [ $((idle / 1000000000)) -ge "$IDLE_SECONDS" ] || { echo "owner active (idle $((idle / 1000000000))s)"; return; }
  fi
}
R=$I/run-current
while [ ! -e "$I/stop" ]; do
  while ! B=$(blocked) || [ -n "$B" ]; do log "wait: ${B:-gate error}"; sleep 60; [ -e "$I/stop" ] && exit 0; done
  "$HERE/guest-update.sh" >> "$I/loop.log" 2>&1
  W=$LH/workload
  mkdir "$R"
  cp -c "$W/workload.img" "$W/compose-manifest.json" "$R/"
  /usr/bin/python3 "$HERE/inputs.py" "$R/compose-manifest.json" "$R/inputs.img" AGENT_ID="$AGENT_ID" DAILY_BYTES="$DAILY_BYTES" OPERATOR="$OPERATOR" \
    ESCROW="$ESCROW" GUEST_ESCROW="$GUEST_ESCROW" CHAIN_ID="$CHAIN_ID" INSTRUCTIONS="$(cat "$I/instructions.txt")" ${UPSTREAM_PROXY:+UPSTREAM_PROXY="$UPSTREAM_PROXY"}
  log "launch $(readlink "$W")"
  /usr/bin/python3 "$HERE/pool_mac_run.py" "$LH/runner" "$R" 3600 mini-4096-1 "$R/inputs.img" > "$R/host-run.log" 2>&1 || log "exit $?"
  rm "$R/workload.img" "$R/inputs.img"
  rm -f "$R"/out/scratch.img "$R"/out/*.img.staged
  mv "$R" "$I/runs/run-$(date +%s)"
  sleep 60
done

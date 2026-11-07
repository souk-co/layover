#!/bin/bash
# run-mini.sh INSTANCE: relaunch one guest instance on the mini, one 3600 s admission after another, through dsmack's own
# launcher (pool_mac_run.py). Instances share the build (~/projects/resip-guest/workload, runner/) and differ in launch inputs:
# instances/INSTANCE/launch.env sets AGENT_ID, DAILY_BYTES, OPERATOR, ESCROW, GUEST_ESCROW, CHAIN_ID and optionally UPSTREAM_PROXY (the instance's
# route) and WORKLOAD (a build other than workload/, e.g. the staging lane's), instances/INSTANCE/instructions.txt is the host's text for it. Each instance has its own run dir, runs/, loop.log and
# stop file under instances/INSTANCE, so several run side by side (one loop per instance), each as its own VM.
# The run dir is linked as ~/ds/run-resip-INSTANCE and ~/dl/run-resip-INSTANCE so the two private-agent pools' preflight
# (--coexist-pool, which globs run-*/session.json) sees it instead of pausing their rotation.
# inputs.py writes the launch inputs to the private-input disk, pool_mac_run.py's fifth argument. AGENT_ID must be the one
# custody and the site bound to this Mac's attestation key.
set -euo pipefail
G=$HOME/projects/resip-guest
N=$1 I=$G/instances/$1
source "$I/launch.env"
: "${AGENT_ID:?}" "${DAILY_BYTES:?}" "${OPERATOR:?set OPERATOR in $I/launch.env}" "${ESCROW:?set ESCROW in $I/launch.env}" \
  "${GUEST_ESCROW:?set GUEST_ESCROW in $I/launch.env}" "${CHAIN_ID:?set CHAIN_ID in $I/launch.env}"
[ -s "$I/instructions.txt" ]
RUNNER=$G/runner
LAUNCH=$HOME/dsmack-staging/source/applications/compute-node/pool_mac_run.py
R=$I/run-current
mkdir -p "$I/runs"
ln -sfn "$R" "$HOME/ds/run-resip-$N"
ln -sfn "$R" "$HOME/dl/run-resip-$N"
while [ ! -e "$I/stop" ]; do
  mkdir "$R"
  cp -c "${WORKLOAD:-$G/workload}/workload.img" "${WORKLOAD:-$G/workload}/compose-manifest.json" "$R/"
  /usr/bin/python3 "$G/inputs.py" "$R/compose-manifest.json" "$R/inputs.img" AGENT_ID="$AGENT_ID" DAILY_BYTES="$DAILY_BYTES" OPERATOR="$OPERATOR" \
    ESCROW="$ESCROW" GUEST_ESCROW="$GUEST_ESCROW" CHAIN_ID="$CHAIN_ID" INSTRUCTIONS="$(cat "$I/instructions.txt")" ${UPSTREAM_PROXY:+UPSTREAM_PROXY="$UPSTREAM_PROXY"}
  echo "$(date -u +%FT%TZ) launch" >> "$I/loop.log"
  /usr/bin/python3 "$LAUNCH" "$RUNNER" "$R" 3600 mini-4096-1 "$R/inputs.img" > "$R/host-run.log" 2>&1 || echo "$(date -u +%FT%TZ) exit $?" >> "$I/loop.log"
  rm "$R/workload.img" "$R/inputs.img"
  rm -f "$R"/out/scratch.img "$R"/out/*.img.staged "$R"/out/.*.partial
  mv "$R" "$I/runs/run-$(date +%s)"
  sleep 60
done
rm "$HOME/ds/run-resip-$N" "$HOME/dl/run-resip-$N"

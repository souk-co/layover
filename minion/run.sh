#!/bin/bash
# cron (hourly): one minion cycle, skipped (and logged as skipped) while the previous one still runs; log per cycle under logs/
set -uo pipefail
cd /data/amiller/layover-minion
export MINION_HOME=$PWD DENO=$HOME/.deno/bin/deno TMPDIR=$PWD/tmp PATH=$HOME/.deno/bin:/usr/bin:/bin
[ -f netmeasure.env ] && . ./netmeasure.env
log=logs/$(date -u +%Y%m%dT%H%M%SZ).log
# the site's current buyer kit each cycle: it pins the staging enrollment key, which rotates
curl -fsS --fail-early --output-dir kit --remote-name-all "${MINION_SITE:-https://pod.dstack.soc1024.com/resip-staging}/kit/{SKILL.md,souk.py,account.py,layover.js,feed.py}" >> "$log" 2>&1 || exit 1
flock -n -E 75 minion.lock python3 minion.py cycle >> "$log" 2>&1
rc=$?
[ $rc -eq 75 ] && echo "skipped: the previous cycle still holds minion.lock" >> "$log"
exit $rc

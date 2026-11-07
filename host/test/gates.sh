#!/bin/bash
# test/gates.sh: run-guest.sh's laptop gates against stubbed pmset/vm_stat/pagesize/ioreg, through the caller's own wait condition.
# Only a healthy Mac launches (with or without a CPU_Speed_Limit line); every limit and every unreadable value waits.
set -euo pipefail
H=$(cd "$(dirname "$0")/.." && pwd); STUB=$(mktemp -d); trap 'rm -rf "$STUB"' EXIT
source /dev/stdin <<<"$(sed -n '/^blocked() {/,/^}/p' "$H/run-guest.sh")"
COND=$(sed -n 's/^  while \(! B=$(blocked) || \[ -n "$B" \]\); do.*/\1/p' "$H/run-guest.sh"); [ -n "$COND" ]
REQUIRE_AC=1 PAUSE_ON_THERMAL=1 PAUSE_WHEN_ACTIVE=1 IDLE_SECONDS=300 MIN_FREE_MIB=2048
mk() { printf '#!/bin/bash\n%s\n' "$2" > "$STUB/$1"; chmod +x "$STUB/$1"; }
AC='echo "Now drawing from '"'"'AC Power'"'"'"'
good() {
  mk pmset 'case "$2" in batt) '"$AC"';; therm) printf "CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 100\n";; esac'
  mk vm_stat 'printf "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 300000.\nPages active: 100.\nPages inactive: 200000.\nPages speculative: 1000.\n"'
  mk pagesize 'echo 16384'
  mk ioreg 'echo "    | |   \"HIDIdleTime\" = 48965079713583"'
}
FAIL=0
expect() {
  if PATH=$STUB:/usr/bin:/bin eval "$COND"; then R="wait: ${B:-gate error}"; else R=launch; fi
  [[ $R == $1* ]] && S=ok || { S=FAIL; FAIL=1; }
  printf '%-4s %-26s %s\n' "$S" "$2" "$R"
}
good; expect launch "all good"
good; mk pmset 'case "$2" in batt) '"$AC"';; therm) echo "Note: No thermal warning level has been recorded";; esac'; expect launch "therm: nothing recorded"
good; mk pmset 'case "$2" in batt) echo "Now drawing from '"'"'Battery Power'"'"'";; therm) echo;; esac'; expect wait "on battery"
good; mk pmset 'case "$2" in batt) '"$AC"';; therm) printf "CPU_Speed_Limit \t= 50\n";; esac'; expect wait "thermal limit 50"
good; mk pmset 'case "$2" in batt) '"$AC"';; therm) echo "Thermal warning level set to 2.";; esac'; expect wait "thermal warning"
good; mk pmset 'exit 1'; expect wait "pmset fails"
good; mk pmset 'case "$2" in batt) '"$AC"';; therm) exit 1;; esac'; expect wait "pmset therm fails only"
good; mk vm_stat 'exit 1'; expect wait "vm_stat fails"
good; mk vm_stat 'echo garbage'; expect wait "vm_stat garbage"
good; mk pagesize 'exit 1'; expect wait "pagesize fails"
good; mk ioreg 'exit 1'; expect wait "ioreg fails"
good; mk ioreg 'echo nothing'; expect wait "ioreg no HIDIdleTime"
good; mk ioreg 'echo "\"HIDIdleTime\" = 1000000000"'; expect wait "owner active 1s"
good; mk vm_stat 'printf "Pages free: 100.\nPages inactive: 100.\nPages speculative: 1.\n"'; expect wait "low memory"
exit $FAIL

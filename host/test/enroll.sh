#!/bin/bash
# The runner creates its enrollment directory; LaunchServices can exit zero after an app failure.
set -euo pipefail
JOIN=$(cd "$(dirname "$0")/.." && pwd)/join.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export LAYOVER_HOME=$T/home
mkdir -p "$T/bin" "$LAYOVER_HOME"
printf "PROFILE=desktop\n" > "$LAYOVER_HOME/host.env"
cat > "$T/bin/open" <<'OPEN'
#!/bin/bash
set -eu
[ ! -e "$6" ]
[ "${MISSING_OUTPUTS:-0}" = 0 ] || exit 0
mkdir "$6"
printf a2V5 > "$6/keyId.txt"
printf attestation > "$6/attestation.cbor"
printf client > "$6/clientData.bin"
OPEN
chmod +x "$T/bin/open"
export PATH=$T/bin:$PATH
bash "$JOIN" enroll > "$T/enrolled.log"
[ -s "$LAYOVER_HOME/runner/enrollment/keyId.txt" ]
if bash "$JOIN" enroll > "$T/overwrite.log" 2>&1; then echo "overwrote enrollment" >&2; exit 1; fi
rm -r "$LAYOVER_HOME/runner/enrollment"
if MISSING_OUTPUTS=1 bash "$JOIN" enroll > "$T/missing.log" 2>&1; then echo "accepted missing outputs" >&2; exit 1; fi
bash "$JOIN" --dry-run enroll > "$T/dry-run.log"
[ ! -e "$LAYOVER_HOME/runner/enrollment" ]
echo "enrollment lifecycle passed"

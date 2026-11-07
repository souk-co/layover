#!/bin/bash
# guest-update.sh: point $LH/workload at the newest guest-* release of souk-co/layover whose manifest GuestEscrow approves
# (approved(keccak(image, manifest, sha256("agent"))), read through layover-chain's Helios-verified /call) and whose base
# image is the one in $LH/runner/base. Downloads and checks it first; the switch is one symlink, taken at the next launch.
set -euo pipefail
LH=${LAYOVER_HOME:-$HOME/layover}
GUEST_ESCROW=0xdf9bb576E30Ec71E200643AB6FC835Eee12C95EA CHAIN=https://pod.dstack.soc1024.com/layover-chain
CALLER=0x$(printf agent | shasum -a 256 | cut -c1-64)
abi() { "$LH/venv/bin/python" "$(dirname "$0")/abi.py" "$@"; }
BASE=$(shasum -a 256 "$LH/runner/base/sha256sum.txt" | cut -c1-64)
for TAG in $(gh api repos/souk-co/layover/releases --jq '.[] | select(.tag_name | startswith("guest-")) | select(.draft | not) | .tag_name'); do
  D=$LH/guests/$TAG
  [ -f "$D/GUEST.json" ] || { mkdir -p "$D.part"; gh release download "$TAG" -R souk-co/layover -p GUEST.json -p compose-manifest.json -D "$D.part" --clobber; }
  [ -f "$D/GUEST.json" ] && S=$D || S=$D.part
  M=$(shasum -a 256 "$S/compose-manifest.json" | cut -c1-64)
  read GM IMG < <(python3 -c 'import json,sys;g=json.load(open(sys.argv[1]));m=json.load(open(sys.argv[2]));print(g["manifest_sha256"],m["base_vm"]["os_image_hash"])' "$S/GUEST.json" "$S/compose-manifest.json")
  [ "$GM" = "$M" ] || { echo "$TAG: GUEST.json names manifest $GM, file is $M" >&2; exit 1; }
  [ "$IMG" = "$BASE" ] || { echo "$TAG: base $IMG, this runner has $BASE; skipped"; continue; }
  W=$(abi workload $IMG $M $CALLER)
  OK=$(curl -fsS "$CHAIN/call?to=$GUEST_ESCROW&data=$(abi calldata 'approved(bytes32)' $W)" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["verified_by"].startswith("helios"),d;print(int(d["result"],16))')
  [ "$OK" = 1 ] || { echo "$TAG: manifest $M not approved on GuestEscrow; skipped"; continue; }
  if [ ! -f "$D/GUEST.json" ]; then
    gh release download "$TAG" -R souk-co/layover -p workload.img.gz -D "$D.part" --clobber
    gunzip -c "$D.part/workload.img.gz" > "$D.part/workload.img"; rm "$D.part/workload.img.gz"
    [ "$(shasum -a 256 "$D.part/workload.img" | cut -c1-64)" = "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["workload_sha256"])' "$D.part/GUEST.json")" ]
    mv "$D.part" "$D"
  fi
  [ "$(readlink "$LH/workload" 2>/dev/null)" = "$D" ] || { ln -sfn "$D" "$LH/workload"; echo "$(date -u +%FT%TZ) guest -> $TAG (manifest $M)"; }
  exit 0
done
echo "no approved guest release for base $BASE" >&2; exit 1

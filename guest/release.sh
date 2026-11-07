#!/bin/bash
# guest/release.sh WEB_DIR PREV: build this commit's guest on zed, allow its manifest and base (and only them) in WEB_DIR/custody.json,
# commit and push that, redeploy custody, then swap the workload on the mini. The loop runs it from its next launch.
# PREV is the build whose workload.img the mini has now. Only a gzipped 512-byte block patch against it (blkdiff.py) goes to
# the mini, through the laptop, whose link drops full image copies; the mini applies it and the result must match zed's sha256.
# Run on the laptop (the custody deploy reads TEE_DAEMON_TOKEN here). WEB_DIR is branch web's web/.
# It never deploys the site. A site build that drops an endpoint the guest calls (as moving custody did) goes out only
# after a release whose guest no longer calls it is running: custody's GET shows a release to the new manifest.
set -euo pipefail
GATEWAY=f5d3b9a5 DSMACK=ad7c7c97
Z=/data/amiller/resip-guest M='~/projects/resip-guest'
BASE=$Z/base-8783a3be
G=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
WEB=$(cd "$1" && pwd) PREV=$2
git -C "$G" diff --quiet HEAD -- guest || { echo "guest/ has uncommitted changes" >&2; exit 1; }
OS=$(ssh zed-mesh "sha256sum $BASE/sha256sum.txt" | cut -d' ' -f1)
RB=$(ssh mini-mesh "shasum -a 256 $M/runner/base/sha256sum.txt" | cut -d' ' -f1)
[ "$OS" = "$RB" ] || { echo "base $OS on zed, but the mini's runner has $RB" >&2; exit 1; }
V=$(git -C "$G" rev-parse --short=8 HEAD)
B=$Z/build-$V
ssh zed-mesh "mkdir $B"
git -C "$G" archive HEAD:guest | ssh zed-mesh "tar -x -C $B"
ssh zed-mesh "cd $B && python3 pack.py $Z/dsmack-$GATEWAY $Z/dsmack-$DSMACK $BASE $Z/starter.json out $V > pack.log 2>&1"
H=$(ssh zed-mesh "sha256sum $B/out/compose-manifest.json" | cut -d' ' -f1)
OLD=$Z/build-$PREV/out/disk/workload.img
[ "$(ssh zed-mesh "sha256sum $OLD" | cut -d' ' -f1)" = "$(ssh mini-mesh "shasum -a 256 $M/workload/workload.img" | cut -d' ' -f1)" ] \
  || { echo "the mini's workload.img is not build-$PREV's" >&2; exit 1; }
ssh zed-mesh "set -o pipefail; python3 $B/blkdiff.py diff $OLD $B/out/disk/workload.img | gzip > $B/workload.patch.gz"
T=$(mktemp -d)
rsync --partial --bwlimit=20000 zed-mesh:$B/workload.patch.gz "$T/"
rsync --partial --bwlimit=20000 "$G/guest/blkdiff.py" "$T/workload.patch.gz" mini-mesh:$M/
ssh mini-mesh "set -o pipefail; cd $M && gunzip -c workload.patch.gz | python3 blkdiff.py apply workload/workload.img workload.img.new && rm workload.patch.gz"
W=$(ssh zed-mesh "sha256sum $B/out/disk/workload.img" | cut -d' ' -f1)
[ "$(ssh mini-mesh "shasum -a 256 $M/workload.img.new" | cut -d' ' -f1)" = "$W" ] || { echo "workload.img.new on the mini is not build-$V's $W" >&2; exit 1; }
ssh zed-mesh "cat $B/out/compose-manifest.json" | ssh mini-mesh "cat > $M/compose-manifest.json.new"
python3 - "$WEB/custody.json" "$H" "$OS" <<'EOF'
import json, sys
p, h, os = sys.argv[1:]
c = json.load(open(p))
c.update(manifests=[h], os_image_hashes=[os])
open(p, "w").write(json.dumps(c, indent=1) + "\n")
EOF
git -C "$WEB" commit -m "Custody: allow guest $V (manifest $H, image $OS)" custody.json
git -C "$WEB" push origin HEAD
python3 "$WEB/deploy.py" custody
ssh mini-mesh "cd $M && mv workload.img.new workload/workload.img && mv compose-manifest.json.new workload/compose-manifest.json"
echo "guest $V manifest $H (image $OS) is on the mini; custody allows only it"

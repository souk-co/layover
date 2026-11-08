#!/bin/bash
# ONE re-pin of the Mac couch pool: pack a new guest from merged dsmack main, register its class, add it to the broker next
# to the live one, restart the pool on it. Live (the starter and the rollback target) is the 2026-11-06 b release:
# manifest def1ca2f, class 0xa4280664, broker package from 9f0e0f88. Run one stage at a time, in this order:
#   check    read-only: the live key e3a6e561 is enrolled on AppleAttestRegistry and MacLinked to the operator, and
#            layover-chain serves /code and block-pinned reads of UsageEscrow (layover branch chain-read-admission deployed)
#   build    on zed: guest binaries and the arm64 couch image as a gzip OCI layout; prints the image digest
#   pack     on zed: key-free compose manifest + workload.img for a new payment class; checks the base image is unchanged
#   preflight on the laptop: the packed release through the guest's PAYMENTS_CONFIG decoder, the pool's workload check and
#            the site's kit allowlist and mirror rule (couch/dsmack/preflight.py); register runs it first
#   register on the laptop: register the new class on chain (UsageEscrow) with the packed manifest hash
#   broker   on the laptop: deploy the merged relay-broker with the new class and workload added and no pinned enrollments
#   install  on the Mac: full launcher restart of org.dsmack.pool.live (the CONNECT proxy changed, so no SIGHUP swap)
#   ready    wait for verified ready slots under the new manifest
#   kit      on the laptop: the key-free manifestTemplate for the kit and the exact manifest for private-agent-web
#   rollback the Mac back on the old pool command and workload, the broker back on the live b package (9f0e0f88);
#            only before the kit stage's pins are merged
# Every stage can be rerun: finished steps are detected and skipped.
# Inputs (environment):
#   DSMACK_REF   merged dsmack commit, full 40-hex sha, containing couch-browse and key-free-manifest (local main; production deploys from it)
#   CLASS        new payment class id, 0x + 64 hex; create once with: export CLASS=0x$(openssl rand -hex 32)
#   WORK         a fresh working directory name, e.g. couch-repin-20261107 (zed: ~/dsmack-releases/WORK, laptop: dsmack local-data/WORK)
#   BASE         zed path of the live base bundle, e.g. /data/amiller/dsmack/reenroll-20261106/in/base
#   broker:      BROKER_CONFIG OPERATOR_TOKEN_SHA256 NEAR_ENCRYPTED_ENV (the live deployment's inputs,
#                BROKER_CONFIG = couch-repin-20261106b/broker-config.json, the other two from production-safe-20261106/)
#   rollback:    OLD_BROKER (default the live b package below)
#   register:    FUNDING_KEY (~/projects/teleport/dsmack/local-data/payments-20261028/funding-wallet.key, owner 0x1FBe)
set -euo pipefail
STAGE=${1:?usage: repin.sh check|build|pack|preflight|register|broker|install|ready|kit|rollback}
: "${DSMACK_REF:?}" "${CLASS:?}" "${WORK:?}"
[[ $CLASS =~ ^0x[0-9a-f]{64}$ ]]
[[ $DSMACK_REF =~ ^[0-9a-f]{40}$ ]]
DSMACK=$HOME/projects/teleport/dsmack/public          # laptop checkout, clean, on main
LAYOVER=$(cd "$(dirname "$0")/../.." && pwd)          # the checkout this script is in
L=$HOME/projects/teleport/dsmack/local-data/$WORK     # laptop working files
Z=/home/amiller/dsmack-releases/$WORK                 # zed
MAC_LIVE=/Users/amiller/dsmack-couch-repin-20261106b  # the live pool's release directory
MAC_NEW=/Users/amiller/dsmack-$WORK
LIVE_WORKLOAD=$MAC_LIVE/workload
BROKER=https://pod.dstack.soc1024.com/relay-broker
CHAIN=https://pod.dstack.soc1024.com/layover-chain
ATTEST=0xa90d8D9A40540678a5a3235C96FC95939411D99e
KID=0xe3a6e5614999084a848e3eed83b3f2a91193c1ce6100d9eb806a557922a93046
OPERATOR=0x1fbe7a7b3f7a37a967f3d927abd6f04db2766c5b
ESCROW=0x835A61a88Cc8D750b5a971219aa8f9813B2067e6
OLD_BROKER=${OLD_BROKER:-$HOME/projects/teleport/dsmack/local-data/couch-repin-20261106b/broker-prepared-17fe7ab47dc970eb}
OLD_BROKER_REF=9f0e0f88ccb0cf963b9bd4a81bbff331a3c83b6e
helios() { python3 -c 'import json,sys; j=json.load(sys.stdin); assert j.get("verified_by")=="helios-opstack", j; print(j[sys.argv[1]])' "$1"; }
# Point org.dsmack.pool.live at release dir $1 (its source/ and pool-command.json), keeping the live service root ~/dl
# (pool generations, restart.json, launcher-backoff.json). Decided from launchd's state, not a marker, so a rerun after a
# failure at any step finishes the switch: loaded with $1's command -> nothing to do; loaded with another -> bootout;
# not loaded -> install from $1 (which rewrites the plist and bootstraps).
mac_switch() {
  ssh mini-mesh bash -s -- "$1" <<'MAC'
set -euo pipefail
R=$1 ROOT=/Users/amiller/dl LABEL=org.dsmack.pool.live D=gui/$(id -u) PLIST=$HOME/Library/LaunchAgents/org.dsmack.pool.live.plist
PY=/Users/amiller/dsmack-browser-pool-20261029/venv/bin/python
cmdpath() { /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:8' "$PLIST" 2>/dev/null || true; }
if launchctl print $D/$LABEL >/dev/null 2>&1; then
  if [ "$(cmdpath)" = "$R/pool-command.json" ]; then echo "pool already runs from $R"; exit 0; fi
  launchctl bootout $D/$LABEL
  until ! launchctl print $D/$LABEL >/dev/null 2>&1; do sleep 1; done   # bootout returns before the job unloads (bootstrap error 5)
fi
rm -f "$PLIST"
$PY $R/source/applications/compute-node/pool-service.py install --label $LABEL --root $ROOT --command $R/pool-command.json
launchctl print $D/$LABEL >/dev/null && [ "$(cmdpath)" = "$R/pool-command.json" ] && echo "pool runs from $R"
MAC
}
# deploy-inference.py --target production needs a clean tree whose HEAD is in local main; the main checkout has untracked
# worktrees/, so deploy from a detached worktree at ref $2 (created once, moved to $2 on every run).
worktree() { [ -d "$1" ] || git -C "$DSMACK" worktree add --detach "$1" "$2"; git -C "$1" checkout -q --detach "$2"; test -z "$(git -C "$1" status --porcelain --untracked-files=all)"; }
NEXT='After install and ready: run the kit stage, commit its pins (layover key-free-manifest, dsmack main), merge layover#121
and #125 together, sync the site mirror web/static/kit/couch from main and redeploy the site (minions fetch its kit),
then rebuild and redeploy private-agent-web (commands printed by the kit stage).'
mkdir -p "$L"

case $STAGE in
check)
  # keys(kid) through Helios: enrolled = 1, expires 2030-03-13. Then the broker's MacLink for the kid names the operator.
  curl -fsS "$CHAIN/call?to=$ATTEST&data=0xdde5b7a1${KID#0x}" | python3 -c 'import json,sys; j=json.load(sys.stdin); r=j["result"][2:]
assert j["verified_by"]=="helios-opstack" and int(r[256:320],16)==1 and int(r[128:192],16)==1899590400, j; print("enrolled")'
  curl -fsS "$BROKER/fleet/ownership?kid=$KID" | python3 -c "import json,sys; v=json.load(sys.stdin)
assert any(l['link']['operator']=='$OPERATOR' for l in v['links']), v; print('linked')"
  # The broker's admission reads need these layover-chain endpoints; the broker stage refuses to run without them.
  curl -fsS "$CHAIN/code?address=$ESCROW&depth=30" | helios code | grep -q '^0x6'
  # /head must honor depth (the broker refuses a head that did not): block <= head - 30.
  curl -fsS "$CHAIN/head?depth=30" | python3 -c 'import json,sys; j=json.load(sys.stdin)
assert j.get("verified_by")=="helios-opstack" and j["depth"]>=30 and j["block"]<=j["head"]-30, ("layover-chain ignores depth", j)'
  B=$(curl -fsS "$CHAIN/head?depth=30" | helios block_hash)
  curl -fsS "$CHAIN/call?to=$ESCROW&data=0xfca82211&block=$B" | helios block_hash | grep -qx "$B"
  echo "layover-chain serves admission reads"
  ;;
build)
  test "$(git -C "$DSMACK" rev-parse main)" = "$DSMACK_REF"
  ssh zed-mesh "set -e; mkdir -p $Z && cd $Z && { [ -d src ] || git clone -q https://github.com/amiller/dsmack.git src; } && cd src && git fetch -q && git checkout -q $DSMACK_REF
    (cd applications/compute-node/peer && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -buildvcs=false -o ../dsmack-compute .)
    (cd applications/egress-policy && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -buildvcs=false -o ../compute-node/dsmack-egress .)
    SOURCE_DATE_EPOCH=0 docker buildx build --builder abalone-oci --platform linux/arm64 --provenance=false --sbom=false \
      --output type=oci,dest=$Z/compute-node.oci.tar,rewrite-timestamp=true -f applications/compute-node/Dockerfile .
    rm -rf $Z/oci && mkdir -p $Z/oci/oci-layout && tar -xf $Z/compute-node.oci.tar -C $Z/oci/oci-layout
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[\"manifests\"][0][\"digest\"])' $Z/oci/oci-layout/index.json | tee $Z/image-digest"
  ;;
pack)
  : "${BASE:?}"
  # The live manifest is the starter (same base_vm). Its PAYMENTS_CONFIG, with the new class and without enrollmentKeyId,
  # is the payments input: the guest binds its run to the key that signs its attestation, so the manifest names none.
  ssh mini-mesh "cat $LIVE_WORKLOAD/compose-manifest.json" > "$L/live-compose-manifest.json"
  sha256sum "$L/live-compose-manifest.json" | grep -q ^def1ca2fa0828534
  ssh zed-mesh "cat > $Z/starter.json" < "$L/live-compose-manifest.json"
  ssh zed-mesh "set -e; cd $Z/src
    if [ -s $Z/pack.json ]; then echo 'already packed:'; cat $Z/pack.json; exit 0; fi
    rm -rf $Z/workload $Z/pack.json.tmp   # a pack that failed part-way
    python3 - $Z/starter.json $CLASS > $Z/payments.json <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); env = json.loads(m['docker_compose_file'])['services']['node']['environment']
p = json.loads(env['PAYMENTS_CONFIG']); p['node'] = sys.argv[2]   # exactly the guest's payments.Config fields (it rejects unknown ones)
print(json.dumps({k: p[k] for k in ('node', 'escrow', 'operator', 'grantSigner', 'buildId', 'destinationPolicyHash', 'runSeconds')}))
PY
    python3 - $Z/starter.json > $Z/args.json <<'PY'
import json, sys
s = json.loads(json.load(open(sys.argv[1]))['docker_compose_file'])['services']['node']
print(json.dumps({'relay': s['command'][1], 'seconds': s['command'][2], 'broker': s['command'][3], 'key': s['command'][4],
                  'cdhash': s['command'][5], 'proxy': s['environment']['HTTPS_PROXY'], 'index': s['environment']['TUNNEL_INDEX']}))
PY
    a() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' $Z/args.json \$1; }
    echo '{\"max_guests\":4,\"guest\":{\"mem_mib\":4096,\"vcpus\":1},\"reserve\":{\"mem_gb\":16,\"cores\":4}}' > $Z/operator.json
    python3 applications/compute-node/workload.py \$PWD $BASE $Z/starter.json $Z/oci \$(cat $Z/image-digest) \
      applications/compute-node/dsmack-compute \$(a relay) \$(a broker) \$(a key) \$(a cdhash) \$(a proxy) $Z/workload \
      \$(a seconds) $Z/payments.json \$(a index) $Z/operator.json > $Z/pack.json.tmp
    python3 - $Z/starter.json $Z/pack.json.tmp $Z/workload/compose-manifest.json <<'PY'
import json, sys
live = json.load(open(sys.argv[1]))['base_vm']['os_image_hash']; new = json.load(open(sys.argv[2]))['os_image_hash']
assert live == new, ('base image changed', live, new)
m = json.load(open(sys.argv[3])); pay = json.loads(json.loads(m['docker_compose_file'])['services']['node']['environment']['PAYMENTS_CONFIG'])
assert sorted(pay) == sorted(['node', 'escrow', 'operator', 'grantSigner', 'buildId', 'destinationPolicyHash', 'runSeconds']), pay
PY
    mv $Z/workload/disk/workload.img $Z/workload/workload.img; rm -rf $Z/workload/disk   # the pool reads WORKLOAD/workload.img
    mv $Z/pack.json.tmp $Z/pack.json; cat $Z/pack.json"
  ssh zed-mesh "cat $Z/workload/compose-manifest.json" > "$L/compose-manifest.json"
  ssh zed-mesh "cat $Z/pack.json" > "$L/pack.json"
  ;;
preflight)
  worktree "$L/dsmack" "$DSMACK_REF"
  rsync -a --bwlimit=20000 zed-mesh:$Z/workload/ "$L/workload/"
  cmp "$L/compose-manifest.json" "$L/workload/compose-manifest.json"
  ssh mini-mesh cat .dsmack/operator.json > "$L/mac-operator.json"
  git -C "$LAYOVER" fetch -q origin web
  rm -rf "$L/web" && mkdir "$L/web" && git -C "$LAYOVER" archive origin/web web | tar -x -C "$L/web"
  python3 "$LAYOVER/couch/dsmack/preflight.py" "$L/workload" "$L/mac-operator.json" "$L/dsmack" "$L/web"
  ;;
register)
  : "${FUNDING_KEY:?}" "${BROKER_CONFIG:?}"
  "$0" preflight
  # register-class.mjs refuses a manifest that names a key; the class is per operator and code.
  python3 - "$BROKER_CONFIG" "$CLASS" > "$L/payments-cfg.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))['payments']; c['classes'].append(sys.argv[2]); print(json.dumps(c))
PY
  M=$(sha256sum "$L/compose-manifest.json" | cut -d' ' -f1)
  registered() { curl -fsS "$CHAIN/read?contract=usage_escrow&fn=getNode(bytes32)&args=$CLASS" | python3 -c "import json,sys; j=json.load(sys.stdin)
assert j['verified_by']=='helios-opstack', j; v=j['value']; print(int(v[0],16)!=0 and v[2]=='0x$M')"; }
  if [ "$(registered)" = True ]; then echo "class $CLASS already registered for $M"; else
    (cd "$DSMACK" && deno run --allow-read --allow-net --allow-env applications/payments/register-class.mjs \
      "$L/payments-cfg.json" "$FUNDING_KEY" "$L/compose-manifest.json")
    until [ "$(registered)" = True ]; do echo waiting for the class in a Helios-verified block; sleep 15; done
  fi
  ;;
broker)
  : "${BROKER_CONFIG:?}" "${OPERATOR_TOKEN_SHA256:?}" "${NEAR_ENCRYPTED_ENV:?}"
  git -C "$DSMACK" merge-base --is-ancestor "$DSMACK_REF" main
  worktree "$L/dsmack" "$DSMACK_REF"
  curl -fsS "$CHAIN/code?address=$ESCROW&depth=30" | helios code | grep -q '^0x6'   # layover-chain has the admission endpoints
  # New class and workload next to the live ones (BROKER_CONFIG is the live deploy's config; it pins no enrollments: the
  # broker reads keys(kid) on chain and admits a paid run only for a key MacLinked to its class operator).
  python3 - "$BROKER_CONFIG" "$CLASS" "$L/pack.json" "$L/compose-manifest.json" > "$L/broker-config.json" <<'PY'
import hashlib, json, sys
c = json.load(open(sys.argv[1])); cls = sys.argv[2]; pack = json.load(open(sys.argv[3])); raw = open(sys.argv[4], 'rb').read()
assert hashlib.sha256(raw).hexdigest() == pack['manifest_sha256']
m = json.loads(raw); cdhash = json.loads(m['docker_compose_file'])['services']['node']['command'][5]
assert 'enrollments' not in c and 'enrollments' not in c['payments'], 'BROKER_CONFIG must be the live on-chain-enrollment config'
c['payments']['classes'].append(cls)
c['workloads'].append({'cdhash': cdhash, 'manifest_sha256': pack['manifest_sha256'], 'os_image_hash': pack['os_image_hash'], 'service': 'node'})
c['chainRead'] = 'https://pod.dstack.soc1024.com/layover-chain'   # all guest admission reads, Helios-verified
print(json.dumps(c, indent=2))
PY
  # One prepared package per exact inputs (ref, config, env); a package left half-written by a failed prepare is redone.
  PREP=$L/broker-prepared-$(cat "$L/broker-config.json" "$NEAR_ENCRYPTED_ENV" <(echo "$DSMACK_REF $OPERATOR_TOKEN_SHA256") | sha256sum | cut -c1-16)
  [ -s "$PREP/relay-broker.tgz" ] && [ -s "$PREP/relay-broker.manifest.json" ] || { rm -rf "$PREP"
    python3 "$L/dsmack/applications/relay-broker/deploy-inference.py" prepare --target production \
      --config "$L/broker-config.json" --operator-token-sha256 "$OPERATOR_TOKEN_SHA256" --encrypted-env "$NEAR_ENCRYPTED_ENV" --out "$PREP"; }
  python3 "$L/dsmack/applications/relay-broker/deploy-inference.py" deploy --target production --prepared "$PREP" \
    --url https://pod.dstack.soc1024.com --evidence "$L/broker-evidence-$(date +%s)" --apply
  # A token no stay holds is refused with 404 BROWSE_UNKNOWN; the class is offered (it reads UsageEscrow at its block tag).
  test "$(curl -s -o /dev/null -w '%{http_code}' $BROKER/agent/browse/00000000000000000000000000000000?publisher=check)" = 404
  until curl -fsS $BROKER/payments/classes | grep -q "$CLASS"; do echo waiting for the class at the broker block tag; sleep 30; done
  ;;
install)
  # Wait for an idle pool, then restart the launchd job on the new source and workload (relay and keys unchanged).
  # Browsing stays at none until the host adds "browse" to ~/.dsmack/operator.json (see the compute-node README).
  ssh mini-mesh "mkdir -p $MAC_NEW; grep -qx $MAC_NEW .dsmack/gc-pins || echo $MAC_NEW >> .dsmack/gc-pins"   # dsmack_gc keeps pinned releases
  rsync -a --bwlimit=20000 zed-mesh:$Z/workload/ "$L/workload/"
  rsync -a --bwlimit=20000 "$L/workload" mini-mesh:$MAC_NEW/
  ssh mini-mesh "set -e; cd $MAC_NEW
    [ -d source ] || git clone -q https://github.com/amiller/dsmack.git source; git -C source fetch -q; git -C source checkout -q $DSMACK_REF
    echo $DSMACK_REF > release-ref
    python3 - $MAC_LIVE/pool-command.json $MAC_NEW <<'PY' > $MAC_NEW/pool-command.json.tmp
import json, sys
c = json.load(open(sys.argv[1])); new = sys.argv[2]
c[1] = new + '/source/applications/compute-node/mac-pool.py'
c[c.index('--workload') + 1] = new + '/workload'
c[c.index('--pool-version') + 1] = open(new + '/release-ref').read().strip()
if '--key-rotation' not in c: c += ['--key-rotation', '/Users/amiller/.dsmack/key-rotation.json']
print(json.dumps(c, indent=2))
PY
    mv $MAC_NEW/pool-command.json.tmp $MAC_NEW/pool-command.json"
  # Let running stays finish before the restart (skipped on a rerun once the pool already runs from MAC_NEW).
  ssh mini-mesh "/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:8' ~/Library/LaunchAgents/org.dsmack.pool.live.plist 2>/dev/null" | grep -qx "$MAC_NEW/pool-command.json" ||
    until curl -fsS $BROKER/network | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin)["totals"]["busy_slots"] != 0)'; do sleep 15; done
  mac_switch "$MAC_NEW"
  echo "$NEXT"
  ;;
ready)
  ready() { curl -fsS $BROKER/fleet | python3 -c "import json,sys
print(sum(1 for mac in json.load(sys.stdin) for s in mac['slots'] if s['state']=='ready' and s['node_id']=='$CLASS' and (s.get('attestation') or {}).get('attestation',{}).get('status')=='verified'))"; }
  until [ "$(ready)" -ge 1 ]; do echo "verified ready slots of class $CLASS: $(ready)"; sleep 30; done
  ;;
kit)
  # The kit pins a template: the packed manifest with PAYMENTS_CONFIG's node and operator emptied (it names no key).
  python3 "$LAYOVER/couch/dsmack/template.py" "$L/compose-manifest.json" "$LAYOVER/couch/dsmack/sandbox-policy.json"
  # private-agent-web pins the exact manifest in on-chain mode: no Apple enrollment blob, keys through layover-chain.
  python3 - "$L/compose-manifest.json" "$DSMACK/applications/private-agent-web/sandbox-policy.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[2])); p.pop('enrollment', None); p['enrollmentMode'] = 'on-chain'; p['manifest'] = open(sys.argv[1], 'rb').read().hex()
open(sys.argv[2], 'w').write(json.dumps(p, indent=2) + '\n')
PY
  echo "Now: run both test suites (layover couch: node --test stay_test.mjs; the key-free template test covers the new pin),"
  echo "commit both pins (layover key-free-manifest branch, dsmack main), merge the layover PRs once (the kit refuses new"
  echo "guests until then), sync the site's static/kit/couch mirror from main and redeploy the site (minions fetch its kit),"
  echo "then redeploy the web product, which pins the same manifest and refuses the new class until it is redeployed:"
  echo "  (cd $DSMACK/applications/private-agent-web && npm ci && npm run build && python3 deploy.py --target production \\"
  echo "    --evidence $L/page-evidence --page-env PAGE_ENV_JSON --operator-token-sha256 \$OPERATOR_TOKEN_SHA256 \\"
  echo "    --registry-account \$PAGE_PUBLISHER_ACCOUNT)   # per applications/private-agent-web/README.md"
  sha256sum "$L/compose-manifest.json"
  ;;
rollback)
  # Works after any stage, and again after a failed rollback. Mac: back to the untouched live command and workload
  # (def1ca2f). Broker: the live b package (ref 9f0e0f88), which admits def1ca2f guests.
  # The new class stays registered on chain, unused. Not after the kit pins are merged: the merged kit refuses def1ca2f.
  # The Mac first and without waiting on the broker (which may be the thing that failed); stays in flight end.
  mac_switch "$MAC_LIVE"
  worktree "$L/dsmack-rollback" $OLD_BROKER_REF
  python3 "$L/dsmack-rollback/applications/relay-broker/deploy-inference.py" deploy --target production --prepared "$OLD_BROKER" \
    --url https://pod.dstack.soc1024.com --evidence "$L/rollback-evidence-$(date +%s)" --apply
  ;;
*) echo "unknown stage $STAGE" >&2; exit 2 ;;
esac

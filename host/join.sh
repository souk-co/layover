#!/bin/bash
# host/join.sh [--dry-run] STEP [ARGS]: join a Mac to Layover as a host, one step at a time (see HOSTING.md "Join with your own Mac").
# Every step that writes (files outside $LH, the chain, the broker, the site, the souk, launchd) goes through `run`, which in
# --dry-run prints the command instead. Reads (downloads into $LH, signature and hash checks, Helios chain reads) always run.
# Settings come from $LH/host.env (written by `init`): OPERATOR (payout address), OPERATOR_ACCOUNT (foundry keystore name that
# pays gas and signs the ProvisioningAuthorization), HOST (short name), PROFILE (desktop|laptop), PERSON_ID, EMAIL.
set -euo pipefail
DRY=0; [ "${1:-}" = --dry-run ] && { DRY=1; shift; }
STEP=${1:?step: init check fetch runner enroll chain-enroll link instance start appraise souk couch}; shift
HERE=$(cd "$(dirname "$0")" && pwd)
LH=${LAYOVER_HOME:-$HOME/layover}
RPC=https://sepolia.base.org CHAIN=https://pod.dstack.soc1024.com/layover-chain SITE=https://pod.dstack.soc1024.com/resip-staging
SOUK=https://souk-dev.dstack.soc1024.com S=31f5c141-fb2d-4572-939a-68543a2d0649
CDS=0x14b569c5D81d42621c5C0d4d62185239C86D8d20 ATTEST=0x04f57D219B1CEaE7f000C2a3360Ce49CffF3162e
INTERMEDIATE=0xb4fb420570c9ae811939c8953a785ed10beeca40453a89404f36e87a12b88d90
ESCROW=0x8FF468c8E447f6cF70f05bEa1cEc1693eC0455cE GUEST_ESCROW=0xdf9bb576E30Ec71E200643AB6FC835Eee12C95EA CHAIN_ID=84532
RUNNER_TAG=runner-v0.1.0-alpha.2 RELEASE_KEY_SHA=4de4686cb585a54375a9ab859aa533e8a81255d9d2c9a76b96d0ae9006ecc0df
DSMACK=https://raw.githubusercontent.com/amiller/dsmack/bdecc110f62bad024a2ff7e508b619f7ed0f0860
GVPROXY_SHA=c6f7b4bc7f21bf810b5cf54e04d979b014c5d96472a03a9e97fe62a00940067c
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

run() { if [ $DRY = 1 ]; then printf 'DRY-RUN:'; printf ' %q' "$@"; echo; else "$@"; fi; }
say() { echo "== $*"; }
need() { command -v "$1" >/dev/null || { echo "missing $1: $2" >&2; exit 1; }; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
# Helios-verified eth_call through layover-chain; prints the raw result
call() { curl -fsS "$CHAIN/call?to=$1&data=$2" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["verified_by"].startswith("helios"),d;print(d["result"])'; }
settings() { [ -f "$LH/host.env" ] || { echo "run: $0 init first" >&2; exit 1; }; source "$LH/host.env"; source "$HERE/profiles/$PROFILE.env"; }
kid() { python3 -c 'import base64,sys;print("0x"+base64.b64decode(open(sys.argv[1]).read().strip()).hex())' "$LH/runner/enrollment/keyId.txt"; }
abi() { "$LH/venv/bin/python" "$HERE/abi.py" "$@"; }
send() { run cast send "$@" --rpc-url $RPC --account "$OPERATOR_ACCOUNT"; }

case $STEP in
init)  # init HOST PROFILE OPERATOR OPERATOR_ACCOUNT PERSON_ID EMAIL
  [ $# = 6 ] || { echo "init HOST desktop|laptop OPERATOR OPERATOR_ACCOUNT PERSON_ID EMAIL" >&2; exit 1; }
  [ -f "$HERE/profiles/$2.env" ] || { echo "unknown profile $2: $(ls "$HERE/profiles" | sed 's/\.env$//' | tr '\n' ' ')" >&2; exit 1; }
  [[ $3 =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "OPERATOR must be a 0x address" >&2; exit 1; }
  mkdir -p "$LH"
  printf 'HOST=%s\nPROFILE=%s\nOPERATOR=%s\nOPERATOR_ACCOUNT=%s\nPERSON_ID=%s\nEMAIL=%s\n' "$@" > "$LH/host.env"
  cat "$LH/host.env";;
check)
  settings
  [ "$(uname -m)" = arm64 ] || { echo "Apple silicon only" >&2; exit 1; }
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 27 ] || { echo "macOS 27 or later" >&2; exit 1; }
  need python3 "Xcode command line tools"; need uv "brew install uv (macOS python3 is 3.9; souk.py needs 3.10+)"; need gh "brew install gh, then gh auth login"
  need cast "curl -L https://foundry.paradigm.xyz | bash && foundryup"
  OPENSSL=$(brew --prefix openssl@3 2>/dev/null)/bin/openssl; [ -x "$OPENSSL" ] || { echo "brew install openssl@3" >&2; exit 1; }
  cast wallet address --account "$OPERATOR_ACCOUNT" | grep -qi "$OPERATOR" || { echo "keystore $OPERATOR_ACCOUNT is not $OPERATOR" >&2; exit 1; }; echo "fund $OPERATOR with ~0.02 Base Sepolia ETH: chain-enroll uses ~14.4M gas in each of two registries"
  FREE=$(df -g "$HOME" | awk 'NR==2{print $4}'); [ "$FREE" -ge 12 ] || { echo "need 12 GB free, have $FREE" >&2; exit 1; }
  gh api repos/souk-co/layover --jq .full_name
  say "ok: $(sw_vers -productVersion), ${FREE} GB free, profile $PROFILE";;
fetch)  # the signed runner release (base image, templates), gvproxy, dsmack's ownership CLI and cd_args, then the newest approved guest
  settings
  OPENSSL=$(brew --prefix openssl@3)/bin/openssl
  R=$LH/runner-release; mkdir -p "$R" "$LH/runner/runtime/base" "$LH/runner/runtime/helper" "$LH/bin"
  [ -f "$R/dsmack-runner-macos-arm64-alpha.2.zip" ] || gh release download $RUNNER_TAG -R amiller/dsmack -p 'dsmack-runner-macos-arm64-alpha.2.zip' -D "$R"
  rm -rf "$R/x"; ditto -x -k "$R/dsmack-runner-macos-arm64-alpha.2.zip" "$R/x"; X=$R/x/dsmack-runner-alpha.2
  [ "$(sha "$X/release-public.pem")" = $RELEASE_KEY_SHA ]
  printf 'dsmack-runner-release/1\0' | cat - "$X/release-runner-alpha.2.UNSIGNED.json" > "$R/msg"
  "$OPENSSL" pkeyutl -verify -pubin -inkey "$X/release-public.pem" -rawin -in "$R/msg" -sigfile "$X/release-runner-alpha.2.sig"
  (cd "$X" && python3 -c 'import json,hashlib;d=json.load(open("release-runner-alpha.2.UNSIGNED.json"))
for f in d["files"]: assert hashlib.sha256(open(f["path"],"rb").read()).hexdigest()==f["sha256"],f["path"]')
  rm -rf "$LH/runner/base"; cp -R "$X/base" "$LH/runner/base"
  for t in scratch result; do gunzip -c "$X/runtime/base/$t-template.ext4.gz" > "$LH/runner/runtime/base/$t-template.ext4"; done
  cp "$X/dsmack-runner" "$X/Info.plist" "$X/entitlements.plist" "$LH/runner-release/"
  G=$LH/runner/runtime/helper/gvproxy-darwin
  [ -f "$G" ] || curl -fsSL -o "$G" https://github.com/containers/gvisor-tap-vsock/releases/download/v0.8.9/gvproxy-darwin
  [ "$(sha "$G")" = $GVPROXY_SHA ]; chmod 755 "$G"
  for f in applications/mac-ownership/ownership.py applications/mac-ownership/dsmack contracts/cd_args.py; do curl -fsSL -o "$LH/bin/$(basename $f)" "$DSMACK/$f"; done
  chmod 755 "$LH/bin/dsmack"
  [ -d "$LH/venv" ] || uv venv -q --python 3.12 "$LH/venv"; VIRTUAL_ENV=$LH/venv uv pip install -q eth-account cbor2
  "$HERE/guest-update.sh"
  say "fetched runner $RUNNER_TAG (signature and $(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["files"]))' "$X/release-runner-alpha.2.UNSIGNED.json") files verified), guest $(readlink "$LH/workload")";;
runner)  # runner APP: check your re-signed DsmackRunner.app and register its CDHash with CDRegistry (open to anyone)
  settings; APP=${1:?path to your re-signed DsmackRunner.app (HOST-START-HERE.txt)}
  codesign --verify --strict "$APP"
  CD=$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^CandidateCDHashFull sha256=//p'); [ ${#CD} = 64 ]
  cmp "$APP/Contents/MacOS/dsmack-runner" "$LH/runner-release/dsmack-runner" >/dev/null && echo "note: executable is byte-identical to the release (only the mini's device can launch it)"
  "$LH/venv/bin/python" "$LH/bin/cd_args.py" "$APP/Contents/MacOS/dsmack-runner" > "$LH/runner-build.json"
  b() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$LH/runner-build.json" "$1"; }
  BUILD=$(call $CDS $(abi calldata 'buildOf(bytes32)' $CD))
  if [ "$BUILD" = 0x0000000000000000000000000000000000000000000000000000000000000000 ]; then
    run cast call $CDS 'registerBuild(bytes,bytes,bytes)(bytes32)' $(b cd) $(b page0) $(b ent) --rpc-url $RPC
    send $CDS 'registerBuild(bytes,bytes,bytes)' $(b cd) $(b page0) $(b ent)
  else echo "CDHash $CD already admitted, build $BUILD"; fi
  run ln -sfn "$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")" "$LH/runner/DsmackRunner.app"
  say "runner $CD";;
enroll)  # a fresh App Attest key from your runner; refuses to overwrite an existing enrollment
  settings; E=$LH/runner/enrollment
  [ ! -e "$E/keyId.txt" ] || { echo "$E already holds key $(kid); move it aside to rotate" >&2; exit 1; }
  run mkdir -p "$E"; run sh -c "head -c 32 /dev/urandom > '$LH/runner/enrollment.challenge.bin'"
  run open -n -W "$LH/runner/DsmackRunner.app" --args enroll "$E" "$LH/runner/enrollment.challenge.bin"
  [ $DRY = 1 ] || say "enrolled key $(kid); put it on chain within 3 days (Apple leaf lifetime): $0 chain-enroll";;
chain-enroll)  # AppleAttestRegistryV1.enroll in each registry a consumer verifies against: the key directory 0x04f5 (site, couch kit,
  # accounts) and GuestEscrow's own verifier, read from GuestEscrow.attest(). verify() answers only the registry's one consumer, so
  # a key enrolled in one is unknown to the other. Permissionless; Apple's chain and CDRegistry decide.
  settings; E=$LH/runner/enrollment; K=$(kid)
  GE_ATTEST=0x$(call $GUEST_ESCROW $(abi calldata 'attest()') | tail -c 41)
  for A in $ATTEST $GE_ATTEST; do
    ROW=$(call $A $(abi calldata 'keys(bytes32)' $K))
    if [ "${ROW: -1}" = 1 ]; then echo "key $K already enrolled in $A"; continue; fi
    read LEAF AUTH < <("$LH/venv/bin/python" -c 'import cbor2,sys;a=cbor2.loads(open(sys.argv[1],"rb").read());print("0x"+a["attStmt"]["x5c"][0].hex(),"0x"+a["authData"].hex())' "$E/attestation.cbor")
    send $A 'enroll(bytes,bytes,bytes,bytes32)' $LEAF $AUTH 0x$(xxd -p "$E/clientData.bin" | tr -d '\n') $INTERMEDIATE --gas-limit 16000000
    [ $DRY = 1 ] || { ROW=$(call $A $(abi calldata 'keys(bytes32)' $K)); [ "${ROW: -1}" = 1 ] || { echo "not enrolled in $A yet (Helios lags ~30 blocks; re-run)" >&2; exit 1; }; }
  done
  say "key $K on chain in $ATTEST and $GE_ATTEST";;
link)  # provisioner + operator's ProvisioningAuthorization + MacLink(kid, publisher, operator), posted to the broker
  settings; D=$LH/dsmack K=$(kid); PY=$LH/venv/bin/python
  mkdir -p -m 700 "$D"
  for k in provisioner publisher; do [ -f "$D/$k.key" ] || run sh -c "umask 077; '$PY' -c 'from eth_account import Account;print(\"0x\"+Account.create().key.hex())' > '$D/$k.key'"; done
  [ $DRY = 1 ] && [ ! -f "$D/provisioner.key" ] && { echo "DRY-RUN: authorize and link need the keys above"; exit 0; }
  PROV=$("$PY" -c 'from eth_account import Account;import sys;print(Account.from_key(open(sys.argv[1]).read().strip()).address)' "$D/provisioner.key")
  printf '{"broker":"https://pod.dstack.soc1024.com/relay-broker","publisher_key":"%s","kid":"%s"}' "$D/publisher.key" "$K" > "$D/mac-ownership.json"
  if [ ! -f "$D/provisioning.json" ]; then
    PW=${OPERATOR_PASSWORD_FILE:?file holding the keystore password (deleted after)}
    [ $DRY = 1 ] || trap 'rm -f "$PW"' EXIT
    run "$PY" "$LH/bin/dsmack" authorize --config "$D/mac-ownership.json" --operator-keystore "$HOME/.foundry/keystores/$OPERATOR_ACCOUNT" --password-file "$PW" --provisioner "$PROV" --out "$D/provisioning.json"
  fi
  run "$PY" "$LH/bin/dsmack" link --config "$D/mac-ownership.json" --authorization "$D/provisioning.json" --provisioner-key "$D/provisioner.key" --kid "$K"
  say "MacLink $K -> $OPERATOR via provisioner $PROV";;
instance)  # instance NAME [UPSTREAM_PROXY]: one line instance (its own agent id, route and instructions)
  settings; N=${1:?instance name}; I=$LH/instances/$N
  mkdir -p "$LH/instances"; HAVE=$(find "$LH/instances" -mindepth 1 -maxdepth 1 -type d ! -name "$N" | wc -l | tr -d ' ')
  [ "$HAVE" -lt "$MAX_INSTANCES" ] || { echo "profile $PROFILE allows $MAX_INSTANCES instance(s)" >&2; exit 1; }
  mkdir -p "$I/runs"
  printf 'AGENT_ID=layover-%s-%s\nDAILY_BYTES=%s\nOPERATOR=%s\nESCROW=%s\nGUEST_ESCROW=%s\nCHAIN_ID=%s\n' "$HOST" "$N" "$DAILY_BYTES" "$OPERATOR" "$ESCROW" "$GUEST_ESCROW" "$CHAIN_ID" > "$I/launch.env"
  [ -z "${2:-}" ] || echo "UPSTREAM_PROXY=$2" >> "$I/launch.env"
  printf '%s\n' "$INSTRUCTIONS" > "$I/instructions.txt"
  say "instance $N: agent id layover-$HOST-$N";;
start)  # start NAME: install and load its launchd agent (and the wireproxy one if a WireGuard route is configured)
  settings; N=${1:?instance name}; [ -f "$LH/instances/$N/launch.env" ] || { echo "no instance $N" >&2; exit 1; }
  P=$HOME/Library/LaunchAgents/org.layover.guest.$N.plist
  run sh -c "sed -e 's|@LH@|$LH|g' -e 's|@HERE@|$HERE|g' -e 's|@INSTANCE@|$N|g' '$HERE/launchd/org.layover.guest.plist' > '$P'"
  run plutil -lint "$P"
  run launchctl bootstrap gui/$(id -u) "$P"
  if [ -f "$LH/proton/wireproxy.conf" ]; then W=$HOME/Library/LaunchAgents/org.layover.wireproxy.plist
    run sh -c "sed 's|@LH@|$LH|g' '$HERE/launchd/org.layover.wireproxy.plist' > '$W'"; run launchctl bootstrap gui/$(id -u) "$W"; fi
  say "started $N; log $LH/instances/$N/loop.log";;
appraise)  # appraise NAME: the guest measures its line and signs a report; poll until verified
  settings; A=layover-$HOST-${1:?instance name}
  curl -fsS "$SITE/api/agents" | python3 -c 'import json,sys;a=sys.argv[1];r=[x for x in json.load(sys.stdin) if x["agent_id"]==a];assert r,a+" not registered: is its guest running?";print(json.dumps(r[0])[:400])' "$A"
  if [ $DRY = 1 ]; then run curl -fsS -X POST -H 'content-type: application/json' -d "{\"requested_by\":\"$PERSON_ID\"}" "$SITE/api/agents/$A/appraisal-requests"; exit 0; fi
  ID=$(curl -fsS -X POST -H 'content-type: application/json' -d "{\"requested_by\":\"$PERSON_ID\"}" "$SITE/api/agents/$A/appraisal-requests" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  until ST=$(curl -fsS "$SITE/api/appraisal-requests/$ID" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["status"],d.get("appraisal_id") or "")') && [[ $ST == done* || $ST == failed* ]]; do sleep 20; done
  [[ $ST == done* ]] || { echo "appraisal $ID: $ST" >&2; exit 1; }
  AP=${ST#done }; curl -fsS "$SITE/api/appraisals/$AP/verified" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["pass"] is True,d;print("verified")'
  echo "$AP" > "$LH/instances/$1/appraisal_id"; say "appraisal $AP";;
souk)  # souk NAME '{"cgnat":false,...}': enroll the line as a seller in the IP souk (needs a team invite with the host role first)
  settings; N=${1:?instance name}; OWN=${2:?owner_reported json, e.g. '{"cgnat":false,"basis":"cable","isp_terms":"not read"}'}
  [ -f "$LH/bin/souk.py" ] || curl -fsSL -o "$LH/bin/souk.py" https://pod.dstack.soc1024.com/resip-staging/kit/souk.py
  "$LH/venv/bin/python" "$LH/bin/souk.py" list >/dev/null || { echo "log in first: $LH/venv/bin/python $LH/bin/souk.py login $SOUK $EMAIL (twice: request, then with the mailed code)" >&2; exit 1; }
  AP=$(cat "$LH/instances/$N/appraisal_id")
  TEXT=$(python3 -c 'import json,sys;print(json.dumps({"appraisal_id":sys.argv[1],"owner_reported":json.loads(sys.argv[2]),"policy":json.loads(sys.argv[3])}))' "$AP" "$OWN" "$POLICY")
  run "$LH/venv/bin/python" "$LH/bin/souk.py" send $S "$(python3 -c 'import json,sys;print(json.dumps({"kind":"line","text":sys.argv[1]}))' "$TEXT")"
  say "sent; the souk answers \"Enrolled line thread-N\" within a minute: python3 $LH/bin/souk.py inbox $S";;
couch)
  settings
  echo "Couch slots are not self-serve yet: the relay broker must list this Mac's workload and a UsageEscrow class registered for $OPERATOR, and the" >&2
  echo "broker's workspaces.stores must include its store (souk-co/layover#29). Ask the team; send them: $(cat "$LH/dsmack/mac-ownership.json")" >&2
  exit 1;;
*) echo "unknown step $STEP" >&2; exit 1;;
esac

# Correct the publisher/operator launch-input confusion (#167)

The four Mini launch fixtures used `0xa43f9f32411358c1319cb36027650a206644c131`, the broker **publisher**, as `OPERATOR`. The signed MacLink/custody operator is `0x1fbe7a7b3f7a37a967f3d927abd6f04db2766c5b`. Correcting that fixture is not an ownership transfer. Custody's existing binding, agent ids, sealed state and base VM must stay intact.

An environment edit alone is insufficient. `OPERATOR` is a launch input outside the measured manifest. GuestEscrow registers a key once and binds its operator/workload; `registerGuestKey` refuses `guestKeys[key].operator != address(0)`. Source: amiller/dsmack `escrow-terms` commit `00002587adc7eaf4de83b6bd4859ddf2878504c1`, `contracts/src/GuestEscrow.sol:86`. Reusing the old key cannot change its registered recipient.

This source correction persists the claim key's manifest/operator/GuestEscrow/chain identity. It keeps a key only when all match. A changed identity, or legacy state without that metadata, generates a fresh claim key and resets only that key's cumulative claim totals. The former private key, manifest, identity (unknown for legacy state) and totals remain in `claim_history` inside sealed custody state. No private history is emitted to logs or public artifacts. Encryption key, CA, broker wallet, byte budget, receipt chain and lease state retain their existing restore/save paths.

If a changed or unknown payment identity has an active escrow lease, boot fails before registering/publicizing a replacement claim key or saving migrated state. Existing accepted terms keep their actual recipient. Drain those leases under the previous guest/configuration; never rewrite their operator or manufacture a claim under the corrected operator. A manifest-only rotation with known unchanged payment identity can still resume leases and claim only the delta beyond their preserved `claimed` totals.

## Reviewed migration sequence (not executed by this patch)

1. Record the current source/workload/base digests, agent ids, custody heads/sequences and signed ownership evidence. Preserve old run artifacts, guest-key attestations, signed claims, statements/receipts and sealed volumes. Do not export private state, reset custody or substitute a genesis volume.
2. Stop offering new work while retaining the previous approved guest/configuration long enough to finish existing escrow leases and publish/commit their final claims. Confirm each instance has no active sealed escrow lease and reconcile its site statements. Public site status alone cannot prove the private sealed lease set is empty. If that cannot be demonstrated, stop the migration; the new boot guard also refuses it.
3. Build this reviewed source on zed using the **existing base VM** and release inputs. Do not merely apply the corrected env to the old image. Run the existing relaunch/rekey-crash harness remotely, including a retained CA/encryption key/broker wallet/budget/receipt chain, legacy-state rotation, and refusal when legacy/changed-payment escrow leases remain active. The lightweight tests below are not a full guest rehearsal.
4. After owner review, authorize the new workload measurement through the existing release process. Keep the old workload's claim approval until old signed claims and their claim windows are reconciled; removing it prematurely disables those keys' claims. No contract operator rewrite or custody rebind is part of this change.
5. Start exactly one corrected run per instance against its existing custody head/volume, with `OPERATOR=0x1fbe…6c5b`. Confirm restore/commit succeeds and advances from the recorded head, CA/encryption key/wallet and budget are retained, claim identity records the corrected operator, and the new claim key differs from the old registered key. Retain the old output directory and sealed history.
6. Only after the new claim key is committed in custody state, verify its `key || operator` attestation and register that **new** key under the new approved workload. Never try to re-register an old key for the corrected operator. Confirm chain reads show the intended operator/workload and old keys remain unchanged.
7. Re-appraise/re-enroll the line with the verified operator, preserving privacy and existing authorization. Check custody metadata, guest-key attestation, line policy, constructor and site admission all agree. Then run a separately authorized bounded trial and read its signed settlement. Close unusable old terms rather than changing their payee.

No VM build, workload approval, key registration, Mini launch/config change, state reset, payment or custody rebinding is performed by this patch. Those actions remain gated on review and the remote rehearsal.

## Lightweight validation

```
node guest/test/claim-state.mjs
node guest/test/claimer.mjs  # existing guest dependencies; no VM/gateway/network
node --check guest/core.mjs
node --check guest/agent.mjs
```

The policy test covers unchanged identity, manifest rotation, operator/escrow/chain changes, legacy state, active-lease refusal, private history retention and unchanged unrelated state. The Wallet integration test proves key reuse/rotation, per-key totals clearing and no private history in logs. The full relaunch/rekey-crash harness still requires the gateway and dsmack test setup on the build host.

## Read-only sealed-state drain checkpoint

A reviewed build supports the optional launch input `DRAIN_PREFLIGHT_CHALLENGE` (exactly 32 bytes of lowercase hex).
Absent means normal production behavior. Present-but-empty or malformed refuses boot. This input is allowed only for
the agent service; it is not a required input and is not forwarded by the ordinary `run-mini.sh` loop.

Preflight waits only for the existing control gateway. It requires an existing, non-null custody head and positive safe
sequence **before** requesting `/release`; it never initializes genesis, commits, creates/rotates a claim key or wallet,
registers an agent/key, resumes/adopts leases, polls for work, opens line gateways, requests model credit or pays anything.
The existing release still verifies the measured workload and MacLink/custody ownership and can append its normal audit
event. That event and hardware assertion counters may advance; the state key, committed head and sequence must not.
The state is decrypted only inside the guest. Unknown layouts/partial payment fields fail closed, without echoing private
state in errors. Every exported lease is counted as active even when its timestamp has expired.

The sole output is private artifact `drain-checkpoint` (0600), containing `{checkpoint, attestation}`. The fixed checkpoint
binds kind `layover-drain-checkpoint/1`, agent id, existing head/sequence, caller-supplied challenge, status, total lease and
escrow-lease counts, and observation time. Its attestation binds `sha256(canonical(checkpoint)) || 0^32`. No lease ids,
domains, buyers, keys, claim history, state plaintext or public site post are emitted. Custody is re-read after restore,
before attesting, and after attesting immediately before output; changed head **or** sequence refuses output. An attestation
that takes over 120 seconds after observation also refuses output. This is a snapshot, not a lease fence: stop other state
writers/new admissions first and keep them stopped; a later custody change invalidates it.

**Zero process exit is not the drain gate.** A valid `status:"active"` checkpoint also exits zero. Require a fresh verified
`status:"empty"`, `total_leases:0`, and `active_escrow_leases:0`, and require its head/sequence still to be current.
Keep this evidence private unless disclosure is separately authorized.

### One-shot invocation (operator-gated; not executed by this source change)

First review/build the candidate with the unchanged base. Separately authorize custody to **add** its reviewed manifest
without removing the previous manifest, changing agent ownership or resetting the head. This narrow custody admission
is required to inspect the existing state; GuestEscrow workload approval for claims can remain pending until the drain
checkpoint is verified. Preserve previous runs/volumes, claim approvals and artifacts. Stop new admissions and stop the
previous instance cleanly after its final commit; do not run this beside another state writer.

On the Mini through `ssh mini-mesh`, prepare one fresh private run directory. Use the existing `runner`, the reviewed
candidate workload, and that instance's existing launch inputs. This is the same five-argument launcher invocation as
`run-mini.sh`, **not** an edit to the production loop or merely an env append:

```sh
umask 077
G="$HOME/projects/resip-guest"
N=mini-home                         # repeat separately for each existing instance
I="$G/instances/$N"
source "$I/launch.env"              # retain AGENT_ID, escrows, chain and other existing inputs
CHALLENGE=$(openssl rand -hex 32)   # retain privately with this inspection request
R="$I/preflight-$(date +%s)"
mkdir -m 700 "$R"
# CANDIDATE is an already staged, reviewed build; no production workload symlink is changed here.
cp -c "$CANDIDATE/workload.img" "$CANDIDATE/compose-manifest.json" "$R/"
/usr/bin/python3 "$G/inputs.py" "$R/compose-manifest.json" "$R/inputs.img" \
  AGENT_ID="$AGENT_ID" DAILY_BYTES="$DAILY_BYTES" OPERATOR="$OPERATOR" ESCROW="$ESCROW" \
  GUEST_ESCROW="$GUEST_ESCROW" CHAIN_ID="$CHAIN_ID" INSTRUCTIONS="$(cat "$I/instructions.txt")" \
  DRAIN_PREFLIGHT_CHALLENGE="$CHALLENGE" ${UPSTREAM_PROXY:+UPSTREAM_PROXY="$UPSTREAM_PROXY"}
/usr/bin/python3 "$HOME/dsmack-staging/source/applications/compute-node/pool_mac_run.py" \
  "$G/runner" "$R" 3600 mini-4096-1 "$R/inputs.img" > "$R/host-run.log" 2>&1
# Keep the entire run and private result artifact; do not remove/reset any previous run or sealed volume.
```

Locate the named artifact in this run's extracted `out/` results, not an older run. Verify with the existing independently
reviewed web verifier, pinned reviewed candidate manifest/base and expected agent/challenge. For example, on the laptop
with `WEB` an existing web source directory and `ARTIFACT` the private artifact path:

```sh
# EXPECTED_MANIFEST is the FINAL reviewed build, not the superseded #173 build's 355bdafc... hash.
# EXPECTED_IMAGE is the unchanged 8783a3be... base hash. HEAD/SEQ must match the stopped instance's final custody checkpoint.
deno eval '
const [web,file,agent,challenge,head,seq,manifest,image] = Deno.args;
const v = await import("file://"+web+"/verify.ts");
const p = await import("file://"+web+"/static/kit/couch/dsmack/policy.mjs");
const {checkpoint:c,attestation} = JSON.parse(await Deno.readTextFile(file));
const must=(x,m)=>{if(!x)throw Error(m)};
must(c.kind==="layover-drain-checkpoint/1"&&c.agent_id===agent&&c.challenge===challenge&&c.head===head&&c.seq===Number(seq),"wrong inspection binding");
must(c.status==="empty"&&c.total_leases===0&&c.active_escrow_leases===0,"not drained");
must(Number.isSafeInteger(c.observed_at)&&Date.now()-c.observed_at>=0&&Date.now()-c.observed_at<=120000,"stale checkpoint");
const data=await v.binding(new TextEncoder().encode(v.canonical(c)));
const checked=await v.verify(attestation,data,{manifest_sha256:manifest});
must(checked.ok&&checked.facts.os_image_hash===image,"unapproved attestation/measurement");
const a=await p.decodeAttestation(p.unhex(attestation));
must(p.hex(a.caller)===p.hex(await p.sha256(new TextEncoder().encode("agent"))),"wrong caller");
const r=await fetch("https://pod.dstack.soc1024.com/resip-custody-staging/api/custody/"+encodeURIComponent(agent),{cache:"no-store"});
must(r.ok,"custody unavailable");const current=await r.json();
must(current.agent_id===agent&&current.head===head&&current.seq===Number(seq),"custody advanced; repeat inspection");
must(Date.now()-c.observed_at>=0&&Date.now()-c.observed_at<=120000,"checkpoint expired during verification; repeat inspection");
console.log("verified empty checkpoint; retain privately and keep all other writers stopped");
' "$WEB" "$ARTIFACT" "$AGENT_ID" "$CHALLENGE" "$HEAD" "$SEQ" "$EXPECTED_MANIFEST" "$EXPECTED_IMAGE"
```

No pipeline should replace these conditions with exit status, artifact existence, public lease status, or the new boot
refusal alone. A successful empty checkpoint permits the next separately reviewed migration gate; it does not approve a
workload, register a key, change configuration or authorize a financial trial by itself.

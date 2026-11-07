// No gateway, VM, network, wallet dependency or build required: node guest/test/claim-state.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { claimIdentity, claimPlan } from "../claim-state.mjs";
const manifest = "22".repeat(32), operator = "0x" + "11".repeat(20), escrow = "0x" + "ee".repeat(20);
const identity = claimIdentity(manifest, operator, escrow, 84532);
const state = { agent_id: "host", claim_key: "sealed-old-private-key", claim_manifest: manifest, claim_identity: identity,
  guest_claims: { "buyer:terms": "42" }, claim_history: [], enc_priv: "unchanged-encryption-key", ca: { key: "unchanged-ca", cert: "unchanged-cert" },
  wallet: "unchanged-broker-wallet", budget: { day: "2026-11-06", used: 12345 }, chain: { head: "old-receipt-head", entries: [{ signed: "old-receipt" }] },
  leases: [{ id: "lease", buyer_wallet: "buyer", terms_hash: "terms", claimed: "42", token: "unchanged-lease-token" }] };
const original = structuredClone(state);
let p = claimPlan(state, identity);
assert.equal(p.keep, true); assert.deepEqual(p.totals, state.guest_claims); assert.deepEqual(p.history, []);
assert.equal(claimPlan(state, claimIdentity(manifest, operator.toUpperCase().replace("0X", "0x"), escrow, 84532)).keep, true);
// A build change alone still permits existing same-payment leases, with per-key totals reset and old claims retained.
p = claimPlan(state, claimIdentity("23".repeat(32), operator, escrow, 84532));
assert.equal(p.keep, false); assert.deepEqual(p.totals, {}); assert.equal(p.history[0].key, state.claim_key); assert.deepEqual(p.history[0].totals, { "buyer:terms": "42" });
for (const changed of [claimIdentity(manifest, "0x" + "33".repeat(20), escrow, 84532), claimIdentity(manifest, operator, "0x" + "44".repeat(20), 84532), claimIdentity(manifest, operator, escrow, 1)]) {
  assert.throws(() => claimPlan(state, changed), /active escrow leases/);
  const drained = { ...state, leases: [] };
  p = claimPlan(drained, changed);
  assert.equal(p.keep, false); assert.deepEqual(p.totals, {}); assert.deepEqual(p.history[0].identity, identity);
}
// Legacy state cannot prove which operator its registered key belongs to, even on the same manifest.
const legacy = { ...state, claim_identity: undefined };
assert.throws(() => claimPlan(legacy, identity), /active escrow leases/);
assert.throws(() => claimPlan({ ...legacy, claim_key: undefined }, identity), /active escrow leases/);
p = claimPlan({ ...legacy, leases: [] }, identity);
assert.equal(p.keep, false); assert.equal(p.history[0].identity, null);
const retried = claimPlan({ ...legacy, leases: [], claim_history: p.history }, identity);
assert.equal(retried.history.length, 1);
// Selection does not mutate encryption keys, CA, wallet, budget, receipt chain, lease claims/tokens or input totals.
assert.deepEqual(state, original);
assert.deepEqual(claimPlan(undefined, identity).history, []);
// All four physical-Mini launch fixtures use the signed operator, not its publisher; keep unrelated inputs untouched.
for (const name of ["mini-home", "mini-iproyal", "mini-proton", "mini-nym"]) {
  const env = fs.readFileSync(new URL(`../instances/${name}/launch.env`, import.meta.url), "utf8");
  assert.match(env, /^OPERATOR=0x1fbe7a7b3f7a37a967f3d927abd6f04db2766c5b$/m);
  assert.match(env, /^CHAIN_ID=84532$/m);
}
console.log("ok: immutable claim identity rotates safely; legacy/changed-payment active leases block; sealed financial history and unrelated state retained");

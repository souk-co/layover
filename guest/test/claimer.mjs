// Actual Wallet/useClaimer integration; uses the guest's existing dependencies, no VM/gateway/network.
import assert from "node:assert/strict";
Object.assign(process.env, {
  RESIP_BASE: "https://pod.dstack.soc1024.com/resip-staging", BROKER: "https://example.test", AGENT_ID: "test-claimer",
  DSTACK_SOCKET: "/unused", INSTRUCTIONS: "test", GATEWAY_API: "http://127.0.0.1:1", GATEWAY_CONTROL: "127.0.0.1:1",
  DAILY_BYTES: "1000", MAX_RESPONSE_BYTES: "1024", POLL_SECONDS: "1", LIFETIME_SECONDS: "1", ARTIFACTS: ".",
  OPERATOR: "0x" + "11".repeat(20), ESCROW: "0x" + "aa".repeat(20), GUEST_ESCROW: "0x" + "ee".repeat(20), CHAIN_ID: "84532",
  VANTAGE_TRACE_URL: "https://example.test/trace", FETCH_USER_AGENT: "test", FETCH_ACCEPT_LANGUAGE: "en",
});
const core = await import("../core.mjs"), manifest = "22".repeat(32);
core.useClaimer(undefined, manifest);
const first = core.claimer.privateKey, identity = { ...core.savedClaimIdentity };
const state = { claim_key: first, claim_manifest: manifest, claim_identity: identity, guest_claims: { "buyer:terms": "42" }, leases: [] };
core.useClaimer(state, manifest);
assert.equal(core.claimer.privateKey, first); assert.deepEqual(core.guestClaims, { "buyer:terms": "42" });
const messages = [], oldError = console.error;
console.error = (...args) => messages.push(args.join(" "));
try {
  core.useClaimer({ ...state, claim_identity: { ...identity, operator: "0x" + "33".repeat(20) } }, manifest);
  assert.notEqual(core.claimer.privateKey, first); assert.deepEqual(core.guestClaims, {});
  assert.equal(core.claimHistory[0].key, first); assert.deepEqual(core.claimHistory[0].totals, { "buyer:terms": "42" });
  const rotated = core.claimer.privateKey;
  assert.throws(() => core.useClaimer({ ...state, claim_identity: undefined, leases: [{ buyer_wallet: "buyer", terms_hash: "terms" }] }, manifest), /active escrow leases/);
  assert.equal(core.claimer.privateKey, rotated);
  core.useClaimer({ ...state, claim_identity: undefined }, manifest);
  assert.notEqual(core.claimer.privateKey, first); assert.deepEqual(core.guestClaims, {});
  assert.equal(core.claimHistory[0].identity, null);
  assert.ok(messages.every((message) => !message.includes(first) && !message.includes(rotated)), "private claim history reached logs");
} finally { console.error = oldError; }
console.log("ok: actual Wallet key reuse/rotation and totals match immutable operator identity; private history is not logged");

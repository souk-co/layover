import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { checkpointCounts, drainPreflight } from "../drain-preflight.mjs";
const agent = "test-drain", head = "aa".repeat(32), challenge = "bb".repeat(32), escrows = ["0x" + "11".repeat(20), "0x" + "22".repeat(20)];
export const state = () => ({ agent_id: agent, enc_priv: "aa", ca: { key: "bb", cert: "cc" }, wallet: "0x" + "33".repeat(32),
  budget: { day: "2026-11-06", used: 17 }, chain: { head: "00".repeat(32), seq: 0, entries: [] }, leases: [], holds: [], claim_history: [{ key: "private-history-marker" }] });
export const lease = () => ({ id: "00000000-0000-4000-8000-000000000001", account: "44".repeat(32), domains: ["private.example"], use: "price_check", price: 200,
  bytes: 0, paid_bytes: 100, token: "55".repeat(32), salt: "66".repeat(32), reply_pub: "77".repeat(32), start: 1000, term_end: 2000,
  until: new Date(2000).toISOString(), startSeq: 0, startPrev: "00".repeat(32), vantage: [], buyer_wallet: "0x" + "88".repeat(20), terms_hash: "0x" + "99".repeat(32), escrow: escrows[1] });
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
async function inspect(value, change = {}) {
  const events = [], artifacts = [];
  await drainPreflight({ challenge, agentId: agent, escrows,
    restoreExisting: async () => { events.push("restore"); return { head, seq: 7, state: value }; },
    current: async () => { events.push("read"); return { head, seq: 7 }; },
    attest: async digest => { events.push("attest"); return "ab" + digest.toString("hex"); },
    canonical, write: result => { events.push("write"); artifacts.push(result); }, now: () => 10000, ...change });
  return { events, artifacts };
}
test("empty checkpoint attests exactly the challenged head/sequence/counts and never exports state", async () => {
  const { artifacts: [artifact], events } = await inspect(state());
  assert.deepEqual(events, ["restore", "read", "attest", "read", "write"]);
  assert.equal(artifact.checkpoint.status, "empty"); assert.equal(artifact.checkpoint.total_leases, 0);
  assert.equal(artifact.checkpoint.active_escrow_leases, 0);
  assert.deepEqual([artifact.checkpoint.agent_id, artifact.checkpoint.head, artifact.checkpoint.seq, artifact.checkpoint.challenge], [agent, head, 7, challenge]);
  assert.equal(artifact.attestation, "ab" + crypto.createHash("sha256").update(canonical(artifact.checkpoint)).digest("hex"));
  assert.equal(JSON.stringify(artifact).includes("private-history-marker"), false);
  assert.equal(JSON.stringify(artifact).includes("wallet"), false);
});
test("every sealed lease remains active, even expired or non-escrow; paid identities are counted conservatively", async () => {
  const paid = state(); paid.leases.push(lease());
  const a = (await inspect(paid)).artifacts[0].checkpoint;
  assert.deepEqual([a.status, a.total_leases, a.active_escrow_leases], ["active", 1, 1]);
  const plain = state(); plain.leases.push({ ...lease(), buyer_wallet: null, terms_hash: null, escrow: null });
  const b = (await inspect(plain)).artifacts[0].checkpoint;
  assert.deepEqual([b.status, b.total_leases, b.active_escrow_leases], ["active", 1, 0]);
});
test("unknown/malformed state, lease flags, holds and partial financial identity fail before checkpoint attestation", async () => {
  for (const bad of [null, [], {}, { ...state(), unexpected_paid_leases: [] }, { ...state(), leases: null }, { ...state(), holds: [{}] },
    ...[{ buyer_wallet: null }, { terms_hash: undefined }, { escrow: "0x" + "ff".repeat(20) }, { exclusive: "false" }, { bytes: -1 }, { token: null }, { buyerWallet: "unknown" }].map(x => ({ ...state(), leases: [{ ...lease(), ...x }] }))]) {
    let attested = false, written = false;
    await assert.rejects(inspect(bad, { attest: async () => { attested = true; return "aa"; }, write: () => { written = true; } }));
    assert.equal(attested, false); assert.equal(written, false);
  }
});
test("bad challenge, genesis metadata and changing head/sequence never emit a checkpoint", async () => {
  let restored = false;
  await assert.rejects(inspect(state(), { challenge: "", restoreExisting: async () => { restored = true; } }));
  assert.equal(restored, false);
  for (const bad of [{ head: null, seq: 0 }, { head, seq: -1 }, { head, seq: 1.5 }]) {
    await assert.rejects(inspect(state(), { restoreExisting: async () => ({ ...bad, state: state() }) }));
  }
  for (const raceAt of [1, 2]) {
    let reads = 0, writes = 0;
    await assert.rejects(inspect(state(), { current: async () => (++reads === raceAt ? { head: "ff".repeat(32), seq: 8 } : { head, seq: 7 }), write: () => { writes++; } }), /changed/);
    assert.equal(writes, 0);
  }
});
test("a delayed attestation cannot emit an expired checkpoint", async () => {
  let time = 1000, written = false;
  await assert.rejects(inspect(state(), { now: () => { const result = time; time += 120001; return result; }, write: () => { written = true; } }), /expired/);
  assert.equal(written, false);
});

// node --test: a session spend cap is enforced exactly at the broker's 60-second minimum charge and refused just past it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Wallet } from "ethers";
import { Stay, guestManifest } from "./stay.mjs";
import * as sandbox from "./dsmack/sandbox.mjs";
import { paymentRunId } from "./dsmack/payments.mjs";
import { reportData } from "./dsmack/binding.mjs";
import { decodeAttestation, hex, sha256, unhex } from "./dsmack/policy.mjs";
import { attest, deviceKey } from "./testdata/synthetic-guest.mjs";
import { ownershipDomain } from "./dsmack/owners.mjs";
import { controller } from "./session.mjs";

const operator = "0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b";
const pool = { node: "0x0376ece8d8e181a2152a962f1b04e7921af50029f38e4abe41234fa8cbf6a4ec", operator };
const policy = JSON.parse(readFileSync(new URL("./dsmack/sandbox-policy.json", import.meta.url), "utf8"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const mini = "0c3d3c90bb26fa01d01aff1fba61f83d395bc8e2df29d2ec5b95acff2c75969f";
const publisher = "0xa43f9f32411358c1319cb36027650a206644c131", peer = "12D3KooWDfKPhz5ejQuUbnRhXBK7AorxqyjXNynT5RReHvQ2SxWe";
const operationId = "12345678-1234-1234-1234-123456789abc";
const fixture = { relay_peer: peer, relay_maddr: "/ip4/192.0.2.3/tcp/4030/p2p/12D3KooWPdcePFHp8pmoxdwpNC2ADNivvsCFYH8KPSfqutt7GWzA/p2p-circuit/p2p/12D3KooWDfKPhz5ejQuUbnRhXBK7AorxqyjXNynT5RReHvQ2SxWe",
  secret_key: "cc52d38939be5a302c707099a87b0df17662a58ac4918f028937e1c6fba0f297a5df1df898ba8b5faa40b18c4b6c6183eb4a4bbf27679877bf751064a07c2de8", receipt_key: "93ff7637cb24c75527f90a4edaddac16c3d83e502f62c3dbc8ad7a10ff2476c0" };

// The broker's /agent/open answer acknowledges `ack` (maxSpendNanoUsd, operationId, conversationId, active, rateNanoUsdPerSecond)
// over a fully verified guest, the same way stay_test.mjs's openWorld drives Stay.open.
async function cappedWorld(ack) {
  const key = await deviceKey(), owner = Wallet.createRandom();
  const rp = crypto.getRandomValues(new Uint8Array(32)), build = new Uint8Array(32).fill(0xdf);
  const manifest = JSON.parse(Buffer.from(policy.manifestTemplate, "hex").toString());
  const escrow = JSON.parse(JSON.parse(manifest.docker_compose_file).services.node.environment.PAYMENTS_CONFIG).escrow;
  const domain = ownershipDomain(escrow), link = { kid: "0x" + hex(key.kid), publisher: owner.address.toLowerCase(), operator: owner.address.toLowerCase(), nonce: "1" };
  const types = { MacLink: [{ name: "kid", type: "bytes32" }, { name: "publisher", type: "address" }, { name: "operator", type: "address" }, { name: "nonce", type: "uint64" }] };
  const signature = await owner.signTypedData(domain, types, link);
  const stay = new Stay(Wallet.createRandom().privateKey);
  const ended = [], admitted = [];
  let registration;
  const word = n => BigInt(n).toString(16).padStart(64, "0");
  globalThis.fetch = async (url, init) => {
    const u = new URL(url), path = u.pathname;
    let value;
    if (path.endsWith("/inference/credit")) value = { spentNanoUsd: "0" };
    else if (path.endsWith("/nodes")) value = [{ kind: "compute", relay_peer: peer, placement: { publisher, slot_id: 0 } }];
    else if (path.endsWith("/attestation")) {
      const challenge = u.searchParams.get("challenge");
      const bytes = guestManifest(policy.manifestTemplate, { ...pool, operator: owner.address }, mini);
      const m = JSON.parse(Buffer.from(bytes).toString());
      const pay = JSON.parse(JSON.parse(m.docker_compose_file).services.node.environment.PAYMENTS_CONFIG);
      const receipt = Wallet.createRandom(), runNonce = "0x" + hex(crypto.getRandomValues(new Uint8Array(32)));
      const payments = { ...pay, buildId: "0x" + hex(build), runExpires: Math.floor(Date.now() / 1000) + 3600, runNonce,
        runId: paymentRunId("0x" + hex(key.kid), runNonce), receiptSigner: receipt.address, receiptPublicKey: receipt.signingKey.compressedPublicKey, challenge };
      const r = { kind: "compute", ...fixture, manifest_sha256: sha(bytes), os_image_hash: m.base_vm.os_image_hash, cdhash: mini, payments };
      const report_data = await reportData(sandbox.peerBytes(r.relay_peer), unhex(r.secret_key), unhex(r.receipt_key + payments.receiptPublicKey.slice(2)), unhex(challenge));
      r.attestation = await attest(key, { os_image_hash: unhex(r.os_image_hash), manifest_sha256: unhex(r.manifest_sha256),
        run: crypto.getRandomValues(new Uint8Array(32)), caller: await sha256(new TextEncoder().encode("node")), report_data, rp, cdhash: unhex(mini), category: 3 });
      registration = r;
      value = r;
    } else if (path.endsWith("/call")) {
      const selector = u.searchParams.get("data").slice(0, 10);
      const result = { "0xdde5b7a1": hex(key.x) + hex(key.y) + word(1899590400) + word(0) + word(1),
        "0x5523509a": word(3), "0xb4eb10ce": policy.registry.slice(2).toLowerCase().padStart(64, "0"),
        "0x65f4df9c": hex(rp), "0xb7b014b6": hex(build), "0xe62b7cbd": word(0), "0xda746951": word(0) }[selector];
      assert.ok(result, "unexpected chain call " + selector);
      value = { verified_by: "helios-opstack", result: "0x" + result };
    } else if (path.endsWith("/fleet/ownership"))
      value = { domain, links: [{ link, publisherSignature: signature, operatorSignature: signature }], revocations: [] };
    else if (path.endsWith("/agent/open")) {
      value = { sessionId: "s1", placement: { publisher, slot_id: 0 },
        browse: { mode: "named", hosts: ["shop.example"], nanoUsdPerSecond: "0", token: "a".repeat(32) },
        grant: { grant_id: "s1", relay_peer: registration.relay_peer, client_peer: JSON.parse(init.body).client_peer },
        node: { ...registration, attestation: { run: hex((await decodeAttestation(unhex(registration.attestation))).run) } }, ...ack };
    } else if (path.endsWith("/agent/end")) {
      ended.push(path);
      value = { sessionId: "s1", active: false, usageUnresolved: false, credit: { spentNanoUsd: "0" } };
    } else throw Error("unexpected URL " + u);
    return new Response(JSON.stringify(value));
  };
  stay.connect = async () => { admitted.push(true); stay.environment = { commandTimeoutSeconds: 120 }; stay.tools = []; return { close: async () => {} }; };
  return { stay, ended, admitted };
}
const ackOf = (rate, cap) => ({ maxSpendNanoUsd: cap, operationId, conversationId: "t", active: true, rateNanoUsdPerSecond: rate });
const cappedOpen = (stay, cap) => stay.open({ publisher, slotId: 0, conversationId: "t", maxSpendNanoUsd: cap, operationId });

test("a cap exactly covering the 60-second minimum charge opens at the posted rate", async () => {
  const { stay, ended } = await cappedWorld(ackOf("15000", "900000"));
  try {
    const opened = await cappedOpen(stay, "900000");
    assert.equal(opened.maxSpendNanoUsd, "900000");
    assert.equal(opened.operationId, operationId);
    assert.equal(BigInt(opened.rateNanoUsdPerSecond) * 60n, BigInt(opened.maxSpendNanoUsd));
    assert.deepEqual(ended, [], "a cap that covers the minimum opens without ending the grant");
  } finally { if (stay.lease) await stay.end(); }
});

test("a cap one nano-USD below the minimum charge is refused and the reserved grant is ended", async () => {
  const { stay, ended } = await cappedWorld(ackOf("15000", "899999"));
  await assert.rejects(cappedOpen(stay, "899999"), /spend cap/);
  assert.equal(ended.length, 1);
  assert.equal(stay.lease, null);
});

test("a raised broker rate is honoured at exactly rate x 60 and refused one nano-USD below it", async () => {
  const at = await cappedWorld(ackOf("15001", "900060"));
  try { await cappedOpen(at.stay, "900060"); }
  finally { if (at.stay.lease) await at.stay.end(); }
  const below = await cappedWorld(ackOf("15001", "900059"));
  await assert.rejects(cappedOpen(below.stay, "900059"), /spend cap/);
  assert.equal(below.ended.length, 1);
});

test("an accepted quote refuses changed or missing broker rates before admission even when the cap fits", async () => {
  for (const rate of ["15001", "14999", undefined]) {
    const { stay, ended, admitted } = await cappedWorld(ackOf(rate, "1800000"));
    await assert.rejects(stay.open({ publisher, slotId: 0, conversationId: "t", maxSpendNanoUsd: "1800000", operationId,
      expectedRateNanoUsdPerSecond: "15000" }), /spend cap|rate differs from the accepted quote/);
    assert.deepEqual(admitted, []);
    assert.equal(ended.length, 1);
    assert.equal(stay.lease, null);
  }
});

test("an accepted quote binds browse scope and quoted rate before admission", async () => {
  const browse = { mode: "named", hosts: ["shop.example"] };
  const args = { publisher, slotId: 0, conversationId: "t", maxSpendNanoUsd: "1800000", operationId,
    expectedRateNanoUsdPerSecond: "15000", browse };
  const exact = await cappedWorld(ackOf("15000", "1800000"));
  try {
    await exact.stay.open(args);
    assert.equal(exact.admitted.length, 1);
  } finally { if (exact.stay.lease) await exact.stay.end(); }
  for (const scope of [{ mode: "open", hosts: [] }, { mode: "named", hosts: ["other.example"] }]) {
    const { stay, ended, admitted } = await cappedWorld({ ...ackOf("15000", "1800000"), browse: { ...scope, token: "a".repeat(32) } });
    await assert.rejects(stay.open(args), /browsing differs from the accepted quote/);
    assert.deepEqual(admitted, []);
    assert.equal(ended.length, 1);
    assert.equal(stay.lease, null);
  }
});

// The session client's own cap validation, before any broker contact.
const tools = ["bash"].map(name => ({ name, description: name, inputSchema: { type: "object" } }));
const terms = { publisher: "0xhost", slot_id: 3, conversation_id: "thread-1" };
function fakeStay() {
  const calls = [];
  return { calls, async open(args) { calls.push(["open", args]); return { tools, environment: { commandTimeoutSeconds: 120 } }; },
    async summary() { return { active: true }; }, async close() { calls.push(["close"]); return {}; } };
}

test("the session client accepts a 39-digit canonical cap and refuses zero, leading zeros and 40 digits", async () => {
  for (const bad of ["0", "0090000", "9" + "0".repeat(39), "900000 ", "+900000"]) {
    const stay = fakeStay(), invoke = controller(stay, tools);
    await assert.rejects(invoke("open", { ...terms, max_spend_nano_usd: bad, operation_id: operationId }), /Spend cap/);
    assert.deepEqual(stay.calls, []);
  }
  const widest = "9" + "0".repeat(38), stay = fakeStay(), invoke = controller(stay, tools);
  await invoke("open", { ...terms, max_spend_nano_usd: widest, operation_id: operationId });
  assert.equal(stay.calls[0][1].maxSpendNanoUsd, widest);
  assert.equal(stay.calls[0][1].operationId, operationId);
});

test("the session client forwards the complete accepted quote and rejects malformed expected rates", async () => {
  const stay = fakeStay(), browse = { mode: "named", hosts: ["shop.example"] };
  await controller(stay, tools)("open", { ...terms, browse, max_spend_nano_usd: "900000", operation_id: operationId,
    expected_rate_nano_usd_per_second: "15000" });
  assert.deepEqual(stay.calls[0][1], { publisher: terms.publisher, slotId: terms.slot_id, conversationId: terms.conversation_id,
    browse, maxSpendNanoUsd: "900000", operationId, expectedRateNanoUsdPerSecond: "15000" });
  for (const bad of [15000, "0", "015000", "+15000", "15000.0"]) {
    const invalid = fakeStay();
    await assert.rejects(controller(invalid, tools)("open", { ...terms, expected_rate_nano_usd_per_second: bad }), /Expected rate/);
    assert.deepEqual(invalid.calls, []);
  }
});

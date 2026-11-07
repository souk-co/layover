// node --test: challenged verification precedes grant reservation; a raced/malformed grant is ended before connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Stay, BROKER, guestManifest } from "./stay.mjs";
import * as sandbox from "./dsmack/sandbox.mjs";
import { paymentRunId } from "./dsmack/payments.mjs";
import { reportData } from "./dsmack/binding.mjs";
import { decodeAttestation, hex, sha256, unhex } from "./dsmack/policy.mjs";
import { attest, deviceKey } from "./testdata/synthetic-guest.mjs";
import { ownershipDomain } from "./dsmack/owners.mjs";

// The live pool's class under the key-free manifest 227eb195: one class per operator and code, for every key of the Mac.
const operator = "0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b";
const pool = { node: "0x0376ece8d8e181a2152a962f1b04e7921af50029f38e4abe41234fa8cbf6a4ec", operator };
const policy = JSON.parse(readFileSync(new URL("./dsmack/sandbox-policy.json", import.meta.url), "utf8"));
const { manifestTemplate } = policy;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const mini = "0c3d3c90bb26fa01d01aff1fba61f83d395bc8e2df29d2ec5b95acff2c75969f";

test("the manifest template names no App Attest key; the Mini's CDHash and the live class fill it to 227eb195", () => {
  const filled = guestManifest(manifestTemplate, pool, mini);
  assert.equal(sha(filled), "227eb19585645522794e6014fa317920e4e51ecd75cb1cfaaf7c728bab5a497a");
  const pay = JSON.parse(JSON.parse(JSON.parse(Buffer.from(filled).toString()).docker_compose_file).services.node.environment.PAYMENTS_CONFIG);
  assert.equal("enrollmentKeyId" in pay, false);
  assert.equal(sha(guestManifest(manifestTemplate, { ...pool, enrollmentKeyId: "0x" + "e3".repeat(32) }, mini)), sha(filled));
  assert.throws(() => guestManifest(Buffer.from(filled).toString("hex"), pool, mini),
    { message: "sandbox-policy manifestTemplate names no App Attest key and leaves the CDHash, node and operator empty" });
});

test("another Mac's re-signed runner gets its own manifest; the CDHash comes from the registration", () => {
  const other = "11".repeat(32), m = JSON.parse(Buffer.from(guestManifest(manifestTemplate, pool, other)).toString());
  assert.equal(JSON.parse(m.docker_compose_file).services.node.command[5], other);
  assert.notEqual(sha(guestManifest(manifestTemplate, pool, other)), "227eb19585645522794e6014fa317920e4e51ecd75cb1cfaaf7c728bab5a497a");
  assert.throws(() => guestManifest(manifestTemplate, pool, undefined), { message: "registration cdhash" });
});

// A guest of the pool's manifest, run by the runner with `cdhash`, whose attestation is signed by `key` (a stand-in for a
// Mac's App Attest key).
const fixture = { relay_peer: "12D3KooWDfKPhz5ejQuUbnRhXBK7AorxqyjXNynT5RReHvQ2SxWe", relay_maddr: "/ip4/192.0.2.3/tcp/4030/p2p/12D3KooWPdcePFHp8pmoxdwpNC2ADNivvsCFYH8KPSfqutt7GWzA/p2p-circuit/p2p/12D3KooWDfKPhz5ejQuUbnRhXBK7AorxqyjXNynT5RReHvQ2SxWe",
  secret_key: "cc52d38939be5a302c707099a87b0df17662a58ac4918f028937e1c6fba0f297a5df1df898ba8b5faa40b18c4b6c6183eb4a4bbf27679877bf751064a07c2de8", receipt_key: "93ff7637cb24c75527f90a4edaddac16c3d83e502f62c3dbc8ad7a10ff2476c0" };
async function poolGuest(key, rp, build, cdhash, { nodePayments = pool, askedChallenge } = {}) {
  const manifest = guestManifest(manifestTemplate, nodePayments, cdhash), m = JSON.parse(Buffer.from(manifest).toString());
  const pay = JSON.parse(JSON.parse(m.docker_compose_file).services.node.environment.PAYMENTS_CONFIG);
  const receipt = Wallet.createRandom(), runNonce = "0x" + hex(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = askedChallenge ?? hex(crypto.getRandomValues(new Uint8Array(32)));
  const payments = { ...pay, buildId: "0x" + hex(build), runExpires: Math.floor(Date.now() / 1000) + 3600, runNonce,
    runId: paymentRunId("0x" + hex(key.kid), runNonce), receiptSigner: receipt.address, receiptPublicKey: receipt.signingKey.compressedPublicKey, challenge };
  const r = { kind: "compute", ...fixture, manifest_sha256: sha(manifest), os_image_hash: m.base_vm.os_image_hash, cdhash, payments };
  const report_data = await reportData(sandbox.peerBytes(r.relay_peer), unhex(r.secret_key), unhex(r.receipt_key + payments.receiptPublicKey.slice(2)), unhex(challenge));
  r.attestation = await attest(key, { os_image_hash: unhex(r.os_image_hash), manifest_sha256: unhex(r.manifest_sha256),
    run: crypto.getRandomValues(new Uint8Array(32)), caller: await sha256(new TextEncoder().encode("node")), report_data, rp, cdhash: unhex(cdhash), category: 3 });
  return { r, challenge };
}

// A chain where CDRegistry admits only the Mini's CDHash, AppleAttestRegistry holds the enrolled keys, and the broker's
// ownership records hold the verified MacLinks.
function world() {
  const rp = crypto.getRandomValues(new Uint8Array(32)), build = new Uint8Array(32).fill(0xdf), keys = new Map(), links = new Map();
  const chain = { key: async kid => keys.get(hex(kid)) ?? { x: new Uint8Array(32), y: new Uint8Array(32), expires: 0, counter: 0, enrolled: false },
    category: async () => 3, rpIdHash: async cd => hex(cd) === mini ? rp : new Uint8Array(32), buildId: async () => build,
    burnedImage: async () => false, burnedBuild: async () => false };
  const enroll = k => keys.set(hex(k.kid), { x: k.x, y: k.y, expires: 1899590400, counter: 0, enrolled: true });
  const link = (k, op) => links.set("0x" + hex(k.kid), [op.toLowerCase()]);
  const verify = async (key, cdhash = mini) => {
    const { r, challenge } = await poolGuest(key, rp, build, cdhash);
    return sandbox.verifyNode(r, { ...policy, chain, operatorsOf: async kid => links.get(kid) ?? [], manifest: guestManifest(manifestTemplate, r.payments, r.cdhash), challenge });
  };
  return { enroll, link, verify };
}

test("a Mac's key rotation: the same template and class verify under the new key once it is enrolled and linked", async () => {
  const { enroll, link, verify } = world();
  const old = await deviceKey(), fresh = await deviceKey();
  enroll(old); link(old, operator);
  const before = await verify(old);
  await assert.rejects(verify(fresh), /is not enrolled on chain/);
  enroll(fresh);
  await assert.rejects(verify(fresh), /has no MacLink to payment operator/);
  link(fresh, operator);
  const after = await verify(fresh);
  assert.equal(hex(after.enrollment.kid), hex(fresh.kid));
  assert.equal(after.policy.manifestHash, before.policy.manifestHash);
});

test("a guest is refused for a CDHash CDRegistry does not admit, an unenrolled key, or no MacLink to the operator", async () => {
  const { enroll, link, verify } = world();
  const linked = await deviceKey(), unenrolled = await deviceKey(), unlinked = await deviceKey();
  enroll(linked); link(linked, operator); link(unenrolled, operator); enroll(unlinked);
  assert.equal((await verify(linked)).policy.cdhash, mini);
  await assert.rejects(verify(linked, "11".repeat(32)), { message: "refused: assertion cdhash is not the approved CDRegistry build" });
  await assert.rejects(verify(unenrolled), /is not enrolled on chain/);
  await assert.rejects(verify(unlinked), /has no MacLink to payment operator/);
  link(unlinked, "0x" + "22".repeat(20));
  await assert.rejects(verify(unlinked), /has no MacLink to payment operator/);
});

const publisher = "0xa43f9f32411358c1319cb36027650a206644c131", peer = "12D3KooWFvqUGMhqBo7pgMd8K9Vg65UPoSHHCjX2maUF5UYJnSGp";
const ended = { sessionId: "s1", active: false, usageUnresolved: false, credit: { spentNanoUsd: "0" } };
const routes = {
  "/inference/credit": { spentNanoUsd: "0" },
  "/nodes": [{ kind: "compute", relay_peer: peer, placement: { publisher, slot_id: 0 } }],
  "/agent/open": { sessionId: "s1", placement: { publisher, slot_id: 0 }, browse: { mode: "named", hosts: ["shop.example"], nanoUsdPerSecond: "100", token: "a".repeat(32) } },
  [`/sandbox/nodes/${peer}/attestation`]: { kind: "compute", relay_peer: peer, cdhash: "00".repeat(32), payments: pool },
  "/agent/end": ended,
};

test("failed or malformed preflight never reserves a grant or invokes tools", async () => {
  for (const malformed of [false, true]) {
    const called = [], stay = new Stay(Wallet.createRandom().privateKey);
    let connects = 0;
    stay.connect = async () => { connects++; throw Error("must not connect"); };
    globalThis.fetch = async url => {
      const path = new URL(url).pathname.slice(new URL(BROKER).pathname.length);
      called.push(path);
      if (malformed && path.includes("/attestation")) return new Response("{bad json");
      return new Response(JSON.stringify(routes[path]), { status: routes[path] ? 200 : 404 });
    };
    await assert.rejects(stay.open({ publisher, slotId: 0, conversationId: "t" }), malformed ? SyntaxError : /not lowercase hex/);
    assert.equal(called.includes("/agent/open"), false);
    assert.equal(called.includes("/agent/end"), false);
    assert.equal(connects, 0);
    assert.equal(stay.lease, undefined);
    assert.equal(stay.peer, null);
    await assert.rejects(stay.tool("bash", { command: "must not execute" }), /No stay is open/);
  }
});

// Exercise Stay.open's real signature/enrollment/canary/MacLink verification through local fetch fixtures.
async function openWorld(change = () => {}, { burnedImage = false, blockOwner = false, admissionReply, endSpent = "0" } = {}) {
  const key = await deviceKey(), owner = Wallet.createRandom();
  const rp = crypto.getRandomValues(new Uint8Array(32)), build = new Uint8Array(32).fill(0xdf);
  const manifest = JSON.parse(Buffer.from(manifestTemplate, "hex").toString());
  const escrow = JSON.parse(JSON.parse(manifest.docker_compose_file).services.node.environment.PAYMENTS_CONFIG).escrow;
  const domain = ownershipDomain(escrow), link = { kid: "0x" + hex(key.kid), publisher: owner.address.toLowerCase(), operator: owner.address.toLowerCase(), nonce: "1" };
  const types = { MacLink: [{ name: "kid", type: "bytes32" }, { name: "publisher", type: "address" }, { name: "operator", type: "address" }, { name: "nonce", type: "uint64" }] };
  const signature = await owner.signTypedData(domain, types, link);
  const events = [], bodies = {}, stay = new Stay(Wallet.createRandom().privateKey);
  let registration, connects = 0, toolCalls = 0;
  const word = n => BigInt(n).toString(16).padStart(64, "0");
  globalThis.fetch = async (url, init) => {
    const u = new URL(url), path = u.pathname;
    events.push(path);
    if (init?.body) bodies[path] = JSON.parse(init.body);
    let value;
    if (path.endsWith("/inference/credit")) value = { spentNanoUsd: "0" };
    else if (path.endsWith("/nodes")) value = [{ kind: "compute", relay_peer: fixture.relay_peer, placement: { publisher, slot_id: 0 } }];
    else if (path.endsWith("/attestation")) {
      ({ r: registration } = await poolGuest(key, rp, build, mini, { nodePayments: { ...pool, operator: owner.address }, askedChallenge: u.searchParams.get("challenge") }));
      value = registration;
    } else if (path.endsWith("/call")) {
      const selector = u.searchParams.get("data").slice(0, 10);
      const result = { "0xdde5b7a1": hex(key.x) + hex(key.y) + word(1899590400) + word(0) + word(1),
        "0x5523509a": word(3), "0xb4eb10ce": policy.registry.slice(2).toLowerCase().padStart(64, "0"),
        "0x65f4df9c": hex(rp), "0xb7b014b6": hex(build), "0xe62b7cbd": word(burnedImage ? 1 : 0), "0xda746951": word(0) }[selector];
      assert.ok(result, "unexpected chain call " + selector);
      value = { verified_by: "helios-opstack", result: "0x" + result };
    } else if (path.endsWith("/fleet/ownership")) {
      if (blockOwner) {
        assert.ok(init?.signal, "ownership lookup must share the assertion deadline");
        await new Promise((_, reject) => {
          if (init.signal.aborted) reject(init.signal.reason);
          else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      value = { domain, links: [{ link, publisherSignature: signature, operatorSignature: signature }], revocations: [] };
    }
    else if (path.endsWith("/agent/open")) {
      const request = bodies[path];
      value = { ...routes["/agent/open"], placement: { ...routes["/agent/open"].placement }, grant: { grant_id: "s1", relay_peer: registration.relay_peer, client_peer: request.client_peer },
        node: { ...registration, attestation: { run: hex((await decodeAttestation(unhex(registration.attestation))).run) } } };
      change(value);
    } else if (path.endsWith("/agent/end")) value = { ...ended, credit: { spentNanoUsd: endSpent } };
    else if (path.endsWith("/tunnels")) value = [{ relayPeer: JSON.parse(manifest.docker_compose_file).services.node.command[1].split("/").at(-1),
      expiresAt: Math.floor(Date.now() / 1000) + 3600, url: "https://relay.invalid" }];
    else throw Error("unexpected URL " + u);
    return new Response(JSON.stringify(value));
  };
  stay.connect = async r => {
    connects++; events.push("connect");
    assert.deepEqual(r, registration);
    if (admissionReply) {
      const body = new TextEncoder().encode(JSON.stringify(admissionReply)), frame = new Uint8Array(body.length + 4);
      new DataView(frame.buffer).setUint32(0, body.length); frame.set(body, 4);
      stay.peer.dial = async () => ({ remotePeer: { toString: () => r.relay_peer }, newStream: async () => ({
        send: payload => { assert.ok(payload.byteLength > 4); return true; },
        async *[Symbol.asyncIterator]() { yield frame; },
      }) });
      return Stay.prototype.connect.call(stay, r);
    }
    stay.environment = { commandTimeoutSeconds: 120 }; stay.tools = [];
    return { callTool: async () => { toolCalls++; return {}; }, close: async () => {} };
  };
  return { stay, events, bodies, counts: () => ({ connects, toolCalls }) };
}

test("verification finishes before reservation, then the same guest connects and receives the signed browse ask", async () => {
  const { stay, events, bodies, counts } = await openWorld();
  try {
    const browse = { mode: "named", hosts: ["shop.example"] };
    const opened = await stay.open({ publisher, slotId: 0, conversationId: "t", browse });
    assert.equal(opened.sessionId, "s1");
    const at = events.indexOf("/relay-broker/agent/open");
    assert.ok(events.slice(0, at).filter(x => x === "/layover-chain/call").length >= 7);
    assert.equal(events.slice(at).includes("/layover-chain/call"), false, "no verification chain read consumes the setup grant");
    assert.equal(events.at(-1), "connect");
    assert.deepEqual(bodies["/relay-broker/agent/open"].browse, browse);
    assert.deepEqual(counts(), { connects: 1, toolCalls: 0 });
  } finally { if (stay.lease) await stay.end(); }
});

test("prefetched burned state still refuses the guest before any grant or work", async () => {
  const { stay, events, counts } = await openWorld(() => {}, { burnedImage: true });
  await assert.rejects(stay.open({ publisher, slotId: 0, conversationId: "t" }), /canary burned/);
  assert.equal(events.includes("/relay-broker/agent/open"), false);
  assert.equal(events.includes("/relay-broker/agent/end"), false);
  assert.deepEqual(counts(), { connects: 0, toolCalls: 0 });
});

test("the shared verification deadline aborts a blocked MacLink lookup before any grant or work", { timeout: 3000 }, async t => {
  const originalTimeout = AbortSignal.timeout;
  // Exercise the actual shared timeout/cancellation path without waiting sixty seconds in a unit test.
  t.mock.method(AbortSignal, "timeout", ms => originalTimeout(ms === 60000 ? 200 : ms));
  const alive = setInterval(() => {}, 1000);
  try {
    const { stay, events, counts } = await openWorld(() => {}, { blockOwner: true });
    await assert.rejects(stay.open({ publisher, slotId: 0, conversationId: "t" }), /timeout/i);
    assert.ok(events.includes("/relay-broker/fleet/ownership"));
    assert.equal(events.includes("/relay-broker/agent/open"), false);
    assert.equal(events.includes("/relay-broker/agent/end"), false);
    assert.deepEqual(counts(), { connects: 0, toolCalls: 0 });
  } finally { clearInterval(alive); }
});

test("a broker without browse terms still ends the reserved grant before connecting", async () => {
  const { stay, events, counts } = await openWorld(value => { delete value.browse; });
  await assert.rejects(stay.open({ publisher, slotId: 0, conversationId: "t" }), /no browse terms.*stay s1 was ended/);
  assert.ok(events.includes("/relay-broker/agent/end"));
  assert.equal(stay.lease, null);
  assert.deepEqual(counts(), { connects: 0, toolCalls: 0 });
});

test("a changed guest/run/receipt key or mismatched grant is ended without connecting or executing work", async () => {
  for (const change of [
    value => { value.node.attestation.run = "ff".repeat(32); },
    value => { value.node.payments = { ...value.node.payments, runId: "0x" + "ff".repeat(32) }; },
    value => { value.node.payments = { ...value.node.payments, receiptSigner: "0x" + "ff".repeat(20) }; },
    value => { value.node.receipt_key = "ff".repeat(32); },
    value => { value.node.relay_peer = peer; },
    value => { value.grant.relay_peer = peer; },
    value => { value.grant.client_peer = peer; },
    value => { value.grant.grant_id = "another-session"; },
    value => { value.placement.slot_id = 1; },
  ]) {
    const { stay, events, counts } = await openWorld(change);
    await assert.rejects(stay.open({ publisher, slotId: 0, conversationId: "t" }), /changed between verification|different client or guest|not the agreed slot/);
    assert.ok(events.includes("/relay-broker/agent/end"));
    assert.equal(stay.lease, null);
    assert.deepEqual(counts(), { connects: 0, toolCalls: 0 });
  }
});


test("guest admission refusal preserves bounded string detail, ends the grant and invokes no tool", async () => {
  const detail = "meter rejected receipt signer: " + "x".repeat(1200) + "hidden-tail";
  for (const supplied of [detail, { proof: "private-object-proof" }]) {
    const { stay, events, counts } = await openWorld(() => {}, {
      admissionReply: { status: "error", error: "metering", detail: supplied, proof: "private-response-proof" }, endSpent: "900000",
    });
    await assert.rejects(stay.open({ publisher, slotId: 0, conversationId: "t" }), error => {
      assert.match(error.message, /Guest refused session: metering/);
      if (typeof supplied === "string") assert.ok(error.message.includes(detail.slice(0, 1024)));
      assert.equal(error.message.includes("hidden-tail"), false);
      assert.equal(error.message.includes("private-object-proof"), false);
      assert.equal(error.message.includes("private-response-proof"), false);
      assert.equal(error.message.includes("[object Object]"), false);
      assert.match(error.message, /stay s1 was ended, 900000 nano-USD charged/);
      assert.ok(error.message.length < 1200);
      return true;
    });
    assert.equal(events.filter(path => path === "/relay-broker/agent/end").length, 1);
    assert.equal(stay.lease, null);
    assert.deepEqual(counts(), { connects: 1, toolCalls: 0 });
    await assert.rejects(stay.tool("bash", { command: "must not execute" }), /No stay is open/);
  }
});

test("a requested session cap is wallet-signed and mismatched broker authority is ended before connection", async () => {
  const operationId = "12345678-1234-1234-1234-123456789abc";
  for (const delta of [undefined, {maxSpendNanoUsd:"900001"}, {operationId:"different"}, {active:false}, {rateNanoUsdPerSecond:"15001"}]) {
    const {stay,events,bodies,counts}=await openWorld(value=>{ if(delta)Object.assign(value,{maxSpendNanoUsd:"900000",operationId,conversationId:"t",active:true,rateNanoUsdPerSecond:"15000"},delta); });
    await assert.rejects(stay.open({publisher,slotId:0,conversationId:"t",maxSpendNanoUsd:"900000",operationId}),/spend cap/);
    assert.equal(bodies["/relay-broker/agent/open"].maxSpendNanoUsd,"900000");
    assert.equal(bodies["/relay-broker/agent/open"].operationId,operationId);
    assert.ok(events.includes("/relay-broker/agent/end"));
    assert.deepEqual(counts(),{connects:0,toolCalls:0});
  }
});

test("a broker-confirmed cap connects only after the existing verified guest checks", async () => {
  const operationId="12345678-1234-1234-1234-123456789abc";
  const {stay}=await openWorld(value=>Object.assign(value,{maxSpendNanoUsd:"900000",operationId,conversationId:"t",active:true,rateNanoUsdPerSecond:"15000"}));
  try {
    const opened=await stay.open({publisher,slotId:0,conversationId:"t",maxSpendNanoUsd:"900000",operationId});
    assert.equal(opened.maxSpendNanoUsd,"900000");assert.equal(opened.operationId,operationId);
  } finally {if(stay.lease)await stay.end();}
});

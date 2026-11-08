import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAssertion, decodeAttestation, hex, unhex } from "./dsmack/policy.mjs";
import { attest, deviceKey } from "./testdata/synthetic-guest.mjs";
import { CALL_TIMEOUT_MS, heliosChain, prewarmChain } from "./chain.mjs";

const policy = { attest: "0x" + "11".repeat(20), registry: "0x" + "22".repeat(20), canary: "0x" + "33".repeat(20) };
const selectors = { key: "0xdde5b7a1", category: "0x5523509a", registry: "0xb4eb10ce", rp: "0x65f4df9c", build: "0xb7b014b6", image: "0xe62b7cbd", burned: "0xda746951" };
const word = n => BigInt(n).toString(16).padStart(64, "0");
async function fixture(category = 3) {
  const key = await deviceKey(), rp = new Uint8Array(32).fill(0x44), build = new Uint8Array(32).fill(0x55), image = new Uint8Array(32).fill(0x66);
  const cdhash = "77".repeat(32);
  const registration = { cdhash, attestation: await attest(key, { os_image_hash: image, manifest_sha256: new Uint8Array(32), run: new Uint8Array(32),
    caller: new Uint8Array(32), report_data: new Uint8Array(64), rp, cdhash: unhex(cdhash), category }) };
  const values = { [selectors.key]: hex(key.x) + hex(key.y) + word(1899590400) + word(0) + word(1), [selectors.category]: word(3),
    [selectors.registry]: policy.registry.slice(2).padStart(64, "0"), [selectors.rp]: hex(rp), [selectors.build]: hex(build),
    [selectors.image]: word(0), [selectors.burned]: word(0) };
  return { key, build, image, registration, values };
}
function transport(values, { blocked = false } = {}) {
  const calls = [], pending = new Set(), watchers = [];
  let aborted = 0;
  function notify() { for (const w of watchers.splice(0)) w(); }
  const fetch = (url, { signal } = {}) => {
    const u = new URL(url), data = u.searchParams.get("data"), selector = data.slice(0, 10);
    calls.push({ selector, to: u.searchParams.get("to"), data }); notify();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; pending.delete(entry); signal?.removeEventListener("abort", stop);
        if (error) reject(error);
        else resolve(Response.json({ verified_by: "helios-opstack", result: "0x" + values[selector] }));
      };
      const stop = () => { aborted++; finish(signal.reason); };
      const entry = { selector, release: () => finish() };
      pending.add(entry);
      if (signal?.aborted) stop();
      else { signal?.addEventListener("abort", stop, { once: true }); if (!blocked) finish(); }
    });
  };
  const count = async n => { while (calls.length < n) await new Promise(resolve => watchers.push(resolve)); };
  const release = selector => { for (const p of [...pending]) if (!selector || p.selector === selector) p.release(); };
  return { fetch, calls, count, release, pending, aborted: () => aborted };
}

test("one assertion prewarms independent reads, respects the registry/build dependencies and reuses each RPC exactly once", { timeout: 3000 }, async () => {
  const f = await fixture(), network = transport(f.values, { blocked: true }), saved = globalThis.fetch;
  globalThis.fetch = network.fetch;
  try {
    const warming = prewarmChain(f.registration, policy);
    await network.count(4);
    assert.deepEqual(network.calls.map(c => c.selector).sort(), [selectors.key, selectors.category, selectors.registry, selectors.image].sort());
    network.release(selectors.registry);
    await network.count(6);
    assert.deepEqual(network.calls.slice(4).map(c => c.selector).sort(), [selectors.rp, selectors.build].sort());
    network.release(selectors.build);
    await network.count(7);
    assert.equal(network.calls.at(-1).selector, selectors.burned);
    assert.ok(network.pending.size > 1, "build-dependent work overlaps unfinished independent reads");
    network.release();
    const attempt = await warming;
    await checkAssertion(await decodeAttestation(unhex(f.registration.attestation)), attempt.chain, Date.now());
    await attempt.dispose();
    await assert.rejects(attempt.chain.key(f.key.kid), /attempt is closed/);
    assert.equal(network.calls.length, 7, "unchanged verifier consumes only the assertion-local promises");
    assert.equal(new Set(network.calls.map(c => c.selector)).size, 7);
    assert.equal(network.pending.size, 0);
  } finally { network.release(); globalThis.fetch = saved; }
});

test("each attempt reads fresh state and unchanged verification refuses a newly burned image", async () => {
  const f = await fixture(), network = transport(f.values), saved = globalThis.fetch;
  globalThis.fetch = network.fetch;
  try {
    const assertion = await decodeAttestation(unhex(f.registration.attestation));
    const first = await prewarmChain(f.registration, policy);
    try { await checkAssertion(assertion, first.chain, Date.now()); } finally { await first.dispose(); }
    f.values[selectors.image] = word(1);
    const second = await prewarmChain(f.registration, policy);
    try { await assert.rejects(checkAssertion(assertion, second.chain, Date.now()), /canary burned/); } finally { await second.dispose(); }
    assert.equal(network.calls.length, 14, "no chain answer or passed verdict survives into another attempt");
  } finally { globalThis.fetch = saved; }
});

test("a wrong registry aborts and drains independent pending reads without querying an unapproved registry", { timeout: 3000 }, async () => {
  const f = await fixture(); f.values[selectors.registry] = "ff".repeat(20).padStart(64, "0");
  const network = transport(f.values, { blocked: true }), saved = globalThis.fetch;
  globalThis.fetch = network.fetch;
  try {
    const warming = prewarmChain(f.registration, policy);
    const refused = assert.rejects(warming, /reads CDRegistry/);
    await network.count(4); network.release(selectors.registry);
    await refused;
    assert.equal(network.calls.length, 4);
    assert.equal(network.pending.size, 0);
    assert.equal(network.aborted(), 3);
  } finally { network.release(); globalThis.fetch = saved; }
});

test("shared cancellation aborts and drains every pending read in the attempt", { timeout: 3000 }, async () => {
  const f = await fixture(), network = transport(f.values, { blocked: true }), saved = globalThis.fetch, abort = new AbortController();
  globalThis.fetch = network.fetch;
  try {
    assert.equal(CALL_TIMEOUT_MS, 60000);
    const warming = prewarmChain(f.registration, policy, { signal: abort.signal });
    const refused = assert.rejects(warming, /attempt budget/);
    await network.count(4);
    abort.abort(new DOMException("attempt budget", "TimeoutError"));
    await refused;
    assert.equal(network.pending.size, 0);
    assert.equal(network.aborted(), 4);
  } finally { network.release(); globalThis.fetch = saved; }
});

test("the shared attempt budget still rejects verification and cache misses after prewarm completes", async () => {
  const f = await fixture(), network = transport(f.values), saved = globalThis.fetch, abort = new AbortController();
  globalThis.fetch = network.fetch;
  let attempt;
  try {
    attempt = await prewarmChain(f.registration, policy, { signal: abort.signal });
    abort.abort(new DOMException("verification budget", "TimeoutError"));
    await assert.rejects(checkAssertion(await decodeAttestation(unhex(f.registration.attestation)), attempt.chain, Date.now()), /verification budget/);
    await assert.rejects(attempt.chain.key(new Uint8Array(32).fill(0xff)), /verification budget/);
    assert.equal(network.calls.length, 7, "late verification cannot open a fresh per-call budget");
  } finally { await attempt?.dispose(); globalThis.fetch = saved; }
});

test("malformed assertions fail before any network read, and raw heliosChain retains its nonmemoized default", async () => {
  const f = await fixture(), network = transport(f.values), saved = globalThis.fetch;
  globalThis.fetch = network.fetch;
  try {
    await assert.rejects(prewarmChain({ ...f.registration, attestation: "bad" }, policy));
    assert.equal(network.calls.length, 0);
    const chain = heliosChain(policy);
    await chain.key(f.key.kid); await chain.key(f.key.kid);
    assert.equal(network.calls.length, 2);
  } finally { globalThis.fetch = saved; }
});


test("Developer ID signed assertion verifies against the development and Developer ID registry", async () => {
  const f = await fixture(6), network = transport(f.values), saved = globalThis.fetch;
  globalThis.fetch = network.fetch;
  try {
    const a = await decodeAttestation(unhex(f.registration.attestation));
    await checkAssertion(a, heliosChain(policy), Date.now());
  } finally { globalThis.fetch = saved; }
});

test("App Store signed assertion is outside the Mac registry categories", async () => {
  const f = await fixture(5), network = transport(f.values), saved = globalThis.fetch;
  globalThis.fetch = network.fetch;
  try {
    const a = await decodeAttestation(unhex(f.registration.attestation));
    await assert.rejects(checkAssertion(a, heliosChain(policy), Date.now()), /validation category/);
  } finally { globalThis.fetch = saved; }
});

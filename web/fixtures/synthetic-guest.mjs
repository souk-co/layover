// Test-only (from dsmack relay-broker/fixtures/synthetic-guest.mjs): a guest Attest attestation signed by a fresh P-256 key standing in for a Mac's App Attest key, in the
// format dstack-compat/guest_attest.py packs and policy.mjs decodeAttestation/checkAssertion verify.
import { ATTEST_DOMAIN, cat, hex, sha256 } from "../static/kit/couch/dsmack/policy.mjs";

const enc = new TextEncoder(), subtle = crypto.subtle;
const be = (n, k) => Uint8Array.from({ length: k }, (_, i) => (n >>> (8 * (k - 1 - i))) & 255);

function pack(o) {
  if (o instanceof Uint8Array) return pack([...o]);
  if (Array.isArray(o)) return cat(o.length < 16 ? Uint8Array.of(0x90 | o.length) : cat(Uint8Array.of(0xdc), be(o.length, 2)), ...o.map(pack));
  if (typeof o === "object") {
    const e = Object.entries(o);
    return cat(Uint8Array.of(0x80 | e.length), ...e.flatMap(([k, v]) => [pack(k), pack(v)]));
  }
  if (typeof o === "string") {
    const b = enc.encode(o);
    return cat(b.length < 32 ? Uint8Array.of(0xa0 | b.length) : b.length < 256 ? Uint8Array.of(0xd9, b.length) : cat(Uint8Array.of(0xda), be(b.length, 2)), b);
  }
  return o < 128 ? Uint8Array.of(o) : Uint8Array.of(0xcc, o);
}
const cborHead = (major, n) => n < 24 ? Uint8Array.of(major << 5 | n) : n < 256 ? Uint8Array.of(major << 5 | 24, n) : cat(Uint8Array.of(major << 5 | 25), be(n, 2));
const cbor = (m) => cat(cborHead(5, m.length), ...m.flatMap(([k, v]) => [cat(cborHead(3, k.length), enc.encode(k)), cat(cborHead(2, v.length), v)]));
function der(raw) {
  const int = (x) => { let i = 0; while (i < 31 && x[i] === 0) i++; x = x.subarray(i); return x[0] & 0x80 ? cat(Uint8Array.of(2, x.length + 1, 0), x) : cat(Uint8Array.of(2, x.length), x); };
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

// A device key: kid is what the runner reports (sha256 of the public point, as App Attest key ids are).
export async function deviceKey() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const point = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, x: point.slice(1, 33), y: point.slice(33), kid: await sha256(point), counter: 0 };
}

// fields: os_image_hash, manifest_sha256, run, caller, report_data (Uint8Array), rp (rpIdHash), cdhash, category.
export async function attest(key, f) {
  const events = [["system-ready", new Uint8Array()]];
  let head = new Uint8Array(32);
  for (const [n, p] of events) head = await sha256(cat(head, await sha256(cat(be(n.length, 4), enc.encode(n), be(p.length, 4), p))));
  const cdh = await sha256(cat(enc.encode(ATTEST_DOMAIN), f.os_image_hash, f.manifest_sha256, f.run, head, f.caller, f.report_data));
  const ext = cbor([["apple_cd_hash_hash_01", f.cdhash], ["apple_cd_hash_type_01", Uint8Array.of(2)],
    ["apple_validation_category_01", Uint8Array.of(f.category, 0, 0, 0)]]);
  const auth = cat(f.rp, Uint8Array.of(0x80), be(++key.counter, 4), ext);
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.pair.privateKey, await sha256(cat(auth, cdh))));
  const assertion = cbor([["signature", der(sig)], ["authenticatorData", auth]]);
  return hex(pack({ version: 1, platform: { kind: "apple-app-attest", data: { key_id: key.kid, assertion } },
    stack: { kind: "dsmack", data: { report_data: f.report_data, os_image_hash: f.os_image_hash, manifest_sha256: f.manifest_sha256,
      run: f.run, caller: f.caller, events: events.map(([event, p]) => ({ event, payload: btoa(String.fromCharCode(...p)) })) } } }));
}

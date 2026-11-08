// Task-secret release policy: verify a dsmack guest Attest attestation and seal the task's secret to the
// guest's secret-key. Pure functions over WebCrypto and fetch, so the same module runs as a dstack-webhost
// handler (server.ts) and as a Lit action (lit-action.js).
//
// Request: {task_id, attestation (hex VersionedAttestation from the guest's /v1/Attest)}.
// Checks, in order: the attestation decodes and its log ends in its only system-ready; the log holds exactly
// one secret-key event; manifest is the task's compose hash; os_image_hash is one of the task's images;
// report_data = requestBinding(task_id); the App Attest key is enrolled on chain (keys(kid)) and unexpired;
// the assertion's cdhash resolves in CDRegistry to its rpIdHash (so it is the approved build); the assertion
// counter is above the on-chain counter; the signature verifies over the rebuilt client data; the canary has
// not burned the image or the build. Reply: seal(secret-key, secret, task_id) = {epk, iv, ct} hex.
const enc = new TextEncoder(), subtle = crypto.subtle;
export const ATTEST_DOMAIN = "dsmack.appattest.guest-attest/1", INFO = "dsmack.secret-release/1";
export const REQUEST_DOMAIN = "dsmack.secret-request/1", SECRET_KEY_EVENT = "secret-key", SYSTEM_READY = "system-ready";
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => {
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error("not lowercase hex");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};
export const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
export const sha256 = async (b) => new Uint8Array(await subtle.digest("SHA-256", b));
const be32 = (n) => Uint8Array.of(n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const must = (c, m) => { if (!c) throw new Error("refused: " + m); };

// MessagePack, the subset guest_attest.pack writes.
export function unpack(b, i = 0) {
  const t = b[i], dv = new DataView(b.buffer, b.byteOffset);
  if (t < 0x80) return [t, i + 1];
  if (t === 0xcc) return [b[i + 1], i + 2];
  if ((t >= 0xa0 && t <= 0xbf) || t === 0xd9 || t === 0xda) {
    const [n, s] = t === 0xd9 ? [b[i + 1], i + 2] : t === 0xda ? [dv.getUint16(i + 1), i + 3] : [t & 31, i + 1];
    return [new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(s, s + n)), s + n];
  }
  if ((t >= 0x80 && t <= 0x9f) || t === 0xdc || t === 0xde) {
    const map = t < 0x90 || t === 0xde, [n, s] = t < 0xa0 ? [t & 15, i + 1] : [dv.getUint16(i + 1), i + 3];
    const out = [];
    let p = s;
    for (let k = 0; k < (map ? 2 * n : n); k++) { const [x, q] = unpack(b, p); out.push(x); p = q; }
    return [map ? Object.fromEntries(out.flatMap((x, k) => k % 2 ? [] : [[x, out[k + 1]]])) : out, p];
  }
  throw new Error("unsupported MessagePack type " + t);
}

// CBOR, the definite-length subset App Attest uses (uint, bytes, text, array, map).
function cbor(b, i = 0) {
  const major = b[i] >> 5, ai = b[i] & 31, dv = new DataView(b.buffer, b.byteOffset);
  must(ai < 27, "CBOR length");
  let [n, p] = ai < 24 ? [ai, i + 1] : ai === 24 ? [b[i + 1], i + 2] : ai === 25 ? [dv.getUint16(i + 1), i + 3] : [dv.getUint32(i + 1), i + 5];
  if (major === 0) return [n, p];
  if (major === 2) return [b.slice(p, p + n), p + n];
  if (major === 3) return [new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(p, p + n)), p + n];
  must(major === 4 || major === 5, "CBOR type");
  const out = major === 5 ? new Map() : [];
  for (let k = 0; k < n; k++) {
    const [x, q] = cbor(b, p);
    if (major === 4) { out.push(x); p = q; continue; }
    const [v, r] = cbor(b, q);
    must(!out.has(x), "CBOR duplicate key");
    out.set(x, v); p = r;
  }
  return [out, p];
}
const whole = (f, b) => { const [v, p] = f(b); must(p === b.length, "trailing bytes"); return v; };

export async function requestBinding(taskId) {
  return cat(await sha256(cat(enc.encode(REQUEST_DOMAIN), enc.encode(taskId))), new Uint8Array(32));
}

// guest_attest.verify: decode, replay the event head, rebuild the client data hash.
export async function decodeAttestation(blob) {
  const a = whole(unpack, blob), s = a.stack.data, pd = a.platform.data;
  must(a.version === 1 && a.platform.kind === "apple-app-attest" && a.stack.kind === "dsmack", "not a dsmack apple-app-attest v1 attestation");
  const events = s.events.map((e) => [e.event, Uint8Array.from(atob(e.payload), (c) => c.charCodeAt(0))]);
  must(events.filter(([n]) => n === SYSTEM_READY).length === 1 && events.at(-1)[0] === SYSTEM_READY && !events.at(-1)[1].length,
    "event log must end in its only system-ready");
  let head = new Uint8Array(32);
  for (const [n, p] of events) head = await sha256(cat(head, await sha256(cat(be32(n.length), enc.encode(n), be32(p.length), p))));
  const f = Object.fromEntries(["os_image_hash", "manifest_sha256", "run", "caller", "report_data"].map((k) => [k, Uint8Array.from(s[k])]));
  must(["os_image_hash", "manifest_sha256", "run", "caller"].every((k) => f[k].length === 32) && f.report_data.length === 64, "field lengths");
  const cd = cat(enc.encode(ATTEST_DOMAIN), f.os_image_hash, f.manifest_sha256, f.run, head, f.caller, f.report_data);
  return { ...f, head, system_events: events.slice(0, -1), key_id: Uint8Array.from(pd.key_id),
    assertion: Uint8Array.from(pd.assertion), client_data_hash: await sha256(cd) };
}

// AppleAuthData.check for an assertion: rpIdHash, flags, counter and the three Apple extensions.
export function authData(auth, category) {
  must(auth.length >= 37 && auth.length <= 1024, "auth size");
  must((auth[32] & 0x3e) === 0 && auth[32] & 0x80, "auth flags");
  const ext = whole(cbor, auth.subarray(37)), le = (v) => v[0] | v[1] << 8 | v[2] << 16 | v[3] << 24;
  must(ext instanceof Map && [...ext.keys()].every((k) => ["apple_cd_hash_hash_01", "apple_cd_hash_type_01",
    "apple_validation_category_01", "apple_bundle_version_01"].includes(k)), "unknown extension");
  const cdhash = ext.get("apple_cd_hash_hash_01"), type = ext.get("apple_cd_hash_type_01"), cat_ = ext.get("apple_validation_category_01");
  must(cdhash?.length === 32 && type?.length === 1 && type[0] === 2, "CDHash");
  must(cat_?.length === 4 && (le(cat_) === category || [3, 6].includes(category) && [3, 6].includes(le(cat_))), "validation category");
  return { rp: auth.slice(0, 32), counter: new DataView(auth.buffer, auth.byteOffset).getUint32(33), cdhash };
}

function derToRaw(d) {
  must(d[0] === 0x30 && d[1] === d.length - 2 && d[2] === 2, "DER signature");
  const int = (i) => { const n = d[i + 1], v = d.subarray(i + 2, i + 2 + n); must(d[i] === 2 && n <= 33, "DER integer"); return [v.subarray(Math.max(0, n - 32)), i + 2 + n]; };
  const [r, i] = int(2), [s, j] = int(i);
  must(j === d.length, "DER trailing");
  return cat(new Uint8Array(32 - r.length), r, new Uint8Array(32 - s.length), s);
}

// Reads through eth_call. attest is an AppleAttestRegistryV1 (keys, cds, validationCategory); canary a Canary.
export function rpcChain(rpc, attest, canary, read) {
  const call = async (to, data) => {
    if (read) return unhex((await read("eth_call", [{ to, data }, "latest"])).slice(2));
    const r = await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) })).json();
    if (r.error) throw new Error("eth_call: " + JSON.stringify(r.error));
    return unhex(r.result.slice(2));
  };
  const w = (b, k) => b.subarray(32 * k, 32 * k + 32), int = (b) => BigInt("0x" + hex(b));
  const word = (b) => b.slice(-20).reduce((s, x) => s + x.toString(16).padStart(2, "0"), "0x");
  let cds;
  const reg = async () => cds ??= word(await call(attest, "0xb4eb10ce"));
  return {
    key: async (kid) => { const b = await call(attest, "0xdde5b7a1" + hex(kid)); return { x: w(b, 0), y: w(b, 1), expires: Number(int(w(b, 2))), counter: Number(int(w(b, 3))), enrolled: int(w(b, 4)) === 1n }; },
    category: async () => Number(int(await call(attest, "0x5523509a"))),
    rpIdHash: async (cdhash) => call(await reg(), "0x65f4df9c" + hex(cdhash)),
    buildId: async () => call(await reg(), "0xb7b014b6"),
    burnedImage: async (image) => int(await call(canary, "0xe62b7cbd" + hex(image))) === 1n,
    burnedBuild: async (build) => int(await call(canary, "0xda746951" + hex(build))) === 1n,
  };
}

// The App Attest half: enrolled key, approved build, counter, signature over the rebuilt client data, canary.
export async function checkAssertion(a, chain, now) {
  const k = await chain.key(a.key_id);
  must(k.enrolled && now / 1000 <= k.expires, "App Attest key is not enrolled or has expired");
  const m = whole(cbor, a.assertion), auth = m.get("authenticatorData");
  const ad = authData(auth, await chain.category());
  must(!eq(ad.rp, new Uint8Array(32)) && eq(await chain.rpIdHash(ad.cdhash), ad.rp), "assertion cdhash is not the approved CDRegistry build");
  must(ad.counter > k.counter, "assertion counter is not above the on-chain counter");
  const pub = await subtle.importKey("raw", cat(Uint8Array.of(4), k.x, k.y), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  must(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, derToRaw(m.get("signature")), await sha256(cat(auth, a.client_data_hash))),
    "assertion signature");
  must(!await chain.burnedImage(a.os_image_hash) && !await chain.burnedBuild(await chain.buildId()), "canary burned this image or build");
}

// Verifies the request against `task` ({manifest, images}, hex) and returns the guest's secret-key (x || y).
export async function check(req, task, chain, now) {
  const a = await decodeAttestation(unhex(req.attestation));
  const keys = a.system_events.filter(([n]) => n === SECRET_KEY_EVENT);
  must(keys.length === 1 && keys[0][1].length === 64, "log needs exactly one 64-byte secret-key before system-ready");
  must(hex(a.manifest_sha256) === task.manifest, "manifest is not the task's compose hash");
  must(task.images.includes(hex(a.os_image_hash)), "os_image_hash is not admitted for this task");
  must(eq(a.report_data, await requestBinding(req.task_id)), "report_data does not bind this request");
  await checkAssertion(a, chain, now);
  return keys[0][1];
}

const ecdh = { name: "ECDH", namedCurve: "P-256" };
async function boxKey(z, epk, recipient, label) {
  const ikm = await subtle.importKey("raw", z, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: cat(enc.encode(INFO), epk, recipient, enc.encode(label)) },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Ephemeral-static P-256 ECDH, HKDF-SHA256, AES-256-GCM; secret_box.open_secret is the guest's open.
export async function seal(recipient, plaintext, label) {
  const e = await subtle.generateKey(ecdh, true, ["deriveBits"]);
  const epk = new Uint8Array(await subtle.exportKey("raw", e.publicKey)).slice(1);
  const r = await subtle.importKey("raw", cat(Uint8Array.of(4), recipient), ecdh, false, []);
  const z = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: r }, e.privateKey, 256));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, await boxKey(z, epk, recipient, label), plaintext));
  return { epk: hex(epk), iv: hex(iv), ct: hex(ct) };
}

// The open side for a policy-held key (the Lit wrapper's provisioning key): d is a 32-byte P-256 scalar.
export async function p256Key(d) {
  const pkcs8 = cat(unhex("3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420"), d);
  const jwk = await subtle.exportKey("jwk", await subtle.importKey("pkcs8", pkcs8, ecdh, true, ["deriveBits"]));
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return { priv: await subtle.importKey("jwk", jwk, ecdh, false, ["deriveBits"]), pub: cat(b64(jwk.x), b64(jwk.y)) };
}

export async function open({ priv, pub }, sealed, label) {
  const epk = unhex(sealed.epk), e = await subtle.importKey("raw", cat(Uint8Array.of(4), epk), ecdh, false, []);
  const z = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: e }, priv, 256));
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unhex(sealed.iv) }, await boxKey(z, epk, pub, label), unhex(sealed.ct)));
}

export async function release(req, task, secret, chain, now = Date.now()) {
  return seal(await check(req, task, chain, now), secret, req.task_id);
}

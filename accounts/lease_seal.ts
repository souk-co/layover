// Existing web/static/common.js lease wire format, shared by trusted accounts construction.
import { hex, unhex } from "../couch/dsmack/policy.mjs";
// X25519 ECDH, HKDF-SHA256 (empty salt, info "resip-bounty/1" for bounties and leases), AES-256-GCM with the tag appended; all hex.
export async function seal(encPub: string, plaintext: string, info = "resip-bounty/1") {
  const te = new TextEncoder(), s = crypto.subtle;
  const eph = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const pub = await s.importKey("raw", unhex(encPub), { name: "X25519" }, false, []);
  const z = await s.deriveBits({ name: "X25519", public: pub }, eph.privateKey, 256);
  const ikm = await s.importKey("raw", z, "HKDF", false, ["deriveKey"]);
  const key = await s.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: te.encode(info) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await s.encrypt({ name: "AES-GCM", iv: nonce }, key, te.encode(plaintext));
  return { epk: hex(new Uint8Array(await s.exportKey("raw", eph.publicKey))), nonce: hex(nonce), ct: hex(new Uint8Array(ct)) };
}

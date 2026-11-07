import { cat, sha256 } from "./policy.mjs";

// Inputs are decoded, profile-validated bytes. Epoch mode uses a zero nonce.
export async function reportData(peer, seal = new Uint8Array(), receipt = new Uint8Array(), challenge = new Uint8Array(32)) {
  const first = await sha256(cat(new TextEncoder().encode("dsmack.bind/1"), peer, seal, receipt));
  return cat(first, await sha256(cat(first, challenge)));
}

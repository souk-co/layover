// Public claim-key proof carried by the existing agent registration. No private key.
import { Bad, unhex } from "./verify.ts";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const AGENT_CALLER = "d4f0bc5a29de06b510f9aa428f1eedba926012b591fef7a518e776a7c9bd1824";
const must = (ok: unknown, message: string) => { if (!ok) throw new Bad("guest_key: " + message); };
export async function checkGuestKey(proof: any, registration: any, custody: any, escrow: string,
  verify: (attestation: string, data: Uint8Array, expected: any) => Promise<any>) {
  must(proof && Object.keys(proof).sort().join(",") === "address,attestation,escrow,operator", "expected public address,operator,escrow,attestation only");
  for (const name of ["address", "operator", "escrow"]) must(typeof proof[name] === "string" && ADDRESS.test(proof[name]) && proof[name] !== "0x" + "00".repeat(20), name + " must be a nonzero lowercase address");
  must(proof.escrow === escrow.toLowerCase(), "wrong GuestEscrow");
  must(registration.ok && custody.operator?.toLowerCase() === proof.operator, "operator must own the verified registration");
  must(custody.allowed?.manifests.includes(registration.facts.manifest_sha256) && custody.allowed?.os_image_hashes.includes(registration.facts.os_image_hash), "registration measurement is not currently allowed");
  must(typeof proof.attestation === "string" && /^(?:[0-9a-f]{2})+$/.test(proof.attestation), "attestation must be lowercase hex");
  const data = new Uint8Array(64);
  data.set(unhex(proof.address.slice(2)), 12); data.set(unhex(proof.operator.slice(2)), 44);
  const checked = await verify(proof.attestation, data, registration.facts);
  must(checked.ok, "claim-key attestation did not verify");
  for (const name of ["run", "manifest_sha256", "os_image_hash", "key_id"]) must(checked.facts[name] === registration.facts[name], "claim-key " + name + " differs from registration");
  must(registration.facts.caller === AGENT_CALLER, "registration caller is not agent");
  must(checked.facts.caller === AGENT_CALLER, "claim-key caller is not agent");
  return { address: proof.address, operator: proof.operator, escrow: proof.escrow, attestation: proof.attestation };
}

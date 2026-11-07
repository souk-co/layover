// GuestEscrow relays that need no buyer: registerGuestKey from an agent's public guest_key proof and claim() from an ended
// lease's public guest_claim, both read from the site. Anyone may ask; server.ts sends only what eth_estimateGas accepts, so a
// refused request costs the gas-only relayer nothing. The contract checks the attestation, the claim signature, the operator
// and the cap; nothing here is trusted beyond the calldata it builds.
import { AbiCoder } from "npm:ethers@6.13.4/abi";
import { decodeAttestation, hex, unhex } from "../couch/dsmack/policy.mjs";

export class RelayError extends Error {}
const must = (c: unknown, m: string) => { if (!c) throw new RelayError(m); };
const big = (b: Uint8Array) => BigInt("0x" + (hex(b) || "0"));

// The App Attest assertion: a definite-length CBOR map of text keys to byte strings (signature, authenticatorData).
function assertionParts(b: Uint8Array) {
  let i = 0;
  const head = (major: number) => {
    must(b[i] >> 5 === major, "assertion: CBOR type");
    const ai = b[i++] & 31;
    if (ai < 24) return ai;
    if (ai === 24) return b[i++];
    must(ai === 25, "assertion: CBOR length");
    i += 2;
    return b[i - 2] << 8 | b[i - 1];
  };
  const bytes = (major: number) => { const n = head(major), v = b.subarray(i, i + n); i += n; return v; };
  const out: Record<string, Uint8Array> = {};
  for (let k = head(5); k > 0; k--) out[new TextDecoder().decode(bytes(3))] = bytes(2);
  must(i === b.length && out.signature && out.authenticatorData, "assertion: signature and authenticatorData");
  return out;
}
function derRS(d: Uint8Array) {
  must(d[0] === 0x30 && d[1] === d.length - 2 && d[2] === 2, "assertion: DER signature");
  const rl = d[3], sl = d[5 + rl];
  must(rl <= 33 && sl <= 33 && d[4 + rl] === 2 && 6 + rl + sl === d.length, "assertion: DER signature");
  return [big(d.subarray(4, 4 + rl)), big(d.subarray(6 + rl))];
}

// registerGuestKey arguments, as dsmack contracts/guest_register.py builds them.
export async function registerArgs(g: Record<string, string>) {
  const a: Record<string, any> = await decodeAttestation(unhex(g.attestation)), rd: Uint8Array = a.report_data;
  must(rd.subarray(0, 12).every((x) => !x) && rd.subarray(32, 44).every((x) => !x), "guest_key: report_data is not key || operator");
  const key = "0x" + hex(rd.subarray(12, 32)), operator = "0x" + hex(rd.subarray(44, 64));
  must(key === g.address && operator === g.operator, "guest_key: address/operator differ from the attested report_data");
  const m = assertionParts(a.assertion), [r, s] = derRS(m.signature);
  const proof = AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes", "uint256", "uint256"], ["0x" + hex(a.key_id), m.authenticatorData, r, s]);
  const events = [...a.system_events, ["system-ready", new Uint8Array()]];
  return [key, operator, ["os_image_hash", "manifest_sha256", "run", "caller"].map((k) => "0x" + hex(a[k])), events, proof];
}

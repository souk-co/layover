// Attestation checks, using the same guest-Attest verifier as the served couch kit. The App Attest key is the one the
// attestation names, read from AppleAttestRegistryV1 through layover-chain (Helios-verified reads). The registry admitted it
// only with an Apple-rooted attestation of an approved CDRegistry build, so no per-device enrollment is pinned here.
import { cat, checkAssertion, decodeAttestation, hex, sha256, unhex } from "./static/kit/couch/dsmack/policy.mjs";
import { heliosChain } from "./static/kit/couch/chain.mjs";
// The contracts the couch kit trusts: AppleAttestRegistryV1, Canary and the CDRegistry the registry must name.
import POLICY from "./static/kit/couch/dsmack/sandbox-policy.json" with { type: "json" };
export { hex, sha256, unhex };
export class Bad extends Error {}

export const CHAIN = { attest: POLICY.attest, canary: POLICY.canary, registry: POLICY.registry };

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  }
  if (typeof v === "number" && !Number.isInteger(v)) throw new Error("result numbers must be integers");
  return JSON.stringify(v);
}

export const binding = async (bytes: Uint8Array) => cat(await sha256(bytes), new Uint8Array(32));
// Registration report_data: sha256(enc_pub) || sha256(proxy CA certificate DER), or 32 zero bytes for agents without a CA.
export const agentBinding = async (encPub: string, caCert: string | null) =>
  cat(await sha256(unhex(encPub)), caCert ? await sha256(unhex(caCert)) : new Uint8Array(32));

// The run and manifest an attestation names, without checking it (no network).
export async function facts(attestation: string) {
  const a = await decodeAttestation(unhex(attestation));
  return { run: hex(a.run), manifest_sha256: hex(a.manifest_sha256), key_id: hex(a.key_id) };
}

// One chain for every verify, each read kept READ_TTL_MS (a key, the registry's build and the canary change rarely; a canary burn
// reaches new verdicts within that time; chain.mjs fails a read after 60 s). layover-chain answers a read in ~15 s, and a verify
// makes seven, so a cold process verifying its history would otherwise read for hours. A failed read is not kept.
export const READ_TTL_MS = 10 * 60e3;
const reads = new Map<string, { at: number; p: Promise<unknown> }>();
const helios = heliosChain(CHAIN) as Record<string, (x?: Uint8Array) => Promise<unknown>>;
const chain = Object.fromEntries(Object.entries(helios).map(([k, f]) => [k, (x?: Uint8Array) => {
  const key = k + (x ? hex(x) : ""), hit = reads.get(key);
  if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.p;
  const p = f(x);
  reads.set(key, { at: Date.now(), p });
  p.catch(() => reads.delete(key));
  return p;
}])) as unknown as ReturnType<typeof heliosChain>;

type Check = { name: string; ok: boolean; detail: string };
// expect.run: the attestation must come from that run; without it, from any run of the same manifest (a guest whose
// state, keys and CA carry over between runs through custody).
export async function verify(attestation: string, reportData: Uint8Array, expect?: { run?: string; manifest_sha256: string }) {
  const checks: Check[] = [];
  const a = await decodeAttestation(unhex(attestation)).catch((e: Error) => { throw new Bad("attestation does not decode as a dsmack VersionedAttestation: " + e.message); });
  const facts = { run: hex(a.run), manifest_sha256: hex(a.manifest_sha256), os_image_hash: hex(a.os_image_hash), key_id: hex(a.key_id), caller: hex(a.caller) };
  checks.push({ name: "report_data binds", ok: hex(a.report_data) === hex(reportData),
    detail: hex(a.report_data) === hex(reportData) ? hex(a.report_data) : `attested ${hex(a.report_data)}, but the document hashes to ${hex(reportData)}` });
  if (expect?.run) checks.push({ name: "same run as registration", ok: facts.run === expect.run && facts.manifest_sha256 === expect.manifest_sha256, detail: facts.run });
  else if (expect) checks.push({ name: "same manifest as verified", ok: facts.manifest_sha256 === expect.manifest_sha256, detail: facts.manifest_sha256 });
  const name = "App Attest assertion, mode on-chain";
  if (!(await chain.key(a.key_id)).enrolled) {
    checks.push({ name, ok: false, detail: `key ${facts.key_id} is not enrolled in registry ${CHAIN.attest}` });
  } else {
    try {
      await checkAssertion(a, chain, Date.now());
      checks.push({ name, ok: true, detail: `key enrolled in registry ${CHAIN.attest}; approved build, counter, signature, canary` });
    } catch (e) {
      checks.push({ name, ok: false, detail: String((e as Error).message) });
    }
  }
  return { ok: checks.every((c) => c.ok), mode: "on-chain", facts, checks, checked_at: new Date().toISOString() };
}

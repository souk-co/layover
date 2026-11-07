// deno run -A web/verify-offline.ts <site base URL> <bounty id>: independently check an unmodified bounty result.
// A privacy-redacted result has no public proof for its projected fields; never substitute the site's verdict for one.
import { agentBinding, binding, canonical, verify } from "./verify.ts";

type Rec = Record<string, any>;
export async function verifyBountyResponse(bounty: Rec, agent: Rec, verifyAttestation = verify) {
  if (!bounty.result) throw new Error("bounty has no result yet");
  if (bounty.result.result_redacted === true) {
    throw new Error("Independent result verification unavailable: the public result was redacted for privacy; the original attestation does not authenticate the displayed fields.");
  }
  if (!agent || agent.agent_id !== bounty.agent_id) throw new Error("bounty agent registration is missing or mismatched");
  if (typeof bounty.result.attestation !== "string") throw new Error("Independent result verification unavailable: result attestation is missing.");
  const registration = await verifyAttestation(agent.attestation, await agentBinding(agent.enc_pub, agent.ca_cert ?? null));
  const result = await verifyAttestation(bounty.result.attestation, await binding(new TextEncoder().encode(canonical(bounty.result.result))), registration.facts);
  return { registration, result };
}

if (import.meta.main) {
  try {
    const [base, id] = Deno.args;
    if (!base || !id) throw new Error("Usage: deno run -A web/verify-offline.ts <site base URL> <bounty id>");
    const get = async (p: string) => { const r = await fetch(base + "/api/" + p); if (!r.ok) throw new Error(p + ": HTTP " + r.status); return r.json(); };
    const bounty = await get("bounties/" + id), agent = (await get("agents")).find((a: Rec) => a.agent_id === bounty.agent_id);
    const checked = await verifyBountyResponse(bounty, agent);
    console.log(JSON.stringify(checked, null, 2));
    if (!checked.registration.ok || !checked.result.ok) Deno.exit(1);
  } catch (e) { console.error((e as Error).message); Deno.exit(1); }
}

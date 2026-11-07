// deno run -A web/verify-offline.ts <site base URL> <bounty id>: re-run the site's checks on a bounty's agent registration and result.
import { agentBinding, binding, canonical, verify } from "./verify.ts";
const [base, id] = Deno.args;
const get = async (p: string) => { const r = await fetch(base + "/api/" + p); if (!r.ok) throw new Error(p + ": HTTP " + r.status); return r.json(); };
const b = await get("bounties/" + id), agent = (await get("agents")).find((a: { agent_id: string }) => a.agent_id === b.agent_id);
const reg = await verify(agent.attestation, await agentBinding(agent.enc_pub, agent.ca_cert ?? null));
console.log(JSON.stringify({ registration: reg }, null, 2));
if (!b.result) throw new Error("bounty has no result yet");
console.log(JSON.stringify({ result: await verify(b.result.attestation, await binding(new TextEncoder().encode(canonical(b.result.result))), reg.facts) }, null, 2));

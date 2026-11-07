// Recompute an agent's probe and drawn-appraisal times from drand alone and compare them with what the site filed.
//   deno run -A web/probe-schedule.ts BASE AGENT_ID
// Each filed request must chain from the previous one's scheduled_at (the first from the agent's anchor), and its drand_round
// must be the first hit after it (schedule.ts): every earlier round in the window is fetched and checked to be a miss.
import { APPRAISAL, type Kind, PROBE, randomness, roundAt, scan } from "./schedule.ts";

const [base, agent] = Deno.args;
const get = async (p: string) => { const r = await fetch(base + "/api/" + p); if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`); return r.json(); };
const sched = await get("probe-scheduler"), anchor = sched.anchors[agent];
if (!anchor) throw new Error(`no anchor for ${agent}`);
const probes = (await get(`agents/${agent}/probes`)).reverse();
const appraisals = (await get(`appraisal-requests?agent_id=${agent}`)).filter((q: { requested_by: string }) => q.requested_by === sched.requested_by);

const cache = new Map<number, Promise<string>>();
const rand = (r: number) => { if (!cache.has(r)) cache.set(r, randomness(r)); return cache.get(r)!; };
let bad = 0;
async function check(what: string, k: Kind, qs: { from: string; drand_round: number; scheduled_at: string; forced: boolean; at?: string; filed_at?: string }[]) {
  let from = anchor;
  for (const q of qs) {
    // Fetch the window's rounds 8 at a time first (api.drand.sh answers 429 to a few hundred at once); scan reads the cache.
    for (let r = roundAt(Date.parse(from) + k.min * 1000); r <= q.drand_round; r += 8) await Promise.all(Array.from({ length: Math.min(8, q.drand_round - r + 1) }, (_, i) => rand(r + i)));
    const { next } = await scan(Date.parse(from), agent, k, 0, roundAt(Date.parse(from) + k.max * 1000), rand);
    const ok = q.from === from && next!.drand_round === q.drand_round && next!.scheduled_at === q.scheduled_at && next!.forced === q.forced;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} ${what} from ${from} -> round ${next!.drand_round} at ${next!.scheduled_at}${next!.forced ? " (forced)" : ""}; site: from ${q.from} round ${q.drand_round} at ${q.scheduled_at}, filed ${q.filed_at ?? q.at}`);
    from = q.scheduled_at;
  }
}
await check("probe", PROBE, probes);
await check("appraisal", APPRAISAL, appraisals);
console.log(bad ? `${bad} mismatches` : `all ${probes.length} probes and ${appraisals.length} drawn appraisals match drand`);
Deno.exit(bad ? 1 : 0);

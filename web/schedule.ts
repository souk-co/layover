// Probe and appraisal times drawn from drand, recomputable by anyone (notes/qa-probes.md on main). Each drand round r of the
// default chain is a coin per agent: d = sha256(randomness_r || utf8(agent_id + tag)) as a 256-bit integer, and r is a hit when
// d < floor(2^256 * period / mean). The next request after `from` (the previous one's scheduled_at, or the agent's anchor) is
// the first hit among the rounds whose time is in [from + min, from + max]; with no hit it is the round at from + max (forced).
// A hit is known only once its round is published, so nobody can predict a probe; the gaps are geometric on the 30 s grid,
// which is the exponential with that mean, cut at min and max.
export const DRAND = { chain: "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce", genesis: 1595431050, period: 30 };
export const DRAND_URL = `https://api.drand.sh/${DRAND.chain}/public/`;
export type Kind = { tag: string; mean: number; min: number; max: number };
export const PROBE: Kind = { tag: "", mean: 3600, min: 120, max: 4 * 3600 };
export const APPRAISAL: Kind = { tag: "/appraisal", mean: 86400, min: 3600, max: 2 * 86400 };

export const roundTime = (r: number) => (DRAND.genesis + (r - 1) * DRAND.period) * 1000;
// The first round whose time is at or after t (ms).
export const roundAt = (t: number) => Math.max(1, Math.ceil((t / 1000 - DRAND.genesis) / DRAND.period) + 1);
// The latest round published by t, with a few seconds for drand to publish it.
export const latestRound = (t: number) => Math.floor((t / 1000 - 5 - DRAND.genesis) / DRAND.period) + 1;

const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const big = (b: Uint8Array) => BigInt("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
export async function hit(randomness: string, agent_id: string, k: Kind) {
  const id = new TextEncoder().encode(agent_id + k.tag), r = unhex(randomness), m = new Uint8Array(r.length + id.length);
  m.set(r); m.set(id, r.length);
  return big(new Uint8Array(await crypto.subtle.digest("SHA-256", m))) < (2n ** 256n * BigInt(DRAND.period)) / BigInt(k.mean);
}

export async function randomness(round: number): Promise<string> {
  const r = await fetch(DRAND_URL + round, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`drand round ${round}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (j.round !== round) throw new Error(`drand returned round ${j.round} for ${round}`);
  return j.randomness;
}

// Scan rounds from `first` up to `upTo` (both inclusive). Returns the scheduled request, or null (no decision yet) and how far it got.
export async function scan(from: number, agent_id: string, k: Kind, first: number, upTo: number, rand: (r: number) => Promise<string>) {
  const last = roundAt(from + k.max * 1000);
  for (let r = Math.max(first, roundAt(from + k.min * 1000)); r <= Math.min(upTo, last); r++) {
    const x = await rand(r);
    if (await hit(x, agent_id, k)) return { next: { drand_round: r, scheduled_at: new Date(roundTime(r)).toISOString(), forced: false, randomness: x }, scanned: r };
    if (r === last) return { next: { drand_round: r, scheduled_at: new Date(roundTime(r)).toISOString(), forced: true, randomness: x }, scanned: r };
  }
  return { next: null, scanned: Math.min(upTo, last) };
}

// State custody for guests. A guest's state blob is AES-256-GCM under a key derived from this key's master; custody
// releases that key only to an attested run of an allowed manifest that asks for the current head, sealed to a fresh
// X25519 key the run bound into its report_data. Commits advance the head by compare-and-swap, so a run that starts
// from an older head, or a second run that forks the chain, is refused. Custody keeps only the latest blob.
// The allowed manifests serve every agent id: the id is a launch input, not measured. The first release binds the agent id to
// the operator its runner key (the attestation's key_id) is linked to by a signed MacLink (owners.ts). A release is refused
// unless its runner key is linked to that operator, so a Mac's key can rotate without a custody change, but a key the
// operator has not linked, or another operator's Mac, gets no state key.
//   GET  /api/custody/<agent>                                  {agent_id, allowed: {manifests, os_image_hashes}, operator, head, seq, events}
//   POST /api/custody/<agent>/release {head, eph_pub, attestation} -> {head, seq, key: sealed {key}, blob}
//   POST /api/custody/<agent>/commit  {prev, blob, mac}            -> {head, seq}
// Release report_data = sha256(canonical({kind:"resip-custody-release/1", agent_id, head, eph_pub})) || 0^32.
// key = HKDF-SHA256(master, empty salt, "resip-custody/1 " + agent_id); the guest derives "resip-state/1 enc" and
// "resip-state/1 commit" from it. mac = HMAC-SHA256(commit key, canonical({agent_id, prev, head: sha256(blob)})).
import { Bad, binding, canonical, hex, sha256, unhex, verify } from "./verify.ts";
import { seal } from "./static/common.js";
import { operatorsOf } from "./owners.ts";
import ALLOW from "./custody.json" with { type: "json" };

// operators names the operator of an agent id whose first releases predate operator binding and recorded only a runner key.
export type Allow = { manifests: string[]; os_image_hashes: string[]; operators?: Record<string, string> };
export type Owner = (kid: string) => Promise<string[]>;
type Verdict = { ok: boolean; facts: Record<string, string>; checks: { name: string; ok: boolean; detail: string }[] };
export type Verify = (attestation: string, reportData: Uint8Array) => Promise<Verdict>;
type Ctx = { dataDir: string };
type Ev = Record<string, any>;

const te = new TextEncoder(), s = crypto.subtle, MAX_BLOB = 8 << 20;
const isHex = (x: unknown, n?: number) => typeof x === "string" && /^([0-9a-f]{2})+$/.test(x) && (!n || x.length === 2 * n);
const hkdf = async (ikm: Uint8Array<ArrayBuffer>, info: string) =>
  new Uint8Array(await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: te.encode(info) }, await s.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), 256));
const hmac = async (k: Uint8Array<ArrayBuffer>, m: string) =>
  hex(new Uint8Array(await s.sign("HMAC", await s.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), te.encode(m))));
const conflict = (m: string) => Response.json({ error: m }, { status: 409 });

async function master(dir: string) {
  try {
    await Deno.writeTextFile(dir + "/custody-key", hex(crypto.getRandomValues(new Uint8Array(32))), { createNew: true, mode: 0o600 });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
  }
  return unhex(await Deno.readTextFile(dir + "/custody-key"));
}
async function events(dir: string, agent: string): Promise<Ev[]> {
  try {
    return (await Deno.readTextFile(dir + "/custody.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.agent_id === agent);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}
const at = (evs: Ev[]) => { const c = evs.filter((e) => e.kind === "commit").at(-1); return { head: c?.head ?? null, seq: c?.seq ?? 0 }; };
const firstKey = (evs: Ev[]) => evs.find((e) => e.kind === "release" && e.key_id)?.key_id ?? null;
function boundOperator(evs: Ev[], allow: Allow, agent: string): string | null {
  const recorded = evs.find((e) => e.kind === "release" && e.operator)?.operator;
  if (recorded) return recorded;
  const kid = firstKey(evs);
  if (!kid) return null;
  const legacy = allow.operators?.[agent]?.toLowerCase();
  if (!legacy) throw new Error(`agent ${agent} was bound to runner key ${kid} before custody bound operators; custody.json operators must name its operator`);
  return legacy;
}
const blobPath = (dir: string, head: string) => `${dir}/custody-blobs/${head}`;

let tail: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>) => { const p = tail.then(f); tail = p.catch(() => {}); return p; };

async function custody(req: Request, path: string, ctx: Ctx, verify: Verify, allow: Allow, owner: Owner): Promise<Response> {
  const m = path.match(/^\/api\/custody\/([A-Za-z0-9._:-]{1,64})(\/release|\/commit)?$/);
  if (!m) throw new Bad("no such custody route");
  const agent = m[1], dir = ctx.dataDir;
  if (!m[2] && req.method === "GET") {
    const evs = await events(dir, agent);
    const { operators: _, ...allowed } = allow;
    return Response.json({ agent_id: agent, allowed, operator: boundOperator(evs, allow, agent), ...at(evs), events: evs.slice(-20) }, { headers: { "cache-control": "no-store" } });
  }
  if (req.method !== "POST") throw new Bad("POST required");
  const body = await req.json();
  // Remote attestation and owner lookups must not hold the global state/CAS lock.
  // Re-read operator binding and head inside serial: another release/commit may finish while these run.
  let release: { head: string | null; eph_pub: string; v: Verdict; linked: string[] } | null = null;
  if (m[2] === "/release") {
    const { head, eph_pub, attestation } = body;
    if (!(head === null || isHex(head, 32)) || !isHex(eph_pub, 32) || !isHex(attestation)) throw new Bad("release: {head: 32-byte hex or null, eph_pub: 32-byte hex, attestation: hex}");
    const v = await verify(attestation, await binding(te.encode(canonical({ kind: "resip-custody-release/1", agent_id: agent, head, eph_pub }))));
    if (!v.ok) return Response.json({ error: "attestation refused: " + v.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ") }, { status: 403 });
    if (!allow.manifests.includes(v.facts.manifest_sha256) || !allow.os_image_hashes.includes(v.facts.os_image_hash)) {
      return Response.json({ error: `manifest ${v.facts.manifest_sha256} on image ${v.facts.os_image_hash} is not allowed a state key` }, { status: 403 });
    }
    release = { head, eph_pub, v, linked: await owner(v.facts.key_id) };
  }
  return serial(async () => {
    const key = await hkdf(await master(dir), "resip-custody/1 " + agent);
    const evs = await events(dir, agent), cur = at(evs);
    const log = (e: Ev) => Deno.writeTextFile(dir + "/custody.jsonl", JSON.stringify({ ...e, agent_id: agent, at: new Date().toISOString() }) + "\n", { append: true });
    if (release) {
      const { head, eph_pub, v, linked } = release;
      const bound = boundOperator(evs, allow, agent);
      const operator = bound ?? (linked.length === 1 ? linked[0] : null);
      if (!operator || !linked.includes(operator)) {
        await log({ kind: "refused", what: "release", key_id: v.facts.key_id, bound, linked, run: v.facts.run });
        return Response.json({ error: `runner key ${v.facts.key_id} is linked to operators [${linked.join(", ")}]; agent ${agent} is bound to ${bound ?? "no operator yet, and its first release needs a key linked to exactly one"}` }, { status: 403 });
      }
      if (head !== cur.head) {
        await log({ kind: "refused", what: "release", asked: head, head: cur.head, seq: cur.seq, run: v.facts.run });
        return conflict(`stale head: custody is at seq ${cur.seq} head ${cur.head}; the state key is released only to a run starting there`);
      }
      await log({ kind: "release", head, seq: cur.seq, run: v.facts.run, manifest_sha256: v.facts.manifest_sha256, key_id: v.facts.key_id, operator });
      const blob = head === null ? null : hex(await Deno.readFile(blobPath(dir, head)));
      return Response.json({ head, seq: cur.seq, key: await seal(eph_pub, JSON.stringify({ key: hex(key) }), "resip-custody/1 release"), blob });
    }
    const { prev, blob, mac } = body;
    if (!(prev === null || isHex(prev, 32)) || !isHex(blob) || blob.length > 2 * MAX_BLOB || !isHex(mac, 32)) throw new Bad("commit: {prev: 32-byte hex or null, blob: hex up to 8 MiB, mac: 32-byte hex}");
    const raw = unhex(blob), head = hex(await sha256(raw));
    if (mac !== await hmac(await hkdf(key, "resip-state/1 commit"), canonical({ agent_id: agent, prev, head }))) return Response.json({ error: "commit mac does not verify" }, { status: 403 });
    if (prev !== cur.head) {
      await log({ kind: "refused", what: "commit", prev, head: cur.head, seq: cur.seq });
      return conflict(`stale head: custody is at seq ${cur.seq} head ${cur.head}, the commit continues ${prev}`);
    }
    await Deno.mkdir(dir + "/custody-blobs", { recursive: true });
    await Deno.writeFile(blobPath(dir, head), raw);
    await log({ kind: "commit", prev, head, seq: cur.seq + 1, bytes: raw.length });
    if (prev) await Deno.remove(blobPath(dir, prev));
    return Response.json({ head, seq: cur.seq + 1 });
  });
}

// The webhost project resip-custody-staging (isolation: container, so no other project can read its /data). The verifier
// and policy are parameters so the off-Mac test can run custody over unsigned local attestations.
export const custodySite = (verify: Verify, allow: Allow, owner: Owner = operatorsOf) => async function handler(req: Request, ctx: Ctx) {
  if (!ctx?.dataDir) throw new Error("webhost must provide a persistent dataDir");
  const path = new URL(req.url).pathname;
  try {
    return await custody(req, path, ctx, verify, allow, owner);
  } catch (e) {
    if (e instanceof Bad || e instanceof SyntaxError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
};
export default custodySite(verify, ALLOW as Allow);

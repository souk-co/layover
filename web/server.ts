import testMailboxes from "./signup-test-mailboxes.json" with { type: "json" };
import { normalizeStarterEmail, starterCap } from "./starter.ts";
// resip staging site, in its own webhost container: append-only JSON records in ctx.dataDir/records.jsonl, plus an in-memory ciphertext relay for
// proxy streams. The webhost strips /resip-staging.
import { agentBinding, Bad, binding, canonical, facts, hex, sha256, unhex, verify } from "./verify.ts";
import { seal } from "./static/common.js";
import { activity } from "./activity.ts";
import { publicRegions } from "./region.ts";
import { operatorsOf } from "./owners.ts";
import { checkGuestKey } from "./guest-key.ts";
import { admissionSnapshot, checkAdmission } from "./lease-admission.ts";
import ADMISSION_CONFIG from "./admission-config.json" with { type: "json" };
import { APPRAISAL, DRAND, type Kind, latestRound, PROBE, randomness, scan } from "./schedule.ts";

type Ctx = { dataDir: string; env?: Record<string, string> };
type Rec = Record<string, any>;
const must = (c: unknown, m: string) => { if (!c) throw new Bad(m); };
// Routes destructure or read fields of the parsed body, so a POST body that is not a JSON object (null, a scalar, an array) is a 400, not a TypeError 500.
async function jsonBody(req: Request): Promise<Rec> {
  const body = await req.json();
  must(body && typeof body === "object" && !Array.isArray(body), "body: a JSON object");
  return body;
}
class Conflict extends Bad {}
class Upstream extends Bad {}
class Limited extends Bad {}
// An outbound call that fails, times out or answers non-2xx is a 502 naming the upstream, never a bare 500.
async function upstream(name: string, url: string, ms: number, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }).catch((e) => { throw new Upstream(`${name}: ${e.name === "TimeoutError" ? `no answer in ${ms / 1000} s` : e.message}`); });
  if (!r.ok) throw new Upstream(`${name} failed (${r.status}): ${await r.text()}`);
  return await r.json().catch((e) => { throw new Upstream(`${name}: ${e.message}`); });
}
const isHex = (s: unknown, n?: number) => typeof s === "string" && /^([0-9a-f]{2})+$/.test(s) && (!n || s.length === 2 * n);
// Any four dot-separated numbers, even inside a longer dotted run (in-addr.arpa, a trailing dot): over-rejects version strings.
const IPV4 = /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/;
const IPV6 = /(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)(?![0-9a-f:])/i;
function noIp(v: unknown, field: string) {
  const s = JSON.stringify(v), m = s.match(IPV4) ?? s.match(IPV6);
  if (m) throw new Bad(`${field} contains something that looks like an IP address (${m[0]}); records must never carry IPs`);
}

// The log is read once per process (this process is its only writer) and kept in memory; append writes it and adds to it.
// Callers get a copy of the list and must not change the records in it. Hashes and decodes of a record are memoized (once).
const logs = new Map<string, Promise<Rec[]>>();
async function load(dataDir: string): Promise<Rec[]> {
  try {
    return (await Deno.readTextFile(dataDir + "/records.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}
const log = (ctx: Ctx) => {
  if (!logs.has(ctx.dataDir)) logs.set(ctx.dataDir, load(ctx.dataDir).catch((e) => { logs.delete(ctx.dataDir); throw e; }));
  return logs.get(ctx.dataDir)!;
};
const records = async (ctx: Ctx) => [...await log(ctx)];
async function append(ctx: Ctx, r: Rec) {
  const line = JSON.stringify({ ...r, at: new Date().toISOString() }), rs = await log(ctx);
  await Deno.writeTextFile(ctx.dataDir + "/records.jsonl", line + "\n", { append: true });
  rs.push(JSON.parse(line));
}
const derived = new WeakMap<Rec, Map<string, Promise<any>>>();
const once = <T>(r: Rec, k: string, f: () => Promise<T>): Promise<T> => {
  if (!derived.has(r)) derived.set(r, new Map());
  const m = derived.get(r)!;
  if (!m.has(k)) m.set(k, f());
  return m.get(k)!;
};

// Verdicts are computed when records are read (and memoized per process), so verifier changes apply to old records.
// A failed check (an RPC error) is not memoized. Only each agent's current registration is verified: every guest run
// re-registers. state() does not verify: a verify reads layover-chain several times (~15 s a read), so a cold process
// takes minutes over the history. Readers that show a verdict await state's verify(), which checks everything in parallel;
// warmSoon() starts it in the background on every API request, so those readers find it done.
// The verifier and custody's URL; the off-Mac harness configures a local verifier and its own custody.
// minionPub: the baseline-load minion's row-signing key (minion.py keygen on zed). chainCacheMs: how long /api/market and
// /api/status/escrow answers are reused, so an unauthenticated GET cannot fan out into chain reads.
const cfg = { verify, operators: operatorsOf, custody: "https://pod.dstack.soc1024.com/resip-custody-staging/api/custody/", minionPub: "ead43187ceff1305cfd0a8710889d2e2b3888c7efde7c00185166926d51000ea", chainCacheMs: 30000 };
export const configure = (o: Partial<typeof cfg>) => Object.assign(cfg, o);
const verdicts = new Map<string, ReturnType<typeof verify>>();
const checked = (att: string, data: Uint8Array, expect?: { run: string; manifest_sha256: string }) => {
  const k = att + ":" + hex(data) + ":" + JSON.stringify(expect ?? null);
  // verify() reports a layover-chain timeout as a failed check rather than throwing: only a passing verdict is kept.
  if (!verdicts.has(k)) verdicts.set(k, cfg.verify(att, data, expect).then((v) => { if (!v.ok) verdicts.delete(k); return v; }, (e) => { verdicts.delete(k); throw e; }));
  return verdicts.get(k)!;
};
const sameRun = (a: Rec) => a.facts;
// The site cannot read deliver_by (it is inside the ciphertext), so a bounty expires a fixed time after it is posted (if still open) or accepted.
export const EXPIRE_MS = 15 * 60 * 1000;
// A probe request not answered within this time of filing fails, so a dead guest fails its probes.
export const PROBE_EXPIRE_MS = 10 * 60 * 1000;
// Staging credit, in cents. No real money: escrow is milestone M3.
const FAUCET = 100, FAUCET_CAP = 500, HOUR = 3600e3, GB = 1e9;

// The site's verdict in plain JSON for fetchers: the attestation checks plus custody's live allowed list (custodyCheck).
const verdict = async (agent_id: string | null, v: Rec) => {
  const checks = agent_id ? [...v.checks, await custodyCheck(agent_id, v.facts)] : v.checks;
  return { verified_by: "resip-staging site", pass: checks.every((c) => c.ok), mode: v.mode, checks: checks.map((c) => ({ name: c.name, pass: c.ok, detail: c.detail })), checked_at: v.checked_at };
};
const appraisalView = async (p: Rec) => {
  const r = p.report;
  return { id: p.id, agent_id: p.agent_id, request_id: r.request_id, ...(await verdict(p.agent_id, p.verification)), coarse: { region: r.region, isp_class: r.isp_class, residential: r.residential, cgnat: r.cgnat },
    asn: r.asn, beacon: r.beacon, challenges: r.challenges, bandwidth_mbps: r.bandwidth_mbps, at: r.at, guest_version: r.guest_version, guest_escrow: p.guest_escrow ?? PREVIOUS_GUEST_ESCROW.toLowerCase(), attestation: p.attestation };
};
// A statement is publicLease (b12111f) cut to what a payment decision reads, plus end_reason and the site's verdict.
// attestation_pass leaves out the custody check (custody replaces the allowed build on every release, and a lease that
// ended on the previous build was still served as signed); measurement_current reports it separately. The holder's
// bearer key adds the signed statement and the decision reason.
// An escrow lease's terms: buyer_claimed_terms_hash is what the buyer posted in the clear (unchecked); statement_terms_hash and
// statement_buyer_wallet are what the guest signed in its end statement (null until the lease ends). guest_claim is the guest's
// signed GuestEscrow claim from that statement, served only when the statement's attestation passed, public so anyone can relay it (layover-accounts /api/relay/claim).
const escrowFields = (l: Rec) => ({ buyer_claimed_terms_hash: l.terms_hash ?? null, statement_terms_hash: l.end?.statement?.terms_hash ?? null,
  statement_buyer_wallet: l.end?.statement?.buyer_wallet ?? null });
async function leaseStatement(l: Rec, holder: boolean) {
  const p = await publicLease(l), v = l.end && await verdict(null, l.end.verification);
  const st = l.end?.statement;
  return { lease_id: l.id, agent_id: l.agent_id, status: l.status, ...escrowFields(l), end_reason: l.end?.end_reason ?? null, window: p.window, exclusive: p.exclusive, statement_exclusive: p.statement_exclusive, shared_with: p.shared_with,
    periods: p.periods, bytes_up: st?.bytes_up ?? null, bytes_down: st?.bytes_down ?? null, bytes_by_period: st?.bytes_by_period ?? null, guest_claim: v?.pass ? st?.guest_claim ?? null : null, ip_commitments: p.ip_commitments, attestation_pass: v ? v.pass : null,
    attestation_checks: v ? v.checks.map((c: Rec) => `${c.pass ? "pass" : "FAIL"} ${c.name}`) : null,
    measurement_current: l.end ? (await custodyCheck(l.agent_id, l.end.verification.facts)).ok : null,
    verified_by: "resip-staging site", ...(holder ? { statement: l.end?.statement ?? null, decision_reason: l.decision?.reason ?? null } : {}) };
}

// A bounty's public statement for settling a fetch job: counts from the guest's signed result, no URLs or content.
// served counts the 2xx responses; requested is the URL count, unknown to the site until the result (it is sealed).
async function bountyStatement(b: Rec) {
  const items = b.result?.result.items;
  return { bounty_id: b.id, agent_id: b.agent_id, buyer_key: b.buyer_key, status: b.status, requested: items ? items.length : null,
    served: items ? items.filter((i: Rec) => i.status >= 200 && i.status < 300).length : null,
    attestation_pass: b.result ? (await verdict(null, b.result.verification)).pass : null,
    at: b.result?.at ?? b.expired?.at ?? b.decision?.at ?? b.at, verified_by: "resip-staging site" };
}

// A probe's public row: no IP, only the commitment, the challenge summary and the measured bytes.
const probeRow = (q: Rec, probes: Map<string, Rec>) => {
  const p = q.probe_id && probes.get(q.probe_id), r = p?.report;
  return { request_id: q.id, status: q.status, from: q.from, drand_round: q.drand_round, forced: q.forced, scheduled_at: q.scheduled_at, filed_at: q.at,
    done_at: p?.at ?? q.failed_at ?? q.expired_at ?? null, probe_id: q.probe_id ?? null, pass: p ? p.verification.ok : q.status === "open" ? null : false, error: q.error ?? null,
    ...(r ? { report_at: r.at, guest_version: r.guest_version, asn: r.asn, isp_class: r.isp_class, residential: r.residential, ip_commit: r.ip_commit,
      same_ip_as_last: r.same_ip_as_last, sites: r.sites, challenges: r.sites.filter((x: Rec) => x.challenge).length, bytes: r.bytes, beacon: r.beacon } : {}) };
};

async function state(rs: Rec[]) {
  const bindings = new Map<string, Promise<Uint8Array>>(), jobs: (() => Promise<void>)[] = [], later = (x: Rec, att: string, data: Uint8Array, expect?: { run: string; manifest_sha256: string }) =>
    jobs.push(async () => { x.verification = await checked(att, data, expect); });
  const probeRequests = new Map<string, Rec>(), probes = new Map<string, Rec>(), anchors = new Map<string, string>();
  const requests = new Map<string, Rec>(), appraisals = new Map<string, Rec>(), agents = new Map<string, Rec>(), bounties = new Map<string, Rec>(), leases = new Map<string, Rec>(), accounts = new Map<string, Rec>();
  const acct = (a: string) => { if (!accounts.has(a)) accounts.set(a, { account: a, balance: 0, entries: [] }); return accounts.get(a)!; };
  const move = (a: string, amount: number, what: string, at: string) => { const x = acct(a); x.balance += amount; x.entries.push({ at, amount, what }); };
  for (const r of rs) {
    if (r.kind === "agent") {
      agents.set(r.agent_id, { ...r, facts: await once(r, "facts", () => facts(r.attestation)) });
      bindings.set(r.agent_id, once(r, "binding", () => agentBinding(r.enc_pub, r.ca_cert ?? null)));
    }
    if (r.kind === "bounty") bounties.set(r.id, { ...r, status: "open", decision: null, result: null, expired: null });
    if (r.kind === "decision") Object.assign(bounties.get(r.bounty_id)!, { decision: r, status: r.decision === "accept" ? "accepted" : "declined" });
    if (r.kind === "result") {
      const result = { ...r };
      later(result, r.attestation, await once(r, "binding", () => binding(new TextEncoder().encode(canonical(r.result)))), sameRun(agents.get(r.agent_id)!));
      Object.assign(bounties.get(r.bounty_id)!, { result, status: "done" });
    }
    if (r.kind === "appraisal_request") requests.set(r.id, { ...r, status: "open" });
    if (r.kind === "probe_anchor") anchors.set(r.agent_id, r.at);
    if (r.kind === "probe_request") probeRequests.set(r.id, { ...r, status: "open" });
    if (r.kind === "probe_failure") Object.assign(probeRequests.get(r.request_id)!, { status: "failed", error: r.error, failed_at: r.at });
    if (r.kind === "probe") {
      probes.set(r.id, r);
      Object.assign(probeRequests.get(r.report.request_id)!, { status: "done", probe_id: r.id });
    }
    if (r.kind === "appraisal_failure") Object.assign(requests.get(r.request_id)!, { status: "failed", error: r.error });
    if (r.kind === "appraisal") {
      appraisals.set(r.id, { ...r });
      later(appraisals.get(r.id)!, r.attestation, await once(r, "binding", () => binding(new TextEncoder().encode(canonical(r.report)))), r.registration);
      Object.assign(requests.get(r.report.request_id)!, { status: "done", appraisal_id: r.id });
    }
    if (r.kind === "credit") move(r.account, r.amount, r.note, r.at);
    if (r.kind === "lease") {
      leases.set(r.id, { ...r, status: "open", funds: r.deposit, topups: [], decision: null, vantage: [], end: null });
      if (!r.admission) move(r.account, -r.deposit, `deposit, lease ${r.id}`, r.at);
    }
    const l = leases.get(r.lease_id)!;
    if (r.kind === "lease_decision") {
      Object.assign(l, { decision: r, status: r.decision === "accept" ? "active" : "declined" });
      if (r.decision !== "accept" && !l.admission) move(l.account, l.funds, `refund, declined lease ${l.id}`, r.at);
    }
    if (r.kind === "lease_topup") { l.topups.push(r); l.funds += r.amount; move(l.account, -r.amount, `top-up, lease ${l.id}`, r.at); }
    if (r.kind === "lease_vantage") l.vantage.push(r);
    if (r.kind === "lease_end") {
      const end = { ...r };
      later(end, r.attestation, await once(r, "binding", () => binding(new TextEncoder().encode(canonical(r.statement)))), sameRun(agents.get(r.agent_id)!));
      Object.assign(l, { end, status: "ended" });
    }
  }
  for (const a of agents.values()) later(a, a.attestation, await bindings.get(a.agent_id)!);
  const now = Date.now();
  for (const b of bounties.values()) {
    const from = b.status === "accepted" ? b.decision.at : b.at, at = Date.parse(from) + EXPIRE_MS;
    if ((b.status === "accepted" || b.status === "open") && now > at) {
      Object.assign(b, { status: "expired", expired: { at: new Date(at).toISOString(), reason: `no ${b.status === "open" ? "decision" : "result"} within ${EXPIRE_MS / 60000} minutes of ${b.status === "open" ? "posting" : "acceptance"}` } });
    }
  }
  for (const q of probeRequests.values()) {
    const at = Date.parse(q.at) + PROBE_EXPIRE_MS;
    if (q.status === "open" && now > at) Object.assign(q, { status: "expired", expired_at: new Date(at).toISOString(), error: `no probe report within ${PROBE_EXPIRE_MS / 60000} minutes` });
  }
  // Paid per GB of the lease's traffic (requests and responses, heads included): the funds pay for paid_bytes, the guest ends the
  // lease when its traffic reaches them, and at the end the holder is charged the statement's bytes at price_per_gb, at most the funds.
  // A statement without a log (a guest that restarted without ending the lease) bills nothing. Leases decided before per-GB pricing
  // (price_per_hour) accrued from acceptance until their funds ran out. Unspent funds go back to the holder's account when the lease ends.
  for (const l of leases.values()) {
    if (!l.decision || l.decision.decision !== "accept") continue;
    if (l.admission) { l.paid_bytes = l.token_budget_bytes; l.charged = null; continue; }
    if (l.decision.price_per_gb) {
      const st = l.end?.statement, price = l.decision.price_per_gb;
      l.paid_bytes = Math.floor((l.funds * GB) / price);
      l.charged = st?.log ? Math.min(l.funds, ((st.bytes_up + st.bytes_down) * price) / GB) : 0;
    } else {
      const start = Date.parse(l.decision.at), price = l.decision.price_per_hour, stop = l.end ? Date.parse(l.end.at) : now;
      l.paid_until = new Date(start + (l.funds / price) * HOUR).toISOString();
      l.charged = Math.min(l.funds, (price * (stop - start)) / HOUR);
    }
    if (l.end) move(l.account, l.funds - l.charged, `refund of unspent funds, lease ${l.id}`, l.end.at);
  }
  const verify = async () => { await Promise.all(jobs.map((f) => f())); };
  return { requests, appraisals, agents, bounties, leases, accounts, probeRequests, probes, anchors, verify };
}
let warming: Promise<void> | null = null;
const warmSoon = (ctx: Ctx) => { warming ??= records(ctx).then(state).then((s) => s.verify()).catch((e) => console.error("verify warm-up", e)).finally(() => { warming = null; }); };

// --- the scheduler: files probe requests and a daily appraisal request per non-test agent at drand-drawn times (schedule.ts).
// It runs after API requests (the guest polls every 10 s), one tick at a time, never inside a request: a drand error is kept
// in `scheduler.error` (GET /api/probe-scheduler) and the next tick tries again. An agent is scheduled from its anchor, written
// when a guest first asks for its probe requests, so only guests that serve probes get them.
export const SCHEDULER = "resip-staging scheduler";
const scheduler: Rec = { ticks: 0, last_tick_at: null, error: null, error_at: null, cursors: {} as Rec };
const polled = new Map<string, string>(), rounds = new Map<number, string>();
const rand = async (r: number) => { if (!rounds.has(r)) rounds.set(r, await randomness(r)); return rounds.get(r)!; };
let ticking: Promise<void> | null = null;
const tickSoon = (ctx: Ctx) => { ticking ??= tick(ctx).catch((e) => { Object.assign(scheduler, { error: String(e?.stack ?? e).slice(0, 2000), error_at: new Date().toISOString() }); console.error("scheduler", e); }).finally(() => { ticking = null; }); };
// The pending draw after `from`: scan the rounds published so far, resuming where the last tick stopped.
async function due(agent_id: string, k: Kind, from: string) {
  const key = agent_id + k.tag, c = scheduler.cursors[key]?.from === from ? scheduler.cursors[key] : { from, scanned: 0 };
  const { next, scanned } = await scan(Date.parse(from), agent_id, k, c.scanned + 1, latestRound(Date.now()), rand);
  scheduler.cursors[key] = { from, scanned };
  return next && { from, drand_round: next.drand_round, scheduled_at: next.scheduled_at, forced: next.forced };
}
async function tick(ctx: Ctx) {
  const { agents, anchors, requests, probeRequests } = await state(await records(ctx));
  for (const agent_id of agents.keys()) {
    if (agent_id.startsWith("test-")) continue;
    const anchor = anchors.get(agent_id);
    if (!anchor) {
      if (polled.has(agent_id)) await append(ctx, { kind: "probe_anchor", agent_id });
      continue;
    }
    const mine = (m: Map<string, Rec>, by?: string) => [...m.values()].filter((q) => q.agent_id === agent_id && (!by || q.requested_by === by));
    const p = await due(agent_id, PROBE, mine(probeRequests).at(-1)?.scheduled_at ?? anchor);
    if (p) await append(ctx, { kind: "probe_request", id: crypto.randomUUID(), agent_id, requested_by: SCHEDULER, ...p });
    // The guest runs at most one appraisal per 600 s and a refused one uses the slot: the drawn appraisal waits for any open one
    // and for 660 s after the last one filed.
    const a = await due(agent_id, APPRAISAL, mine(requests, SCHEDULER).at(-1)?.scheduled_at ?? anchor), last = mine(requests).at(-1);
    if (a && !(last && (last.status === "open" || Date.now() - Date.parse(last.at) < 660e3))) {
      await append(ctx, { kind: "appraisal_request", id: crypto.randomUUID(), agent_id, requested_by: SCHEDULER, ...a });
    }
  }
  Object.assign(scheduler, { ticks: scheduler.ticks + 1, last_tick_at: new Date().toISOString() });
}

// The broker's /fleet (~40 KB of signed heartbeats) cut to one row per slot, small enough for the amin's web_fetch to read inline.
export const BROKER_FLEET = "https://pod.dstack.soc1024.com/relay-broker/fleet";
// The broker's own network status, proxied same-origin for the public dashboard: its CORS policy is not guaranteed, and the
// page must not depend on the pod being reachable from a visitor's browser.
export const BROKER_NETWORK = "https://pod.dstack.soc1024.com/relay-broker/network";
// Per publisher, how many of this site's /fleet reads found it online: kept in memory since this process started (SINCE).
const SINCE = new Date().toISOString(), seenOnline = new Map<string, { online: number; samples: number }>();
// The host's posted browse surcharges (operator.json browse.price, nano-USD per second; the broker's browseRate reads a missing
// price as 0): open above a non-open default, named per host. The amin checks a stay's rate against them.
const browsePrice = (b?: Rec) => b ? { default: b.default, open: Number(b.price?.open_nano_usd_per_second ?? 0), named: Number(b.price?.named_host_nano_usd_per_second ?? 0) } : null;
// Host levels (#153): named presets over the knobs a host already posts (a MacBook you use, a MacBook on its charger, an
// always-on mini, and the mini plus extras), so a host picks one instead of setting each field; any field it posts beside the
// level still wins. slots.max null is no ceiling; "days" of max stay is 3 days for a guest room, 7 for a suite.
export const HOST_LEVELS: Record<string, { availability: Rec; slots: { min: number; max: number | null }; max_stay_s: number; perks: string[] }> = {
  air_mattress: { availability: { kind: "lid_open", leave_notice_s: 300 }, slots: { min: 1, max: 1 }, max_stay_s: 3600, perks: [] },
  futon: { availability: { kind: "hours", hours: ["22:00", "08:00"] }, slots: { min: 1, max: 2 }, max_stay_s: 28800, perks: ["browse_package_hosts"] },
  guest_room: { availability: { kind: "always" }, slots: { min: 3, max: 4 }, max_stay_s: 259200, perks: ["browse_package_hosts", "home_line"] },
  suite: { availability: { kind: "always" }, slots: { min: 4, max: null }, max_stay_s: 604800, perks: ["line", "vpn_exit", "ai_plan_allowance", "open_browse"] },
};
// The couch card a level expands to: the preset with the host's explicit fields over it (config.host in its fleet heartbeat:
// {level, and any of availability, slots, max_stay_s, perks}). The buyer side reads these fields, not the level's name, so a
// host that changed one still reads true. A level not in the table, or a field of the wrong shape, throws a Bad naming it,
// which couchSlots serves on that host's rows as card_error rather than failing the whole listing.
export function hostLevel(host: Rec) {
  // The lookup must be an own string key of the table: ["suite"] would coerce to "suite", and a plain [] would pass
  // inherited keys like "constructor" as levels.
  const preset = typeof host.level === "string" && Object.hasOwn(HOST_LEVELS, host.level) ? HOST_LEVELS[host.level] : undefined;
  if (!preset) throw new Bad(`level: ${JSON.stringify(host.level).slice(0, 100)} is not one of ${Object.keys(HOST_LEVELS).join(", ")}`);
  const card: Rec = { level: host.level, availability: preset.availability, slots: preset.slots, max_stay_s: preset.max_stay_s, perks: preset.perks };
  for (const k of ["availability", "slots", "max_stay_s", "perks"]) if (host[k] !== undefined) card[k] = host[k];
  const a = card.availability;
  must(["lid_open", "hours", "always"].includes(a?.kind), "availability.kind: one of lid_open, hours, always");
  must(a.kind !== "hours" || Array.isArray(a.hours) && a.hours.length === 2 && a.hours.every((h: unknown) => typeof h === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(h)), 'availability.hours: ["HH:MM", "HH:MM"], e.g. ["22:00", "08:00"]');
  must(a.leave_notice_s === undefined || Number.isInteger(a.leave_notice_s) && a.leave_notice_s > 0, "availability.leave_notice_s: whole seconds of notice");
  must(Number.isInteger(card.slots?.min) && card.slots.min >= 1 && (card.slots.max === null || Number.isInteger(card.slots.max) && card.slots.max >= card.slots.min), "slots: {min >= 1, max >= min or null for no ceiling}");
  must(Number.isInteger(card.max_stay_s) && card.max_stay_s > 0, "max_stay_s: whole seconds");
  must(Array.isArray(card.perks) && card.perks.every((p: unknown) => typeof p === "string"), "perks: strings");
  return card;
}
// A host whose card fails to expand (it posted a level not in the table or a field of the wrong shape) is still listed: its
// rows unchanged with the failure named, so one misposting host cannot hide every other host from buyers.
const cardOf = (host?: Rec) => {
  if (host?.level === undefined) return {};
  try {
    return hostLevel(host);
  } catch (e) {
    if (!(e instanceof Bad)) throw e;
    return { card_error: e.message };
  }
};
const slotAnswers = new Map<string, { at: number; p: Promise<Rec[]> }>();
function cachedSlots(ctx: Ctx) {
  const hit = slotAnswers.get(ctx.dataDir);
  if (hit && Date.now() - hit.at < cfg.chainCacheMs) return hit.p;
  const p = couchSlots();
  const entry = { at: Infinity, p };
  slotAnswers.set(ctx.dataDir, entry);
  p.then(() => { entry.at = Date.now(); }, () => {});
  p.catch(() => { if (slotAnswers.get(ctx.dataDir)?.p === p) slotAnswers.delete(ctx.dataDir); });
  return p;
}
async function couchSlots() {
  const fleet = await upstream("broker /fleet", BROKER_FLEET, 15000);
  for (const m of fleet) {
    const u = seenOnline.get(m.publisher) ?? { online: 0, samples: 0 };
    seenOnline.set(m.publisher, { online: u.online + (m.online ? 1 : 0), samples: u.samples + 1 });
  }
  return fleet.flatMap((m: Rec) => m.slots.map((s: Rec) => ({ publisher: m.publisher, chip: m.hardware.chip,
    online: m.online, updated_at: m.updated_at, vcpus: m.config.guest.vcpus, mem_mib: m.config.guest.mem_mib, browse: browsePrice(m.config.browse),
    // A host that picked a level serves its expanded card on each of its slot rows; a host without one serves today's row unchanged.
    ...cardOf(m.config.host), slot_id: s.slot_id,
    // The broker stamps a guest whose last relay hop it was refused; such a slot is not offered as ready until a hop succeeds.
    state: s.attestation?.unreachable ? "unreachable" : s.state, unreachable: s.attestation?.unreachable ?? null,
    last_error_code: s.last_error_code, run_id: s.run_id, verified: s.attestation?.attestation?.status === "verified", handoverAt: s.attestation?.admit_until ?? null,
    // started_at (when the slot's guest run came up) and jobs_served (the broker's stay counter) are the timestamps
    // and stay counts the usage dashboard reads; both come straight from the fleet row.
    started_at: s.started_at ?? null, jobs_served: s.jobs_served ?? null, online_share: { ...seenOnline.get(m.publisher)!, since: SINCE } })));
}
// The measurement an agent registered from must be one custody allows it now (read live, so a release needs no site deploy).
async function custodyGet(agent_id: string) {
  return await upstream("custody GET", cfg.custody + encodeURIComponent(agent_id), 15000);
}
async function custodyCheck(agent_id: string, f: Rec) {
  const { allowed: al } = await custodyGet(agent_id);
  const ok = !!al && al.manifests.includes(f.manifest_sha256) && al.os_image_hashes.includes(f.os_image_hash);
  return { name: "measurement allowed by custody", ok, detail: al ? `manifest ${f.manifest_sha256}, image ${f.os_image_hash}` : "custody allows this agent no measurement" };
}
async function allowed(a: Rec) {
  const check = await custodyCheck(a.agent_id, a.verification.facts);
  return { ...a, guest_escrow: a.guest_key?.escrow ?? PREVIOUS_GUEST_ESCROW.toLowerCase(), verification: { ...a.verification, ok: a.verification.ok && check.ok, checks: [...a.verification.checks, check] } };
}

// --- the public dashboard's minute series: like the scheduler, it runs after API requests, at most one row a minute, and appends
// {t, ready, busy, bounties_done, leases} to stats-history.jsonl in the data dir. Only counts: no regions, IPs or emails. The
// newest row's t is the clock (so a restart does not double-sample), and rows older than HISTORY_KEEP_MS are retired on write.
export const HISTORY_EVERY_MS = 60e3, HISTORY_KEEP_MS = 7 * 86400e3, HISTORY_FILE = "stats-history.jsonl";
const historyLines = new Map<string, Rec[]>();
async function history(ctx: Ctx): Promise<Rec[]> {
  let rows = historyLines.get(ctx.dataDir);
  if (rows) return rows;
  try {
    rows = (await Deno.readTextFile(ctx.dataDir + "/" + HISTORY_FILE)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) rows = [];
    else throw e;
  }
  historyLines.set(ctx.dataDir, rows!);
  return rows!;
}
export async function sampleHistory(ctx: Ctx) {
  const rows = await history(ctx), now = Date.now();
  if (rows.some((r) => Date.parse(r.t) > now - HISTORY_EVERY_MS)) return false;
  const { bounties, leases } = await state(await records(ctx)), real = (id: string) => !id.startsWith("test-");
  const slots = await couchSlots(), row = { t: new Date(now).toISOString(),
    ready: slots.filter((s) => s.online && s.state === "ready" && s.verified).length,
    busy: slots.filter((s) => s.state === "busy").length,
    bounties_done: [...bounties.values()].filter((b) => real(b.agent_id) && b.result).length,
    leases: [...leases.values()].filter((l) => real(l.agent_id) && l.status === "active").length };
  rows.push(row);
  const keep = rows.filter((r) => Date.parse(r.t) > now - HISTORY_KEEP_MS);
  if (keep.length === rows.length) await Deno.writeTextFile(ctx.dataDir + "/" + HISTORY_FILE, JSON.stringify(row) + "\n", { append: true });
  else {
    historyLines.set(ctx.dataDir, keep);
    await Deno.writeTextFile(ctx.dataDir + "/" + HISTORY_FILE, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return true;
}
let sampling: Promise<unknown> | null = null;
const sampleSoon = (ctx: Ctx) => { sampling ??= sampleHistory(ctx).catch((e) => console.error("history sample", e)).finally(() => { sampling = null; }); };
// A lease is private between its holder and the guest. The public form has no domains, counts, prices or account:
// the window, whether the buyer asked for an exclusive or a shared lease (exclusive: null on leases posted before the choice existed),
// whether the statement claims exclusivity and how many other leases shared its domains, the guest's vantage checks summarized (periods: each 300 s
// of the window, covered when its checks saw the same IP and ASN), the statement's verification, the sealed request,
// and terms {account, paid_bytes, exclusive} sealed to the key the request was sealed to, for the guest. The holder reads the
// full record with its account secret.
const PERIOD = 300e3;
async function publicLease(l: Rec) {
  const start = l.decision?.decision === "accept" ? Date.parse(l.decision.at) : NaN;
  const stop = l.end ? Date.parse(l.end.at) : Math.min(Date.now(), Date.parse(l.decision?.term_end));
  const periods = [];
  for (let t = start; t < stop; t += PERIOD) {
    const vs = l.vantage.filter((v: Rec) => Date.parse(v.checked_at) >= t && Date.parse(v.checked_at) < t + PERIOD);
    periods.push({ start: new Date(t).toISOString(), covered: vs.length > 0 && vs.every((v: Rec) => v.same_ip && v.same_asn) });
  }
  return { id: l.id, agent_id: l.agent_id, at: l.at, status: l.status, ...escrowFields(l), enc_pub: l.enc_pub, enc: l.enc,
    window: isNaN(start) ? null : { start: l.decision.at, term_end: l.decision.term_end, end: l.end?.at ?? null },
    exclusive: l.exclusive ?? null, statement_exclusive: l.end?.statement?.exclusive ?? null, shared_with: l.end?.statement?.shared_with ?? null,
    ip_commitments: { count: new Set(l.vantage.map((v: Rec) => v.ip_commit)).size, checks: l.vantage.length, stable: l.vantage.every((v: Rec) => v.same_ip && v.same_asn) },
    periods, verification: l.end?.verification ?? null,
    terms: await seal(l.enc_pub, JSON.stringify({ account: l.account, paid_bytes: l.paid_bytes ?? null, exclusive: l.exclusive }), "resip-lease-terms/1") };
}

// --- ciphertext relay between a buyer's resip-proxy and the guest; held in memory only, never parsed or stored ---
type Pipe = { chunks: Uint8Array[]; closed: boolean; wake: (() => void) | null };
const relays = new Map<string, { agent_id: string; up: Pipe; down: Pipe; seen: number; taken: boolean }>();
// Every accept poller waits in its own slot (a forked run's guest and the live one can both be polling). A stream handed
// to a poller that never reads it (a run that died after the handoff) goes back in the queue after HANDOFF_MS.
type Queue = { ids: string[]; waiters: Set<() => void> };
const pending = new Map<string, Queue>();
const pipe = (): Pipe => ({ chunks: [], closed: false, wake: null });
const wait = (p: { wake: (() => void) | null }, ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); p.wake = () => { clearTimeout(t); r(); }; });
const waitQ = (q: Queue, ms: number) => new Promise<void>((r) => { const done = () => { clearTimeout(t); q.waiters.delete(done); r(); }; const t = setTimeout(done, ms); q.waiters.add(done); });
const wakeQ = (q: Queue) => { for (const w of [...q.waiters]) w(); };
const queue = (agent_id: string) => { if (!pending.has(agent_id)) pending.set(agent_id, { ids: [], waiters: new Set() }); return pending.get(agent_id)!; };
const POLL_MS = 25000, HANDOFF_MS = 10000;

async function relay(req: Request, path: string, agents: () => Promise<Map<string, Rec>>) {
  for (const [id, r] of relays) if (Date.now() - r.seen > 10 * 60e3) relays.delete(id);
  if (path === "/api/relay/open" && req.method === "POST") {
    const { agent_id } = await jsonBody(req);
    must((await agents()).has(agent_id), "agent_id: not registered");
    const id = crypto.randomUUID();
    relays.set(id, { agent_id, up: pipe(), down: pipe(), seen: Date.now(), taken: false });
    const q = queue(agent_id);
    q.ids.push(id);
    wakeQ(q);
    return Response.json({ stream_id: id });
  }
  if (path === "/api/relay/accept" && req.method === "GET") {
    const agent_id = new URL(req.url).searchParams.get("agent_id")!;
    const q = queue(agent_id);
    if (!q.ids.length) await waitQ(q, POLL_MS);
    // A poller that went away (a guest run that ended) must not take streams with it.
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const ids = q.ids.splice(0);
    for (const id of ids) setTimeout(() => { if (relays.has(id) && !relays.get(id)!.taken) { q.ids.push(id); wakeQ(q); } }, HANDOFF_MS);
    return Response.json(ids);
  }
  const m = path.match(/^\/api\/relay\/([0-9a-f-]{36})\/(up|down)(\/close)?$/);
  must(m, "no such relay route");
  const r = relays.get(m![1]);
  if (!r) return Response.json({ error: "no such stream" }, { status: 410 });
  r.seen = Date.now();
  const p = r[m![2] as "up" | "down"];
  if (m![2] === "up" && req.method === "GET") r.taken = true;
  if (req.method === "POST" && m![3]) { p.closed = true; p.wake?.(); return Response.json({ ok: true }); }
  if (req.method === "POST") { p.chunks.push(new Uint8Array(await req.arrayBuffer())); p.wake?.(); return Response.json({ ok: true }); }
  if (!p.chunks.length && !p.closed) await wait(p, POLL_MS);
  if (p.chunks.length) {
    const out = new Uint8Array(p.chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of p.chunks.splice(0)) { out.set(c, o); o += c.length; }
    return new Response(out, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  }
  return new Response(null, { status: p.closed ? 410 : 204 });
}

// A buyer account is sha256 of a 32-byte secret sent as a bearer token; the site never stores the secret.
async function bearer(req: Request) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get("authorization") ?? "");
  must(m, "Authorization: Bearer <32-byte hex account secret> required");
  return hex(await sha256(unhex(m![1])));
}

// Same-origin, fixed-path proxy: browsers never need account-service CORS and emails stay in POST bodies.
const ACCOUNTS_URL = "https://pod.dstack.soc1024.com/layover-accounts/api/";
async function accountCall(path: string, req: Request, body?: Rec) {
  return await upstream("layover-accounts /" + path, ACCOUNTS_URL + path, 180000, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(req.headers.has("authorization") ? { authorization: req.headers.get("authorization")! } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function consoleAccount(req: Request) {
  must(/^Bearer \S+$/.test(req.headers.get("authorization") ?? ""), "Not signed in: account session required");
  const user = await accountCall("balance", req);
  must(typeof user.email === "string" && /^0x[0-9a-f]{40}$/i.test(user.address), "account service did not return an identity");
  return user;
}
async function owns(a: Rec, address: string) {
  const wallet = address.toLowerCase();
  if (a.registered_by?.toLowerCase() === wallet) return true;
  const custody = await custodyGet(a.agent_id);
  if (custody.operator?.toLowerCase() === wallet) return true;
  return (await cfg.operators(a.facts.key_id)).some(x => x.toLowerCase() === wallet);
}
const regionPolicies = (rs: Rec[]) => new Map(rs.filter(r => r.kind === "region_privacy").map(r => [r.agent_id, r]));
async function consoleApi(req: Request, path: string, ctx: Ctx) {
  if (["/api/console/login", "/api/console/verify"].includes(path)) {
    must(req.method === "POST", "POST required");
    const b = await jsonBody(req);
    return await accountCall(path.endsWith("/login") ? "login" : "verify", req,
      path.endsWith("/login") ? { email: b.email } : { challenge_id: b.challenge_id, code: b.code });
  }
  must(path === "/api/console/lines" || path === "/api/console/privacy", "unknown console endpoint");
  const user = await consoleAccount(req), rs = await records(ctx), st = await state(rs);
  const lines = (await Promise.all([...st.agents.values()].filter(a => !a.agent_id.startsWith("test-")).map(async a => await owns(a, user.address) ? a : null))).filter(Boolean) as Rec[];
  if (path === "/api/console/privacy") {
    must(req.method === "POST", "POST required");
    const b = await jsonBody(req);
    must(lines.some(a => a.agent_id === b.agent_id), "only the line owner can set region privacy");
    must(typeof b.show_state === "boolean", "show_state: boolean required");
    must(["home", "rented_exit", "vpn"].includes(b.connection_kind), "connection_kind: home, rented_exit or vpn");
    await append(ctx, { kind: "region_privacy", agent_id: b.agent_id, show_state: b.show_state, connection_kind: b.connection_kind });
    return { saved: true };
  }
  must(req.method === "GET", "GET required");
  await st.verify();
  // This endpoint alone returns full regions, after server-side ownership checks.
  return { email: user.email, address: user.address, lines: await Promise.all(lines.map(async a => ({ ...await allowed(a),
    appraisals: await Promise.all([...st.appraisals.values()].filter(p => p.agent_id === a.agent_id).map(appraisalView)),
    privacy: regionPolicies(rs).get(a.agent_id) ?? { show_state: false, connection_kind: a.coarse.residential ? "home" : "vpn" } }))) };
}

// The GETs that show a verdict (verification on agents, appraisals, bounty results or lease ends); every other route answers without one.
const VERIFIED: [RegExp, string][] = [/^\/api\/agents$/, /^\/api\/agents\/[^/]+\/appraisals$/, /^\/api\/appraisals\//, /^\/api\/bounties/, /^\/api\/leases/, /^\/api\/market$/]
  .map((x) => [x, "GET"]);
// Stored signed minion rows; posted_at is when the site received the row.
const minionRows = (rs: Rec[]) => rs.filter((r) => r.kind === "minion").map((r) => ({ ...JSON.parse(r.row_json), row_json: r.row_json, sig: r.sig, posted_at: r.at }));
async function api(req: Request, path: string, ctx: Ctx) {
  const url = new URL(req.url), rs = await records(ctx), { requests, appraisals, agents, bounties, leases, accounts, probeRequests, probes, anchors, verify } = await state(rs);
  if (VERIFIED.some((x) => x[1] === req.method && x[0].test(path))) await verify();
  const body = req.method === "POST" ? await jsonBody(req) : null;
  if (path === "/api/agents" && req.method === "GET") {
    const selected = url.searchParams.get("agent_id");
    return await Promise.all([...agents.values()].filter(a => selected === null || a.agent_id === selected).map(async a => {
      const row = await allowed(a);
      if (selected !== null) return row;
      const { guest_key, ...summary } = row;
      return { ...summary, ...(guest_key ? { guest_key_available: true } : {}) };
    }));
  }
  if (path === "/api/agents" && req.method === "POST") {
    const { agent_id, enc_pub, ca_cert, attestation, coarse, instructions, guest_key } = body;
    must(typeof agent_id === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(agent_id), "agent_id: 1-64 of [A-Za-z0-9._:-]");
    must(isHex(enc_pub, 32), "enc_pub: 32-byte lowercase hex X25519 key");
    must(ca_cert === undefined || isHex(ca_cert), "ca_cert: optional lowercase hex DER certificate");
    must(isHex(attestation), "attestation: lowercase hex VersionedAttestation");
    must(coarse && typeof coarse.region === "string" && typeof coarse.isp_class === "string" && typeof coarse.residential === "boolean", "coarse: {region, isp_class, residential:boolean}");
    must(instructions === undefined || typeof instructions === "string", "instructions: optional string");
    noIp(coarse, "coarse");
    // Only a verified registration is recorded (test- ids, which the stats and the scheduler leave out, also unverified, for the
    // smoke test). agent_id is a launch input, not measured: custody binds it to the operator its runner key is linked to at its
    // first state release, and a registration must come from a runner key linked to that operator (owners.ts), so a rotated
    // key of the same Mac's operator registers with no site change. A guest releases its state before it registers.
    const verification = await checked(attestation, await agentBinding(enc_pub, ca_cert ?? null));
    must(verification.ok || agent_id.startsWith("test-"), "registration attestation did not verify: " + verification.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; "));
    const custody = await custodyGet(agent_id), bound = custody.operator, key_id = verification.facts.key_id;
    if (bound === null ? !agent_id.startsWith("test-") : !(await cfg.operators(key_id)).includes(bound)) {
      throw new Conflict(bound ? `agent_id ${agent_id} is bound to operator ${bound}; runner key ${key_id} is not linked to it` : `custody has bound no operator to agent_id ${agent_id}: the guest takes its state before it registers`);
    }
    const proof = guest_key === undefined ? {} : { guest_key: await checkGuestKey(guest_key, verification, custody, [GUEST_ESCROW, PREVIOUS_GUEST_ESCROW], checked) };
    if (guest_key !== undefined) {
      const latest = await custodyGet(agent_id);
      must(latest.operator?.toLowerCase() === proof.guest_key.operator && (await cfg.operators(key_id)).some(x => x.toLowerCase() === proof.guest_key.operator), "guest_key: current operator ownership changed");
      must(latest.allowed?.manifests.includes(verification.facts.manifest_sha256) && latest.allowed?.os_image_hashes.includes(verification.facts.os_image_hash), "guest_key: current measurement changed");
    }
    const registered = req.headers.has("authorization") ? await consoleAccount(req) : null;
    // A public attestation can be replayed: an account session alone cannot claim its registration.
    if (registered) must(bound?.toLowerCase() === registered.address.toLowerCase() ||
      (await cfg.operators(key_id)).some(x => x.toLowerCase() === registered.address.toLowerCase()), "account wallet does not operate this registration");
    const registrar = registered?.address ?? rs.findLast(r => r.kind === "agent" && r.agent_id === agent_id)?.registered_by;
    const r = { kind: "agent", ...(registrar ? { registered_by: registrar } : {}), agent_id, enc_pub, ca_cert: ca_cert ?? null, attestation, ...proof, coarse: { region: coarse.region, isp_class: coarse.isp_class, residential: coarse.residential }, instructions: instructions ?? null };
    await leaseLock("agent:" + ctx.dataDir + ":" + agent_id, async () => {
      // All registrations share this narrow append lock. An old proof validation
      // must not overwrite a newer registration that arrived while it awaited checks.
      if (guest_key !== undefined) {
        const prior = rs.findLast(row => row.kind === "agent" && row.agent_id === agent_id);
        const latest = (await records(ctx)).findLast(row => row.kind === "agent" && row.agent_id === agent_id);
        if (latest !== prior) throw new Conflict("guest_key: registration changed during validation");
      }
      await append(ctx, r);
    });
    return await allowed({ ...r, verification });
  }
  const mr = path.match(/^\/api\/agents\/([A-Za-z0-9._:-]{1,64})\/appraisal-requests$/);
  if (mr && req.method === "POST") {
    must(agents.has(mr[1]), "agent_id: not registered");
    must(body.requested_by === undefined || (typeof body.requested_by === "string" && body.requested_by.length <= 200), "requested_by: optional string, at most 200 chars");
    noIp(body, "request");
    const r = { kind: "appraisal_request", id: crypto.randomUUID(), agent_id: mr[1], requested_by: body.requested_by ?? null };
    await append(ctx, r);
    return { ...r, at: new Date().toISOString(), status: "open" };
  }
  const ml0 = path.match(/^\/api\/(appraisal|probe)-requests$/);
  if (ml0 && req.method === "GET") {
    const id = url.searchParams.get("agent_id");
    if (ml0[1] === "probe" && id) polled.set(id, new Date().toISOString());
    return [...(ml0[1] === "probe" ? probeRequests : requests).values()].filter((r) => ["agent_id", "status"].every((k) => !url.searchParams.get(k) || r[k] === url.searchParams.get(k)));
  }
  const mq = path.match(/^\/api\/(appraisal|probe)-requests\/([0-9a-f-]{36})(\/failure)?$/);
  if (mq) {
    const rq = (mq[1] === "probe" ? probeRequests : requests).get(mq[2]);
    must(rq, `no such ${mq[1]} request`);
    if (!mq[3] && req.method === "GET") return rq;
    must(mq[3] && req.method === "POST", "POST /failure required");
    if (rq!.status !== "open") throw new Conflict(`${mq[1]} request is ${rq!.status}, not open`);
    must(typeof body.error === "string" && body.error.length <= 300, "error: string, at most 300 chars");
    noIp(body, "failure");
    const r = { kind: mq[1] + "_failure", request_id: rq!.id, agent_id: rq!.agent_id, error: body.error };
    await append(ctx, r);
    return { ...rq, status: "failed", error: body.error };
  }
  const mpr = path.match(/^\/api\/agents\/([A-Za-z0-9._:-]{1,64})\/probes$/);
  if (mpr && req.method === "POST") {
    const agent = agents.get(mpr[1]), { report, attestation } = body;
    must(agent, "agent_id: not registered");
    must(report?.kind === "probe" && report.agent_id === mpr[1], 'report: {kind: "probe", agent_id matching the URL, request_id, ...}');
    const rq = probeRequests.get(report.request_id);
    must(rq?.agent_id === mpr[1], "report.request_id: not a probe request of this agent");
    if (rq!.status !== "open") throw new Conflict(`probe request is ${rq!.status}, not open`);
    must(isHex(attestation), "attestation: lowercase hex VersionedAttestation");
    noIp(report, "report");
    const v = await checked(attestation, await binding(new TextEncoder().encode(canonical(report))), sameRun(agent!));
    must(v.ok, "probe attestation did not verify: " + v.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; "));
    const r = { kind: "probe", id: crypto.randomUUID(), agent_id: mpr[1], report, attestation, registration: sameRun(agent!), verification: v };
    await append(ctx, r);
    return { id: r.id, verification: v };
  }
  if (mpr && req.method === "GET") {
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
    must(limit === undefined || (Number.isInteger(limit) && limit > 0), "limit must be a positive integer");
    return [...probeRequests.values()].filter((q) => q.agent_id === mpr[1]).reverse().slice(0, limit).map((q) => probeRow(q, probes));
  }
  const mvp = path.match(/^\/api\/probes\/([0-9a-f-]{36})(\/verified)?$/);
  if (mvp && req.method === "GET") {
    const p = probes.get(mvp[1]);
    must(p, "no such probe");
    if (!mvp[2]) return p;
    const v = await checked(p!.attestation, await binding(new TextEncoder().encode(canonical(p!.report))), p!.registration);
    return { id: p!.id, agent_id: p!.agent_id, request_id: p!.report.request_id, ...(await verdict(p!.agent_id, v)), report: p!.report, attestation: p!.attestation };
  }
  if (path === "/api/probe-scheduler" && req.method === "GET") return { drand: DRAND, probe: PROBE, appraisal: APPRAISAL, requested_by: SCHEDULER, anchors: Object.fromEntries(anchors), last_polled: Object.fromEntries(polled), ...scheduler };
  const mp = path.match(/^\/api\/agents\/([A-Za-z0-9._:-]{1,64})\/appraisals$/);
  if (mp && req.method === "POST") {
    const agent = agents.get(mp[1]), { report, attestation } = body;
    must(agent, "agent_id: not registered");
    must(report?.kind === "appraisal" && report.agent_id === mp[1], 'report: {kind: "appraisal", agent_id matching the URL, request_id, ...}');
    const rq = requests.get(report.request_id);
    must(rq?.agent_id === mp[1], "report.request_id: not an appraisal request of this agent");
    if (rq!.status !== "open") throw new Conflict(`appraisal request is ${rq!.status}, not open`);
    must(isHex(attestation), "attestation: lowercase hex VersionedAttestation");
    noIp(report, "report");
    const v = await checked(attestation, await binding(new TextEncoder().encode(canonical(report))), sameRun(agent!));
    must(v.ok, "appraisal attestation did not verify: " + v.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; "));
    const r = { kind: "appraisal", id: crypto.randomUUID(), agent_id: mp[1], report, attestation, guest_escrow: agent!.guest_key?.escrow ?? PREVIOUS_GUEST_ESCROW.toLowerCase(), registration: sameRun(agent!) };
    await append(ctx, r);
    return { id: r.id, verification: v };
  }
  // Per-UTC-day totals of what holders were charged on this agent's accepted leases: per GB, on the day the lease ended; per hour
  // (leases decided before per-GB pricing), accruing until the end or paid_until. Day totals only: a per-lease amount stays private.
  const me = path.match(/^\/api\/agents\/([A-Za-z0-9._:-]{1,64})\/earnings$/);
  if (me && req.method === "GET") {
    must(agents.has(me[1]), "agent_id: not registered");
    const days: Record<string, number> = {};
    for (const l of leases.values()) {
      if (l.agent_id !== me[1] || l.decision?.decision !== "accept") continue;
      if (l.decision.price_per_gb) {
        if (l.end) days[l.end.at.slice(0, 10)] = (days[l.end.at.slice(0, 10)] ?? 0) + l.charged;
        continue;
      }
      const price = l.decision.price_per_hour, stop = Math.min(l.end ? Date.parse(l.end.at) : Date.now(), Date.parse(l.paid_until));
      for (let t = Date.parse(l.decision.at); t < stop; t = Math.floor(t / 86400e3 + 1) * 86400e3) {
        const day = new Date(t).toISOString().slice(0, 10);
        days[day] = (days[day] ?? 0) + (price * (Math.min(stop, Math.floor(t / 86400e3 + 1) * 86400e3) - t)) / HOUR;
      }
    }
    return { agent_id: me[1], unit: "staging cents (site ledger, not money)", days: Object.entries(days).sort().map(([day, cents]) => ({ day, cents })) };
  }
  // ?limit=N: the newest N, newest first (the amin's web_fetch reads one inline; the whole history is ~38 KB).
  if (mp && req.method === "GET") {
    const all = [...appraisals.values()].filter((p) => p.agent_id === mp[1]), n = url.searchParams.get("limit");
    if (n !== null) must(/^[1-9][0-9]?$/.test(n), "limit: 1 to 99");
    return await Promise.all((n === null ? all : all.slice(-Number(n)).reverse()).map(appraisalView));
  }
  const mv = path.match(/^\/api\/appraisals\/([0-9a-f-]{36})(\/verified)?$/);
  if (mv && req.method === "GET") {
    const p = appraisals.get(mv[1]);
    must(p, "no such appraisal");
    return mv[2] ? await appraisalView(p!) : p;
  }
  const ms = path.match(/^\/api\/leases\/([0-9a-f-]{36})\/statement$/);
  if (ms && req.method === "GET") {
    const l = leases.get(ms[1]);
    must(l, "no such lease");
    if (req.headers.has("authorization")) must(await bearer(req) === l!.account, "only the lease holder's account reads the full lease");
    return await leaseStatement(l!, req.headers.has("authorization"));
  }
  const q = url.searchParams;
  const filter = (xs: Rec[]) => xs.filter((b) => ["agent_id", "status", "buyer_key", "terms_hash", "account"].every((k) => !q.get(k) || b[k] === q.get(k)));
  if (path === "/api/bounties" && req.method === "GET") return filter([...bounties.values()]);
  if (path === "/api/bounties" && req.method === "POST") {
    const { agent_id, buyer_key, enc } = body;
    must(agents.has(agent_id), "agent_id: not registered");
    must(typeof buyer_key === "string" && buyer_key.length <= 200, "buyer_key: string");
    must(enc && isHex(enc.epk, 32) && isHex(enc.nonce, 12) && isHex(enc.ct) && enc.ct.length > 32, "enc: {epk:32B hex, nonce:12B hex, ct:hex}");
    const r = { kind: "bounty", id: crypto.randomUUID(), agent_id, buyer_key, enc: { epk: enc.epk, nonce: enc.nonce, ct: enc.ct }, enc_pub: agents.get(agent_id)!.enc_pub };
    await append(ctx, r);
    return r;
  }
  const mb = path.match(/^\/api\/bounties\/([0-9a-f-]{36})\/statement$/);
  if (mb && req.method === "GET") {
    const b = bounties.get(mb[1]);
    must(b, "no such bounty");
    return await bountyStatement(b!);
  }
  const m = path.match(/^\/api\/bounties\/([0-9a-f-]{36})(\/decision|\/result)?$/);
  if (m) {
    const b = bounties.get(m[1]);
    must(b, "no such bounty");
    if (!m[2] && req.method === "GET") return b;
    if (m[2] === "/decision" && req.method === "POST") {
      must(b!.status === "open", `bounty is ${b!.status}, not open`);
      const { decision, reason, quote, forecasts, policy_sha256 } = body;
      must(decision === "accept" || decision === "decline", 'decision: "accept" | "decline"');
      must(typeof reason === "string", "reason: string");
      must(quote === null || quote === undefined || Number.isInteger(quote), "quote: integer cents or null");
      must(policy_sha256 === null || policy_sha256 === undefined || isHex(policy_sha256, 32), "policy_sha256: 32-byte hex or null");
      noIp(body, "decision");
      const r = { kind: "decision", bounty_id: b!.id, agent_id: b!.agent_id, decision, reason, quote: quote ?? null, forecasts: forecasts ?? null, policy_sha256: policy_sha256 ?? null };
      const push = soukPush(ctx), st = await bountyStatement({ ...b!, decision: r, status: "declined" });
      await append(ctx, r);
      if (decision === "decline") push(st);
      return r;
    }
    if (m[2] === "/result" && req.method === "POST") {
      must(b!.status === "accepted", `bounty is ${b!.status}, not accepted`);
      const { result, attestation } = body;
      must(result && result.bounty_id === b!.id && Array.isArray(result.items), "result: {bounty_id matching the URL, items:[...], ...}");
      must(result.items.every((i: Rec) => i && typeof i === "object" && !Array.isArray(i)), "result.items: each item is an object");
      must(isHex(attestation), "attestation: lowercase hex VersionedAttestation");
      noIp(result, "result");
      const verification = await checked(attestation, await binding(new TextEncoder().encode(canonical(result))), sameRun(agents.get(b!.agent_id)!));
      // The statement is built before the record is written, so nothing after the write can fail the guest's POST.
      const r = { kind: "result", bounty_id: b!.id, agent_id: b!.agent_id, result, attestation }, push = soukPush(ctx);
      const st = await bountyStatement({ ...b!, result: { ...r, verification, at: new Date().toISOString() }, status: "done" });
      await append(ctx, r);
      push(st);
      return { ...r, verification };
    }
  }
  if (path === "/api/accounts/faucet" && req.method === "POST") {
    const account = await bearer(req), balance = accounts.get(account)?.balance ?? 0;
    must(balance < FAUCET_CAP, `staging faucet tops up only below ${FAUCET_CAP} cents; balance is ${balance.toFixed(2)}`);
    const r = { kind: "credit", account, amount: FAUCET, note: "staging faucet (not money)" };
    await append(ctx, r);
    return { ...r, balance: balance + FAUCET };
  }
  const ma = path.match(/^\/api\/accounts\/([0-9a-f]{64})$/);
  if (ma && req.method === "GET") {
    must(await bearer(req) === ma[1], "only the account's secret reads it");
    return accounts.get(ma[1]) ?? { account: ma[1], balance: 0, entries: [] };
  }
  if (path === "/api/leases" && req.method === "GET") return await Promise.all(filter([...leases.values()]).map(publicLease));
  if (path === "/api/leases" && req.method === "POST") {
    const account = await bearer(req), { agent_id, deposit, enc, exclusive, terms_hash } = body;
    must(agents.has(agent_id), "agent_id: not registered");
    must(typeof exclusive === "boolean", "exclusive: true (no other lease, bounty or appraisal on these domains) or false (shared)");
    must(body.admission || ctx.env?.REQUIRE_LEASE_ADMISSION !== "true", "new leases require wallet-bound token authorization; legacy sealed payloads cannot prove whose wallet they bill");
    if (!body.admission) {
      must(Number.isInteger(deposit) && deposit >= 1, "deposit: integer cents >= 1");
      must((accounts.get(account)?.balance ?? 0) >= deposit, "deposit exceeds the account's staging balance");
    }
    must(enc && isHex(enc.epk, 32) && isHex(enc.nonce, 12) && isHex(enc.ct) && enc.ct.length > 32, "enc: {epk:32B hex, nonce:12B hex, ct:hex}");
    // terms_hash: an escrow lease's GuestEscrow terms, buyer-claimed in the clear (already public on chain with the buyer's wallet).
    // The amin finds its deal's lease by this hash and the posting account (?account=, the id `resip account` prints), which
    // only the account secret's holder can post as; the guest bills against the copy sealed in enc, and its end statement signs that one.
    must(terms_hash === undefined || /^0x[0-9a-f]{64}$/.test(terms_hash), "terms_hash: optional 0x 32-byte lowercase hex");
    let token = {};
    if (body.admission) {
      const a = agents.get(agent_id)!;
      const verification = await cfg.verify(a.attestation, await agentBinding(a.enc_pub, a.ca_cert ?? null));
      const custody = await custodyGet(agent_id);
      must(verification.ok && custody.allowed?.manifests.includes(verification.facts.manifest_sha256) && custody.allowed?.os_image_hashes.includes(verification.facts.os_image_hash), "token admission: current guest measurement is not allowed");
      must(custody.operator === body.admission.operator && (await cfg.operators(verification.facts.key_id)).includes(custody.operator), "token admission: operator does not own this registration");
      token = await checkAdmission(body, account, { ...a, facts: verification.facts }, ctx.env?.LEASE_ADMISSION_SIGNER ?? ADMISSION_CONFIG.service_signer,
        () => admissionSnapshot(body.admission.wallet, body.admission.terms_hash, chain, body.admission.escrow));
      const latest = (await records(ctx)).findLast((r) => r.kind === "agent" && r.agent_id === agent_id);
      must(latest?.enc_pub === a.enc_pub && latest?.at === a.at && latest?.attestation === a.attestation, "token admission: registration changed during validation");
      must(body.admission.expires_at > Math.floor(Date.now() / 1000), "token admission: authorization expired before reservation");
      must(![...leases.values()].some((l) => l.admission && (l.admission.nonce === body.admission.nonce || l.admission.wallet === body.admission.wallet && l.terms_hash === terms_hash)), "token admission: nonce or terms already reserved");
    }
    const r = { kind: "lease", id: crypto.randomUUID(), agent_id, account, deposit, exclusive, ...token, ...(body.admission ? { admission: body.admission, admission_signature: body.signature } : {}), enc: { epk: enc.epk, nonce: enc.nonce, ct: enc.ct }, enc_pub: agents.get(agent_id)!.enc_pub,
      ...(terms_hash ? { terms_hash } : {}) };
    await append(ctx, r);
    return r;
  }
  const ml = path.match(/^\/api\/leases\/([0-9a-f-]{36})(\/decision|\/vantage|\/topup|\/end)?$/);
  if (ml) {
    const l = leases.get(ml[1]);
    must(l, "no such lease");
    if (!ml[2] && req.method === "GET" && !req.headers.has("authorization")) return await publicLease(l!);
    if (!ml[2] && req.method === "GET") {
      must(await bearer(req) === l!.account, "only the lease holder's account reads the full lease");
      return l;
    }
    must(req.method === "POST", "POST required");
    const base = { lease_id: l!.id, agent_id: l!.agent_id };
    if (ml[2] === "/decision") {
      must(l!.status === "open", `lease is ${l!.status}, not open`);
      const { decision, reason, price_per_gb, term_end, forecasts, policy_sha256 } = body;
      must(decision === "accept" || decision === "decline", 'decision: "accept" | "decline"');
      must(typeof reason === "string", "reason: string");
      must(decision === "decline" || (Number.isInteger(price_per_gb) && price_per_gb > 0 && !isNaN(Date.parse(term_end)) && isHex(policy_sha256, 32)),
        "accept needs price_per_gb (integer cents per 10^9 bytes > 0), term_end (ISO time), policy_sha256");
      noIp(body, "decision");
      if (l!.admission && decision === "accept") must(price_per_gb === l!.admission.price_per_gb && Date.parse(term_end) > Date.now() && Date.parse(term_end) <= Date.now() + 305000, "token admission: decision exceeds standing terms");
      const r = { kind: "lease_decision", ...base, decision, reason, price_per_gb: price_per_gb ?? null, term_end: term_end ?? null, forecasts: forecasts ?? null, policy_sha256: policy_sha256 ?? null };
      await append(ctx, r);
      return r;
    }
    if (ml[2] === "/vantage") {
      must(l!.status === "active", `lease is ${l!.status}, not active`);
      const { at, ip_commit, asn, same_ip, same_asn } = body;
      must(isHex(ip_commit, 32) && Number.isInteger(asn) && typeof same_ip === "boolean" && typeof same_asn === "boolean" && !isNaN(Date.parse(at)),
        "vantage: {at, ip_commit: 32-byte hex, asn: integer, same_ip, same_asn: booleans}");
      noIp(body, "vantage");
      const r = { kind: "lease_vantage", ...base, checked_at: at, ip_commit, asn, same_ip, same_asn };
      await append(ctx, r);
      return r;
    }
    if (ml[2] === "/topup") {
      const account = await bearer(req), { amount } = body;
      must(account === l!.account, "only the lease holder can top up");
      must(!l!.admission, "token leases cannot top up or extend their reserved cap");
      must(l!.status === "active", `lease is ${l!.status}, not active`);
      must(Number.isInteger(amount) && amount >= 1 && (accounts.get(account)?.balance ?? 0) >= amount, "amount: integer cents within the account's balance");
      const r = { kind: "lease_topup", ...base, amount };
      await append(ctx, r);
      return r;
    }
    if (ml[2] === "/end") {
      must(l!.status === "active", `lease is ${l!.status}, not active`);
      const { end_reason, statement, attestation, receipts_enc } = body;
      must(typeof end_reason === "string" && statement?.lease_id === l!.id && isHex(attestation), "end: {end_reason, statement for this lease, attestation, receipts_enc}");
      must(receipts_enc === null || (isHex(receipts_enc?.epk, 32) && isHex(receipts_enc?.nonce, 12) && isHex(receipts_enc?.ct)), "receipts_enc: sealed {epk, nonce, ct} or null");
      noIp(statement, "statement");
      const verification = await checked(attestation, await binding(new TextEncoder().encode(canonical(statement))), sameRun(agents.get(l!.agent_id)!));
      const r = { kind: "lease_end", ...base, end_reason, statement, attestation, receipts_enc };
      await append(ctx, r);
      return { ...r, verification };
    }
  }
  // The baseline-load minion's rows (layover minion/minion.py): one per paid use, signed by the minion's pinned key over
  // the exact row JSON. Rows never carry addresses (ip_commit only).
  if (path === "/api/minion/rows" && req.method === "POST") {
    const { row_json, sig } = body;
    must(typeof row_json === "string" && isHex(sig, 64), "row_json (a JSON string) and sig (ed25519, hex) required");
    const key = await crypto.subtle.importKey("raw", unhex(cfg.minionPub), { name: "Ed25519" }, false, ["verify"]);
    must(await crypto.subtle.verify("Ed25519", key, unhex(sig), new TextEncoder().encode(row_json)), "sig is not the minion's signature over row_json");
    const row = JSON.parse(row_json);
    must(typeof row.id === "string" && typeof row.agent_id === "string", "row needs id and agent_id");
    noIp(row, "row");
    if (minionRows(rs).some((r) => r.id === row.id)) return { id: row.id, duplicate: true };
    await append(ctx, { kind: "minion", row_json, sig });
    return { id: row.id };
  }
  if (path === "/api/minion/rows" && req.method === "GET") {
    return minionRows(rs).filter((r) => !url.searchParams.get("agent_id") || r.agent_id === url.searchParams.get("agent_id"));
  }
  if (path === "/api/couch-slots" && req.method === "GET") return await cachedSlots(ctx);
  if (path === "/api/broker-network" && req.method === "GET") return await upstream("broker /network", BROKER_NETWORK, 15000);
  if (path === "/api/stats/history" && req.method === "GET") return (await history(ctx)).filter((r) => Date.parse(r.t) > Date.now() - HISTORY_KEEP_MS);
  if (path === "/api/market" && req.method === "GET") return await cached("market " + ctx.dataDir, () => market(ctx, agents, appraisals, leases, bounties, probeRequests, probes));
  if (path === "/api/stats" && req.method === "GET") {
    const real = (id: string) => !id.startsWith("test-");
    const bs = [...bounties.values()].filter((b) => real(b.agent_id)), as = [...agents.values()].filter((a) => real(a.agent_id));
    const by: Record<string, Rec> = {};
    for (const a of as) by[a.coarse.isp_class] ??= { agents: 0, bounties: 0, accepted: 0, declined: 0, done: 0, expired: 0 };
    for (const a of as) by[a.coarse.isp_class].agents++;
    for (const b of bs) {
      const g = by[agents.get(b.agent_id)!.coarse.isp_class];
      g.bounties++;
      if (b.decision) g[b.decision.decision === "accept" ? "accepted" : "declined"]++;
      if (b.result) g.done++;
      if (b.expired) g.expired++;
    }
    const sum = (k: string) => Object.values(by).reduce((n, g) => n + g[k], 0);
    const ls = [...leases.values()].filter((l) => real(l.agent_id));
    return { agents: as.length, bounties: bs.length, accepted: sum("accepted"), declined: sum("declined"), done: sum("done"), expired: sum("expired"), by_isp_class: by,
      leases: { requested: ls.length, active: ls.filter((l) => l.status === "active").length, ended: ls.filter((l) => l.status === "ended").length, declined: ls.filter((l) => l.status === "declined").length,
        open: ls.filter((l) => l.status === "open").length, settled_cents: ls.filter((l) => l.status === "ended").reduce((n, l) => n + l.charged, 0) },
      starter_signups: await starterStats(ctx), excluded_test_agents: agents.size - as.length };
  }
  return null;
}

// The doorman: signs a stranger up to the IP souk by inviting their email with the member credential the site holds
// (SOUK_DOORMAN_CREDENTIAL, a member with both roles; the souk admits an invite only for roles the inviter holds).
// The souk's program pays a new buyer starter credit from the sponsors' pot when they first sign in.
export const SOUK_URL = "https://souk-dev.dstack.soc1024.com", SOUK_ID = "31f5c141-fb2d-4572-939a-68543a2d0649";
export const SIGNUP_LIMITS = { email: { n: 3, ms: 24 * HOUR }, ip: { n: 300, ms: HOUR } };
// Explicit deploy configuration; only mailbox limits are waived. IP and daily caps still apply.
const signupTestMailboxes = new Set(testMailboxes.map(normalizeStarterEmail));
const signups = { email: new Map<string, number[]>(), ip: new Map<string, number[]>() };
function limit(kind: "email" | "ip", key: string) {
  const { n, ms } = SIGNUP_LIMITS[kind], now = Date.now(), recent = (signups[kind].get(key) ?? []).filter((t) => t > now - ms);
  if (recent.length >= n) throw new Limited(`signup limit: ${n} per ${ms / HOUR} h per ${kind}; try again later`);
  signups[kind].set(key, [...recent, now]);
}
// Serialize durable reservations before inviting. Failed/uncertain invites consume capacity,
// since an upstream timeout may still have admitted the buyer. No raw emails enter the log.
let signupLane: Promise<unknown> = Promise.resolve();
const signupCaps = (ctx: Ctx) => ({ global: starterCap(ctx.env?.STARTERS_PER_DAY, 200), per_domain: starterCap(ctx.env?.STARTERS_PER_DOMAIN_PER_DAY, 20) });
async function starterStats(ctx: Ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await records(ctx)).filter((r) => r.kind === "starter_signup" && r.at.startsWith(today));
  return { ...signupCaps(ctx), used_today: rows.length, day: today, test_mailboxes: signupTestMailboxes.size };
}
function reserveSignup(ctx: Ctx, email: string, role: string) {
  const decision = signupLane.then(async () => {
    const normalized = normalizeStarterEmail(email), domain = normalized.split("@")[1];
    const digest = async (s: string) => hex(await sha256(new TextEncoder().encode(s)));
    const email_key = await digest(normalized), domain_key = await digest(domain);
    const rows = (await records(ctx)).filter((r) => r.kind === "starter_signup" || r.kind === "host_signup");
    if (!signupTestMailboxes.has(normalized) && rows.some((r) => r.email_key === email_key && r.role === role)) throw new Limited("signup limit: this mailbox has already been invited for this role");
    if (role === "buyer") {
      const today = new Date().toISOString().slice(0, 10), caps = signupCaps(ctx);
      const daily = rows.filter((r) => r.kind === "starter_signup" && r.at.startsWith(today));
      if (daily.length >= caps.global) throw new Limited("signup limit: daily starter cap reached");
      if (daily.filter((r) => r.domain_key === domain_key).length >= caps.per_domain) throw new Limited("signup limit: daily domain starter cap reached");
    }
    await append(ctx, { kind: role === "buyer" ? "starter_signup" : "host_signup", email_key, domain_key, role });
  });
  signupLane = decision.catch(() => {});
  return decision;
}
async function signup(req: Request, ctx: Ctx) {
  must(req.method === "POST", "POST required");
  const { email, role } = await jsonBody(req);
  must(typeof email === "string" && email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "email: an email address");
  must(role === "buyer" || role === "host", 'role: "buyer" (use hosts\' couches, connections and tools) or "host" (offer your Mac)');
  const token = ctx.env?.SOUK_DOORMAN_CREDENTIAL;
  if (!token) throw new Error("SOUK_DOORMAN_CREDENTIAL is not set in this deploy");
  // The webhost strips client-address headers unless its TRUSTED_PROXY_IPS names the front proxy, so without one every
  // request shares the "unattributed" bucket and the per-IP limit is a global one. The address is never written down.
  limit("ip", req.headers.get("x-real-ip") ?? "unattributed");
  if (!signupTestMailboxes.has(normalizeStarterEmail(email))) limit("email", normalizeStarterEmail(email));
  await reserveSignup(ctx, email, role);
  // souk-dev takes 6-15 s to answer an invite.
  const event = await upstream("souk invite", SOUK_URL + "/api/souk_invite", 60000, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ souk_id: SOUK_ID, email_or_person: email.trim(), roles: [role] }) });
  await append(ctx, { kind: "signup" }); // Count only; never persist contact details.
  return { invited: email.trim(), role, souk_id: SOUK_ID, event,
    next: `In the kit directory K, run \`python3 $K/account.py login ${email.trim()}\`; it mails a sign-in code. Ask your principal for the code and run the same command with the code appended. That signs them in to their Layover account and to the souk and pays the account's starter LAYC; then \`python3 $K/souk.py list\` shows the IP souk.${role === "buyer" ? " A new buyer is also paid souk starter credit at first sign-in." : ""}` };
}

// --- status board reads (status.html): souk-dev reachability and the Layover escrow on Base Sepolia. The token balance is read
// through a public RPC; Claimed events and paid totals come from layover-chain (Helios-verified reads on the pod).
// layover-chain serves logs only within the last 8191 blocks (~27 min at 200 ms a block), at most 200 blocks a call, so claims
// are indexed forward while the site is read: each read scans new blocks up to INDEX_MAX behind the verified head, and blocks
// it skips (nobody read the site for a while) are counted in missed_blocks. Each (buyer, terms) pair seen in a Claimed event is
// kept as an escrow_pair record, and its total comes from the escrow's claimed(buyer, terms), which holds all history.
export const ESCROW = { address: "0x8FF468c8E447f6cF70f05bEa1cEc1693eC0455cE", rpc: "https://sepolia.base.org" };
export const CHAIN = "https://pod.dstack.soc1024.com/layover-chain";
// Claimed(address indexed user, address indexed operator, bytes32 indexed termsHash, uint256 cumulativeOwed, uint64 period)
export const CLAIMED = "0x2efe0d5f05f64dd46ce04f78eb9a5f7553a7906f99fc51a94948e3390b879bba";
// GuestEscrow (dsmack PR #90, 220f6c1), paid in LAYC: Claimed(address indexed user, address indexed guestKey, bytes32 indexed termsHash,
// address operator, uint256 cumulativeOwed, uint256 amount), no period; a pair's total is totalClaimed(user, termsHash).
export const GUEST_ESCROW = "0xca184cFC10F55b67F8aFB42029D768eC6E6F36ad", LAYC = "0x9e851Bf5E3b613aaA09853A07D1132F49c90b515";
export const PREVIOUS_GUEST_ESCROW = "0xdf9bb576E30Ec71E200643AB6FC835Eee12C95EA";
export const GUEST_CLAIMED = "0x5ff05825c9fb9b33dad13f66f13d0b8cb6a7fd6add23709ff82de1f2e3b9994d";
// Per escrow: its layover-chain contract name, address, Claimed topic, where the operator is, and the pair-total function.
export const ESCROWS = [
  { contract: "escrow", address: ESCROW.address, token: "usdc", topic: CLAIMED, operator: (l: Rec) => l.topics[2], total: "claimed(address,bytes32)" },
  { contract: "guest_escrow", address: GUEST_ESCROW, token: "layc", topic: GUEST_CLAIMED, operator: (l: Rec) => l.data.slice(0, 66), total: "totalClaimed(address,bytes32)" },
  { contract: "guest_escrow_legacy", address: PREVIOUS_GUEST_ESCROW, token: "layc", topic: GUEST_CLAIMED, operator: (l: Rec) => l.data.slice(0, 66), total: "totalClaimed(address,bytes32)" },
];
export const LOG_SPAN = 200, INDEX_MAX = 2000;
const claims = { since: null as number | null, scanned_to: null as number | null, missed_blocks: 0, recent: [] as Rec[] };
// sepolia.base.org sometimes answers a read with result null: an RPC hiccup, not an answer, and returning it made escrow() trip
// over the null and answer 500. A read whose method always has a value is asked again a bounded number of times, then the null is
// refused as an upstream error. Sends are never retried: this site only reads. `until` is one deadline for a whole status read
// (escrow()'s serial eth_calls share it, since they hold chainLock and /api/market queues behind them): each fetch's timeout
// shrinks to the time left of it and a retry that would cross it is not made, so the worst case is the deadline, not
// RPC_TRIES × the 10 s timeout.
const NEVER_NULL = new Set(["eth_call", "eth_blockNumber", "eth_getBalance", "eth_getTransactionCount", "eth_getBlockByNumber", "eth_gasPrice", "eth_estimateGas", "eth_maxPriorityFeePerGas"]);
export const RPC_TRIES = 4, RPC_READ_MS = 20000;
async function rpc(url: string, method: string, params: unknown[], until = Number.POSITIVE_INFINITY) {
  for (let i = 1; ; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(Math.min(10000, Math.max(0, until - Date.now()))) })
      .catch((e) => { throw new Upstream(`${method} at ${url}: ${e.message}`); });
    const j = await r.json();
    if (j.error) throw new Upstream(`${method} at ${url}: ${j.error.message}`);
    if (j.result !== null && j.result !== undefined || !NEVER_NULL.has(method)) return j.result;
    if (i === RPC_TRIES) throw new Upstream(`${method} at ${url}: the RPC answered null ${i} times`);
    if (Date.now() + 500 * i >= until) throw new Upstream(`${method} at ${url}: the RPC keeps answering null and the status read's deadline passed`);
    await new Promise((x) => setTimeout(x, 500 * i));
  }
}
async function chain(path: string, q: Record<string, string>) {
  const u = `${CHAIN}${path}?${new URLSearchParams(q)}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) }).catch((e) => { throw new Upstream(`layover-chain ${u}: ${e.message}`); });
  const text = await r.text();
  if (!r.ok) throw new Upstream(`layover-chain ${u}: ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const word = (h: string, i: number) => BigInt("0x" + h.slice(2 + 64 * i, 66 + 64 * i));
// Pairs recorded before GuestEscrow was indexed carry no escrow field: they are UsageEscrow's. A pair counts once, whatever the log
// holds (records written before the chain lock could repeat one).
const escrowPairs = (rs: Rec[]) => {
  const seen = new Set<string>(), key = (r: Rec) => [r.escrow, r.user, r.terms_hash].join(" ");
  return rs.filter((r) => r.kind === "escrow_pair").map((r) => ({ escrow: "escrow", ...r, ...(r.escrow === "guest_escrow" && !r.escrow_address ? { escrow: "guest_escrow_legacy" } : {}) })).filter((r) => !seen.has(key(r)) && !!seen.add(key(r)));
};
// One chain answer per key at a time: a request waits for the one before it (so scans and escrow_pair appends never interleave),
// and an answer younger than cfg.chainCacheMs is reused. A failed answer is not kept.
const answers = new Map<string, { at: number; p: Promise<unknown> }>();
let chainLock: Promise<unknown> = Promise.resolve();
function cached<T>(key: string, f: () => Promise<T>): Promise<T> {
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < cfg.chainCacheMs) return hit.p as Promise<T>;
  const p = chainLock.catch(() => {}).then(f);
  chainLock = p;
  const entry = { at: Infinity, p };
  answers.set(key, entry);
  p.then(() => { entry.at = Date.now(); }, () => { if (answers.get(key) === entry) answers.delete(key); });
  return p;
}
async function scanClaims(ctx: Ctx) {
  const { head } = await chain("/head", {}), start = Math.max((claims.scanned_to ?? -Infinity) + 1, head - INDEX_MAX + 1);
  if (claims.scanned_to !== null) claims.missed_blocks += start - claims.scanned_to - 1;
  claims.since ??= start;
  const key = (e: string, user: string, terms: string) => [e, user, terms].join(" ");
  const known = new Set(escrowPairs(await records(ctx)).map((r) => key(r.escrow, r.user, r.terms_hash)));
  for (let from = start; from <= head; from += LOG_SPAN) {
    for (const e of ESCROWS) {
      const { logs } = await chain("/logs", { address: e.address, topics: e.topic, from: String(from), to: String(Math.min(head, from + LOG_SPAN - 1)) });
      for (const l of logs) {
        // GuestEscrow's data is (operator, cumulativeOwed, amount); UsageEscrow's is (cumulativeOwed, period).
        const guest = e.token === "layc", c = { escrow: e.contract, block: l.block, tx: l.tx, user: "0x" + l.topics[1].slice(26), operator: "0x" + e.operator(l).slice(26),
          terms_hash: l.topics[3], cumulative_owed: String(word(l.data, guest ? 1 : 0)), ...(guest ? { amount: String(word(l.data, 2)) } : { period: String(word(l.data, 1)) }) };
        claims.recent.push(c);
        if (!known.has(key(e.contract, c.user, c.terms_hash))) await append(ctx, { kind: "escrow_pair", escrow: e.contract, escrow_address: e.address, user: c.user, operator: c.operator, terms_hash: c.terms_hash, first_claim_block: c.block });
        known.add(key(e.contract, c.user, c.terms_hash));
      }
    }
    claims.scanned_to = Math.min(head, from + LOG_SPAN - 1);
  }
  claims.recent = claims.recent.slice(-50);
  return { since: claims.since, scanned_to: claims.scanned_to, missed_blocks: claims.missed_blocks };
}
// ABI topics from the origin GuestEscrow fixture. Only verified layover-chain logs are used.
export const ACTIVITY_TOPICS: Record<string, string> = {
  "0x2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c4": "deposit",
  "0x65f658cabb03ca311acb4c4795234c11045d3a8ac4356a37e109f519244350d5": "accept",
  [GUEST_CLAIMED]: "Claimed",
  "0x45daf3cb34d9f2cad28dd896eb772bb5066cfeab0bb395c494a5ebd524cbcf26": "close",
  "0xd1c19fbcd4551a5edfb66d43d2e337c04837afda3482b42bdf569a8fccdae5fb": "withdraw",
};
const activityRefresh = new Map<string, { pending: boolean; after: number }>();
function refreshActivity(ctx: Ctx) {
  const old = activityRefresh.get(ctx.dataDir);
  if (old && (old.pending || Date.now() < old.after)) return;
  const entry = { pending: true, after: 0 };
  activityRefresh.set(ctx.dataDir, entry);
  void scanActivity(ctx).catch(() => {}).finally(() => { entry.pending = false; entry.after = Date.now() + 10000; });
}
export async function scanActivity(ctx: Ctx) {
  const rs = await records(ctx), cursor = rs.filter(r => r.kind === "activity_cursor").at(-1)?.block;
  const { head } = await chain("/head", {});
  const known = new Set(rs.filter(r => r.kind === "escrow_activity").map(r => r.key));
  // Same bounded lookback as the existing Claimed index; missed history cannot be recovered by this reader.
  for (let from = Math.max((cursor ?? -Infinity) + 1, head - INDEX_MAX + 1); from <= head; from += LOG_SPAN) {
    const to = Math.min(head, from + LOG_SPAN - 1);
    for (const escrow of ESCROWS) {
      const topics = escrow.token === "layc" ? ACTIVITY_TOPICS : {
        ...Object.fromEntries(Object.entries(ACTIVITY_TOPICS).filter(([, event]) => !["Claimed", "withdraw"].includes(event))),
        [CLAIMED]: "Claimed",
        "0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5": "withdraw",
      };
      for (const [topic, event] of Object.entries(topics)) {
        const { logs } = await chain("/logs", { address: escrow.address, topics: topic, from: String(from), to: String(to) });
        for (const l of logs) {
          const key = [escrow.address, l.tx, topic, l.log_index ?? l.logIndex ?? l.data, ...(l.topics ?? [])].join(":");
          if (known.has(key)) continue;
          // Older chain readers omit event timestamps. In that case time is first observation, not an invented block time.
          const stamp = l.block_timestamp ?? l.timestamp;
          const time = typeof stamp === "number" ? new Date(stamp * 1000).toISOString() : undefined;
          await append(ctx, { kind: "escrow_activity", key, event, tx: l.tx, block: l.block, ...(time ? { time } : {}) });
          known.add(key);
        }
      }
    }
    await append(ctx, { kind: "activity_cursor", block: to });
  }
}
async function escrow(ctx: Ctx) {
  // The three serial reads share one deadline, RPC_READ_MS from now: they hold chainLock, and /api/market queues behind them.
  const until = Date.now() + RPC_READ_MS;
  const call = (to: string, data: string) => rpc(ESCROW.rpc, "eth_call", [{ to, data }, "latest"], until);
  const token = "0x" + (await call(ESCROW.address, "0xfc0c546a")).slice(26);
  const [balance, decimals] = [word(await call(token, "0x70a08231" + ESCROW.address.slice(2).toLowerCase().padStart(64, "0")), 0), word(await call(token, "0x313ce567"), 0)];
  const index = await scanClaims(ctx);
  return { ...ESCROW, chain: CHAIN, token, balance: String(balance), decimals: Number(decimals), last_claimed: claims.recent.at(-1) ?? null, claim_index: index };
}

// --- public market data (GET /api/market): what any reader, the amin included, weighs a price against. Per line: health (the
// registration's attestation and custody's allowed measurement), the latest appraisal, accepted leases and their per-GB prices,
// finished fetch jobs, when its guest last asked for probe requests (polled_at; it asks every 10 s while it runs, and this site's
// memory of it starts empty at each restart) and its newest finished probe. Per host address (a couch publisher or an escrow operator): couch slots, and per known (buyer, terms) pair
// paying it, the escrow's claimed() and claimPeriod() (layover-chain, Helios-verified): totals hold all history, but a pair is
// known only once the claim index has seen one of its Claimed events. Per minion target: a summary of the baseline-load minion's last 24 signed rows, if any.
// Owners' posted floors live in the souk's enrollment records, not on this site. Kept small: the souk host's web_fetch inlines 12k chars.
const real = (id: string) => !id.startsWith("test-");
async function market(ctx: Ctx, agents: Map<string, Rec>, appraisals: Map<string, Rec>, leases: Map<string, Rec>, bounties: Map<string, Rec>, probeRequests: Map<string, Rec>, probes: Map<string, Rec>) {
  const index = await scanClaims(ctx), rs = await records(ctx);
  const slots = await cachedSlots(ctx), hosts: Record<string, Rec> = {};
  const host = (a: string) => hosts[a] ??= { chip: null, online: null, slots: 0, ready: 0, claims: {} };
  const tally = (a: string, e: string) => host(a).claims[e] ??= { pairs: 0, paid: "0", recent: 0, last_block: null, ...(e === "escrow" ? { last_period: null } : {}) };
  for (const s of slots) {
    const h = host(s.publisher);
    Object.assign(h, { chip: s.chip, online: s.online, slots: h.slots + 1, ready: h.ready + (s.online && s.state === "ready" && s.verified ? 1 : 0) });
  }
  const read = (contract: string, fn: string, p: Rec) => chain("/read", { contract, fn, args: `${p.user},${p.terms_hash}` });
  const pairs = await Promise.all(escrowPairs(rs).map(async (p) => ({ ...p, claimed: await read(p.escrow, ESCROWS.find((e) => e.contract === p.escrow)!.total, p),
    period: p.escrow === "escrow" ? await read("escrow", "claimPeriod(address,bytes32)", p) : null })));
  for (const p of pairs) {
    const x = tally(p.operator, p.escrow);
    Object.assign(x, { pairs: x.pairs + 1, paid: String(BigInt(x.paid) + BigInt(p.claimed.value[0])) });
    if (p.period) x.last_period = x.last_period !== null && BigInt(x.last_period) > BigInt(p.period.value[0]) ? x.last_period : p.period.value[0];
  }
  for (const c of claims.recent) Object.assign(tally(c.operator, c.escrow), { recent: tally(c.operator, c.escrow).recent + 1, last_block: c.block });
  const grace = await chain("/read", { contract: "guest_escrow", fn: "CLAIM_GRACE()" });
  const lines = await Promise.all([...agents.values()].filter((a) => real(a.agent_id)).map(async (a) => {
    const p = [...appraisals.values()].filter((x) => x.agent_id === a.agent_id).at(-1), r = p?.report;
    const ls = [...leases.values()].filter((l) => l.agent_id === a.agent_id && l.decision?.decision === "accept"), last = ls.at(-1);
    const bs = [...bounties.values()].filter((b) => b.agent_id === a.agent_id && b.result), items = bs.flatMap((b) => b.result.result.items);
    const q = [...probeRequests.values()].findLast((q) => q.agent_id === a.agent_id && q.status !== "open"), pr = q && probeRow(q, probes);
    return { agent_id: a.agent_id, region: a.coarse.region, isp_class: a.coarse.isp_class, residential: a.coarse.residential, verified: (await allowed(a)).verification.ok,
      appraisal: r ? { at: r.at, pass: p.verification.ok, guest_version: r.guest_version, cgnat: r.cgnat, bandwidth_mbps: r.bandwidth_mbps } : null,
      leases: { accepted: ls.length, ended: ls.filter((l) => l.end).length, charged_cents: ls.reduce((n, l) => n + l.charged, 0),
        last: last ? { at: last.decision.at, price_per_gb: last.decision.price_per_gb ?? null, price_per_hour: last.decision.price_per_hour ?? null } : null },
      fetch_jobs: { done: bs.length, pages: items.length, served: items.filter((i: Rec) => i.status >= 200 && i.status < 300).length, last_at: bs.at(-1)?.result.at ?? null },
      polled_at: polled.get(a.agent_id) ?? null, probe: pr ? { at: pr.done_at, pass: pr.pass, error: pr.error } : null };
  }));
  const by: Record<string, Rec[]> = {};
  for (const r of minionRows(rs)) (by[r.agent_id] ??= []).push(r);
  const minion = Object.fromEntries(Object.entries(by).map(([id, all]) => {
    const xs = all.slice(-24), pages = xs.flatMap((x) => x.pages ?? []), n = (c: string) => pages.filter((p) => p.class === c).length;
    const commits = xs.filter((x) => x.ip_commit), cg = xs.findLast((x) => "cgnat" in x);
    return [id, { uses: xs.length, failed_paid_uses: xs.filter((x) => x.failed_paid_use).length, pages: pages.length, served: n("served"), thin: n("thin"),
      challenged: n("challenged"), blocked: n("blocked"), cgnat: cg?.cgnat ?? null, cgnat_method: cg?.cgnat_method ?? null,
      addresses: new Set(commits.map((x) => x.ip_commit)).size, address_measurements: commits.length, last_at: xs.at(-1).at ?? null }];
  }));
  return { at: new Date().toISOString(), sources: { site: "this site's records", couch: BROKER_FLEET, claims: `${CHAIN} /logs and /read (Helios-verified), Base Sepolia: escrow ${ESCROW.address}, guest_escrow ${GUEST_ESCROW}` },
    units: { charged_cents: "staging cents (site ledger, not money)", claims: "per escrow, its token's base units (6 decimals): escrow in USDC, guest_escrow in LAYC (1 LAYC = $1 = 100 credits)" },
    escrows: { escrow: { address: ESCROW.address, token: "USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      guest_escrow: { address: GUEST_ESCROW, token: "LAYC " + LAYC, claim_grace_s: Number(grace.value[0]), withdrawable: "balance minus exposure, at any time" } },
    claim_index: index, chain_block: pairs[0] ? { block: pairs[0].claimed.block, block_hash: pairs[0].claimed.block_hash } : null, lines, hosts, minion };
}
async function soukDev() {
  const t = performance.now(), ms = () => Math.round(performance.now() - t);
  try {
    const r = await fetch(SOUK_URL + "/", { signal: AbortSignal.timeout(5000) });
    await r.body?.cancel();
    return { url: SOUK_URL + "/", up: r.ok, status: r.status, ms: ms() };
  } catch (e) {
    return { url: SOUK_URL + "/", up: false, error: (e as Error).message, ms: ms() };
  }
}

// A decided or done bounty's statement goes to the IP souk as the doorman's `statement` message: the souk's program settles
// the fetch job in that step, without waiting for a model run to poll the statement. The guest's
// POST does not wait for the souk (a program step there takes seconds); a failed push is logged, and the amin's poll still reads it.
export function soukPush(ctx: Ctx) {
  const token = ctx.env?.SOUK_DOORMAN_CREDENTIAL;
  if (!token) throw new Error("SOUK_DOORMAN_CREDENTIAL is not set in this deploy");
  return (st: Rec) => fetch(SOUK_URL + "/api/souk_send", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ souk_id: SOUK_ID, kind: "statement", text: JSON.stringify(st) }) })
    .then(async (r) => r.ok ? console.log(`souk: pushed bounty ${st.bounty_id} (${st.status})`) : console.error(`souk: push of bounty ${st.bounty_id} failed (${r.status}): ${await r.text()}`))
    .catch((e) => console.error(`souk: push of bounty ${st.bounty_id} failed: ${e.message}`));
}

// References about hosts, from the IP souk. The souk has no public read, so the doorman member subscribes once (a `references`
// message) and the souk's program replies every reference about a host to it, now and as each is recorded; this reads them
// from the doorman's inbox. The author is not in them. Cached 30 s: provider.html polls every 10 s.
let refCache: { at: number; rows: Rec[] } | null = null;
async function references(req: Request, ctx: Ctx) {
  must(req.method === "GET", "GET required");
  const token = ctx.env?.SOUK_DOORMAN_CREDENTIAL;
  if (!token) throw new Upstream("references unavailable: SOUK_DOORMAN_CREDENTIAL is not set in this deploy");
  if (!refCache || Date.now() - refCache.at > 30e3) {
    const inbox = await upstream("souk inbox", SOUK_URL + "/api/souk_inbox", 60000, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ souk_id: SOUK_ID }) });
    const out = inbox.filter((x: Rec) => x.kind === "Output").map((x: Rec) => x.payload.text as string);
    if (!out.includes("references subscribed")) throw new Upstream('the doorman member is not subscribed to references: send it kind "references" in the souk once');
    const byDeal = new Map(out.filter((t) => t.startsWith("reference ")).map((t) => JSON.parse(t.slice(10))).map((x: Rec) => [x.deal, x]));
    refCache = { at: Date.now(), rows: [...byDeal.values()].reverse() };
  }
  const subject = new URL(req.url).searchParams.get("subject")?.toLowerCase();
  return refCache.rows.filter((x) => !subject || x.subject.toLowerCase() === subject);
}


const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json; charset=utf-8" };
const md = "text/markdown; charset=utf-8", js = "text/javascript; charset=utf-8", py = "text/x-python; charset=utf-8", json = "application/json; charset=utf-8";
// The kit files the site serves; couch/dsmack/preflight.py (main) checks every kit file of main's couch/ is listed.
export const kit: Record<string, string> = { "kit/index.txt": "text/plain; charset=utf-8", "kit/SKILL.md": md, "kit/souk.py": py, "kit/account.py": py, "kit/resip.js": js, "kit/layover.js": js, "kit/feed.py": py, "kit/first_fetch.py": py, "kit/fetch.py": py,
  "kit/couch/SKILL.md": md, "kit/couch/mcp.mjs": js, "kit/couch/stay.mjs": js, "kit/couch/chain.mjs": js, "kit/couch/session.mjs": js, "kit/couch/tools.json": json, "kit/couch/package.json": json, "kit/couch/package-lock.json": json,
  ...Object.fromEntries(["binding.mjs", "encoding.mjs", "enrollment.mjs", "payments.mjs", "policy.mjs", "registry.mjs", "sandbox.mjs", "owners.mjs"].map((f) => ["kit/couch/dsmack/" + f, js])),
  "kit/couch/dsmack/registry.json": json, "kit/couch/browser-setup.sh": "text/x-shellscript; charset=utf-8", "kit/couch/dsmack/sandbox-policy.json": json };
// layover.js is the line client under its Layover name; resip.js stays for installs that use the old name.
const alias: Record<string, string> = { "kit/layover.js": "kit/resip.js" };
async function publicResponse(out: unknown, ctx: Ctx) {
  const rs = await records(ctx);
  return publicRegions(out, new Map(rs.filter(r => r.kind === "agent").map(r => [r.agent_id, r])), regionPolicies(rs));
}
export async function handler(req: Request, ctx: Ctx) {
  must(ctx?.dataDir, "webhost must provide a persistent dataDir");
  const path = new URL(req.url).pathname;
  if (path.startsWith("/api/")) {
    try {
      if (path === "/api/activity") {
        must(req.method === "GET", "GET required");
        // Refresh in the background: a slow chain reader must not stall the dashboard.
        refreshActivity(ctx);
        return Response.json(await publicResponse(activity(await records(ctx)), ctx), { headers: { "cache-control": "no-store" } });
      }
      if (path.startsWith("/api/console/")) return Response.json(await consoleApi(req, path, ctx), { headers: { "cache-control": "no-store" } });
      if (path === "/api/signup") return Response.json(await signup(req, ctx), { headers: { "cache-control": "no-store" } });
      if (path === "/api/status/souk-dev") return Response.json(await soukDev(), { headers: { "cache-control": "no-store" } });
      if (path === "/api/status/escrow") return Response.json(await cached("escrow " + ctx.dataDir, () => escrow(ctx)), { headers: { "cache-control": "no-store" } });
      if (path === "/api/references") return Response.json(await references(req, ctx), { headers: { "cache-control": "no-store" } });
      if (path.startsWith("/api/relay/")) return await relay(req, path, async () => (await state(await records(ctx))).agents);
      warmSoon(ctx);
      const out = path === "/api/leases" && req.method === "POST" ? await leaseLock(ctx.dataDir, () => api(req, path, ctx)) : await api(req, path, ctx), headers = { "cache-control": "no-store" };
      tickSoon(ctx);
      return out === null ? Response.json({ error: "not found" }, { status: 404, headers }) : Response.json(await publicResponse(out, ctx), { headers });
    } catch (e) {
      if (e instanceof Bad || e instanceof SyntaxError) return Response.json({ error: e.message }, { status: e instanceof Conflict ? 409 : e instanceof Limited ? 429 : e instanceof Upstream ? 502 : 400 });
      throw e;
    }
  }
  const retired: Record<string, string> = { "index.html": "layover.html", "deals.html": "dashboard.html#deals-tools", "supplier.html": "provider.html", "public.html": "dashboard.html", "leases.html": "dashboard.html#lease-statements" };
  const target = retired[path.slice(1)];
  if (target) {
    const [page, fragment] = target.split("#"), query = new URL(req.url).search;
    return new Response(null, { status: 302, headers: { location: page + query + (fragment ? "#" + fragment : ""), "cache-control": "no-store" } });
  }
  const file = path === "/" ? "layover.html" : path === "/kit" || path === "/kit/" ? "kit/index.txt" : path.slice(1);
  if (!["layover.html", "provider.html", "dashboard.html", "status.html", "style.css", "common.js", "roadmap.json"].includes(file) && !kit[file]) return new Response("not found", { status: 404 });
  try {
    return new Response(await Deno.readFile(new URL("./static/" + (alias[file] ?? file), import.meta.url)), { headers: { "content-type": kit[file] ?? types[file.split(".")[1]], "cache-control": "no-cache" } });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
    throw e;
  }
}
export default handler;

// Start both reads without holding up the listener. Use the API path so verification
// and chain indexing populate exactly the caches that the first buyer will read.
export async function warmCaches(ctx: Ctx) {
  await Promise.all(["couch-slots", "market"].map(async (name) => {
    try { await api(new Request("http://startup/api/" + name), "/api/" + name, ctx); }
    catch (e) { console.error(name + " startup warm-up failed", e); }
  }));
}

if (import.meta.main) {
  const [port, dataDir] = Deno.args;
  // The dashboard's minute series samples on a timer, so history accrues with or without traffic (tests import this module
  // and call sampleHistory themselves; a request-hook would fetch the broker from every test's handler call).
  setInterval(() => sampleSoon({ dataDir, env: Deno.env.toObject() }), HISTORY_EVERY_MS);
  void warmCaches({ dataDir, env: Deno.env.toObject() });
  Deno.serve({ port: Number(port) }, (req) => handler(req, { dataDir, env: Deno.env.toObject() }));
}

// Serialize validation and the single append that consumes nonce + reserves its entire terms pair.
// The site's append-only log has one writer process per dataDir.
const leaseLocks = new Map<string, Promise<unknown>>();
async function leaseLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const prior = leaseLocks.get(directory) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(action);
  leaseLocks.set(directory, next);
  try { return await next; } finally { if (leaseLocks.get(directory) === next) leaseLocks.delete(directory); }
}

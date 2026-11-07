// Appraisal of the line on request: line facts, a drand beacon round, challenge rates on five homepages and a timed
// download, all through one egress-policy gateway, signed with /v1/Attest. Schema: notes/appraisal-schema.md on main.
// A probe is the light check the site schedules about once an hour (notes/qa-probes.md): drand, the network operator, the IP
// commitment against the previous probe's, and one homepage each from two sites, through its own gateway with the same upstream.
import fs from "node:fs";
import { AGENT_ID, FETCH_HEADERS, OUT, attest, budgetLeft, canonical, env, hex, num, log, operator, post, record, runGateway, sha256, spend, traceRule, vantage, viaGateway } from "./core.mjs";
import { reservedBy } from "./lease.mjs";

export const VERSION = env("GUEST_VERSION"), MIN_MS = num("APPRAISAL_MIN_SECONDS") * 1000;
// drand (League of Entropy) default chain, 30 s rounds. IPRoyal refuses beacon.nist.gov and www.linkedin.com at CONNECT.
export const DRAND_CHAIN = "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce", BEACON = `https://api.drand.sh/${DRAND_CHAIN}/public/latest`;
export const SITES = ["www.google.com", "www.amazon.com", "www.reddit.com", "www.zillow.com", "www.nytimes.com"];
export const SPEED_BYTES = 4_000_000, SPEED = `https://speed.cloudflare.com/__down?bytes=${SPEED_BYTES}`;
// Cloudflare's challenge page loads challenge-platform/h/.../orchestrate and sets _cf_chl_opt; its bot-management script
// (challenge-platform/scripts/jsd) is on ordinary pages too, so it is not a marker.
const MARKERS = /captcha-delivery\.com|challenge-platform\/h\/|_cf_chl_opt|cf-chl|_Incapsula_Resource|px-captcha|g-recaptcha|hcaptcha|Just a moment\.\.\.|namedItem\("solution"\)/i;
// AWS WAF answers a challenge with 202 and an empty body (its x-amzn-waf-action header does not pass the gateway).
export const isChallenge = (status, body) => (status === 202 && body.length === 0) || MARKERS.test(body.toString("latin1"));

export const PROBE_SITES = ["www.walmart.com", "www.indeed.com"];
const rule = (name, paths, bytes, query = false, headers = FETCH_HEADERS) => ({ name, port: 443, methods: ["GET"], paths, query, headers, drop_credentials: true,
  max_request_bytes: 4096, max_response_bytes: bytes, upload_bytes: 4096, download_bytes: bytes, requests: 1, requests_per_minute: 1 });
// The gateway caps one response at 4 MiB, headers included.
export const policy = (sites) => ({ rules: [rule(new URL(BEACON).hostname, [new URL(BEACON).pathname], 1 << 16), ...sites.map((s) => rule(s, ["/"], 4 << 20)),
  rule(new URL(SPEED).hostname, ["/__down"], 4 << 20, true), traceRule(1)] });

export const probePolicy = () => ({ rules: [rule(new URL(BEACON).hostname, [new URL(BEACON).pathname], 1 << 16), rule("ipinfo.io", ["/json"], 1 << 16, false, {}),
  rule("dns.google", ["/resolve"], 1 << 16, true, { Accept: "application/dns-json" }), ...PROBE_SITES.map((s) => rule(s, ["/"], 2 << 20))] });

// One GET through the gateway, logged like a bounty fetch. A response without a certificate is the gateway's own refusal: an error.
async function get(listen, url, kind = "appraisal") {
  const u = new URL(url), t = performance.now(), r = await viaGateway(listen, u), ms = Math.round(performance.now() - t);
  spend(r.body.length);
  record({ kind: "request", [kind]: true, host: u.hostname, method: "GET", url, status: r.status, body_sha256: hex(sha256(r.body)), bytes: r.body.length, cert_sha256: r.cert });
  if (!r.cert) throw new Error(`${kind}: the gateway refused ${url}: ${r.status} ${r.body.toString().slice(0, 200)}`);
  return { ...r, ms };
}
const ok200 = (r, url) => { if (r.status !== 200) throw new Error(`${new URL(url).hostname} ${r.status}: ${r.body.toString().slice(0, 200)}`); return r; };
const beaconOf = (b) => { const round = JSON.parse(b.body); return { round: round.round, randomness_sha256: hex(sha256(Buffer.from(round.randomness, "hex"))) }; };

export async function appraise(line, salt, requestId) {
  // Probing a leased host would break the lease's exclusivity. The error is public, so it names no host.
  if ([BEACON, SPEED, ...SITES.map((s) => "https://" + s)].some((u) => reservedBy(new URL(u).hostname))) throw new Error("an appraisal host is reserved by an active lease");
  const gw = await runGateway(policy(SITES));
  try { return await measure(gw, line, salt, requestId); } finally { await gw.stop(); }
}
async function measure(gw, line, salt, requestId) {
  const v = await vantage(gw.listen, salt);
  if (!v.same_ip || !v.same_asn) throw new Error("appraisal: the trace through the gateway did not see the line's address and ASN");
  const b = await get(gw.listen, BEACON);
  if (b.status !== 200) throw new Error(`drand beacon ${b.status}: ${b.body.toString().slice(0, 200)}`);
  const challenges = [];
  for (const site of SITES) {
    const r = await get(gw.listen, `https://${site}/`);
    challenges.push({ site, status: r.status, challenge: isChallenge(r.status, r.body) });
  }
  const d = await get(gw.listen, SPEED);
  if (d.status !== 200 || d.body.length !== SPEED_BYTES) throw new Error(`speed download ${d.status}, ${d.body.length} bytes`);
  return { kind: "appraisal", request_id: requestId, agent_id: AGENT_ID, at: new Date().toISOString(), guest_version: VERSION, ip_commit: v.ip_commit, asn: line.asn,
    isp_class: line.isp_class, region: line.region, residential: line.residential, cgnat: "not_checked",
    beacon: { ...beaconOf(b), cert_sha256: b.cert, ms: b.ms },
    challenges, bandwidth_mbps: Math.round(SPEED_BYTES * 8 / d.ms / 1000) };
}

// prev: the previous probe's ip_commit (sealed state), so same_ip_as_last compares addresses without holding one.
export async function probe(salt, prev, requestId) {
  if ([BEACON, "https://ipinfo.io", "https://dns.google", ...PROBE_SITES.map((s) => "https://" + s)].some((u) => reservedBy(new URL(u).hostname))) throw new Error("a probe host is reserved by an active lease");
  const gw = await runGateway(probePolicy());
  try {
    let bytes = 0;
    const g = async (url) => { const r = await get(gw.listen, url, "probe"); bytes += r.body.length; return r; };
    const b = ok200(await g(BEACON), BEACON), op = await operator(async (u) => JSON.parse(ok200(await g(u), u).body), salt), sites = [];
    for (const site of PROBE_SITES) {
      const r = await g(`https://${site}/`);
      sites.push({ site, status: r.status, challenge: isChallenge(r.status, r.body) });
    }
    return { kind: "probe", request_id: requestId, agent_id: AGENT_ID, at: new Date().toISOString(), guest_version: VERSION, beacon: beaconOf(b), asn: op.asn,
      isp_class: op.isp_class, residential: op.residential, ip_commit: op.ip_commit, same_ip_as_last: prev === null ? null : op.ip_commit === prev, sites, bytes };
  } finally { await gw.stop(); }
}

// report_data = sha256(canonical(report)) || 0^32, as for bounty results.
export const sign = (report) => attest(sha256(canonical(report)));
export async function submit(report) {
  const attestation = await sign(report);
  const reply = await post(`/api/agents/${encodeURIComponent(AGENT_ID)}/${report.kind}s`, { report, attestation });
  if (!reply.id) throw new Error(`${report.kind} POST returned no id: ` + JSON.stringify(reply).slice(0, 300));
  record({ kind: report.kind, request: report.request_id, report_sha256: hex(sha256(canonical(report))), id: reply.id });
  return { attestation, reply };
}

// One open request from the poll loop. A failure belongs to this request: it goes into the log and to the site as the
// request's failure, and lease serving goes on. If posting the failure fails too, that propagates and the run exits.
let last = 0;
export async function serveRequest(q, line, salt) {
  try {
    if (Date.now() - last < MIN_MS) throw new Error(`one appraisal per ${MIN_MS / 1000} s; the last started at ${new Date(last).toISOString()}`);
    if (budgetLeft() < 6e6) throw new Error("the daily volume budget is spent");
    last = Date.now();
    const report = await appraise(line, salt, q.id), signed = await submit(report);
    fs.appendFileSync(OUT + "/appraisal", JSON.stringify({ report, ...signed }) + "\n");
    log("appraisal", q.id, JSON.stringify(signed.reply), canonical(report));
  } catch (e) {
    log("appraisal", q.id, "failed:", e.stack);
    record({ kind: "appraisal_failed", request: q.id, error: e.message.slice(0, 300) });
    await post(`/api/appraisal-requests/${q.id}/failure`, { error: e.message.slice(0, 300) });
  }
}

// A probe request from the poll loop, failing like an appraisal request. ps.last is the last probe's ip_commit, kept in the sealed state.
export async function serveProbe(q, salt, ps) {
  try {
    if (budgetLeft() < 5 << 20) throw new Error("the daily volume budget is spent");
    const report = await probe(salt, ps.last, q.id), signed = await submit(report);
    ps.last = report.ip_commit;
    fs.appendFileSync(OUT + "/probe", JSON.stringify({ report, ...signed }) + "\n");
    log("probe", q.id, JSON.stringify(signed.reply), canonical(report));
  } catch (e) {
    if (expired(e)) return log("probe", q.id, "expired before its report was posted");
    log("probe", q.id, "failed:", e.stack);
    record({ kind: "probe_failed", request: q.id, error: e.message.slice(0, 300) });
    try { await post(`/api/probe-requests/${q.id}/failure`, { error: e.message.slice(0, 300) }); }
    catch (f) { if (!expired(f)) throw f; log("probe", q.id, "expired before its failure was posted"); }
  }
}
// The site expires a probe request 10 minutes after filing; a report or failure posted later gets exactly this 409.
const expired = (e) => e.status === 409 && e.body === JSON.stringify({ error: "probe request is expired, not open" });

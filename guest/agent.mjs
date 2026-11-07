// resip guest: register an attested X25519 key and proxy CA, poll sealed bounties and lease requests, let the
// delegate decide, fetch through the egress-policy gateway, serve leased proxy streams, post signed results.
import crypto from "node:crypto";
import fs from "node:fs";
import { AGENT_ID, FETCH_HEADERS, INSTRUCTIONS, LIFETIME_MS, MAX_RESPONSE, OUT, POLL_MS, TRACE, BASE, attest, budget, budgetLeft,
  canonical, chain, complete, directEgress, firstJson, controlReady, gatewayUp, hex, json, lineFacts, log, modelId, post, record, runGateway, sha256, spend, traceRule, vantage,
  useWallet, viaGateway, wallet, useClaimer, claimer, claimManifest, savedClaimIdentity, claimHistory, attestedManifest, guestClaims, addressWord, GUEST_ESCROW, OPERATOR, x25519Raw, SYSTEM, openSealed, ESCROW } from "./core.mjs";
import { exportLeases, reservedBy, makeCA, pollLeases, prepareLeases, resumeLeases, serveRelay, useSave } from "./lease.mjs";
import { commit, restore, restoreExisting, custodySnapshot } from "./state.mjs";
import { drainPreflight } from "./drain-preflight.mjs";
import { serveProbe, serveRequest } from "./appraise.mjs";
import { attestBountyAction } from "./guest-action.mjs";

export { canonical };

// --- deterministic pre-check, before any model call ---
export function precheck(b) {
  if (b.method !== "GET") return "only GET is allowed";
  if (!Array.isArray(b.urls) || b.urls.length === 0) return "no URLs";
  if (!Number.isInteger(b.max_requests) || b.max_requests < b.urls.length) return "max_requests is below the URL count";
  if (b.max_requests > 50) return "more than 50 requests in one bounty";
  for (const u of b.urls) {
    const p = new URL(u);
    if (p.protocol !== "https:" || p.port || p.username || p.hash) return "URLs must be https with no port, credentials or fragment";
    const lease = reservedBy(p.hostname);
    // The reason is public: it names no host, so it does not say which domain is leased.
    if (lease) return `URL ${b.urls.indexOf(u) + 1}'s host is reserved by an active lease until ${lease.until}`;
  }
  if (!(Date.parse(b.deliver_by) > Date.now())) return "deliver_by has passed";
  if (b.max_requests * MAX_RESPONSE > budgetLeft()) return "would exceed the daily volume budget";
  return null;
}

const SCHEMA = `Reply with one JSON object and nothing else:
{"decision":"accept"|"decline","reason":"one sentence for the buyer","quote":<integer US cents, at most max_price_cents; null if declining>,
 "forecasts":{"captcha":<0..1>,"proxy_tag":<0..1>,"blocklist":<0..1>,"isp_notice":<0..1>},
 "rules":[{"host":"<one of the bounty hosts>","paths":["<exact paths from the bounty>"],"requests":<int>,"requests_per_minute":<int>}]}
forecasts are your probabilities that this job causes each incident on this line within 30 days.
rules list exactly the hosts and paths you allow; empty when declining.`;
export async function delegate(b, line) {
  const urls = b.urls.map((u) => new URL(u));
  const job = { task_description_untrusted: b.task, hosts: [...new Set(urls.map((u) => u.hostname))],
    urls: urls.map((u) => ({ host: u.hostname, path: u.pathname })), method: b.method, max_requests: b.max_requests,
    deliver_by: b.deliver_by, max_price_cents: b.max_price };
  const raw = await complete(SYSTEM("fetch jobs") + SCHEMA, JSON.stringify({ line: { region: line.region, isp_class: line.isp_class, residential: line.residential }, job }));
  const d = firstJson(raw);
  if (!["accept", "decline"].includes(d.decision)) throw new Error("delegate returned no decision: " + raw.slice(0, 200));
  return d;
}

// Rules may only narrow the bounty: every host/path must be one the bounty named.
export function compile(b, rules) {
  const allowed = new Set(b.urls.map((u) => { const p = new URL(u); return p.hostname + p.pathname; }));
  const byHost = new Map();
  for (const r of rules) for (const p of r.paths) {
    if (!allowed.has(r.host + p)) throw new Error(`delegate rule ${r.host}${p} is not in the bounty`);
    byHost.set(r.host, [...new Set([...(byHost.get(r.host) ?? []), p])]);
  }
  const n = (h) => Math.min(b.max_requests, rules.filter((r) => r.host === h).reduce((s, r) => s + r.requests, 0));
  const query = (h) => b.urls.some((u) => { const p = new URL(u); return p.hostname === h && p.search; });
  if (byHost.has(new URL(TRACE).hostname)) throw new Error("bounty host collides with the vantage-check host");
  return { rules: [...[...byHost].map(([host, paths]) => ({ name: host, port: 443, methods: ["GET"], paths: paths.sort(),
    query: query(host), headers: FETCH_HEADERS, drop_credentials: true,
    max_request_bytes: 4096, max_response_bytes: MAX_RESPONSE, upload_bytes: 4096 * n(host), download_bytes: MAX_RESPONSE * n(host),
    requests: n(host), requests_per_minute: Math.max(1, Math.min(...rules.filter((r) => r.host === host).map((r) => r.requests_per_minute))) })),
    traceRule(1)] };
}

export async function fetchAll(id, b, policy) {
  const gw = await runGateway(policy), items = [];
  const v = await vantage(gw.listen);
  record({ kind: "vantage", bounty: id, same_ip: v.same_ip, asn: v.asn, same_asn: v.same_asn });
  if (!v.same_ip || !v.same_asn) throw new Error("vantage check through the gateway did not see the line's address and ASN");
  for (const s of b.urls) {
    const u = new URL(s), r = await viaGateway(gw.listen, u);
    spend(r.body.length);
    const item = { url: s, status: r.status, sha256: hex(sha256(r.body)), bytes: r.body.length, cert_sha256: r.cert, fetched_at: new Date().toISOString() };
    record({ kind: "request", bounty: id, host: u.hostname, method: "GET", url: s, status: r.status, body_sha256: item.sha256, cert_sha256: r.cert, bytes_up: r.up, bytes_down: r.down });
    items.push(item);
  }
  return { items, audit: await gw.stop() };
}

const bountyPost = async (id, action, payload) => post(`/api/bounties/${id}/${action}`,
  await attestBountyAction({ audience: BASE, agentId: AGENT_ID, bountyId: id, action, payload }, attest));
const decline = (id, reason, forecasts = null) => bountyPost(id, "decision", { decision: "decline", reason, quote: null, forecasts, policy_sha256: null });
async function handle(b, priv, encPubHex, line) {
  if (b.enc_pub !== encPubHex) return decline(b.id, "sealed to an earlier key of this agent");
  const bounty = openSealed(priv, b.enc);
  const refused = precheck(bounty);
  if (refused) {
    record({ kind: "refused", bounty: b.id, hosts: [...new Set(bounty.urls.map((u) => new URL(u).hostname))], reason: refused });
    return decline(b.id, "pre-check: " + refused);
  }
  const d = await delegate(bounty, line);
  log("delegate", b.id, d.decision, d.reason);
  if (d.decision === "decline") return decline(b.id, d.reason, d.forecasts);
  if (!Number.isInteger(d.quote) || d.quote > bounty.max_price) throw new Error(`delegate quote ${d.quote} is not an integer within max_price ${bounty.max_price}`);
  const policy = compile(bounty, d.rules), policy_sha256 = hex(sha256(canonical(policy)));
  await bountyPost(b.id, "decision", { decision: "accept", reason: d.reason, quote: d.quote, forecasts: d.forecasts, policy_sha256 });
  const { items, audit } = await fetchAll(b.id, bounty, policy);
  const result = { bounty_id: b.id, items, region: line.region, isp_class: line.isp_class, residential: line.residential, policy_sha256 };
  const attestation = await attest(sha256(canonical(result)));
  fs.appendFileSync(OUT + "/jobs", JSON.stringify({ bounty_id: b.id, model: modelId, policy, gateway_audit: audit, result }) + "\n");
  return bountyPost(b.id, "result", { result, attestation });
}

export async function main() {
  if (process.env.DRAIN_PREFLIGHT_CHALLENGE !== undefined) {
    const challenge = process.env.DRAIN_PREFLIGHT_CHALLENGE;
    if (!/^[0-9a-f]{64}$/.test(challenge)) throw new Error("drain preflight challenge must be 32-byte lowercase hex");
    await controlReady();
    await drainPreflight({ challenge, agentId: AGENT_ID, escrows: [ESCROW, GUEST_ESCROW], restoreExisting, current: custodySnapshot, attest, canonical,
      write: value => fs.writeFileSync(OUT + "/drain-checkpoint", canonical(value) + "\n", { flag: "wx", mode: 0o600 }) });
    return;
  }
  const t0 = Date.now();
  await gatewayUp();
  log("direct egress from the agent service:", JSON.stringify(await directEgress()));
  // The bounty key, the CA, the log, leases and the budget come from the sealed state when custody has one.
  const custody = await restore(), s = custody.state;
  const privateKey = s ? crypto.createPrivateKey({ key: Buffer.from(s.enc_priv, "hex"), format: "der", type: "pkcs8" }) : crypto.generateKeyPairSync("x25519").privateKey;
  const encPub = x25519Raw(crypto.createPublicKey(privateKey)), encPubHex = hex(encPub);
  if (s) { Object.assign(chain, s.chain); Object.assign(budget, s.budget); }
  useWallet(s?.wallet);
  const appraisalSalt = s?.appraisal_salt ?? hex(crypto.randomBytes(32)), probes = { last: s?.probe_last_commit ?? null };
  const line = await lineFacts();
  const ca = await makeCA(AGENT_ID, s?.ca);
  // report_data = sha256(enc_pub) || sha256(CA certificate DER): one attestation binds both keys to this run.
  const attestation = await attest(sha256(encPub), sha256(ca.der));
  useClaimer(s, attestedManifest(attestation));
  const coarse = { region: line.region, isp_class: line.isp_class, residential: line.residential };
  // Hydrate records without gateways or public effects, then seal the selected claim
  // identity and complete restored lease/receipt state before anyone can register it.
  if (s) prepareLeases(s);
  const save = () => {
    const { keepFrom, ...ls } = exportLeases();
    return commit(custody, { agent_id: AGENT_ID, enc_priv: hex(privateKey.export({ format: "der", type: "pkcs8" })), ca: ca.saved, budget, wallet: wallet.privateKey, claim_key: claimer.privateKey, claim_manifest: claimManifest, claim_identity: savedClaimIdentity, claim_history: claimHistory, guest_claims: guestClaims, appraisal_salt: appraisalSalt, probe_last_commit: probes.last,
      chain: { seq: chain.seq, head: chain.head, entries: chain.entries.filter((r) => r.entry.seq >= keepFrom) }, ...ls });
  };
  useSave(save);
  await save();
  // report_data = claim key || operator. This public proof is available while the
  // guest is active, and is also exported at completion for audit/recovery.
  const guest_key = { address: claimer.address.toLowerCase(), operator: OPERATOR.toLowerCase(), escrow: GUEST_ESCROW.toLowerCase(),
    attestation: await attest(addressWord(claimer.address), addressWord(OPERATOR)) };
  fs.writeFileSync(OUT + "/guest-key", JSON.stringify(guest_key));
  const reg = await post("/api/agents", { agent_id: AGENT_ID, enc_pub: encPubHex, ca_cert: hex(ca.der), attestation, coarse, instructions: INSTRUCTIONS, guest_key });
  record({ kind: "boot", agent_id: AGENT_ID, enc_pub: encPubHex, ca_sha256: hex(sha256(ca.der)), restored: { seq: custody.seq, head: custody.head } });
  fs.writeFileSync(OUT + "/registration", JSON.stringify({ agent_id: AGENT_ID, enc_pub: encPubHex, ca_sha256: hex(sha256(ca.der)), coarse, verification: reg.verification, wallet: wallet.address, ready_ms: Date.now() - t0 }));
  log("registered", AGENT_ID, encPubHex, JSON.stringify(coarse), "verification ok:", reg.verification?.ok, "ready in", Date.now() - t0, "ms");
  const ctx = { priv: privateKey, encPubHex, line, ca, until: t0 + LIFETIME_MS };
  if (s) await resumeLeases(s, { prepared: true });
  const relay = serveRelay(ctx);
  while (Date.now() < ctx.until) {
    await pollLeases(ctx);
    for (const b of await json(`${BASE}/api/bounties?agent_id=${encodeURIComponent(AGENT_ID)}&status=open`)) {
      const t = Date.now();
      try { await handle(b, privateKey, encPubHex, line); }
      catch (e) {
        log("bounty", b.id, "failed:", e.stack);
        await decline(b.id, "guest error: " + e.message.slice(0, 300));
      }
      log("bounty", b.id, "handled in", Date.now() - t, "ms");
    }
    for (const q of await json(`${BASE}/api/appraisal-requests?agent_id=${encodeURIComponent(AGENT_ID)}&status=open`)) await serveRequest(q, line, Buffer.from(appraisalSalt, "hex"));
    for (const q of await json(`${BASE}/api/probe-requests?agent_id=${encodeURIComponent(AGENT_ID)}&status=open`)) await serveProbe(q, Buffer.from(appraisalSalt, "hex"), probes);
    await save();
    await new Promise((s) => setTimeout(s, POLL_MS));
  }
  // Leases stay active: the next run restores them from the committed state.
  ctx.stopped = true;
  while (ctx.inflight) await new Promise((s) => setTimeout(s, 100));
  await save();
  await relay;
}

// Exit explicitly: lease gateways and open relay streams would keep the process alive past its lifetime.
if (import.meta.url === `file://${process.argv[1]}`) { await main(); process.exit(0); }

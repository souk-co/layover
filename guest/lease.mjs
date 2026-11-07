// Mode 2 and stage-1 leases: a CA generated in the guest, a TLS-terminating proxy reached through the site's
// ciphertext relay, exclusive or shared leases on (line, domain set), and signed end-of-lease statements over the log.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import tls from "node:tls";
import { Duplex } from "node:stream";
import * as x509 from "@peculiar/x509";
import { attestLeaseAction } from "./guest-action.mjs";
import { AGENT_ID, BASE, CHAIN_ID, ESCROW, GUEST_ESCROW, OPERATOR, OUT, signGuestClaim, FETCH_HEADERS, MAX_RESPONSE, TRACE, attest, canonical, chain, complete, env, firstJson, num, headBytes, hex, json, log, post,
  record, runGateway, sha256, spend, traceRule, vantage, viaGateway, web, x25519Pub, x25519Raw, SYSTEM, openSealed } from "./core.mjs";

// Prices and floors are integer cents per GB (10^9 bytes) of request and response bytes, heads included.
const FLOOR = { price_check: num("LEASE_FLOOR_PRICE_CHECK"), account: num("LEASE_FLOOR_ACCOUNT") }, SHARED_FLOOR = num("LEASE_FLOOR_SHARED");
const floorFor = (use, exclusive) => exclusive ? FLOOR[use] : SHARED_FLOOR;
const LEASE_REQUESTS = num("LEASE_MAX_REQUESTS"), LEASE_RPM = num("LEASE_REQUESTS_PER_MINUTE"), ACCOUNT_BURST = 20;
const VANTAGE_MS = num("VANTAGE_SECONDS") * 1000, GRACE_MS = num("RENEW_GRACE_SECONDS") * 1000, CLAIM_MS = num("CLAIM_SECONDS") * 1000;
const escrowOf = (r) => [ESCROW, GUEST_ESCROW].find((e) => e.toLowerCase() === String(r.escrow).toLowerCase());
const MAX_PROXY_REQUEST = 65536, WEBSOCKET_SECONDS = 900, PERIOD = 300e3;
// owed in 6-decimal token units: bytes x cents/GB / 100 (dollars) x 10^6 (units) / 10^9 (bytes per GB), rounded down.
const owed = (bytes, centsPerGb) => ((BigInt(bytes) * BigInt(centsPerGb)) / 100000n).toString();
// Commits the sealed state (agent.mjs); a claim leaves the guest only after the state recording it is committed.
let save;
export const useSave = (f) => { save = f; };
// The site's paid_bytes for an accepted lease (s is the lease as the site lists it), in its terms sealed to the agent's key.
function paidBytes(priv, s) {
  const p = openSealed(priv, s.terms, "resip-lease-terms/1").paid_bytes;
  if (!Number.isInteger(p)) throw new Error(`lease ${s.id}: the site's terms carry no paid_bytes`);
  return p;
}

// --- CA: ECDSA P-256, valid 30 days, carried across runs in the sealed state; one leaf key per run, a leaf certificate per host ---
x509.cryptoProvider.set(crypto.webcrypto);
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const subtle = crypto.webcrypto.subtle;
async function newCA(agentId) {
  const keys = await subtle.generateKey(ALG, true, ["sign", "verify"]), now = Date.now();
  const ca = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: hex(crypto.randomBytes(16)), name: `CN=resip guest CA ${agentId}`,
    notBefore: new Date(now - 60e3), notAfter: new Date(now + 30 * 86400e3), keys, signingAlgorithm: ALG, extensions: [new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true), await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)] });
  return { key: hex(await subtle.exportKey("pkcs8", keys.privateKey)), cert: hex(ca.rawData) };
}
export async function makeCA(agentId, saved) {
  saved ??= await newCA(agentId);
  const ca = new x509.X509Certificate(Buffer.from(saved.cert, "hex")), { notBefore, notAfter } = ca;
  if (Date.now() > notAfter.getTime() - 86400e3) throw new Error(`the proxy CA expires ${notAfter.toISOString()}; rotating it needs buyers to re-trust a new CA`);
  const keys = { privateKey: await subtle.importKey("pkcs8", Buffer.from(saved.key, "hex"), ALG, false, ["sign"]) };
  const leafKeys = await subtle.generateKey(ALG, true, ["sign", "verify"]);
  const leafPem = crypto.createPrivateKey({ key: Buffer.from(await subtle.exportKey("pkcs8", leafKeys.privateKey)), format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" });
  const contexts = new Map();
  const context = async (host) => {
    if (!contexts.has(host)) {
      const leaf = await x509.X509CertificateGenerator.create({ serialNumber: hex(crypto.randomBytes(16)), subject: `CN=${host}`, issuer: ca.subject,
        notBefore, notAfter, signingKey: keys.privateKey, publicKey: leafKeys.publicKey, signingAlgorithm: ALG, extensions: [
          new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]), new x509.BasicConstraintsExtension(false),
          new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
          await x509.AuthorityKeyIdentifierExtension.create(ca)] });
      contexts.set(host, tls.createSecureContext({ key: leafPem, cert: leaf.toString("pem") + "\n" + ca.toString("pem") }));
    }
    return contexts.get(host);
  };
  return { der: Buffer.from(ca.rawData), context, saved };
}

// --- leases ---
const leases = new Map();
let holds = [];
const covers = (domains, host) => domains.some((d) => host === d || host.endsWith("." + d));
const overlap = (a, b) => a.some((d) => covers(b, d)) || b.some((d) => covers(a, d));
// An active exclusive lease on host: it refuses bounties, appraisals and every other lease. Shared leases refuse nothing.
export const reservedBy = (host) => [...leases.values()].find((l) => l.active && l.exclusive && covers(l.domains, host)) ?? null;
// An exclusive request conflicts with any overlapping lease; a shared one only with an exclusive lease.
const conflicts = (domains, exclusive, x) => (exclusive || x.exclusive) && overlap(domains, x.domains);
const DNS = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const isHex32 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const COOKIE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/, GLOB = /^\/[\x21-\x7e]{0,200}$/;
const globs = (x) => Array.isArray(x) && x.length <= 20 && x.every((g) => typeof g === "string" && GLOB.test(g));
const ACCOUNT_KEYS = ["session_cookies", "max_sessions", "login_paths", "signup_paths", "signup", "post_paths", "max_posts_per_hour"];
// The account caps the gateway enforces (dsmack PR #79); all fields are required for use "account".
function precheckAccount(a) {
  if (!a || typeof a !== "object" || Object.keys(a).sort().join() !== [...ACCOUNT_KEYS].sort().join()) return "account: {" + ACCOUNT_KEYS.join(", ") + "} required for use account";
  if (!Array.isArray(a.session_cookies) || a.session_cookies.length < 1 || a.session_cookies.length > 5 || !a.session_cookies.every((c) => COOKIE.test(c))) return "account.session_cookies: 1-5 cookie names";
  if (!Number.isInteger(a.max_sessions) || a.max_sessions < 1 || a.max_sessions > 50) return "account.max_sessions: 1-50";
  if (!globs(a.login_paths) || !globs(a.signup_paths) || !globs(a.post_paths)) return "account.login_paths, signup_paths, post_paths: up to 20 path globs each";
  if (typeof a.signup !== "boolean") return "account.signup: boolean";
  if (!Number.isInteger(a.max_posts_per_hour) || a.max_posts_per_hour < 1 || a.max_posts_per_hour > 1000) return "account.max_posts_per_hour: 1-1000";
  return null;
}

function precheckLease(r, exclusive) {
  if (r.kind !== "lease") return "not a lease request";
  if (typeof exclusive !== "boolean") return "the site's terms carry no exclusive: true|false";
  if (!Array.isArray(r.domains) || r.domains.length < 1 || r.domains.length > 10 || !r.domains.every((d) => DNS.test(d))) return "domains: 1-10 lowercase DNS names";
  if (covers(r.domains, new URL(TRACE).hostname)) return "the vantage-check host cannot be leased";
  if (!(r.use in FLOOR)) return "use: price_check or account";
  if (!Number.isInteger(r.term_minutes) || r.term_minutes < 1 || r.term_minutes > 10080) return "term_minutes: 1-10080";
  if (!isHex32(r.token) || !isHex32(r.salt) || !isHex32(r.reply_pub)) return "token, salt, reply_pub: 32-byte hex";
  if (r.use === "account" && precheckAccount(r.account)) return precheckAccount(r.account);
  if (r.use !== "account" && r.account !== undefined) return "account caps apply only to use account";
  if (r.use === "account" && !exclusive) return "use account is exclusive only";
  // An escrow lease names the buyer's wallet, the accepted terms' hash and the escrow it settles on (ESCROW by the broker path or
  // GUEST_ESCROW by a guest-signed claim, never both); a dev-credit lease names none.
  if (new Set([r.buyer_wallet, r.terms_hash, r.escrow].map((x) => x === undefined)).size > 1) return "buyer_wallet, terms_hash and escrow come together";
  if (r.buyer_wallet !== undefined && !(/^0x[0-9a-fA-F]{40}$/.test(r.buyer_wallet) && /^0x[0-9a-f]{64}$/.test(r.terms_hash))) return "buyer_wallet: 0x address, terms_hash: 0x 32-byte hex";
  if (r.escrow !== undefined && escrowOf(r) === undefined) return `escrow: ${ESCROW} or ${GUEST_ESCROW}`;
  const renewing = holds.find((h) => h.until > Date.now() && h.lease_id === r.renews && h.token === r.token);
  const floor = Math.max(floorFor(r.use, exclusive), renewing ? renewing.price : 0);
  if (!Number.isInteger(r.price_per_gb) || r.price_per_gb < floor) return `price_per_gb is below the floor of ${floor} cents for ${exclusive ? "exclusive" : "shared"} ${r.use}`;
  for (const l of leases.values()) if (l.active && conflicts(r.domains, exclusive, l)) return `overlaps domains ${l.exclusive ? "leased exclusively" : "under a shared lease"} until ${l.until}`;
  for (const h of holds) if (h.until > Date.now() && h !== renewing && conflicts(r.domains, exclusive, h)) return `the previous holder has first right to renew until ${new Date(h.until).toISOString()}`;
  return null;
}

const LEASE_SCHEMA = `Reply with one JSON object and nothing else:
{"decision":"accept"|"decline","reason":"one sentence for the buyer","forecasts":{"captcha":<0..1>,"proxy_tag":<0..1>,"blocklist":<0..1>,"isp_notice":<0..1>}}
A lease gives one buyer's own HTTPS requests to the listed domains (and their subdomains) this line for the term, through a proxy in the
attested guest. exclusive true: no other buyer, bounty or appraisal reaches those domains from this line during the term. exclusive false
(shared): other shared leases and bounties may use the same domains at the same time, so the sites see more traffic from this line. use "price_check": GET and HEAD only, credentials stripped. use "account": the buyer runs logged-in accounts, GET/HEAD/POST with
Authorization headers, cookies, its own User-Agent, Origin and Referer, HTTP/2 to the sites and WebSockets. For "account" the request names caps that the
gateway enforces per domain: at most max_sessions distinct logged-in accounts (identified by session_cookies), no requests to signup_paths unless
signup is true, and at most max_posts_per_hour requests to post_paths. Judge whether these caps describe a household's few accounts or an account farm,
and whether the price justifies them against the floor. The buyer pays per GB of traffic through the line (requests and responses).
floor_cents_per_gb is the owner's minimum price for this use and mode and the offered price meets it.
forecasts are your probabilities that this lease causes each incident on this line within 30 days.`;

// Both uses pass the buyer's Accept-Language and Accept-Encoding (the body comes back as encoded, with its Content-Encoding).
// use "account": also the buyer's cookies, User-Agent, Origin and Referer, HTTP/2 to the origin, WebSockets, and one account
// group per leased domain covering it and its subdomains; price_check sends the manifest's User-Agent.
function leasePolicy(l) {
  const acct = l.use === "account", methods = acct ? ["GET", "HEAD", "POST"] : ["GET", "HEAD"];
  const rule = (name, group) => ({ name, port: 443, methods, paths: [], path_prefixes: ["/"], query: true, drop_credentials: !acct,
    headers: acct ? {} : { "User-Agent": FETCH_HEADERS["User-Agent"] }, client_headers: [...(acct ? ["User-Agent", "Origin", "Referer"] : []), "Accept-Language", "Accept-Encoding"],
    ...(acct ? { cookies: true, http2: true, websocket_seconds: WEBSOCKET_SECONDS, burst: ACCOUNT_BURST, account: { group, ...l.acct } } : {}),
    max_request_bytes: MAX_PROXY_REQUEST, max_response_bytes: MAX_RESPONSE, upload_bytes: MAX_PROXY_REQUEST * LEASE_REQUESTS,
    download_bytes: MAX_RESPONSE * LEASE_REQUESTS, requests: LEASE_REQUESTS, requests_per_minute: LEASE_RPM });
  return { rules: [...l.domains.flatMap((d) => [rule(d, d), rule("*." + d, d)]), traceRule(1000)] };
}

// Sign once before post(): the control gateway may retry the exact request after a
// transient 5xx, and the site recognizes its nonce without applying it twice.
const leasePost = async (id, action, payload) => post(`/api/leases/${id}/${action}`,
  await attestLeaseAction({ audience: BASE, agentId: AGENT_ID, leaseId: id, action, payload }, attest));
const decide = (id, body) => leasePost(id, "decision", { decision: "decline", price_per_gb: null, term_end: null, forecasts: null, policy_sha256: null, ...body });
async function handleLease(s, ctx) {
  if (s.enc_pub !== ctx.encPubHex) return decide(s.id, { reason: "sealed to an earlier key of this agent" });
  const r = openSealed(ctx.priv, s.enc), terms = openSealed(ctx.priv, s.terms, "resip-lease-terms/1"), refused = precheckLease(r, terms.exclusive);
  if (refused) {
    record({ kind: "refused", lease: null, request: s.id, hosts: Array.isArray(r.domains) ? r.domains : [], reason: refused });
    return decide(s.id, { reason: "pre-check: " + refused });
  }
  const raw = await complete(SYSTEM("lease requests") + LEASE_SCHEMA, JSON.stringify({ line: { region: ctx.line.region, isp_class: ctx.line.isp_class, residential: ctx.line.residential },
    lease: { domains: r.domains, use: r.use, exclusive: terms.exclusive, term_minutes: r.term_minutes, price_cents_per_gb: r.price_per_gb, floor_cents_per_gb: floorFor(r.use, terms.exclusive),
      ...(r.account ? { account_caps: r.account } : {}), task_description_untrusted: r.task } }));
  const d = firstJson(raw);
  if (!["accept", "decline"].includes(d.decision)) throw new Error("delegate returned no decision: " + raw.slice(0, 200));
  log("delegate lease", s.id, d.decision, d.reason);
  if (d.decision === "decline") return decide(s.id, { reason: d.reason, forecasts: d.forecasts });
  const l = { id: s.id, account: terms.account, domains: r.domains, use: r.use, exclusive: terms.exclusive, price: r.price_per_gb, bytes: 0, buyer_wallet: r.buyer_wallet ?? null, terms_hash: r.terms_hash ?? null, escrow: r.escrow === undefined ? null : escrowOf(r), token: r.token, salt: Buffer.from(r.salt, "hex"),
    reply_pub: r.reply_pub, start: Date.now(), vantage: [], peers: [], ...(r.account ? { acct: Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, r.account[k]])), sessions: [] } : {}) };
  l.term_end = l.start + r.term_minutes * 60e3;
  l.until = new Date(l.term_end).toISOString();
  const policy = leasePolicy(l);
  l.gw = await runGateway(policy);
  const v = await vantage(l.gw.listen, l.salt);
  if (!v.same_ip || !v.same_asn) { await l.gw.stop(); throw new Error("vantage check through the lease gateway did not see the line's address and ASN"); }
  l.startPrev = chain.head;
  l.startSeq = record({ kind: "lease_start", lease: l.id, account: l.account, domains: l.domains, use: l.use, exclusive: l.exclusive, price_per_gb: l.price, term_end: l.until }).entry.seq;
  for (const m of leases.values()) if (m.active && overlap(l.domains, m.domains)) { m.peers.push(l.id); l.peers.push(m.id); }
  l.active = true;
  leases.set(l.id, l);
  await decide(s.id, { decision: "accept", reason: d.reason, price_per_gb: l.price, term_end: l.until, forecasts: d.forecasts, policy_sha256: hex(sha256(canonical(policy))) });
  // Set before any commit can carry the lease, so a lease ended from resumeLeases always has it.
  l.paid_bytes = paidBytes(ctx.priv, await json(`${BASE}/api/leases/${l.id}`));
  await noteVantage(l, v);
}

async function noteVantage(l, v) {
  l.lastVantage = Date.now();
  const at = record({ kind: "vantage", lease: l.id, ip_commit: v.ip_commit, asn: v.asn, same_ip: v.same_ip, same_asn: v.same_asn }).entry.at;
  l.vantage.push({ at, ip_commit: v.ip_commit, asn: v.asn });
  await leasePost(l.id, "vantage", { at, ip_commit: v.ip_commit, asn: v.asn, same_ip: v.same_ip, same_asn: v.same_asn });
  return v.same_ip && v.same_asn;
}

function sealTo(pubHex, obj) {
  const eph = crypto.generateKeyPairSync("x25519");
  const z = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Pub(Buffer.from(pubHex, "hex")) });
  const key = Buffer.from(crypto.hkdfSync("sha256", z, Buffer.alloc(0), "resip-receipts/1", 32)), nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  return { epk: hex(x25519Raw(eph.publicKey)), nonce: hex(nonce), ct: hex(Buffer.concat([c.update(canonical(obj)), c.final(), c.getAuthTag()])) };
}

const leaseBytes = (l) => chain.entries.filter((r) => r.entry.seq >= l.startSeq && r.entry.lease === l.id && ["request", "websocket_close"].includes(r.entry.kind)).reduce((n, r) => n + r.entry.bytes_up + r.entry.bytes_down, 0);
// Signs the lease's cumulative owed so far (delta since the last claim), commits the state that records it, then appends it to
// outputs/claims, so the newest line is always relayable and no claim exists that the committed state does not count.
async function claimTick(l) {
  l.lastTick = Date.now();
  const due = BigInt(owed(Math.min(leaseBytes(l), l.paid_bytes), l.price)), delta = due - BigInt(l.claimed ?? "0");
  if (delta <= 0n) return;
  l.lastClaim = await signGuestClaim(l.buyer_wallet, l.terms_hash, delta);
  l.claimed = due.toString();
  await save();
  fs.appendFileSync(OUT + "/claims", JSON.stringify({ lease_id: l.id, ...l.lastClaim }) + "\n");
}
const touches = (domains, e) => (e.host && covers(domains, e.host)) || (e.hosts ?? []).some((h) => covers(domains, h));
async function end(l, reason) {
  await l.gw.stop();
  const last = record({ kind: "lease_end", lease: l.id, reason });
  const rows = chain.entries.filter((r) => r.entry.seq >= l.startSeq);
  const reqs = rows.filter((r) => r.entry.kind === "request" && touches(l.domains, r.entry));
  const exclusive = l.exclusive && reqs.every((r) => r.entry.lease === l.id), leased = reqs.every((r) => r.entry.lease);
  // Bytes of this lease's requests in 300 s periods from the lease's start (the site's lease periods are 300 s from its decision record).
  const mine = rows.filter((r) => r.entry.lease === l.id && ["request", "websocket_close"].includes(r.entry.kind)), sum = (rs, k) => rs.reduce((n, r) => n + r.entry[k], 0), t0 = Date.parse(rows[0].entry.at), bytes_by_period = [];
  for (let t = t0; t < Date.parse(last.entry.at); t += PERIOD) {
    const p = mine.filter((r) => Date.parse(r.entry.at) >= t && Date.parse(r.entry.at) < t + PERIOD);
    bytes_by_period.push({ start: new Date(t).toISOString(), bytes_up: sum(p, "bytes_up"), bytes_down: sum(p, "bytes_down") });
  }
  const bytes_up = sum(mine, "bytes_up"), bytes_down = sum(mine, "bytes_down"), due = owed(Math.min(bytes_up + bytes_down, l.paid_bytes), l.price);
  // A GuestEscrow lease's latest claim rides in the attested statement; a UsageEscrow lease settles on owed by the broker path.
  if (l.escrow === GUEST_ESCROW) await claimTick(l);
  const guest_claim = l.escrow === GUEST_ESCROW ? l.lastClaim ?? null : null;
  const statement = { kind: "layover-lease-statement/2", agent_id: AGENT_ID, lease_id: l.id, account: l.account, domains: l.domains, use: l.use,
    price_per_gb: l.price, bytes_up, bytes_down, bytes_by_period, owed: due, guest_claim,
    buyer_wallet: l.buyer_wallet, terms_hash: l.terms_hash, operator: OPERATOR, escrow: l.escrow, chain_id: CHAIN_ID, start: rows[0].entry.at, end: last.entry.at, end_reason: reason,
    log: { start_seq: l.startSeq, start_prev_head: l.startPrev, end_seq: last.entry.seq, end_head: last.head },
    requests_to_domains: reqs.length, requests_by_lease: reqs.filter((r) => r.entry.lease === l.id).length, exclusive, shared_with: l.peers.length,
    refused_to_others: rows.filter((r) => r.entry.kind === "refused" && r.entry.lease !== l.id && touches(l.domains, r.entry)).length,
    vantage: { checks: l.vantage.length, ip_commits: [...new Set(l.vantage.map((v) => v.ip_commit))], asns: [...new Set(l.vantage.map((v) => v.asn))] },
    claim: exclusive ? `every request from this runner to these domains between start and end belonged to lease ${l.id}`
      : l.exclusive ? "NOT exclusive: requests from other jobs reached these domains"
      : leased ? `shared: every request from this runner to these domains between start and end belonged to lease ${l.id}${l.peers.length ? ` or one of ${l.peers.length} other shared lease(s)` : ""}`
      : "shared: requests from bounties or appraisals also reached these domains" };
  // Committed with the lease still active: a run that dies before the post below resumes the lease and ends it again.
  await save();
  l.active = false;
  const attestation = await attest(sha256(canonical(statement)));
  // The holder gets its own entries in full and every other entry as a digest, enough to recompute end_head.
  const receipts = { start_prev_head: l.startPrev, rows: rows.map((r) => ({ seq: r.entry.seq, digest: r.digest, entry: r.entry.lease === l.id ? r.entry : null })) };
  await leasePost(l.id, "end", { end_reason: reason, statement, attestation, receipts_enc: sealTo(l.reply_pub, receipts) });
  if (reason === "term ended") holds.push({ lease_id: l.id, token: l.token, domains: l.domains, exclusive: l.exclusive, price: l.price, until: Date.now() + GRACE_MS });
  log("lease", l.id, "ended:", reason, "exclusive:", exclusive, "shared_with:", l.peers.length, "requests:", reqs.length);
}
// Sealed-state form of the active leases and renewal holds; the log keeps entries from the oldest active lease's start.
const KEEP = ["id", "account", "domains", "use", "exclusive", "peers", "price", "bytes", "buyer_wallet", "terms_hash", "escrow", "paid_bytes", "claimed", "lastClaim", "lastTick", "token", "reply_pub", "start", "term_end", "until", "startSeq", "startPrev", "vantage", "lastVantage", "acct", "sessions"];
export function exportLeases() {
  const active = [...leases.values()].filter((l) => l.active);
  return { leases: active.map((l) => ({ ...Object.fromEntries(KEEP.filter((k) => k in l).map((k) => [k, l[k]])), salt: hex(l.salt) })), holds: holds.filter((h) => h.until > Date.now()),
    keepFrom: Math.min(chain.seq, ...active.map((l) => l.startSeq)) };
}
// A restored lease gets a fresh gateway and a vantage check before it serves again; a changed line ends it.
// State sealed before shared leases existed has no exclusive or peers: every lease then was exclusive.
export function prepareLeases(s) {
  holds = s.holds.map((h) => ({ exclusive: true, ...h }));
  for (const r of s.leases) leases.set(r.id, { exclusive: true, peers: [], ...r, salt: Buffer.from(r.salt, "hex"), active: true });
}
export async function resumeLeases(s, { prepared = false } = {}) {
  if (!prepared) { prepareLeases(s); await save(); }
  for (const l of leases.values()) {
    l.gw = await runGateway(leasePolicy(l));
    if (!(await noteVantage(l, await vantage(l.gw.listen, l.salt)))) await end(l, "line address or ASN changed");
    log("lease", l.id, "resumed from sealed state");
  }
}

export async function pollLeases(ctx) {
  for (const s of await json(`${BASE}/api/leases?agent_id=${encodeURIComponent(AGENT_ID)}&status=open`)) {
    try { await handleLease(s, ctx); }
    catch (e) {
      log("lease", s.id, "failed:", e.stack);
      await decide(s.id, { reason: "guest error: " + e.message.slice(0, 300) });
    }
  }
  for (const s of await json(`${BASE}/api/leases?agent_id=${encodeURIComponent(AGENT_ID)}&status=active`)) {
    const l = leases.get(s.id);
    if (!l) {
      // Decided by an earlier boot that did not end it (a crash): this boot has no log for it and says so, signed.
      const statement = { kind: "layover-lease-statement/2", agent_id: AGENT_ID, lease_id: s.id, end_reason: "guest restarted without ending the lease; no log covers it", exclusive: null };
      await leasePost(s.id, "end", { end_reason: statement.end_reason, statement, attestation: await attest(sha256(canonical(statement))), receipts_enc: null });
      continue;
    }
    if (!l.active) continue;
    l.paid_bytes = paidBytes(ctx.priv, s);
    if (l.bytes >= l.paid_bytes) await end(l, "lapsed: funds exhausted");
    else if (Date.now() >= l.term_end) await end(l, "term ended");
    else if (l.escrow === GUEST_ESCROW && Date.now() - (l.lastTick ?? l.start) >= CLAIM_MS) await claimTick(l);
    else if (Date.now() - l.lastVantage >= VANTAGE_MS && !(await noteVantage(l, await vantage(l.gw.listen, l.salt)))) await end(l, "line address or ASN changed");
  }
}

// --- relay streams. Up (buyer->guest): 32-byte ephemeral X25519 key, then frames. Each frame is a 4-byte big-endian
// length and AES-256-GCM ciphertext+tag; nonce = 4 zero bytes || 8-byte frame counter; one key per direction,
// HKDF-SHA256(X25519(eph, enc_priv), salt = eph pub, info = "resip-stream/1 up" | "resip-stream/1 down").
// First up frame: JSON hello {lease_id, token, host, port}; first down frame: JSON {ok} or {ok:false, error}. Then TLS. ---
const nonce = (n) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 4); return b; };
function sealFrame(key, n, pt) {
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce(n)), ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  const h = Buffer.alloc(4); h.writeUInt32BE(ct.length);
  return Buffer.concat([h, ct]);
}
function openFrame(key, n, ct) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce(n));
  d.setAuthTag(ct.subarray(-16));
  return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
}

async function relayOk(r, what) { if (!r.ok) throw new Error(`relay ${what} -> ${r.status}: ${(await r.text()).slice(0, 200)}`); return r; }
function admit(h) {
  const l = leases.get(h.lease_id);
  if (!l || !l.active || typeof h.token !== "string" || h.token.length !== 64 || !crypto.timingSafeEqual(Buffer.from(h.token), Buffer.from(l.token))) {
    record({ kind: "refused", lease: null, host: String(h.host), reason: "no active lease with this id and token" });
    return { error: "no active lease with this id and token" };
  }
  if (h.port !== 443 || !covers(l.domains, h.host)) {
    const reason = h.port !== 443 ? "only port 443" : reservedBy(h.host) ? `${h.host} is reserved by another lease` : `${h.host} is not in this lease's domains`;
    record({ kind: "refused", lease: l.id, host: h.host, reason });
    return { error: reason };
  }
  return { lease: l, host: h.host };
}

async function serveStream(sid, ctx) {
  const url = `${BASE}/api/relay/${sid}`, queue = [];
  let buf = Buffer.alloc(0), keys = null, nUp = 0, nDown = 0, flushing = null, duplex = null;
  // One POST must fit the control gateway's max_request_bytes (1 MiB, headers included): frames up to 512 KiB per POST, and
  // a write is cut into frames of at most 256 KiB, because the TLS socket hands over a whole response body (4 MiB at most) as one write.
  const flush = async () => {
    while (queue.length) {
      let n = 0, k = 0;
      while (k < queue.length && n + queue[k].length <= 1 << 19) n += queue[k++].length;
      await relayOk(await web(url + "/down", { method: "POST", body: Buffer.concat(queue.splice(0, Math.max(k, 1))) }), "down");
    }
    flushing = null;
  };
  const send = (pt) => { for (let i = 0; i < pt.length; i += 1 << 18) queue.push(sealFrame(keys.down, nDown++, pt.subarray(i, i + (1 << 18)))); flushing ??= flush(); };
  const close = async () => { while (flushing) await flushing; await relayOk(await web(url + "/down/close", { method: "POST" }), "close"); };
  for (;;) {
    const r = await web(url + "/up");
    if (r.status === 410) break;
    await relayOk(r, "up");
    buf = Buffer.concat([buf, Buffer.from(await r.arrayBuffer())]);
    if (!keys && buf.length >= 32) {
      const epk = buf.subarray(0, 32), z = crypto.diffieHellman({ privateKey: ctx.priv, publicKey: x25519Pub(epk) });
      const k = (d) => Buffer.from(crypto.hkdfSync("sha256", z, epk, "resip-stream/1 " + d, 32));
      keys = { up: k("up"), down: k("down") };
      buf = buf.subarray(32);
    }
    while (keys && buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const pt = openFrame(keys.up, nUp++, buf.subarray(4, 4 + buf.readUInt32BE(0)));
      buf = buf.subarray(4 + buf.readUInt32BE(0));
      if (duplex) { duplex.push(pt); continue; }
      const s = admit(JSON.parse(pt));
      send(Buffer.from(JSON.stringify(s.error ? { ok: false, error: s.error } : { ok: true })));
      if (s.error) return close();
      duplex = new Duplex({ read() {}, write(c, _e, cb) { send(c); cb(); }, final(cb) { close().then(() => cb(), cb); } });
      const sock = new tls.TLSSocket(duplex, { isServer: true, secureContext: await ctx.ca.context(s.host), ALPNProtocols: ["http/1.1"] });
      sock.session = s;
      sock.on("error", (e) => log("stream", sid, "tls:", e.message));
      ctx.http.emit("connection", sock);
    }
  }
  duplex?.push(null);
}

const pick = (h, ks) => Object.fromEntries(ks.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));
const FORWARD = ["accept", "accept-language", "accept-encoding", "content-type", "authorization", "cookie", "user-agent", "origin", "referer"];
const WS_HEADERS = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"];
// A session is sha256 of "name=value\0" for each of the lease's session cookies present, as the gateway counts it. The guest
// keeps the lease's sessions in the sealed state, so max_sessions holds across runs, where the gateway's counters restart.
function sessionOf(l, cookie) {
  if (!l.acct || !cookie) return null;
  const jar = new Map();
  for (const kv of cookie.split(";")) { const i = kv.indexOf("="), k = kv.slice(0, i).trim(); if (i > 0 && !jar.has(k)) jar.set(k, kv.slice(i + 1).trim()); }
  const b = l.acct.session_cookies.filter((n) => jar.has(n)).map((n) => `${n}=${jar.get(n)}\0`).join("");
  return b ? hex(sha256(b)) : null;
}
function refusal(s, l, host, session) {
  if (host !== s.host) return [421, `Host ${host} differs from the tunnel's ${s.host}`];
  if (!l.active || !covers(l.domains, host)) return [403, l.active ? `${host} is not in this lease's domains` : "the lease has ended"];
  if (session && !l.sessions.includes(session) && l.sessions.length >= l.acct.max_sessions) return [403, `account_session_cap: this lease already has ${l.sessions.length} session(s), counted across runs`];
  return null;
}
// The log keeps digests of the request (with its cookie) and of the cookie, never the cookie itself.
const requestFacts = (method, url, headers, body) => ({ cookie_sha256: headers.cookie ? hex(sha256(headers.cookie)) : null,
  request_sha256: hex(sha256(canonical({ method, url, headers, body_sha256: hex(sha256(body)) }))) });

async function proxyRequest(req, res) {
  const s = req.socket.session, l = s.lease, host = (req.headers.host ?? "").replace(/:443$/, "");
  const deny = (status, reason, extra = {}) => { record({ kind: "refused", lease: l.id, host, method: req.method, reason }); res.writeHead(status, { "content-type": "text/plain", ...extra }).end("resip: " + reason + "\n"); };
  const headers = pick(req.headers, FORWARD), session = sessionOf(l, headers.cookie), no = refusal(s, l, host, session);
  if (no) return deny(...no);
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_PROXY_REQUEST) return deny(413, "request body over " + MAX_PROXY_REQUEST + " bytes"); chunks.push(c); }
  const body = Buffer.concat(chunks), url = "https://" + host + req.url;
  const r = await viaGateway(l.gw.listen, new URL(url), req.method, headers, body);
  // No certificate means the gateway answered itself: a policy, cap or budget refusal, or an upstream failure.
  if (!r.cert) return deny(r.status, "gateway: " + r.body.toString().trim(), pick(r.headers, ["x-dsmack-account"]));
  spend(r.body.length);
  l.bytes += r.up + r.down;
  if (session && !l.sessions.includes(session)) l.sessions.push(session);
  const row = record({ kind: "request", lease: l.id, host, method: req.method, url, status: r.status, body_sha256: hex(sha256(r.body)), cert_sha256: r.cert,
    account: r.headers["x-dsmack-account"] ?? null, bytes_up: r.up, bytes_down: r.down, ...requestFacts(req.method, url, headers, body) });
  res.writeHead(r.status, { ...pick(r.headers, ["content-type", "content-encoding", "location", "retry-after", "set-cookie", "x-dsmack-account"]), "x-resip-receipt": `${row.entry.seq} ${row.digest}`,
    "x-resip-cert-sha256": r.cert, "content-length": r.body.length }).end(r.body);
}

// WebSocket: the upgrade goes through the gateway, which names the stream; the frames are piped opaquely after the 101. The 101 row
// counts the handshake's bytes; a websocket_close row, when the stream closes, counts the frames' (frames after the lease's end are not billed).
function proxyUpgrade(req, sock, head) {
  const s = sock.session, l = s.lease, host = (req.headers.host ?? "").replace(/:443$/, ""), url = "https://" + host + req.url;
  const headers = pick(req.headers, FORWARD), session = sessionOf(l, headers.cookie), no = refusal(s, l, host, session);
  const answer = (status, hs, body) => sock.end(Buffer.concat([Buffer.from([`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}`,
    ...Object.entries({ ...hs, "content-length": body.length, connection: "close" }).flatMap(([k, v]) => [v].flat().map((x) => `${k}: ${x}`))].join("\r\n") + "\r\n\r\n"), body]));
  const deny = (status, reason) => { record({ kind: "refused", lease: l.id, host, method: "GET", reason: "websocket: " + reason }); answer(status, { "content-type": "text/plain" }, Buffer.from("resip: " + reason + "\n")); };
  if (no) return Promise.resolve(deny(...no));
  const [h, p] = l.gw.listen.split(":"), sent = { ...headers, ...pick(req.headers, WS_HEADERS), host, connection: "Upgrade", upgrade: "websocket" };
  const upHead = headBytes(`GET ${req.url} HTTP/1.1`, Object.entries(sent).flat()), downHead = (res) => headBytes(`HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`, res.rawHeaders);
  return new Promise((resolve, reject) => {
    const up = http.request({ host: h, port: Number(p), path: req.url, method: "GET", headers: sent });
    up.on("upgrade", (res, g, ghead) => {
      if (session && !l.sessions.includes(session)) l.sessions.push(session);
      const stream = Number(res.headers["x-dsmack-stream"]), frames = { up: head.length, down: ghead.length };
      l.bytes += upHead + downHead(res);
      const row = record({ kind: "request", lease: l.id, host, method: "GET", url, status: 101, websocket_stream: stream, cert_sha256: null,
        account: res.headers["x-dsmack-account"] ?? null, bytes_up: upHead, bytes_down: downHead(res), ...requestFacts("GET", url, headers, Buffer.alloc(0)) });
      sock.on("data", (c) => frames.up += c.length);
      g.on("data", (c) => frames.down += c.length);
      g.once("close", () => {
        if (!l.active) return;
        l.bytes += frames.up + frames.down;
        record({ kind: "websocket_close", lease: l.id, host, websocket_stream: stream, bytes_up: frames.up, bytes_down: frames.down });
      });
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let i = 0; i < res.rawHeaders.length; i += 2) if (!/^x-dsmack-stream$/i.test(res.rawHeaders[i])) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      sock.write([...lines, `x-resip-receipt: ${row.entry.seq} ${row.digest}`, `x-resip-stream: ${stream}`].join("\r\n") + "\r\n\r\n");
      if (ghead.length) sock.write(ghead);
      if (head.length) g.write(head);
      g.on("error", (e) => { log("websocket", stream, "gateway side:", e.message); sock.destroy(); });
      sock.on("error", (e) => { log("websocket", stream, "buyer side:", e.message); g.destroy(); });
      g.pipe(sock); sock.pipe(g);
      resolve();
    });
    up.on("response", (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => {
        const b = Buffer.concat(chunks);
        if (!res.headers["x-dsmack-cert-sha256"]) deny(res.statusCode, "gateway: " + b.toString().trim());
        else {
          l.bytes += upHead + downHead(res) + b.length;
          record({ kind: "request", lease: l.id, host, method: "GET", url, status: res.statusCode, body_sha256: hex(sha256(b)), cert_sha256: res.headers["x-dsmack-cert-sha256"],
            account: res.headers["x-dsmack-account"] ?? null, bytes_up: upHead, bytes_down: downHead(res) + b.length, ...requestFacts("GET", url, headers, Buffer.alloc(0)) });
          answer(res.statusCode, pick(res.headers, ["content-type", "content-encoding", "location", "set-cookie", "x-dsmack-account"]), b);
        }
        resolve();
      });
    });
    up.on("error", reject);
    up.end();
  });
}

// After ctx.stopped no new request starts; the final commit waits for ctx.inflight to drain so none is left out of it.
// An open WebSocket counts only until its 101 is logged.
export async function serveRelay(ctx) {
  ctx.inflight = 0;
  const track = (p, fail) => { ctx.inflight++; p.catch((e) => { log("proxy failed:", e.stack); fail(); }).finally(() => ctx.inflight--); };
  ctx.http = http.createServer((req, res) => ctx.stopped ? res.destroy() : track(proxyRequest(req, res), () => res.destroy()));
  ctx.http.on("upgrade", (req, sock, head) => ctx.stopped ? sock.destroy() : track(proxyUpgrade(req, sock, head), () => sock.destroy()));
  while (!ctx.stopped) {
    const r = await relayOk(await web(`${BASE}/api/relay/accept?agent_id=${encodeURIComponent(AGENT_ID)}`), "accept");
    for (const sid of await r.json()) serveStream(sid, ctx).catch((e) => log("stream", sid, "failed:", e.stack));
  }
}

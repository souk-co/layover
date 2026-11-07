// Off-Mac end-to-end test of one run (harness.mjs has the stand-ins).
//   [BROKER=https://pod.dstack.soc1024.com/relay-broker-staging] node test/local.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
// Exercises: CA registration, two exclusive leases, overlapping requests refused, two shared leases on one domain both served
// while an exclusive request for it is refused, shared account use refused, proxy traffic allowed and refused in the guest,
// a bounty to an exclusively leased domain refused and one to a shared domain served, leases ending at their term, each
// statement's exclusive, shared_with and bytes, the receipts chain at the end, and a registration of the agent id from another runner key refused.
import fs from "node:fs";
import { harness, run, show, sleep, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2);
const h = await harness(GW, WEB, DSMACK, "test-local-1"), { BASE, get, cli, curl, want, wantOut } = h;
const g = h.guest();
g.exit.then((x) => { console.error("guest exited", x.code); process.exit(1); });
const reg = await until(async () => (await get("agents")).find((a) => a.agent_id === "test-local-1"), 500);

// verify must refuse: this attestation's App Attest assertion is fake.
const A = h.dir + "/A", B = h.dir + "/B", C = h.dir + "/C", D = h.dir + "/D";
show("verify refuses the unsigned local attestation", (await cli("verify", BASE, "test-local-1", A)).code ? "refused (exit 1)" : "ACCEPTED: wrong");
for (const d of [A, B, C, D]) await h.buyer(d);
const leaseId = h.leaseId, accepted = (r) => { wantOut(r, "accept - "); return leaseId(r); };
const la = accepted(await cli("lease", A, "example.com", "price_check", "exclusive", "3", "60", "3", "Price checks on example.com pages"));
const lb = accepted(await cli("lease", B, "iana.org", "price_check", "exclusive", "30", "60", "50", "Price checks on iana.org pages"));
wantOut(await cli("lease", B, "www.example.com", "price_check", "exclusive", "30", "60", "5", "Overlap test"), "decline - pre-check: overlaps domains leased exclusively");
wantOut(await cli("lease", C, "www.example.com", "price_check", "shared", "30", "60", "5", "Shared under an exclusive lease"), "decline - pre-check: overlaps domains leased exclusively");
wantOut(await cli("lease", C, "example.org", "price_check", "shared", "30", "10", "5", "Below the shared floor"), "decline - pre-check: price_per_gb is below the floor of 15 cents for shared price_check");
// 20 c/GB is below the exclusive floor (30) and above the shared one (15); the term ends in 3 minutes.
const lc = accepted(await cli("lease", C, "example.org", "price_check", "shared", "3", "20", "1", "Shared price checks on example.org"));
const ld = accepted(await cli("lease", D, "www.example.org", "price_check", "shared", "3", "20", "1", "Shared price checks on www.example.org"));
wantOut(await cli("lease", B, "example.org", "price_check", "exclusive", "30", "60", "5", "Exclusive over shared"), "decline - pre-check: overlaps domains under a shared lease");
const caps = { session_cookies: ["sid"], max_sessions: 1, login_paths: [], signup_paths: [], signup: false, post_paths: [], max_posts_per_hour: 1 };
wantOut(await cli("lease", D, "example.net", "account", "shared", "30", "300", "5", "Shared account use", "", "--account=" + JSON.stringify(caps)), "decline - pre-check: use account is exclusive only");
for (const [d, id] of [[A, la], [C, lc]]) if ((await get("leases/" + id)).exclusive !== (d === A)) throw new Error("public lease " + id + " does not show the requested mode");

h.proxy(A, la, 18801); h.proxy(B, lb, 18802); h.proxy(C, lc, 18803); h.proxy(D, ld, 18804);
await sleep(2000);
want(await curl(18801, A + "/ca.pem", "https://example.com/"), "200 OK");
want(await curl(18801, A + "/ca.pem", "https://www.iana.org/"), "403 Forbidden");
want(await curl(18802, B + "/ca.pem", "https://example.com/"), "403 Forbidden");
want(await curl(18802, B + "/ca.pem", "https://www.iana.org/help/example-domains"), "200 OK");
want(await curl(18803, C + "/ca.pem", "https://www.example.org/"), "200 OK");
want(await curl(18804, D + "/ca.pem", "https://www.example.org/"), "200 OK");
want(await curl(18803, C + "/ca.pem", "https://example.com/"), "403 Forbidden");
want(await curl(18804, D + "/ca.pem", "https://example.org/"), "403 Forbidden");

const bountyTo = async (url) => {
  const enc = await run("deno", ["eval", "--ext=js", `import { seal } from '${WEB}/static/common.js'; console.log(JSON.stringify(await seal(Deno.args[0], Deno.args[1])));`, reg.enc_pub,
    JSON.stringify({ task: "fetch " + url, urls: [url], method: "GET", max_requests: 1, deliver_by: new Date(Date.now() + 3600e3).toISOString(), max_price: 50 })]);
  const bounty = await (await fetch(BASE + "/api/bounties", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: "test-local-1", buyer_key: "test-other-buyer", enc: JSON.parse(enc.stdout) }) })).json();
  const b = await until(async () => { const b = await get("bounties/" + bounty.id); return b.decision && b; });
  show("bounty to " + url, b.decision.decision + " - " + b.decision.reason);
  return b;
};
const bx = await bountyTo("https://example.com/");
if (bx.decision.decision !== "decline" || !bx.decision.reason.startsWith("pre-check: URL 1's host is reserved by an active lease")) throw new Error("a bounty to an exclusively leased domain was not refused");
const bs = await bountyTo("https://www.example.org/");
if (bs.decision.decision !== "accept") throw new Error("a bounty to a domain under shared leases was not accepted");
await until(async () => (await get("bounties/" + bs.id)).status === "done");

show("waiting for leases A, C and D to end", "(3-minute terms)");
for (const id of [la, lc, ld]) await until(async () => (await get("leases/" + id)).status !== "active", 5000);
await cli("status", A, la);
await cli("status", B, lb);
for (const [d, id] of [[C, lc], [D, ld]]) wantOut(await cli("status", d, id), '"exclusive":false');
const st = async (d, id) => (await h.getAs(d, "leases/" + id)).end.statement;
const [sa, sc, sd] = [await st(A, la), await st(C, lc), await st(D, ld)];
if (sa.exclusive !== true || sa.shared_with !== 0) throw new Error("exclusive lease A: statement " + JSON.stringify(sa));
for (const s of [sc, sd]) {
  if (s.exclusive !== false || s.shared_with !== 1 || s.requests_by_lease !== 1 || s.requests_to_domains !== 3) throw new Error("shared lease: statement " + JSON.stringify(s));
  if (s.claim !== "shared: requests from bounties or appraisals also reached these domains") throw new Error("shared lease claim: " + s.claim);
}
for (const s of [sa, sc, sd]) {
  const by = (k) => s.bytes_by_period.reduce((n, p) => n + p[k], 0);
  if (s.kind !== "layover-lease-statement/2" || s.buyer_wallet !== null || s.terms_hash !== null || s.end_reason !== "term ended" || !(s.bytes_down > 200) || !(s.bytes_up > 50) || by("bytes_up") !== s.bytes_up || by("bytes_down") !== s.bytes_down) throw new Error("statement bytes: " + JSON.stringify(s));
}
show("statements", { A: [sa.exclusive, sa.shared_with, sa.claim], C: [sc.exclusive, sc.shared_with, sc.requests_by_lease, sc.requests_to_domains], D: [sd.exclusive, sd.shared_with, sd.requests_by_lease, sd.requests_to_domains] });
for (const id of [lc, ld]) { const p = await get("leases/" + id); if (p.exclusive !== false || p.statement_exclusive !== false || p.shared_with !== 1) throw new Error("public shared lease " + JSON.stringify(p)); }
show("account A", (await h.getAs(A, "accounts/" + (await h.getAs(A, "leases/" + la)).account)).entries);
// Leases are private to the holder and the guest: no public response names a leased domain.
// The bounty to www.example.org was served, so its public result names that URL; the lease reads still must not.
// agent_id is not measured: custody binds it to the runner key of its first release (the harness attests as key 44..44), and the site refuses another key.
const other = await run("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(DSMACK + "/dstack-compat")}); import guest_attest
print(guest_attest.attestation({"os_image_hash": "11"*32, "manifest_sha256": "22"*32, "run": "33"*32}, b"\\x55"*32, bytes(64), {"events": [{"name": "system-ready", "payload": ""}], "key_id": "45"*32, "assertion": "a0"}).hex())`]);
const steal = await fetch(BASE + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: "test-local-1", enc_pub: "77".repeat(32),
  attestation: other.stdout.trim(), coarse: { region: "elsewhere", isp_class: "x", residential: false } }) });
const stealErr = (await steal.json()).error;
if (steal.status !== 409 || !stealErr.includes("bound to runner key " + "44".repeat(32))) throw new Error(`registration from another runner key: ${steal.status} ${stealErr}`);
show("registration from another runner key", `${steal.status} ${stealErr}`);
const pub = JSON.stringify(await Promise.all(["agents", "bounties", "leases", "leases/" + la, "leases/" + lb, "stats", "custody/test-local-1"].map(get)));
const pubShared = JSON.stringify(await Promise.all(["leases", "leases/" + lc, "leases/" + ld, "leases/" + lc + "/statement", "leases/" + ld + "/statement"].map(get)));
for (const d of ["example.com", "iana.org", "example.org"]) if (pubShared.includes(d) || (d !== "example.org" && pub.includes(d))) throw new Error("a public response names the leased domain " + d);
show("public responses", `no leased domain in ${pub.length} bytes`);
show("log", fs.readFileSync(g.out + "/log", "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s).entry).map((e) => `${e.seq} ${e.kind} ${e.lease ?? e.bounty ?? ""} ${e.host ?? (e.hosts ?? []).join(",")} ${e.status ?? ""} ${e.reason ?? ""}`).join("\n"));
process.exit(0);

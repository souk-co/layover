// Two probes measured for real off-Mac: the gateway service (gateway.mjs, the real gateway binary, direct internet) and
// probe() against the live hosts, then the signing input through a fake /v1/Attest socket that records report_data.
//   node test/probe.mjs GATEWAY_BINARY
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync("/tmp/resip-probe-"), here = (p) => new URL(p, import.meta.url).pathname, seen = [];
const gs = spawn("node", [here("../gateway.mjs"), process.argv[2], here("../control-policy.json"), "127.0.0.1", "28990", "28991", dir], { stdio: ["ignore", "ignore", "inherit"] });
process.on("exit", () => gs.kill());
http.createServer((req, res) => { let s = ""; req.on("data", (c) => s += c); req.on("end", () => { seen.push(JSON.parse(s).report_data); res.end(JSON.stringify({ attestation: "ab" })); }); })
  .listen(dir + "/dstack.sock");
Object.assign(process.env, { RESIP_BASE: "https://pod.dstack.soc1024.com/resip-staging", BROKER: "https://pod.dstack.soc1024.com/relay-broker-staging", AGENT_ID: "test-probe",
  GUEST_VERSION: "test", DSTACK_SOCKET: dir + "/dstack.sock", INSTRUCTIONS: fs.readFileSync(here("../instructions.txt"), "utf8").trim(), GATEWAY_API: "http://127.0.0.1:28991", GATEWAY_CONTROL: "127.0.0.1:28990",
  DAILY_BYTES: "5000000000", OPERATOR: "0x" + "0e".repeat(20), ESCROW: "0x" + "e5".repeat(20), GUEST_ESCROW: "0x" + "9e".repeat(20), CHAIN_ID: "84532", MAX_RESPONSE_BYTES: String(4 << 20), POLL_SECONDS: "10", LIFETIME_SECONDS: "60", RETRY_SECONDS: "180", ARTIFACTS: dir,
  VANTAGE_TRACE_URL: "https://www.cloudflare.com/cdn-cgi/trace", FETCH_USER_AGENT: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  FETCH_ACCEPT_LANGUAGE: "en-US,en;q=0.9", LEASE_FLOOR_PRICE_CHECK: "30", LEASE_FLOOR_SHARED: "15", LEASE_FLOOR_ACCOUNT: "300", LEASE_MAX_REQUESTS: "200", LEASE_REQUESTS_PER_MINUTE: "30",
  VANTAGE_SECONDS: "300", CLAIM_SECONDS: "300", RENEW_GRACE_SECONDS: "600", APPRAISAL_MIN_SECONDS: "600" });
const { canonical, gatewayUp, hex, sha256 } = await import("../core.mjs");
const { DRAND_CHAIN, PROBE_SITES, SITES, isChallenge, probe, sign } = await import("../appraise.mjs");

assert.equal(isChallenge(200, Buffer.from('<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>')), false);
assert.equal(isChallenge(403, Buffer.from('<script>window._cf_chl_opt={};a.src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"</script>')), true);

assert.ok(PROBE_SITES.every((s) => !SITES.includes(s)));
await gatewayUp();
const salt = crypto.randomBytes(32), t = Date.now();
const first = await probe(salt, null, "req-1");
console.log("probe in", Date.now() - t, "ms:", JSON.stringify(first, null, 1));
const second = await probe(salt, first.ip_commit, "req-2"), third = await probe(salt, "00".repeat(32), "req-3");
const ip = (await (await fetch("https://ipinfo.io/json")).json()).ip;
assert.equal(first.ip_commit, hex(sha256(Buffer.concat([salt, Buffer.from(ip)]))));
assert.deepEqual([first.same_ip_as_last, second.same_ip_as_last, third.same_ip_as_last], [null, true, false]);
for (const r of [first, second, third]) assert.ok(!JSON.stringify(r).includes(ip) && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(JSON.stringify(r)), "report carries no IP");
assert.deepEqual(Object.keys(first).sort(), ["agent_id", "asn", "at", "beacon", "bytes", "guest_version", "ip_commit", "isp_class", "kind", "request_id", "residential", "same_ip_as_last", "sites"]);
assert.equal(first.kind, "probe");
assert.deepEqual(first.sites.map((s) => s.site), PROBE_SITES);
assert.ok(first.sites.every((s) => Number.isInteger(s.status) && typeof s.challenge === "boolean"));
assert.deepEqual(Object.keys(first.beacon).sort(), ["randomness_sha256", "round"]);
const info = await (await fetch(`https://api.drand.sh/${DRAND_CHAIN}/info`)).json();
const round = await (await fetch(`https://api.drand.sh/${DRAND_CHAIN}/public/${first.beacon.round}`)).json();
assert.equal(first.beacon.randomness_sha256, hex(sha256(Buffer.from(round.randomness, "hex"))));
assert.ok(Date.parse(first.at) - (info.genesis_time + (first.beacon.round - 1) * info.period) * 1000 < 120_000, "beacon round is under two minutes old");
assert.equal(await sign(first), "ab");
assert.equal(seen.at(-1), hex(sha256(canonical(first))) + "00".repeat(32));
const log = fs.readFileSync(dir + "/log", "utf8").trim().split("\n").map((l) => JSON.parse(l).entry).filter((e) => e.kind === "request" && e.probe);
assert.equal(log.length, 3 * 5);
assert.deepEqual([0, 1, 2].map((i) => log.slice(5 * i, 5 * i + 5).reduce((n, e) => n + e.bytes, 0)), [first.bytes, second.bytes, third.bytes]);
console.log("ok: bytes per probe", [first, second, third].map((r) => r.bytes), "report_data", seen.at(-1));
process.exit(0);

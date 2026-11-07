// The appraisal measured for real off-Mac: the gateway service (gateway.mjs, the real gateway binary, direct internet) and
// appraise() against the live sites, then the signing input through a fake /v1/Attest socket that records report_data.
//   node test/appraise.mjs GATEWAY_BINARY
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync("/tmp/resip-appraise-"), here = (p) => new URL(p, import.meta.url).pathname, seen = [];
const gs = spawn("node", [here("../gateway.mjs"), process.argv[2], here("../control-policy.json"), "127.0.0.1", "28990", "28991", dir], { stdio: ["ignore", "ignore", "inherit"] });
process.on("exit", () => gs.kill());
http.createServer((req, res) => { let s = ""; req.on("data", (c) => s += c); req.on("end", () => { seen.push(JSON.parse(s).report_data); res.end(JSON.stringify({ attestation: "ab" })); }); })
  .listen(dir + "/dstack.sock");
Object.assign(process.env, { RESIP_BASE: "https://pod.dstack.soc1024.com/resip-staging", BROKER: "https://pod.dstack.soc1024.com/relay-broker-staging", AGENT_ID: "test-appraise",
  GUEST_VERSION: "test", DSTACK_SOCKET: dir + "/dstack.sock", INSTRUCTIONS: fs.readFileSync(here("../instructions.txt"), "utf8").trim(), GATEWAY_API: "http://127.0.0.1:28991", GATEWAY_CONTROL: "127.0.0.1:28990",
  DAILY_BYTES: "5000000000", OPERATOR: "0x" + "0e".repeat(20), ESCROW: "0x" + "e5".repeat(20), GUEST_ESCROW: "0x" + "9e".repeat(20), CHAIN_ID: "84532", MAX_RESPONSE_BYTES: String(4 << 20), POLL_SECONDS: "10", LIFETIME_SECONDS: "60", RETRY_SECONDS: "180", ARTIFACTS: dir,
  VANTAGE_TRACE_URL: "https://www.cloudflare.com/cdn-cgi/trace", FETCH_USER_AGENT: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  FETCH_ACCEPT_LANGUAGE: "en-US,en;q=0.9", LEASE_FLOOR_PRICE_CHECK: "30", LEASE_FLOOR_SHARED: "15", LEASE_FLOOR_ACCOUNT: "300", LEASE_MAX_REQUESTS: "200", LEASE_REQUESTS_PER_MINUTE: "30",
  VANTAGE_SECONDS: "300", CLAIM_SECONDS: "300", RENEW_GRACE_SECONDS: "600", APPRAISAL_MIN_SECONDS: "600" });
const { canonical, gatewayUp, hex, lineFacts, sha256 } = await import("../core.mjs");
const { DRAND_CHAIN, appraise, isChallenge, sign, SITES } = await import("../appraise.mjs");

assert.equal(isChallenge(202, Buffer.alloc(0)), true);
assert.equal(isChallenge(403, Buffer.from("<script>var dd={'host':'geo.captcha-delivery.com'}</script>")), true);
assert.equal(isChallenge(200, Buffer.from("<html>hello</html>")), false);
assert.throws(() => canonical({ bandwidth_mbps: 1.5 }));

await gatewayUp();
const line = await lineFacts(), salt = crypto.randomBytes(32), t = Date.now();
const report = await appraise(line, salt, "req-1");
console.log("appraisal in", Date.now() - t, "ms:", JSON.stringify(report, null, 1));
const ip = (await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text()).match(/^ip=(.*)$/m)[1];
assert.equal(report.ip_commit, hex(sha256(Buffer.concat([salt, Buffer.from(ip)]))));
assert.ok(!JSON.stringify(report).includes(ip) && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(JSON.stringify(report)), "report carries no IP");
assert.deepEqual(Object.keys(report).sort(), ["agent_id", "asn", "at", "bandwidth_mbps", "beacon", "cgnat", "challenges", "guest_version", "ip_commit", "isp_class", "kind", "region", "request_id", "residential"]);
assert.equal(report.cgnat, "not_checked");
assert.deepEqual(report.challenges.map((c) => c.site), SITES);
assert.deepEqual(Object.keys(report.beacon).sort(), ["cert_sha256", "ms", "randomness_sha256", "round"]);
const info = await (await fetch(`https://api.drand.sh/${DRAND_CHAIN}/info`)).json();
const round = await (await fetch(`https://api.drand.sh/${DRAND_CHAIN}/public/${report.beacon.round}`)).json();
assert.equal(report.beacon.randomness_sha256, hex(sha256(Buffer.from(round.randomness, "hex"))));
assert.ok(Date.parse(report.at) - (info.genesis_time + (report.beacon.round - 1) * info.period) * 1000 < 120_000, "beacon round is under two minutes old");
assert.equal(await sign(report), "ab");
assert.equal(seen.at(-1), hex(sha256(canonical(report))) + "00".repeat(32));
const log = fs.readFileSync(dir + "/log", "utf8").trim().split("\n").map((l) => JSON.parse(l).entry);
assert.equal(log.filter((e) => e.kind === "request" && e.appraisal).length, SITES.length + 2);
console.log("ok: report_data", seen.at(-1));
process.exit(0);

// Off-Mac test of #141: the guest rides out a pod outage (a site deploy, a broker restart) and exits once it outlasts RETRY_SECONDS.
//   node test/blip.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
// 1. Every pod route answers 502 for 90 s (RETRY_SECONDS 170). The guest stays up, logs each retry, polls again within 10 s of
//    recovery, and its relay serves a lease taken after the outage.
// 1b. Only the broker answers 502, for 150 s, while a lease request waits: the decision's broker calls are re-signed on each try
//    (the broker refuses a signature older than 120 s) and the lease is accepted once the broker is back.
// 2. The pod answers 502 for good. The guest exits non-zero about RETRY_SECONDS later with the 502 as its error.
import assert from "node:assert/strict";
import { harness, outage, show, sleep, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2), AGENT = "test-blip-1";
const h = await harness(GW, WEB, DSMACK, AGENT), { cli, curl, want, wantOut } = h;
const g = h.guest({ RETRY_SECONDS: "170", LIFETIME_SECONDS: "600" });
let exited = null, stderr = "";
g.proc.stderr.on("data", (c) => stderr += c);
const retries = () => (stderr.match(/-> 502: upstream_tls_or_io: test outage; retrying in \d+ ms/g) ?? []).length;
g.exit.then((x) => exited = { ...x, at: Date.now() });
const polled = async () => { const p = (await h.get("probe-scheduler")).last_polled[AGENT]; return p ? Date.parse(p) : 0; };
await until(polled, 500);

outage.on = true;
const t0 = Date.now();
while (Date.now() - t0 < 90e3) { assert.equal(exited, null, "guest exited during the outage: " + JSON.stringify(exited)); await sleep(1000); }
outage.on = false;
const back = Date.now(), first = await until(async () => { const p = await polled(); return p > back && p; }, 200);
assert.equal(exited, null);
assert.ok(first - back <= 10e3, `first poll ${first - back} ms after recovery`);
assert.ok(retries() > 10, `${retries()} retries logged`);
show("90 s outage", { pod_502s: outage.served, retries_logged: retries(), first_poll_after_recovery_ms: first - back });

const A = h.dir + "/A";
await h.buyer(A);
const r = await cli("lease", A, "example.com", "price_check", "shared", "3", "20", "1", "After the outage");
wantOut(r, "accept - ");
h.proxy(A, h.leaseId(r), 18811);
await sleep(2000);
want(await curl(18811, A + "/ca.pem", "https://example.com/"), "200 OK");

Object.assign(outage, { on: true, prefix: "/relay-broker-staging/" });
setTimeout(() => Object.assign(outage, { on: false, prefix: "/" }), 150e3);
const t2 = Date.now(), r2 = await cli("lease", A, "example.org", "price_check", "shared", "3", "20", "1", "During a broker outage");
wantOut(r2, "accept - ");
assert.equal(exited, null);
assert.ok(Date.now() - t2 >= 150e3, "decided before the broker came back");
show("150 s broker outage", { decided_after_s: Math.round((Date.now() - t2) / 1000) });

outage.on = true;
const t1 = Date.now();
const x = await until(() => exited, 500);
show("permanent outage", { exit: x.code, after_s: Math.round((x.at - t1) / 1000) });
assert.notEqual(x.code, 0);
assert.ok(x.at - t1 >= 165e3 && x.at - t1 <= 230e3, `exited ${x.at - t1} ms into the outage`);
assert.match(x.err, /-> 502: upstream_tls_or_io: test outage/);
console.log("ok: a 90 s outage ridden out with a poll within 10 s of recovery; a lasting one exits after RETRY_SECONDS with the 502");
process.exit(0);

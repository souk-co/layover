// Off-Mac test of two failures that used to wedge or crash the live guest (harness.mjs has the stand-ins).
//   node test/recover.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
// 1. A usage call that 500s once after a chat is retried (#141) and the decision goes through. While usage keeps failing past
//    RETRY_SECONDS (3 here) the decision fails with the broker's error and the broker holds that request in flight; the next
//    decision reconciles before prepare instead of getting 409 REQUEST_IN_FLIGHT.
// 2. A probe request the site expired (10 minutes after filing) answers the report or failure POST with 409 "probe request is
//    expired, not open"; serveProbe logs it and returns. Any other refusal still throws.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { harness, show, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2), AGENT = "test-recover-1";
const h = await harness(GW, WEB, DSMACK, AGENT), { cli, wantOut } = h;
const g = h.guest({ RETRY_SECONDS: "3" });
g.exit.then((x) => { console.error("guest exited", x.code); process.exit(1); });
await until(async () => (await h.get("agents")).find((a) => a.agent_id === AGENT), 500);
const A = h.dir + "/A";
await h.buyer(A);
const lease = (n) => cli("lease", A, `d${n}.example.com`, "price_check", "shared", "30", "20", "1", "Recovery test " + n);

h.broker.failUsage = 1;
wantOut(await lease(1), "accept - ");
assert.equal(h.broker.failUsage, 0);
h.broker.failUsage = 99;
wantOut(await lease(3), "decline - guest error: broker usage 500");
assert.equal(h.broker.pending, true);
wantOut(await lease(4), "decline - guest error: broker usage 500");
h.broker.failUsage = 0;
wantOut(await lease(5), "accept - ");
show("broker", "a failed usage call no longer strands the wallet");

// The probe half runs in this process against the guest's own gateway service, with its own artifacts dir.
const out = h.dir + "/inproc";
fs.mkdirSync(out);
Object.assign(process.env, h.env, { ARTIFACTS: out, GATEWAY_API: "http://127.0.0.1:" + g.ports[1], GATEWAY_CONTROL: "127.0.0.1:" + g.ports[0] });
const { budget, DAILY_BYTES, gatewayUp } = await import("../core.mjs");
const { serveProbe } = await import("../appraise.mjs");
await gatewayUp();
const expiredRequest = () => {
  const id = crypto.randomUUID();
  fs.appendFileSync(h.dir + "/site/records.jsonl", JSON.stringify({ kind: "probe_request", id, agent_id: AGENT, at: new Date(Date.now() - 11 * 60e3).toISOString() }) + "\n");
  return { id };
};
const kinds = () => fs.readFileSync(out + "/log", "utf8").trim().split("\n").map((l) => JSON.parse(l).entry.kind);
const salt = crypto.randomBytes(32), ps = { last: null };

budget.used = DAILY_BYTES;
const failing = expiredRequest();
await serveProbe(failing, salt, ps);
assert.equal((await h.get("probe-requests/" + failing.id)).status, "expired");
assert.deepEqual(kinds(), ["probe_failed"]);
await assert.rejects(serveProbe({ id: crypto.randomUUID() }, salt, ps), /-> 400: \{"error":"no such probe request"\}/);

budget.used = 0;
const late = expiredRequest();
await serveProbe(late, salt, ps);
assert.equal(ps.last, null);
assert.ok(kinds().filter((k) => k === "request").length >= 5, "the probe was measured");
assert.equal(kinds().filter((k) => k === "probe_failed").length, 2, "no failure recorded for the late report");
assert.equal((await h.get("probe-requests/" + late.id)).status, "expired");
console.log("ok: in-flight request reconciled before prepare; expired probe requests logged, other refusals thrown");
process.exit(0);

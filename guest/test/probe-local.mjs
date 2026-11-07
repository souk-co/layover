// Off-Mac end-to-end test of drawn probes (harness.mjs has the stand-ins). The agent id is not test-*, so the site's scheduler
// covers it; its anchor is written three hours back, so the scheduler files the probes drand drew since then at once and the
// agent serves them. Each is measured for real and refused by the site only for the harness's fake App Attest assertion.
//   node test/probe-local.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
import assert from "node:assert/strict";
import fs from "node:fs";
import { harness, run, show, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2), AGENT = "local-probe-1";
const h = await harness(GW, WEB, DSMACK, AGENT), { BASE, get } = h;
fs.appendFileSync(h.dir + "/site/records.jsonl", JSON.stringify({ kind: "probe_anchor", agent_id: AGENT, at: new Date(Date.now() - 3 * 3600e3).toISOString() }) + "\n");
const g = h.guest();
g.exit.then((x) => { console.error("guest exited", x.code); process.exit(1); });
// Done when the scheduler has scanned up to the latest round and every probe it filed is served.
const latest = () => Math.floor((Date.now() / 1000 - 5 - 1595431050) / 30) + 1;
const rows = await until(async () => { const ps = await get(`agents/${AGENT}/probes`), c = (await get("probe-scheduler")).cursors[AGENT];
  return c && c.scanned >= latest() - 2 && ps.length >= 2 && ps.every((p) => p.status !== "open") && ps; }, 2000);
show("probes", rows);
const sched = await get("probe-scheduler");
show("scheduler", { ...sched, cursors: undefined });
assert.equal(sched.error, null);
assert.ok(rows.every((p, i) => i === 0 || p.scheduled_at < rows[i - 1].scheduled_at), "newest first");
for (const p of rows) {
  assert.equal(p.status, "failed");
  assert.match(p.error, /^POST \/api\/agents\/local-probe-1\/probes -> 400: \{"error":"probe attestation did not verify: App Attest assertion, mode none \([^;]*$/);
  assert.ok(Date.parse(p.scheduled_at) <= Date.parse(p.filed_at));
}
assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(JSON.stringify(rows)));
const log = fs.readFileSync(g.out + "/log", "utf8").trim().split("\n").map((l) => JSON.parse(l).entry);
assert.equal(log.filter((e) => e.kind === "probe_failed").length, rows.length);
assert.equal(log.filter((e) => e.kind === "request" && e.probe).length, 5 * rows.length);
const r = await run("deno", ["run", "-A", "--no-check", WEB + "/probe-schedule.ts", BASE, AGENT]);
console.log(r.stdout);
assert.match(r.stdout, new RegExp(`all ${rows.length} probes`));
console.log("ok:", rows.length, "drawn probes served, schedule recomputed from drand");
process.exit(0);

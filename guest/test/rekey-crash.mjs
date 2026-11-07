// A host that refuses the custody commit carrying a claim, then relaunches under another allowed manifest (a new claim key),
// gets no lease's bytes claimed twice. Run 1 (key K1) serves page 1 and its claim commits and is published; page 2 is served and
// every commit after its request row is refused, so run 1 exits without publishing a claim for it. Run 2, attested under the
// second manifest (key K2), resumes the lease from the committed state, which still counts page 1 as claimed and has no row for
// page 2, and serves page 3: K2 claims page 3 only, and K1 + K2 together claim exactly the committed bytes.
//   node test/rekey-crash.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { cut, harness, ORIGIN_HOST, run, show, sleep, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2), AGENT = "test-rekey-1", MiB = 1 << 20;
const BIG = crypto.randomBytes(MiB);
const h = await harness(GW, WEB, DSMACK, AGENT, {}, (req, res) => res.writeHead(200, { "content-type": "application/octet-stream" }).end(BIG));
const lines = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x)) : [];
const owed = (b) => ((BigInt(b) * 250n) / 100000n).toString();

const run1 = h.guest({ RETRY_SECONDS: "5" });
await until(async () => (await h.get("agents")).find((a) => a.agent_id === AGENT), 500);
const A = h.dir + "/A";
await h.buyer(A);
const WALLET = "0x" + "Ab".repeat(20), TERMS = "0x" + "c7".repeat(32);
const { id: la, decision } = await h.lease(A, "shared", 5, { domains: [ORIGIN_HOST], use: "price_check", term_minutes: 30, price_per_gb: 250, task: "Stand-in site", buyer_wallet: WALLET, terms_hash: TERMS, escrow: h.env.GUEST_ESCROW });
assert.equal(decision.decision, "accept", decision.reason);
const rows = (out) => lines(out + "/log").filter((r) => r.entry.kind === "request" && r.entry.lease === la).map((r) => r.entry.bytes_up + r.entry.bytes_down);
const page = async (port) => {
  await run("curl", ["-sS", "--max-time", "60", "-x", "http://127.0.0.1:" + port, "--cacert", A + "/ca.pem", "-o", h.dir + "/body", `https://${ORIGIN_HOST}/big`]);
  assert.ok(fs.readFileSync(h.dir + "/body").equals(BIG), "the page did not arrive whole");
};
h.proxy(A, la, 18851);
await sleep(2000);
await page(18851);
const c1 = (await until(() => lines(run1.out + "/claims")[0], 500)).cumulative_owed;
assert.equal(c1, owed(rows(run1.out)[0]));
show("run 1 page 1 claimed by K1", c1);

// The run may die on the refused commit before the relay has delivered all of page 2 to the buyer.
cut.when = () => rows(run1.out).length >= 2;
await sleep(3000);
await page(18851).catch((e) => show("page 2 not delivered whole", e.message.split("\n")[0]));
const x1 = await run1.exit;
assert.ok(x1.code !== 0 && cut.refused > 0 && x1.err.includes("custody unreachable"), `run 1 exit ${x1.code}, ${cut.refused} commits refused`);
assert.equal(lines(run1.out + "/claims").length, 1, "run 1 published a claim whose commit was refused");
show("run 1 page 2, commits refused", { exit: x1.code, commits_refused: cut.refused, claims: 1 });

cut.when = () => false;
h.attester.manifest = "23".repeat(32);
const run2 = h.guest();
run2.exit.then((x) => { console.error("run 2 exited", x.code, x.err.slice(-600)); process.exit(1); });
await until(() => lines(run2.out + "/log").some((r) => r.entry.kind === "vantage" && r.entry.lease === la), 500);
h.proxy(A, la, 18852);
await sleep(2000);
await page(18852);
const c2 = (await until(() => lines(run2.out + "/claims")[0], 500)).cumulative_owed;
const k1 = JSON.parse(fs.readFileSync(run1.out + "/guest-key", "utf8")).address, k2 = JSON.parse(fs.readFileSync(run2.out + "/guest-key", "utf8")).address;
assert.notEqual(k1, k2);
const committed = rows(run1.out)[0] + rows(run2.out).reduce((a, b) => a + b, 0);
show("run 2 (new manifest) page 3 claimed by K2", c2);
assert.equal((BigInt(c1) + BigInt(c2)).toString(), owed(committed), "K1 + K2 claim other than the committed bytes");
show("K1 + K2", { claimed: (BigInt(c1) + BigInt(c2)).toString(), owed_for_committed_bytes: owed(committed), page_2_unclaimed: owed(rows(run1.out)[1]) });
console.log("ok: no bytes claimed twice across the rekey; the refused commit's claim was never published");
process.exit(0);

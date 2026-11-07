// Off-Mac test of sealed state across runs: a lease that spans a relaunch with the same key and CA, a release at an
// older head refused, and a forked run stopped. The GuestEscrow claim key carries over a relaunch of the same manifest and is
// replaced when the run's manifest changes (run 3 is attested under a second allowed manifest). A lease the surviving run committed
// is ended from resumeLeases by run 4, whose trace host reports another address: its statement bills against the committed paid_bytes.
//   node test/relaunch.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { harness, ORIGIN_HOST, show, sleep, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2), AGENT = "test-relaunch-1";
const h = await harness(GW, WEB, DSMACK, AGENT, {}, (req, res) => res.end("ip=1.1.1.1\n")), { BASE, get, cli, curl, want } = h;
const reg = async (after = "") => until(async () => (await get("agents")).filter((a) => a.agent_id === AGENT && a.at > after).at(-1), 500);
const custody = () => get("custody/" + AGENT);

const run1 = h.guest({ LIFETIME_SECONDS: "60" }), r1 = await reg();
const A = h.dir + "/A";
await h.buyer(A);
const la = h.leaseId(await cli("lease", A, "example.com", "price_check", "exclusive", "4", "60", "100", "Price checks on example.com"));
h.proxy(A, la, 18811);
await sleep(2000);
want(await curl(18811, A + "/ca.pem", "https://example.com/"), "200 OK");
show("run 1 exit", await run1.exit);
show("lease after run 1", (await get("leases/" + la)).status);
const c1 = await custody();
show("custody after run 1", { seq: c1.seq, head: c1.head });

const run2 = h.guest(), r2 = await reg(r1.at);
if (r2.enc_pub !== r1.enc_pub || r2.ca_cert !== r1.ca_cert) throw new Error("run 2 registered a different key or CA than run 1");
show("run 2 registered the same key and CA", true);
const walletOf = (r) => until(() => fs.existsSync(r.out + "/registration") && JSON.parse(fs.readFileSync(r.out + "/registration", "utf8")).wallet, 500);
show("run 2 kept the broker wallet", (await walletOf(run1)) === (await walletOf(run2)));
const keyOf = (r) => fs.existsSync(r.out + "/guest-key") && JSON.parse(fs.readFileSync(r.out + "/guest-key", "utf8")).address;
const [k1, k2] = [await until(() => keyOf(run1), 500), await until(() => keyOf(run2), 500)];
if (k1 !== k2) throw new Error(`run 2 attested claim key ${k2}, not run 1's ${k1}`);
show("run 2 kept the claim key", k2);
await until(async () => (await custody()).seq > c1.seq);
want(await curl(18811, A + "/ca.pem", "https://example.com/"), "200 OK");
want(await curl(18811, A + "/ca.pem", "https://www.example.com/"), "200 OK");

// A run asking for the key at an older head, with a valid (local) attestation over that request.
const old = c1.events.find((e) => e.kind === "commit").head, eph_pub = crypto.randomBytes(32).toString("hex");
const canonical = (v) => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v);
const rd = Buffer.concat([crypto.createHash("sha256").update(canonical({ kind: "resip-custody-release/1", agent_id: AGENT, head: old, eph_pub })).digest(), Buffer.alloc(32)]).toString("hex");
const attestation = await new Promise((ok) => http.request({ socketPath: h.env.DSTACK_SOCKET, path: "/v1/Attest", method: "POST" }, (res) => { let s = ""; res.on("data", (c) => s += c); res.on("end", () => ok(JSON.parse(s).attestation)); }).end(JSON.stringify({ report_data: rd })));
const rb = await fetch(`${BASE}/api/custody/${AGENT}/release`, { method: "POST", body: JSON.stringify({ head: old, eph_pub, attestation }) });
show("rollback: release at an older head", `${rb.status} ${(await rb.json()).error}`);

// A second live run forks the chain: whichever commits second is refused and stops.
h.attester.manifest = "23".repeat(32);
const run3 = h.guest();
const k3 = await Promise.race([until(() => keyOf(run3), 500), run3.exit.then((x) => keyOf(run3) || Promise.reject(new Error("run 3 exited before its guest-key: " + x.err)))]);
if (k3 === k2) throw new Error("run 3, under a new manifest, kept the claim key " + k2);
show("run 3 (new manifest) made a new claim key", k3);
const first = await Promise.race([run2.exit.then((x) => ({ run: 2, ...x })), run3.exit.then((x) => ({ run: 3, ...x }))]);
show(`fork: run ${first.run} exited ${first.code}`, first.err.split("\n").filter((l) => /stale head|another run/.test(l)).slice(0, 2).join(" / "));
show("custody refusals", (await custody()).events.filter((e) => e.kind === "refused").map((e) => `${e.what} ${e.asked ?? e.prev} vs ${e.head}`));
want(await curl(18811, A + "/ca.pem", "https://example.com/"), "200 OK");

const l = await until(async () => { const x = await h.getAs(A, "leases/" + la); return x.status !== "active" && x; }, 5000);
show("lease end", { status: l.status, reason: l.end.end_reason, log: l.end.statement.log, requests_by_lease: l.end.statement.requests_by_lease, exclusive: l.end.statement.exclusive });
h.wantOut(await cli("verify", BASE, AGENT, A), "verified:");
h.wantOut(await cli("status", A, la), "statement verified (unsigned-test-fixture)");
const survivor = first.run === 2 ? run3 : run2;
show("log of the surviving run", fs.readFileSync(survivor.out + "/log", "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s).entry)
  .map((e) => `${e.seq} ${e.kind} ${e.lease ?? ""} ${e.host ?? ""} ${e.status ?? ""} ${e.reason ?? ""} ${e.restored ? JSON.stringify(e.restored) : ""}`).join("\n"));

const lb = h.leaseId(await cli("lease", A, "example.net", "price_check", "exclusive", "4", "60", "10", "Price checks on example.net"));
const seq = (await custody()).seq;
await until(async () => (await custody()).seq > seq, 500);
survivor.proc.kill("SIGKILL");
await survivor.exit;
const run4 = h.guest({ VANTAGE_TRACE_URL: `https://${ORIGIN_HOST}/cdn-cgi/trace` });
const eb = (await until(async () => { const x = await h.getAs(A, "leases/" + lb); return x.status !== "active" && x; }, 1000)).end;
if (eb.end_reason !== "line address or ASN changed" || eb.statement.owed !== "0") throw new Error("lease ended from resumeLeases: " + JSON.stringify(eb.statement));
show("run 4 ended the resumed lease", { reason: eb.end_reason, owed: eb.statement.owed, run4_alive: run4.proc.exitCode === null });
process.exit(0);

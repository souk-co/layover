// Off-Mac test of per-GB leases: every request row carries bytes_up and bytes_down, and the end-of-lease statement adds them
// up per 300 s period. A shared lease at 250 c/GB with a 1 cent deposit pays for 4,000,000 bytes; a 3 MiB page from a stand-in
// site counts 3 MiB plus heads down and only a head up, the lease stays active, a second page takes it past its paid bytes and the
// guest ends it "lapsed: funds exhausted"; the holder is charged min(funds, bytes x price). The lease is an escrow lease: the statement
// (layover-lease-statement/2) names the buyer's wallet, terms hash and escrow (GuestEscrow) from the request, the host's operator from
// its launch inputs, the CHAIN_ID launch input, and owed = min(bytes, paid_bytes) x price in 6-decimal token units.
//   node test/bytes.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { verifyTypedData, zeroPadValue } from "ethers";
import { harness, ORIGIN_HOST, run, show, sleep, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2), AGENT = "test-bytes-1", MiB = 1 << 20, HEADS = 2048;
const BIG = crypto.randomBytes(3 * MiB);
const h = await harness(GW, WEB, DSMACK, AGENT, {}, (req, res) => res.writeHead(200, { "content-type": "application/octet-stream" }).end(BIG));
// Malformed or missing escrow launch inputs stop the agent at start.
for (const [k, v, msg] of [["GUEST_ESCROW", "", "missing env GUEST_ESCROW"], ["GUEST_ESCROW", "0x78e0", "GUEST_ESCROW is not a 0x address"],
  ["GUEST_ESCROW", h.env.ESCROW.toUpperCase().replace("0X", "0x"), "ESCROW and GUEST_ESCROW are the same contract"], ["CHAIN_ID", "", "missing env CHAIN_ID"], ["CHAIN_ID", "0", "CHAIN_ID is not a positive integer"]]) {
  const x = await h.guest({ [k]: v }).exit;
  assert.ok(x.code !== 0 && x.err.includes(msg), `${k}=${v}: exit ${x.code}, ${x.err}`);
}
show("bad escrow launch inputs", "refused at start");
const g = h.guest();
g.exit.then((x) => { console.error("guest exited", x.code); process.exit(1); });
await until(async () => (await h.get("agents")).find((a) => a.agent_id === AGENT), 500);
const A = h.dir + "/A", ca = A + "/ca.pem";
await h.buyer(A);
const WALLET = "0x" + "Ab".repeat(20), TERMS = "0x" + "c7".repeat(32);
// An escrow lease names the escrow it settles on, one of the two launch inputs: without one, or with a third address, it is refused.
h.wantOut(await h.cli("lease", A, ORIGIN_HOST, "price_check", "shared", "30", "250", "1", "Stand-in site", "--buyer-wallet=" + WALLET, "--terms-hash=" + TERMS),
  "pre-check: buyer_wallet, terms_hash and escrow come together");
const base = { domains: [ORIGIN_HOST], use: "price_check", term_minutes: 30, price_per_gb: 250, task: "Stand-in site", buyer_wallet: WALLET, terms_hash: TERMS };
assert.match((await h.lease(A, "shared", 1, { ...base, escrow: "0x" + "77".repeat(20) })).decision.reason, /^pre-check: escrow: /);
const { id: la, decision } = await h.lease(A, "shared", 1, { ...base, escrow: h.env.GUEST_ESCROW });
assert.equal(decision.decision, "accept");
show("escrow field", "missing and unknown escrow refused; GuestEscrow lease accepted");
h.proxy(A, la, 18841);
await sleep(2000);
assert.equal((await h.getAs(A, "leases/" + la)).paid_bytes, 4e6);

const get = async (port = 18841) => {
  await run("curl", ["-sS", "--max-time", "60", "-x", "http://127.0.0.1:" + port, "--cacert", ca, "-D", h.dir + "/headers", "-o", h.dir + "/body", `https://${ORIGIN_HOST}/big`]);
  h.want({ line: fs.readFileSync(h.dir + "/headers", "utf8") }, "200 OK");
  assert.ok(fs.readFileSync(h.dir + "/body").equals(BIG), "the 3 MiB page did not arrive whole");
};
await get();
await sleep(5000);
assert.equal((await h.get("leases/" + la)).status, "active", "the lease ended before its traffic reached its paid bytes");
show("after one 3 MiB page", "still active");
const mid = fs.readFileSync(g.out + "/claims", "utf8").trim().split("\n").map((x) => JSON.parse(x));
assert.equal(mid.length, 1, "no claim was signed on the metering tick while the lease was active");
assert.ok(BigInt(mid[0].cumulative_owed) > 0n);
show("claim signed mid-lease", mid[0].cumulative_owed);
await get();
const l = await until(async () => { const x = await h.getAs(A, "leases/" + la); return x.status !== "active" && x; }, 1000);
const st = l.end.statement;
show("statement", { end_reason: st.end_reason, price_per_gb: st.price_per_gb, bytes_up: st.bytes_up, bytes_down: st.bytes_down, bytes_by_period: st.bytes_by_period });
assert.equal(st.end_reason, "lapsed: funds exhausted");
assert.deepEqual([st.kind, st.lease_id, st.buyer_wallet, st.terms_hash, st.operator, st.escrow, st.chain_id], ["layover-lease-statement/2", la, WALLET, TERMS, h.env.OPERATOR, h.env.GUEST_ESCROW, Number(h.env.CHAIN_ID)]);
assert.ok(st.bytes_up + st.bytes_down > l.paid_bytes);
assert.equal(st.owed, String((BigInt(l.paid_bytes) * 250n) / 100000n), "owed counts the lease's bytes up to paid_bytes");
assert.equal(st.requests_by_lease, 2);
assert.ok(st.bytes_down >= 2 * 3 * MiB && st.bytes_down <= 2 * (3 * MiB + HEADS), `bytes_down ${st.bytes_down} is not 2 x (3 MiB + heads)`);
assert.ok(st.bytes_up > 2 * 50 && st.bytes_up <= 2 * HEADS, `bytes_up ${st.bytes_up} is not two request heads`);
assert.ok(st.bytes_by_period.length >= 1 && st.bytes_by_period.every((p) => !isNaN(Date.parse(p.start))));
assert.equal(st.bytes_by_period.reduce((n, p) => n + p.bytes_down, 0), st.bytes_down);
assert.equal(st.bytes_by_period.reduce((n, p) => n + p.bytes_up, 0), st.bytes_up);
assert.equal(Date.parse(st.bytes_by_period[0].start), Date.parse(st.start));
assert.equal(l.charged, Math.min(l.funds, ((st.bytes_up + st.bytes_down) * 250) / 1e9));
// Guest-signed claim: the claim key signs the cumulative owed for (buyer, terms) under GuestEscrow's per-buyer domain, and the
// key's attestation (report_data = key || operator) decodes to registerGuestKey calldata with dsmack's guest_register.py.
const gc = st.guest_claim, gk = JSON.parse(fs.readFileSync(g.out + "/guest-key", "utf8"));
assert.deepEqual([gc.escrow, gc.buyer, gc.terms_hash, gc.operator, gc.cumulative_owed, gc.key.toLowerCase(), gk.operator], [h.env.GUEST_ESCROW, WALLET, TERMS, h.env.OPERATOR, st.owed, gk.address, h.env.OPERATOR]);
const signer = verifyTypedData({ name: "LayoverGuestEscrow", version: "1", chainId: Number(h.env.CHAIN_ID), verifyingContract: h.env.GUEST_ESCROW, salt: zeroPadValue(WALLET, 32) },
  { Claim: [{ name: "operator", type: "address" }, { name: "termsHash", type: "bytes32" }, { name: "cumulativeOwed", type: "uint256" }] },
  { operator: gc.operator, termsHash: gc.terms_hash, cumulativeOwed: gc.cumulative_owed }, gc.signature);
assert.equal(signer.toLowerCase(), gk.address);
// The harness's stand-in assertion has no signature, so check report_data (guest_register.py's own test uses a real assertion).
const rd = (await run("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(DSMACK + "/dstack-compat")}); import guest_attest; print(guest_attest.verify(bytes.fromhex(sys.argv[1]))["report_data"].hex())`, gk.attestation])).stdout.trim();
assert.equal(rd, zeroPadValue(gk.address, 32).slice(2).toLowerCase() + zeroPadValue(h.env.OPERATOR, 32).slice(2));
show("guest claim", { key: gk.address, cumulative_owed: gc.cumulative_owed });
// The same buyer and terms hash on UsageEscrow: the statement names UsageEscrow and owes bytes x price, and the guest signs no claim.
const { id: lb, decision: db } = await h.lease(A, "shared", 1, { ...base, term_minutes: 1, escrow: h.env.ESCROW });
assert.equal(db.decision, "accept");
h.proxy(A, lb, 18842);
await sleep(2000);
await get(18842);
const sb = (await until(async () => { const x = await h.getAs(A, "leases/" + lb); return x.status !== "active" && x; }, 2000)).end.statement;
assert.deepEqual([sb.escrow, sb.buyer_wallet, sb.terms_hash, sb.guest_claim], [h.env.ESCROW, WALLET, TERMS, null]);
assert.ok(BigInt(sb.owed) > 0n);
const all = fs.readFileSync(g.out + "/claims", "utf8").trim().split("\n").map((x) => JSON.parse(x));
assert.ok(all.length >= 2 && all[0].signature === mid[0].signature && BigInt(all[0].cumulative_owed) < BigInt(gc.cumulative_owed));
assert.deepEqual(all.at(-1).signature, gc.signature);
show("UsageEscrow lease", { owed: sb.owed, guest_claim: sb.guest_claim, claims: 1 });
const pub = await h.get(`leases/${la}/statement`);
assert.deepEqual([pub.bytes_up, pub.bytes_down, pub.bytes_by_period], [st.bytes_up, st.bytes_down, st.bytes_by_period]);
const verifiedStatus = await h.cli("status", A, la);
h.wantOut(verifiedStatus, "receipts chain ok");
h.wantOut(verifiedStatus, "statement verified (unsigned-test-fixture)");
console.log(`ok: two 3 MiB pages = ${st.bytes_down} bytes down (heads ${st.bytes_down - 6 * MiB}), ${st.bytes_up} up; charged ${l.charged} of ${l.funds} cents; lapsed past paid_bytes; owed ${st.owed} token units`);
process.exit(0);

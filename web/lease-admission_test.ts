import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Wallet } from "npm:ethers@6.13.4/wallet";
import { keccak256 } from "npm:ethers@6.13.4/crypto";
import { Bad, canonical, hex, sha256 } from "./verify.ts";
import { admissionSnapshot, checkAdmission, ADMISSION_ESCROW, ADMISSION_SITE, ADMISSION_SERVICE, ADMISSION_TOKEN } from "./lease-admission.ts";

const signer = new Wallet("0x" + "12".repeat(32)), wallet = "0x" + "34".repeat(20), operator = "0x" + "56".repeat(20), hash = "0x" + "78".repeat(32);
const now = Math.floor(Date.now() / 1000), account = "ab".repeat(32);
async function fixture() {
  const agent = { agent_id: "host", enc_pub: "cd".repeat(32), facts: { run: "run" }, at: "2026-11-06T00:00:00.000Z" };
  const terms = canonical({ kind: "layover-terms/1", chain_id: 84532, escrow: ADMISSION_ESCROW, token: ADMISSION_TOKEN, thread: "thread-1", agent_id: "host", mode: "shared", domains: ["example.com"], category: "price_check", minutes: 5, operator, price_per_gb: 200, cap: "200001" });
  const enc = { epk: "11".repeat(32), nonce: "22".repeat(12), ct: "33".repeat(40) };
  const admission = { kind: "layover-lease-admission/1", chain_id: "84532", escrow: ADMISSION_ESCROW, audience: ADMISSION_SITE, service: ADMISSION_SERVICE, account, wallet, agent_id: "host", agent_run: "run", enc_pub: agent.enc_pub, registration_at: agent.at, terms_hash: keccak256(new TextEncoder().encode(terms)), terms, operator, cap: "200001", exclusive: false, price_per_gb: 200, enc_sha256: hex(await sha256(new TextEncoder().encode(canonical(enc)))), nonce: "45".repeat(32), issued_at: now, expires_at: now + 90, backing_block: 123, backing_block_hash: hash };
  const snapshot = { verified_by: "helios-opstack", chain_id: "84532", escrow: ADMISSION_ESCROW, wallet, terms_hash: admission.terms_hash, block: 124, block_hash: hash, block_timestamp: now - 1, operator, cap: "200001", closed_at: "0", released: false, balance: "200001", exposure: "200001", total_claimed: "0" };
  const body = { admission, signature: await signer.signMessage(canonical(admission)), enc, agent_id: "host", deposit: 0, exclusive: false, terms_hash: admission.terms_hash };
  return { body, agent, snapshot };
}
Deno.test("token admission: byte cap rounds down from backed unclaimed LAYC units", async () => {
  const { body, agent, snapshot } = await fixture();
  const r = await checkAdmission(body, account, agent, signer.address, async () => snapshot, now);
  assertEquals(r.token_budget_bytes, 100000500); assertEquals(r.token_reserved_units, "200001");
});
Deno.test("token admission: rejects changed signature/envelope/account and every financial domain binding", async () => {
  for (const [field, value] of Object.entries({ kind: "other", chain_id: "1", escrow: wallet, service: "https://evil", audience: "https://evil", account: "ee".repeat(32), agent_id: "other", agent_run: "other", enc_pub: "ee".repeat(32), registration_at: "other", terms_hash: hash, operator: wallet, cap: "1", exclusive: true, price_per_gb: 0, enc_sha256: "ee".repeat(32), nonce: "", expires_at: now, issued_at: now - 121, terms: "{}" })) {
    const { body, agent, snapshot } = await fixture();
    (body.admission as Record<string, unknown>)[field] = value;
    body.signature = await signer.signMessage(canonical(body.admission));
    await assertRejects(() => checkAdmission(body, account, agent, signer.address, async () => snapshot, now), Bad);
  }
  const { body, agent, snapshot } = await fixture();
  body.enc.ct = "44".repeat(40);
  await assertRejects(() => checkAdmission(body, account, agent, signer.address, async () => snapshot, now), Bad);
  await assertRejects(() => checkAdmission(body, account, agent, undefined, async () => snapshot, now), Bad);
  await assertRejects(() => checkAdmission(body, account, agent, wallet, async () => snapshot, now), Bad);
});
Deno.test("token admission: fails closed on stale, unverified, unfunded, changed or closed chain terms", async () => {
  for (const [field, value] of Object.entries({ verified_by: "rpc", chain_id: "1", block_timestamp: now - 121, block_hash: "bad", wallet: operator, terms_hash: hash, operator: wallet, cap: "1", closed_at: "1", released: true, balance: "200000", exposure: "200000", total_claimed: "200001" })) {
    const { body, agent, snapshot } = await fixture();
    (snapshot as Record<string, unknown>)[field] = value;
    await assertRejects(() => checkAdmission(body, account, agent, signer.address, async () => snapshot, now), Bad);
  }
});
Deno.test("token admission: pins every raw call to one recent verified head and rejects mixed block metadata", async () => {
  const meta = { verified_by: "helios-opstack", block: 123, block_hash: hash, depth: 30, head_age_s: 1, block_timestamp: now - 1 };
  const calls: Record<string, string>[] = [];
  const read = async (path: string, q: Record<string, string>) => {
    if (path === "/head") return meta;
    calls.push(q);
    const word = (n: bigint) => n.toString(16).padStart(64, "0");
    return { ...meta, to: ADMISSION_ESCROW, result: q.data.startsWith("0x8d3e7a69") ? "0x" + operator.slice(2).padStart(64, "0") + word(200001n) + word(0n) + word(0n) : q.data === "0xfc0c546a" ? "0x" + ADMISSION_TOKEN.slice(2).padStart(64, "0") : "0x" + word(200001n) };
  };
  const r = await admissionSnapshot(wallet, hash, read);
  assertEquals(r.block, 123); assertEquals(calls.length, 5);
  assertEquals(calls.every((q) => q.block === hash), true);
  await assertRejects(() => admissionSnapshot(wallet, hash, async (p, q) => ({ ...await read(p, q), ...(p === "/call" ? { block_hash: "0x" + "01".repeat(32) } : {}) })), Bad);
  await assertRejects(() => admissionSnapshot(wallet, hash, async (p, q) => ({ ...await read(p, q), head_age_s: 121 })), Bad);
});

Deno.test("token admission: atomic nonce/pair reservation survives restart and never touches staging credit", async () => {
  const { configure, handler } = await import("./server.ts");
  const dir = await Deno.makeTempDir(), restart = await Deno.makeTempDir();
  const f = await fixture(), secret = "ab".repeat(32);
  const bearer = hex(await sha256(new Uint8Array(32).fill(0xab)));
  f.body.admission.account = bearer;
  f.body.signature = await signer.signMessage(canonical(f.body.admission));
  const att = (await Deno.readTextFile(new URL("./server_test.ts", import.meta.url))).match(/const att = "([0-9a-f]+)"/)![1];
  await Deno.writeTextFile(dir + "/records.jsonl", JSON.stringify({ kind: "agent", ...f.agent, facts: undefined, attestation: att, coarse: { region: "us", isp_class: "cable", residential: true } }) + "\n");
  configure({ custody: "http://custody/", operators: async () => [operator], verify: (async () => ({ ok: true, mode: null, facts: { run: "run", key_id: "key", manifest_sha256: "m", os_image_hash: "o" }, checks: [], checked_at: "" })) as never });
  const real = globalThis.fetch, w = (n: bigint) => n.toString(16).padStart(64, "0");
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.hostname === "custody") return Response.json({ operator, allowed: { manifests: ["m"], os_image_hashes: ["o"] } });
    const meta = { verified_by: "helios-opstack", block: 123, block_hash: hash, depth: 30, head_age_s: 1, block_timestamp: now - 1 };
    if (u.pathname.endsWith("/head")) return Response.json(meta);
    if (u.pathname.endsWith("/call")) {
      const data = u.searchParams.get("data")!;
      return Response.json({ ...meta, to: ADMISSION_ESCROW, result: data.startsWith("0x8d3e7a69") ? "0x" + operator.slice(2).padStart(64, "0") + w(200001n) + w(0n) + w(0n) : data === "0xfc0c546a" ? "0x" + ADMISSION_TOKEN.slice(2).padStart(64, "0") : "0x" + w(data.startsWith("0xae78ba6e") ? 0n : 200001n) });
    }
    return Response.json({});
  }) as typeof fetch;
  const env = { LEASE_ADMISSION_SIGNER: signer.address, REQUIRE_LEASE_ADMISSION: "true" };
  const post = (body = f.body, dataDir = dir) => handler(new Request("http://x/api/leases", { method: "POST", headers: { authorization: "Bearer " + secret }, body: JSON.stringify(body) }), { dataDir, env });
  try {
    const results = await Promise.all([post(), post()]);
    assertEquals(results.map((r) => r.status).sort(), [200, 400]);
    const saved = (await Deno.readTextFile(dir + "/records.jsonl")).trim().split("\n").map(JSON.parse);
    const leases = saved.filter((r) => r.kind === "lease");
    assertEquals(leases.length, 1); assertEquals(leases[0].deposit, 0); assertEquals(leases[0].token_budget_bytes, 100000500);
    assertEquals(saved.some((r) => r.kind === "credit" || r.kind === "lease_topup"), false);
    await Deno.copyFile(dir + "/records.jsonl", restart + "/records.jsonl");
    assertEquals((await post(f.body, restart)).status, 400);
    const freshNonce = structuredClone(f.body); freshNonce.admission.nonce = "67".repeat(32); freshNonce.signature = await signer.signMessage(canonical(freshNonce.admission));
    assertEquals((await post(freshNonce, restart)).status, 400);
    const badProof = structuredClone(f.body); badProof.signature = "bad"; badProof.deposit = 20;
    assertEquals((await post(badProof)).status, 400); // failure cannot downgrade to staging.
    const noProof = { ...f.body, admission: undefined, signature: undefined };
    assertEquals((await post(noProof as typeof f.body)).status, 400);
  } finally {
    globalThis.fetch = real;
    await Deno.remove(dir, { recursive: true }); await Deno.remove(restart, { recursive: true });
  }
});

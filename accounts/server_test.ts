// deno test -A accounts/server_test.ts — needs anvil (foundry) on PATH. A local chain with LAYC and GuestEscrow (vendored
// bytecode from amiller/dsmack contracts/out, MockGuestAttest from its GuestEscrow tests) and a stub souk that mails no
// mail: its code for every challenge is 123456. The last test runs the bundled service the way the webhost container does.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Wallet } from "npm:ethers@6.13.4/wallet";
import { Interface } from "npm:ethers@6.13.4/abi";
import handler, { abi } from "./server.ts";

const dir = new URL(".", import.meta.url).pathname;
const fixture = (n: string) => JSON.parse(Deno.readTextFileSync(dir + "fixtures/" + n + ".json"));
// anvil's first two default accounts: the pot (LAYC owner and genesis holder) and a faucet for the relayer's ETH.
const POT = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SOUK_ID = "31f5c141-fb2d-4572-939a-68543a2d0649", PORT = 18545 + Math.floor(Math.random() * 1000), RPC = `http://127.0.0.1:${PORT}`;

async function rpc(method: string, params: unknown[]) {
  const j = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function tx(from: string, to: string | null, data: string, value = "0x0") {
  const hash = await rpc("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, value }]);
  let rc;
  while (!(rc = await rpc("eth_getTransactionReceipt", [hash]))) await new Promise((r) => setTimeout(r, 50));
  assertEquals(rc.status, "0x1");
  return rc;
}
const deploy = async (from: string, name: string, types: string[], args: unknown[]) =>
  (await tx(from, null, fixture(name).bytecode + new Interface([`constructor(${types.join(",")})`]).encodeDeploy(args).slice(2))).contractAddress;
const view = async (to: string, fn: string, args: unknown[]) => abi.decodeFunctionResult(fn, await rpc("eth_call", [{ to, data: abi.encodeFunctionData(fn, args) }, "latest"]));

async function setup() {
  const anvil = new Deno.Command("anvil", { args: ["--port", String(PORT), "--silent"], stdout: "null", stderr: "null" }).spawn();
  for (let i = 0; ; i++) {
    try { await rpc("eth_chainId", []); break; } catch (e) { if (i > 50) throw e; await new Promise((r) => setTimeout(r, 100)); }
  }
  const [pot, faucet] = await rpc("eth_accounts", []);
  const token = await deploy(pot, "LayoverCredit", ["address", "uint256"], [pot, 1_000_000_000_000n]);
  // GuestEscrow checks attest.registry() == itself: the mock names the escrow's address, the deployer's next create.
  const next = BigInt(await rpc("eth_getTransactionCount", [pot, "latest"])) + 1n;
  const predicted = "0x" + (await import("npm:ethers@6.13.4/address")).getCreateAddress({ from: pot, nonce: next }).slice(2);
  const attest = await deploy(pot, "MockGuestAttest", ["address"], [predicted]);
  const escrow = await deploy(pot, "GuestEscrow", ["address", "address", "address"], [token, pot, attest]);
  assertEquals(escrow.toLowerCase(), predicted.toLowerCase());
  const codes = new Map<string, string>();
  const soukServer = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const b = await req.json(), path = new URL(req.url).pathname;
    if (path === "/api/auth/code") { const id = crypto.randomUUID(); codes.set(id, b.email); return Response.json({ challenge_id: id }); }
    // Like souk Dev: the real code, or 000000 for anyone.
    if (path === "/api/auth/verify") return codes.has(b.challenge_id) && ["123456", "000000"].includes(b.code)
      ? Response.json({ person: "p-" + codes.get(b.challenge_id), token: "souk." + b.challenge_id }) : Response.json({ error: "Wrong sign-in code." }, { status: 401 });
    // Only bob was never invited to the IP souk.
    if (path === "/api/souk_list") return Response.json(req.headers.get("authorization")?.startsWith("Bearer souk.") && !codes.get(req.headers.get("authorization")!.slice(12))?.startsWith("bob")
      ? [{ souk_id: SOUK_ID, name: "IP souk", roles: ["buyer"] }] : []);
    return Response.json({ error: "unknown endpoint" }, { status: 404 });
  });
  const env = { ACCOUNTS_SEED: Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join(""),
    RPC, TOKEN: token, ESCROW: escrow, CHAIN_ID: "31337", SOUK_URL: `http://127.0.0.1:${soukServer.addr.port}`, SOUK_ID, POT_KEY: POT, STARTER: "50000000", STARTERS_PER_DAY: "100", RELAYS_PER_DAY: "10" };
  const ctx = { env, dataDir: await Deno.makeTempDir() };
  const relayer = (await (await handler(new Request("http://x/api/info"), ctx)).json()).relayer;
  await tx(faucet, relayer, "0x", "0xde0b6b3a7640000");
  return { anvil, soukServer, ctx, token, escrow, pot, faucet, close: async () => { anvil.kill(); await anvil.status; await soukServer.shutdown(); } };
}

type S = Awaited<ReturnType<typeof setup>>;
const req = (s: S, path: string, body?: unknown, session?: string) =>
  handler(new Request("http://x/api" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(session ? { authorization: "Bearer " + session } : {}) }, body: body ? JSON.stringify(body) : undefined }), s.ctx)
    .then(async (r) => ({ status: r.status, body: await r.json() }));
async function signIn(s: S, email: string) {
  const { body: { challenge_id } } = await req(s, "/login", { email });
  const r = await req(s, "/verify", { challenge_id, code: "123456" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const [H1, H2, H3, H4, H5, H6] = [1, 2, 3, 4, 5, 6].map((n) => "0x" + n.toString().repeat(64)), OP = "0x" + "77".repeat(20);

Deno.test("accounts on a local chain", async (t) => {
  const s = await setup();
  try {
    await t.step("unauthenticated and forged requests are refused", async () => {
      for (const [p, b] of [["/close", { termsHash: H1 }], ["/lease-authorization", {}], ["/balance", undefined], ["/accept", { termsHash: H1, operator: OP, cap: "1", deposit: "1" }], ["/withdraw", { to: OP, amount: "1" }], ["/export", { confirm: "a@b.co" }]] as const) {
        assertEquals((await req(s, p, b)).status, 401, p);
        assertEquals((await req(s, p, b, "eyJlIjoiYUBiLmNvIiwieCI6OTk5OTk5OTk5OTk5OX0.AAAA")).status, 401, p + " forged");
      }
      const { body: { challenge_id } } = await req(s, "/login", { email: "Mallory@Example.org" });
      assertEquals((await req(s, "/verify", { challenge_id, code: "000000" })).status, 401, "the souk Dev test code");
      assertEquals((await req(s, "/verify", { challenge_id, code: "654321" })).status, 401, "a wrong code");
      assertEquals((await req(s, "/verify", { challenge_id: crypto.randomUUID(), code: "123456" })).status, 401, "a challenge this service did not start");
    });

    await t.step("sign-in pays starter credit once per email", async () => {
      const a = await signIn(s, "Alice@Example.com ");
      assertEquals(a.email, "alice@example.com");
      assertEquals(a.souk.token.startsWith("souk."), true);
      assert(a.starter.tx, JSON.stringify(a.starter));
      console.log("starter transfer gas", a.starter.gas_used);
      const again = await signIn(s, "alice@example.com");
      assertEquals(again.address, a.address);
      assertEquals(again.starter, null);
      assertEquals((await signIn(s, "ALICE@example.com")).starter, null);
      assertEquals((await req(s, "/balance", undefined, a.session)).body.wallet, "50000000");
      assertEquals((await view(s.token, "balanceOf", [a.address]))[0], 50_000_000n);
    });

    await t.step("lease admission authenticates the session and rejects opaque envelopes before any financial read", async () => {
      const a = await signIn(s, "alice@example.com");
      const invalid = await req(s, "/lease-authorization", { enc: { ct: "caller ciphertext" }, buyer_wallet: OP }, a.session);
      assertEquals(invalid.status, 400);
      assert(invalid.body.error.includes("only agent_id"));
      assertEquals((await req(s, "/lease-authorization", undefined, a.session)).status, 400, "POST required");
      const info = await req(s, "/info");
      assert(/^0x[0-9a-fA-F]{40}$/.test(info.body.admission_signer));
      assert(info.body.admission_signer !== a.address && info.body.admission_signer !== info.body.relayer);
    });

    await t.step("accept deposits and accepts terms; replays and over-commitment are refused", async () => {
      const a = await signIn(s, "alice@example.com");
      const r = await req(s, "/accept", { termsHash: H1, operator: OP, cap: "30000000", deposit: "30000000" }, a.session);
      assertEquals(r.status, 200, JSON.stringify(r.body));
      console.log("accept gas", r.body.tx.gas_used);
      // The deposit is its own transaction and is returned beside the accept.
      assertEquals(r.body.deposit_tx.fn, "depositWithAuthorization");
      assert(/^0x[0-9a-f]{64}$/.test(r.body.deposit_tx.tx) && r.body.deposit_tx.tx !== r.body.tx.tx, JSON.stringify(r.body));
      assertEquals([r.body.wallet, r.body.escrow, r.body.exposure, r.body.withdrawable], ["20000000", "30000000", "30000000", "0"]);
      const terms = await view(s.escrow, "terms", [a.address, H1]);
      assertEquals([terms[0].toLowerCase(), terms[1], terms[2]], [OP, 30_000_000n, 0n]);
      // Open terms count against the escrow balance: nothing is sent for terms the balance could not cover.
      const over = await req(s, "/accept", { termsHash: H2, operator: OP, cap: "10000000", deposit: "0" }, a.session);
      assertEquals(over.status, 400);
      assert(over.body.error.includes("more than the escrow balance"), over.body.error);
      assertEquals((await view(s.escrow, "terms", [a.address, H2]))[0], "0x0000000000000000000000000000000000000000");
      assertEquals((await req(s, "/accept", { termsHash: H2, operator: OP, cap: "1", deposit: "20000001" }, a.session)).status, 400, "a deposit beyond the wallet");
      // The same request again (a retry) changes nothing; the same hash with other terms is refused.
      const again = await req(s, "/accept", { termsHash: H1, operator: OP, cap: "30000000", deposit: "30000000" }, a.session);
      assertEquals([again.status, again.body.already, again.body.escrow, again.body.wallet], [200, true, "30000000", "20000000"]);
      const other = await req(s, "/accept", { termsHash: H1, operator: OP, cap: "1", deposit: "0" }, a.session);
      assertEquals(other.status, 400);
      assert(other.body.error.includes("already accepted"), other.body.error);
      // Concurrent accepts cannot both claim the same free balance.
      const race = await Promise.all([H3, H4].map((h) => req(s, "/accept", { termsHash: h, operator: OP, cap: "5000000", deposit: "5000000" }, a.session)));
      assertEquals(race.map((x) => x.status), [200, 200]);
      assertEquals([race[1].body.wallet, race[1].body.escrow, race[1].body.exposure], ["10000000", "40000000", "40000000"]);
      const race2 = await Promise.all([H5, H6].map((h) => req(s, "/accept", { termsHash: h, operator: OP, cap: "1", deposit: "0" }, a.session)));
      assertEquals(race2.map((x) => x.status), [400, 400], "no free escrow balance");
    });

    await t.step("withdraw: wallet first, escrow only down to exposure; close and the claim grace free the rest", async () => {
      const a = await signIn(s, "alice@example.com"), to = Wallet.createRandom().address, bal = async () => (await req(s, "/balance", undefined, a.session)).body;
      const refuse = async (b: unknown, text: string) => { const x = await req(s, "/withdraw", b, a.session); assertEquals(x.status, 400, JSON.stringify(x.body)); assert(x.body.error.includes(text), x.body.error); };
      await refuse({ to, amount: "0" }, "more than 0");
      await refuse({ to: a.address, amount: "1" }, "this wallet itself");
      await refuse({ to, amount: "10000001" }, "can release 0");
      const w = await req(s, "/withdraw", { to, amount: "10000000" }, a.session);
      assertEquals([w.status, w.body.from_escrow, w.body.wallet, w.body.escrow], [200, "0", "0", "40000000"], JSON.stringify(w.body));
      assertEquals((await view(s.token, "balanceOf", [to]))[0], 10_000_000n);
      await refuse({ to, amount: "1" }, "can release 0");

      const closed = await req(s, "/close", { termsHash: H1 }, a.session);
      assertEquals(closed.status, 200, JSON.stringify(closed.body));
      assertEquals((await view(s.escrow, "terms", [a.address, H1]))[2] > 0n, true);
      // Simulate a caller whose successful close reply was lost: the retry reads closure and sends nothing.
      const relayer = (await req(s, "/info")).body.relayer;
      const beforeNonce = await rpc("eth_getTransactionCount", [relayer, "latest"]);
      const beforeLedger = await Deno.readTextFile(s.ctx.dataDir + "/ledger.jsonl");
      const replay = await req(s, "/close", { termsHash: H1 }, a.session);
      assertEquals(replay.status, 200, JSON.stringify(replay.body));
      assertEquals([replay.body.closed, replay.body.already, replay.body.tx], [H1, true, null]);
      const closedAt = Number((await view(s.escrow, "terms", [a.address, H1]))[2]);
      assertEquals([replay.body.closed_at, replay.body.claimable_until], [closedAt, closedAt + 86400]);
      assertEquals(await rpc("eth_getTransactionCount", [relayer, "latest"]), beforeNonce, "no retransmitted transaction");
      assertEquals(await Deno.readTextFile(s.ctx.dataDir + "/ledger.jsonl"), beforeLedger, "no second budget/close record");
      const other = await signIn(s, "other-close@example.com");
      assertEquals((await req(s, "/close", { termsHash: H1 }, other.session)).status, 400, "another wallet cannot inherit this closure");
      assertEquals((await req(s, "/close", { termsHash: H5 }, a.session)).status, 400, "never accepted");
      await refuse({ to, amount: "1" }, "can release 0");
      assertEquals((await bal()).exposure, "40000000", "still exposed during the claim grace");

      await rpc("evm_increaseTime", [86401]);
      await rpc("evm_mine", []);
      const after = await bal();
      assertEquals([after.releasable, after.exposure, after.withdrawable], [[H1], "10000000", "30000000"]);
      await refuse({ to, amount: "30000001" }, "can release 30000000");
      const out = await req(s, "/withdraw", { to, amount: "30000000" }, a.session);
      assertEquals([out.status, out.body.from_escrow, out.body.wallet, out.body.escrow, out.body.exposure, out.body.withdrawable], [200, "30000000", "0", "10000000", "10000000", "0"], JSON.stringify(out.body));
      assertEquals((await view(s.token, "balanceOf", [to]))[0], 40_000_000n);
      assertEquals((await view(s.escrow, "terms", [a.address, H1]))[3], true, "released on chain");
      await refuse({ to, amount: "1" }, "can release 0");
    });

    await t.step("each email has a daily budget of relayed transactions, and one user's spam does not block another", async () => {
      const d = await signIn(s, "dave@example.com"), e = await signIn(s, "erin@example.com");
      const spam = Array.from({ length: 8 }, (_, i) => req(s, "/accept", { termsHash: "0x" + (i + 16).toString(16).padStart(64, "0"), operator: OP, cap: "1", deposit: "1" }, d.session));
      const erin = await req(s, "/accept", { termsHash: H1, operator: OP, cap: "1000000", deposit: "1000000" }, e.session);
      assertEquals(erin.status, 200, JSON.stringify(erin.body));
      const results = await Promise.all(spam);
      assertEquals(results.filter((x) => x.status === 200).length, 5, "10 transactions: five accepts with a deposit");
      assert(results.filter((x) => x.status === 400).every((x) => x.body.error.includes("daily limit")), JSON.stringify(results.map((x) => x.body)));
    });

    await t.step("export needs a session, the email and a fresh mailed code", async () => {
      const a = await signIn(s, "alice@example.com"), b = await signIn(s, "bob@example.com");
      assertEquals((await req(s, "/export", { confirm: "alice@example.com" })).status, 401);
      assertEquals((await req(s, "/export", { confirm: "alice@example.com" }, b.session)).status, 400, "bob's session cannot export alice");
      assertEquals((await req(s, "/export", {}, a.session)).status, 400);
      const started = await req(s, "/export", { confirm: "alice@example.com" }, a.session);
      assertEquals([started.status, started.body.private_key, started.body.code_sent_to], [200, undefined, "alice@example.com"]);
      const id = started.body.challenge_id;
      assertEquals((await req(s, "/export", { confirm: "alice@example.com", challenge_id: id, code: "000000" }, a.session)).status, 401, "the souk Dev test code");
      assertEquals((await req(s, "/export", { confirm: "alice@example.com", challenge_id: id, code: "123456" }, b.session)).status, 400, "bob cannot use alice's code");
      assertEquals((await req(s, "/verify", { challenge_id: id, code: "123456" })).status, 401, "an export code does not sign in");
      const e = await req(s, "/export", { confirm: "alice@example.com", challenge_id: id, code: "123456" }, a.session);
      assertEquals(new Wallet(e.body.private_key).address, a.address);
      assertEquals((await req(s, "/export", { confirm: "alice@example.com", challenge_id: id, code: "123456" }, a.session)).status, 401, "a code works once");
      assert(b.address !== a.address);
      assert(b.starter.skipped.includes("not a member"), "no starter credit for an email the doorman never invited");
    });

    await t.step("relay/claim pays the terms' operator from a site statement once; a forged claim sends nothing", async () => {
      const { sha256, solidityPacked, AbiCoder, toUtf8Bytes } = await import("npm:ethers@6.13.4");
      const esc = new Interface(["function setWorkload(bytes32,bytes32,bytes32,bool)", "function registerGuestKey(address,address,(bytes32,bytes32,bytes32,bytes32),(string,bytes)[],bytes)"]);
      const c = await signIn(s, "carol@example.com"), guest = Wallet.createRandom(), op = "0x" + "88".repeat(20), coder = AbiCoder.defaultAbiCoder();
      assertEquals((await req(s, "/accept", { termsHash: H6, operator: op, cap: "1000000", deposit: "1000000" }, c.session)).status, 200);
      const [img, man, run, caller] = [7, 8, 9, 10].map((n) => "0x" + n.toString(16).padStart(2, "0").repeat(32));
      await tx(s.pot, s.escrow, esc.encodeFunctionData("setWorkload", [img, man, caller, true]));
      const head = sha256(solidityPacked(["bytes32", "bytes32"], ["0x" + "00".repeat(32), sha256(solidityPacked(["uint32", "string", "uint32"], [12, "system-ready", 0]))]));
      const context = sha256(solidityPacked(["bytes", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes"],
        [toUtf8Bytes("dsmack.appattest.guest-attest/1"), img, man, run, head, caller, coder.encode(["address", "address"], [guest.address, op])]));
      await tx(s.pot, s.escrow, esc.encodeFunctionData("registerGuestKey", [guest.address, op, [img, man, run, caller], [["system-ready", "0x"]], coder.encode(["bytes32", "bytes32"], [context, "0x" + "cd".repeat(32)])]));
      const domain = { name: "LayoverGuestEscrow", version: "1", chainId: 31337, verifyingContract: s.escrow, salt: "0x" + c.address.slice(2).toLowerCase().padStart(64, "0") };
      const types = { Claim: [{ name: "operator", type: "address" }, { name: "termsHash", type: "bytes32" }, { name: "cumulativeOwed", type: "uint256" }] };
      const claim = async (w: { address: string; signTypedData: Wallet["signTypedData"] }, owed: string) => ({ escrow: s.escrow, key: w.address, buyer: c.address, terms_hash: H6, operator: op, cumulative_owed: owed,
        signature: await w.signTypedData(domain, types, { operator: op, termsHash: H6, cumulativeOwed: owed }) });
      const statements: Record<string, unknown> = { "11111111-1111-1111-1111-111111111111": await claim(guest, "400000"), "22222222-2222-2222-2222-222222222222": await claim(Wallet.createRandom(), "900000"), "33333333-3333-3333-3333-333333333333": { buyer: "nope" } };
      const site = Deno.serve({ port: 0, onListen() {} }, (r) => Response.json({ guest_claim: statements[new URL(r.url).pathname.split("/")[3]] ?? null }));
      (s.ctx.env as Record<string, string>).SITE = `http://127.0.0.1:${site.addr.port}`;
      try {
        const nonce = async () => BigInt(await rpc("eth_getTransactionCount", [(await (await handler(new Request("http://x/api/info"), s.ctx)).json()).relayer, "latest"]));
        const before = await nonce();
        const forged = await req(s, "/relay/claim", { lease_id: "22222222-2222-2222-2222-222222222222" });
        assertEquals(forged.status, 400);
        assert(forged.body.error.includes("guest key not registered"), forged.body.error);
        assertEquals(await nonce(), before, "a refused claim sends no transaction");
        const junk = await req(s, "/relay/claim", { lease_id: "33333333-3333-3333-3333-333333333333" });
        assertEquals(junk.status, 400, "a malformed site record is a refusal, not a 500");
        const paid = await req(s, "/relay/claim", { lease_id: "11111111-1111-1111-1111-111111111111" });
        assertEquals([paid.status, paid.body.fn, paid.body.operator], [200, "claim", op], JSON.stringify(paid.body));
        assertEquals((await view(s.token, "balanceOf", [op]))[0], 400000n);
        assertEquals((await view(s.escrow, "paid", [c.address]))[0], 400000n);
        assertEquals((await req(s, "/relay/claim", { lease_id: "11111111-1111-1111-1111-111111111111" })).body.already, true);
        assertEquals(await nonce(), before + 1n);
      } finally { delete (s.ctx.env as Record<string, string>).SITE; await site.shutdown(); }
    });

    await t.step("registerArgs builds guest_register.py's calldata from a guest key attestation and refuses a mismatched address", async () => {
      const { registerArgs } = await import("./guest_relay.ts");
      const { deviceKey, attest } = await import("../couch/testdata/synthetic-guest.mjs");
      const key = Wallet.createRandom().address.toLowerCase(), op = "0x1fbe7a7b3f7a37a967f3d927abd6f04db2766c5b", rd = new Uint8Array(64), b = (h: string) => Uint8Array.from(h.slice(2).match(/../g)!, (x) => parseInt(x, 16));
      rd.set(b(key), 12); rd.set(b(op), 44);
      const f = (n: number) => new Uint8Array(32).fill(n);
      const blob = await attest(await deviceKey(), { os_image_hash: f(1), manifest_sha256: f(2), run: f(3), caller: f(4), report_data: rd, rp: f(5), cdhash: f(6), category: 1 });
      const [k, o, a, ev] = await registerArgs({ address: key, operator: op, attestation: blob }) as any[];
      assertEquals([k, o, a, ev.length, ev.at(-1)[0]], [key, op, ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32), "0x" + "04".repeat(32)], 1, "system-ready"]);
      await assertRejects(() => registerArgs({ address: "0x" + "00".repeat(19) + "01", operator: op, attestation: blob }), Error, "differ from the attested report_data");
    });

    await t.step("the bundled service runs under the container's deny flags", async () => {
      const out = await Deno.makeTempDir(), shim = out + "/_entry.ts";
      const b = await new Deno.Command("deno", { args: ["bundle", "--platform=deno", dir + "server.ts", "-o", out + "/server.ts"], stdout: "null", stderr: "piped" }).output();
      assertEquals(b.code, 0, new TextDecoder().decode(b.stderr));
      // The webhost's _ENTRY_SHIM_DENO, on a free port instead of 3000.
      const port = PORT + 1000;
      await Deno.writeTextFile(shim, `const [ENTRY, FILES, DATA, ENV_JSON] = Deno.args; const env = JSON.parse(ENV_JSON || "{}");
const handler = (await import(\`file://\${FILES}/\${ENTRY}\`)).default; Deno.serve({ port: ${port} }, (req) => handler(req, { env, dataDir: DATA }));`);
      const p = new Deno.Command("deno", { args: ["run", "--no-prompt", `--allow-read=${out}`, "--allow-net", "--deny-env", "--deny-ffi", "--deny-run", "--deny-sys",
        `--allow-write=${s.ctx.dataDir}`, shim, "server.ts", out, s.ctx.dataDir, JSON.stringify(s.ctx.env)], stdout: "null", stderr: "null" }).spawn();
      try {
        let info;
        for (let i = 0; ; i++) {
          try { info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json(); break; } catch (e) { if (i > 100) throw e; await new Promise((r) => setTimeout(r, 100)); }
        }
        assertEquals(info.escrow, s.escrow);
        assertEquals(info.pot, new Wallet(POT).address);
      } finally { p.kill(); await p.status; }
    });
  } finally { await s.close(); }
});

Deno.test("keys differ per email and per seed, and are stable", async () => {
  const { userWallet } = await import("./server.ts");
  const env = { ACCOUNTS_SEED: "ab".repeat(32) };
  assertEquals((await userWallet(env, "A@x.co")).address, (await userWallet(env, " a@x.co")).address);
  assertEquals((await userWallet(env, "jose\u0301@x.co")).address, (await userWallet(env, "jos\u00e9@x.co")).address, "NFD and NFC are one wallet");
  assert((await userWallet(env, "a@x.co")).address !== (await userWallet(env, "b@x.co")).address);
  assert((await userWallet(env, "a@x.co")).address !== (await userWallet({ ACCOUNTS_SEED: "cd".repeat(32) }, "a@x.co")).address);
  await assertRejects(() => userWallet({ ACCOUNTS_SEED: "" }, "a@x.co"));
});

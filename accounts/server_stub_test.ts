// deno test -A accounts/server_stub_test.ts — no anvil needed. The RPC endpoint is a loopback stub: an in-memory LAYC
// ledger that answers eth_call from a map and applies transfer/transferWithAuthorization by decoding what send() signs
// (signatures are accepted, never checked). The souk is a stub whose person ids, mailed codes and IP-souk membership the
// tests set. This pins what the anvil suite cannot: sign-ins racing the starter credit, the relay-budget boundary, export
// codes (wrong, foreign, reused, expired by a fake clock), malformed bodies, and the send-confirmation path — anvil mines
// instantly, so only here can a receipt be held back until after null polls and a lost broadcast.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import { Wallet } from "npm:ethers@6.13.4/wallet";
import { Transaction } from "npm:ethers@6.13.4/transaction";
import handler, { abi } from "./server.ts";

type Rec = Record<string, any>;
// anvil's first default account, as in server_test.ts: the pot that holds all LAYC.
const POT = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SOUK_ID = "31f5c141-fb2d-4572-939a-68543a2d0649", STARTER = 5_000_000n;

// Every transaction the service sends, as decoded from the raw bytes it signed.
type Sent = { fn: string; from: string; to: string; args: unknown[] };

async function stubChain() {
  const token = new Map<string, bigint>([[new Wallet(POT).address, 10n ** 12n]]);
  const nonces = new Map<string, number>(), receipts = new Map<string, Rec>(), sent: Sent[] = [];
  const u256 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
  const reads: Record<string, (a: any[]) => string> = {
    balanceOf: (a) => u256(token.get(a[0]) ?? 0n),
    balance: () => u256(0n), deposits: () => u256(0n), paid: () => u256(0n), exposure: () => u256(0n),
    withdrawNonce: () => u256(0n), totalClaimed: () => u256(0n), terms: () => "0x" + "0".repeat(64 * 4),
  };
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const { method, params } = await req.json();
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    switch (method) {
      case "eth_call": {
        const { data } = params[0], fn = abi.getFunction(data.slice(0, 10))!.name;
        return reply(reads[fn](abi.decodeFunctionData(fn, data)));
      }
      case "eth_getTransactionCount":
        return reply("0x" + (nonces.get(params[0]) ?? 0).toString(16));
      case "eth_sendRawTransaction": {
        // The service confirms each send by the raw tx's own hash, so the receipt is filed under that hash, not a random one.
        const tx = Transaction.from(params[0]), parsed = tx.data === "0x" ? null : abi.parseTransaction({ data: tx.data, value: tx.value });
        nonces.set(tx.from!, (nonces.get(tx.from!) ?? 0) + 1);
        if (parsed) {
          const a = [...parsed.args];
          if (parsed.fragment.name === "transfer") token.set(a[0], (token.get(a[0]) ?? 0n) + a[1]);
          if (parsed.fragment.name === "transferWithAuthorization") {
            token.set(a[0], (token.get(a[0]) ?? 0n) - a[2]);
            token.set(a[1], (token.get(a[1]) ?? 0n) + a[2]);
          }
          sent.push({ fn: parsed.fragment.name, from: tx.from!, to: tx.to!, args: a });
        }
        receipts.set(tx.hash!, { status: "0x1", gasUsed: "0x5208" });
        return reply(tx.hash);
      }
      case "eth_getTransactionReceipt":
        return reply(receipts.get(params[0]) ?? null);
      case "eth_estimateGas": return reply("0x10000");
      case "eth_gasPrice": return reply("0x1");
      case "eth_maxPriorityFeePerGas": return reply("0x1");
      case "eth_getBlockByNumber": return reply({ timestamp: "0x70000000" });
      case "eth_getBalance": return reply("0x0");
      default: return Response.json({ jsonrpc: "2.0", id: 1, error: { message: method + " is not stubbed" } });
    }
  });
  return { url: `http://127.0.0.1:${server.addr.port}`, sent, close: () => server.shutdown() };
}

// The souk: any challenge's code is 123456; person ids and IP-souk membership come from the maps below.
async function stubSouk() {
  const byCode = new Map<string, string>(), persons = new Map<string, string>(), strangers = new Set<string>();
  const personOf = (email?: string) => email && (persons.get(email) ?? "p-" + email);
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const b = await req.json(), path = new URL(req.url).pathname;
    if (path === "/api/auth/code") { const id = crypto.randomUUID(); byCode.set(id, b.email); return Response.json({ challenge_id: id }); }
    if (path === "/api/auth/verify") return byCode.has(b.challenge_id) && b.code === "123456"
      ? Response.json({ person: personOf(byCode.get(b.challenge_id)), token: "souk." + b.challenge_id })
      : Response.json({ error: "Wrong sign-in code." }, { status: 401 });
    if (path === "/api/souk_list") {
      const email = byCode.get((req.headers.get("authorization") ?? "").replace(/^Bearer souk\./, ""));
      return Response.json(email && !strangers.has(email) ? [{ souk_id: SOUK_ID, name: "IP souk", roles: ["buyer"] }] : []);
    }
    return Response.json({ error: "unknown endpoint" }, { status: 404 });
  });
  return { url: `http://127.0.0.1:${server.addr.port}`, persons, strangers, close: () => server.shutdown() };
}

async function setup() {
  const chain = await stubChain(), souk = await stubSouk();
  const env = { ACCOUNTS_SEED: Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join(""),
    RPC: chain.url, TOKEN: "0x" + "aa".repeat(20), ESCROW: "0x" + "bb".repeat(20), CHAIN_ID: "31337", SOUK_URL: souk.url, SOUK_ID,
    POT_KEY: POT, STARTER: String(STARTER), STARTERS_PER_DAY: "100", RELAYS_PER_DAY: "2" };
  return { chain, souk, ctx: { env, dataDir: await Deno.makeTempDir() }, close: async () => { await chain.close(); await souk.close(); } };
}

type S = Awaited<ReturnType<typeof setup>>;
const req = (s: S, path: string, body?: unknown, session?: string) =>
  handler(new Request("http://x/api" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(session ? { authorization: "Bearer " + session } : {}) }, body: body ? JSON.stringify(body) : undefined }), s.ctx)
    .then(async (r) => ({ status: r.status, body: await r.json() }));
// A POST whose body is the text verbatim (invalid JSON included); req() would JSON.stringify it into a valid string body.
const post = (s: S, path: string, text: string, session?: string) =>
  handler(new Request("http://x/api" + path, { method: "POST", headers: { "content-type": "application/json", ...(session ? { authorization: "Bearer " + session } : {}) }, body: text }), s.ctx)
    .then(async (r) => ({ status: r.status, body: await r.json() }));
async function signIn(s: S, email: string) {
  const { body: { challenge_id } } = await req(s, "/login", { email });
  const r = await req(s, "/verify", { challenge_id, code: "123456" });
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const ledgerRows = async (s: S) => (await Deno.readTextFile(s.ctx.dataDir + "/ledger.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

Deno.test("accounts against a stubbed loopback chain", async (t) => {
  const s = await setup();
  try {
    await t.step("starter: once per souk person even under concurrent sign-ins, exactly STARTER, members only", async () => {
      // Two mailboxes share the souk person p-alice; carol is her own person; bob never joined the IP souk.
      s.souk.persons.set("alice@example.com", "p-alice");
      s.souk.persons.set("alice+news@example.com", "p-alice");
      s.souk.persons.set("carol@example.com", "p-carol");
      s.souk.strangers.add("bob@example.com");
      const six = await Promise.all(["alice@example.com", "alice@example.com", "alice@example.com", "alice+news@example.com", "alice+news@example.com", "carol@example.com"].map((e) => signIn(s, e)));
      const rows = (await ledgerRows(s)).filter((r) => r.kind === "starter");
      assertEquals(rows.map((r) => r.person).sort(), ["p-alice", "p-carol"], "one starter row per person, race or not");
      assertEquals(six.filter((v) => v.starter?.tx).length, 2, "exactly two of the six concurrent sign-ins were paid");
      const transfers = s.chain.sent.filter((x) => x.fn === "transfer");
      assertEquals(transfers.length, 2);
      for (const x of transfers) assertEquals(x.args[1], STARTER, "the pot sends exactly STARTER base units");
      const paid = new Set(rows.map((r) => r.to));
      assertEquals(paid.size, 2);
      for (const x of transfers) assert(paid.has(x.args[0] as string), "each transfer goes to the wallet in its ledger row");
      assertEquals((await signIn(s, "alice+news@example.com")).starter, null, "the person's other mailbox gets nothing later");
      const bob = await signIn(s, "bob@example.com");
      assert(bob.starter?.skipped?.includes("not a member"), JSON.stringify(bob.starter));
      assertEquals((await ledgerRows(s)).filter((r) => r.email === "bob@example.com").length, 0, "no starter row for a stranger");
      assertEquals(s.chain.sent.filter((x) => x.fn === "transfer").length, 2, "no transfer for a stranger");
    });

    await t.step("relay budget: refused at the boundary, before any transaction; a full budget does not block others", async () => {
      const dave = await signIn(s, "dave@example.com"), to = Wallet.createRandom().address;
      assertEquals((await req(s, "/balance", undefined, dave.session)).body.wallet, String(STARTER));
      for (let i = 0; i < 2; i++) assertEquals((await req(s, "/withdraw", { to, amount: "1" }, dave.session)).status, 200);
      const third = await req(s, "/withdraw", { to, amount: "1" }, dave.session);
      assertEquals(third.status, 400);
      assert(third.body.error.includes("daily limit of 2 relayed transactions") && third.body.error.includes("(2 used, 1 needed)"), third.body.error);
      assertEquals(s.chain.sent.filter((x) => x.fn === "transferWithAuthorization").length, 2, "the refused request sends nothing");
      const erin = await signIn(s, "erin@example.com");
      const three = await Promise.all([1, 2, 3].map(() => req(s, "/withdraw", { to, amount: "1" }, erin.session)));
      assertEquals(three.map((x) => x.status).sort(), [200, 200, 400], "per-user lanes serialize: two fit, the third is refused");
      assertEquals((await req(s, "/balance", undefined, erin.session)).body.wallet, String(STARTER - 2n));
    });

    await t.step("export: a fresh matching code; wrong, foreign, reused and expired codes are refused", async () => {
      const alice = await signIn(s, "alice@example.com"), bella = await signIn(s, "bella@example.com");
      assertEquals((await req(s, "/export", { confirm: "alice@example.com" })).status, 401, "no session");
      assertEquals((await req(s, "/export", { confirm: "bella@example.com" }, alice.session)).status, 400, "confirm must be the session's email");
      const started = await req(s, "/export", { confirm: "alice@example.com" }, alice.session);
      assertEquals([started.status, started.body.private_key, started.body.code_sent_to], [200, undefined, "alice@example.com"]);
      const id = started.body.challenge_id;
      assertEquals((await req(s, "/export", { confirm: "alice@example.com", challenge_id: id, code: "654321" }, alice.session)).status, 401, "a wrong code");
      assertEquals((await req(s, "/export", { confirm: "alice@example.com", challenge_id: id, code: "000000" }, alice.session)).status, 401, "the souk Dev test code");
      assertEquals((await req(s, "/export", { confirm: "alice@example.com", challenge_id: crypto.randomUUID(), code: "123456" }, alice.session)).status, 401, "a challenge this service did not start");
      assertEquals((await req(s, "/verify", { challenge_id: id, code: "123456" })).status, 401, "an export code does not sign in");
      const done = await req(s, "/export", { confirm: "alice@example.com", challenge_id: id, code: "123456" }, alice.session);
      assertEquals(done.status, 200, JSON.stringify(done.body));
      assertEquals(new Wallet(done.body.private_key).address, alice.address);
      assert((await ledgerRows(s)).some((r) => r.kind === "export" && r.email === "alice@example.com"), "the export is recorded");
      assertEquals((await req(s, "/export", { confirm: "alice@example.com", challenge_id: id, code: "123456" }, alice.session)).status, 401, "a code works once");
      const time = new FakeTime();
      try {
        const late = await req(s, "/export", { confirm: "bella@example.com" }, bella.session);
        await time.tickAsync(10 * 60e3 + 1000); // CHALLENGE_MS is ten minutes
        const x = await req(s, "/export", { confirm: "bella@example.com", challenge_id: late.body.challenge_id, code: "123456" }, bella.session);
        assertEquals(x.status, 401, "an expired code");
      } finally { time.restore(); }
    });

    await t.step("explicit old and new escrow accepts send both transactions to that domain; unknown routes send nothing", async () => {
      let user = await signIn(s, "routes@example.com");
      const operator = "0x" + "77".repeat(20);
      for (const [n, escrow] of ["0xdf9bb576e30ec71e200643ab6fc835eee12c95ea", "0xca184cfc10f55b67f8afb42029d768ec6e6f36ad"].entries()) {
        if (n) user = await signIn(s, "routes-new@example.net");
        const before = s.chain.sent.length;
        const response = await req(s, "/accept", { escrow, termsHash: "0x" + String(n + 1).repeat(64), operator, cap: "1", deposit: "1" }, user.session);
        assertEquals(response.status, 200, JSON.stringify(response.body));
        const sent = s.chain.sent.slice(before);
        assertEquals(sent.map(tx => tx.fn), ["depositWithAuthorization", "acceptTermsFor"]);
        assert(sent.every(tx => tx.to.toLowerCase() === escrow));
      }
      const before = s.chain.sent.length;
      assertEquals((await req(s, "/accept", { escrow: operator }, user.session)).status, 400);
      assertEquals(s.chain.sent.length, before);
    });

    await t.step("malformed bodies get 4xx, not 500, and never reach the chain", async () => {
      const frank = await signIn(s, "frank@example.com"), OP = "0x" + "77".repeat(20), H = "0x" + "a".repeat(64);
      const before = s.chain.sent.length;
      const bad = async (path: string, body: unknown, want = 400, session = frank.session) => {
        const r = await req(s, path, body, session);
        assertEquals(r.status, want, `${path} ${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
      };
      await bad("/login", '"a string"', 400, undefined);
      assertEquals((await post(s, "/login", "{oops")).status, 400, "not JSON at all");
      await bad("/login", []);
      await bad("/login", { email: null });
      await bad("/login", { email: 123 });
      await bad("/login", { email: "not an email" });
      await bad("/verify", { code: "123456" }, 401, undefined);
      await bad("/verify", { challenge_id: 123456, code: "123456" }, 401, undefined);
      await bad("/accept", {});
      await bad("/accept", { termsHash: "0xzz" + "0".repeat(60), operator: OP, cap: "1", deposit: "1" });
      await bad("/accept", { termsHash: "0x" + "0".repeat(64), operator: OP, cap: "1", deposit: "1" });
      await bad("/accept", { termsHash: H, operator: "0x12", cap: "1", deposit: "1" });
      await bad("/accept", { termsHash: H, operator: OP, cap: "12.5", deposit: "1" });
      await bad("/accept", { termsHash: H, operator: OP, cap: 123, deposit: "1" });
      await bad("/accept", { termsHash: H, operator: OP, cap: "1", deposit: "-1" });
      await bad("/withdraw", { to: "0x1234", amount: "1" });
      await bad("/withdraw", { to: OP, amount: "1.5" });
      await bad("/withdraw", { to: OP });
      await bad("/export", { confirm: 5 });
      assertEquals((await req(s, "/nope", {}, frank.session)).status, 404);
      assertEquals(s.chain.sent.length, before, "no malformed request reached the chain");
    });

    await t.step("a send is confirmed by its hash's receipt: null then the receipt, a receipt after a lost broadcast, never a 500", async () => {
      // A proxy in front of the stub chain that can answer null where the RPC must have a value, answer null for the
      // receipt until the test lets it land, and forward a broadcast (so it lands) while telling the caller it failed.
      const flaky = (o: { gasPriceNulls?: number; receiptNulls?: number; loseBroadcast?: boolean }) => {
        const raw: string[] = [], st = { gas: 0, polls: 0, broadcasts: 0 };
        const server = Deno.serve({ port: 0, onListen() {} }, async (r) => {
          const b = await r.json(), fwd = () =>
            fetch(s.chain.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((x) => x.json());
          if (b.method === "eth_gasPrice" && st.gas++ < (o.gasPriceNulls ?? 0)) return Response.json({ jsonrpc: "2.0", id: 1, result: null });
          if (b.method === "eth_getTransactionReceipt" && st.polls++ < (o.receiptNulls ?? 0)) return Response.json({ jsonrpc: "2.0", id: 1, result: null });
          if (b.method === "eth_sendRawTransaction") {
            st.broadcasts++;
            raw.push(b.params[0]);
            if (o.loseBroadcast) { await fwd(); return Response.json({ jsonrpc: "2.0", id: 1, error: { message: "the broadcast's reply was lost" } }); }
          }
          return Response.json(await fwd());
        });
        return { url: `http://127.0.0.1:${server.addr.port}`, raw, st, close: () => server.shutdown() };
      };
      const gail = await signIn(s, "gail@example.com"), hugo = await signIn(s, "hugo@example.com");
      const env = s.ctx.env as Record<string, string>, real = env.RPC;
      const f = flaky({ gasPriceNulls: 1, receiptNulls: 2 }), f2 = flaky({ loseBroadcast: true, receiptNulls: 1 });
      try {
        // The RPC answers null and then the value: one null is not an answer for a read, and the receipt is null until the
        // transaction is mined. The send returns the raw transaction's own hash once the receipt appears.
        env.RPC = f.url;
        const w = await req(s, "/withdraw", { to: Wallet.createRandom().address, amount: "1" }, gail.session);
        assertEquals([w.status, w.body.error, w.body.txs[0].fn], [200, undefined, "transferWithAuthorization"], JSON.stringify(w.body));
        assertEquals(w.body.txs[0].tx, Transaction.from(f.raw[0]).hash, "the send returns the raw transaction's own hash");
        assert(f.st.gas >= 2, "a null read was retried, not taken as an answer");
        assert(f.st.polls >= 3, "the receipt answered null before it answered the receipt");
        // The receipt lands after the broadcast timed out: the transaction was on the chain all the same, so the caller
        // gets its hash, never a 500 with the broadcast's error.
        env.RPC = f2.url;
        const w2 = await req(s, "/withdraw", { to: Wallet.createRandom().address, amount: "1" }, hugo.session);
        assertEquals([w2.status, w2.body.error, w2.body.txs[0].fn], [200, undefined, "transferWithAuthorization"], JSON.stringify(w2.body));
        assertEquals(w2.body.txs[0].tx, Transaction.from(f2.raw[0]).hash, "a send that landed returns its hash, never a 500");
        assert(f2.st.broadcasts >= 1 && f2.st.polls >= 2, "the receipt landed after the lost broadcast and one null poll");
      } finally { env.RPC = real; await f.close(); await f2.close(); }
    });
  } finally { await s.close(); }
});

// BUG accounts/server.ts:210 — a JSON-null body (await req.json() === null) is dereferenced (body.email, body.challenge_id,
// body.confirm) before any validation, so the handler answers 500 instead of 4xx. Repro: POST /api/login with body `null`.
// Fixed by #230; un-ignore after it merges.
Deno.test({
  name: "a JSON-null body is refused with 400 \"body: a JSON object\" (fixed by #230; un-ignore after it merges)",
  ignore: true,
  async fn() {
    const s = await setup();
    try {
      assertEquals((await post(s, "/login", "null")).status, 400, "/login");
      assertEquals((await post(s, "/verify", "null")).status, 400, "/verify");
      const f = await signIn(s, "frank@example.com");
      assertEquals((await post(s, "/accept", "null", f.session)).status, 400, "/accept");
      assertEquals((await post(s, "/export", "null", f.session)).status, 400, "/export");
    } finally { await s.close(); }
  },
});

Deno.test("starter aliases with distinct persons, historical ledger, domain and global caps", async () => {
  const s = await setup();
  Object.assign(s.ctx.env, { STARTERS_PER_DAY: "3", STARTERS_PER_DOMAIN_PER_DAY: "2" });
  try {
    await Deno.writeTextFile(s.ctx.dataDir + "/ledger.jsonl", JSON.stringify({ kind: "starter", person: "historical-person", email: "Old.Name+old@googlemail.com", at: "2020-01-01T00:00:00.000Z" }) + "\n");
    assertEquals((await signIn(s, "oldname@gmail.com")).starter, null);
    const first = await signIn(s, "First.Name+one@Gmail.com");
    assert(first.starter.tx);
    assertEquals(first.souk.person, "p-First.Name+one@Gmail.com", "the souk mails the typed address");
    // Distinct souk persons and wallets must still share the starter identity.
    assertEquals((await signIn(s, "firstname+two@googlemail.com")).starter, null);
    const pair = await Promise.all([signIn(s, "second@gmail.com"), signIn(s, "third@googlemail.com")]);
    assertEquals(pair.filter((v) => v.starter?.tx).length, 1);
    assert(pair.some((v) => v.starter?.skipped?.includes("domain limit")));
    assert((await signIn(s, "last@example.net")).starter.tx);
    assert((await signIn(s, "over@example.org")).starter.skipped.includes("starter limit"));
    assertEquals((await ledgerRows(s)).filter((r) => r.kind === "starter").length, 4);
    // Legacy records have no normalized_email field; normalize on read as well.
    assertEquals((await signIn(s, "first.name+legacy@gmail.com")).starter, null);
  } finally { await s.close(); }
});

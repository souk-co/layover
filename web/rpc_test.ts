// deno test -A --no-check web/rpc_test.ts (verify.ts has pre-existing type errors)
import { assertEquals } from "jsr:@std/assert@1";
import { CHAIN, configure, ESCROW, handler, RPC_READ_MS, RPC_TRIES } from "./server.ts";

configure({ chainCacheMs: 0 });

// A loopback stand-in for the escrow RPC that answers from a queue (the last answer repeats), each answer after `delay` ms;
// ESCROW.rpc is rerouted to it the way the other suites reroute outbound calls, and layover-chain is answered in-process with
// an empty claim index at the head. `ms` is the whole status read's wall clock.
const w = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
async function escrowVia(answers: unknown[], delay = 0): Promise<{ status: number; body: any; seen: string[]; ms: number }> {
  let q = 0;
  const t0 = Date.now();
  const seen: string[] = [], head = 1_000_000;
  const stub = Deno.serve({ port: 0, onListen() {} }, async (r) => {
    const b = await r.json();
    seen.push(b.method);
    await new Promise((x) => setTimeout(x, delay));
    return Response.json({ jsonrpc: "2.0", id: b.id, result: answers[Math.min(q++, answers.length - 1)] });
  });
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === ESCROW.rpc) return real(`http://127.0.0.1:${stub.addr.port}`, init);
    return Promise.resolve(u.includes("/head") ? Response.json({ head }) : Response.json({ logs: [] }));
  }) as typeof fetch;
  try {
    const r = await handler(new Request("http://x/api/status/escrow"), { dataDir: await Deno.makeTempDir() });
    return { status: r.status, body: await r.json(), seen, ms: Date.now() - t0 };
  } finally {
    globalThis.fetch = real;
    await stub.shutdown();
  }
}

Deno.test("an escrow read rides out an RPC that answers null twice before the value", async () => {
  const token = "0x036cbd53842c5426634e7929541ec2318f3dcf7e", { status, body, seen } = await escrowVia([null, null, w(BigInt(token)), w(100000000n), w(6n)]);
  assertEquals([status, body.token, body.balance, body.decimals, body.last_claimed], [200, token, "100000000", 6, null]);
  assertEquals(seen, Array(5).fill("eth_call"), "the two nulls were asked again, not answered");
});

Deno.test("an RPC that answers null every time is a 502 naming the upstream, never a TypeError 500, inside the read's deadline", async () => {
  const { status, body, seen, ms } = await escrowVia([null]);
  assertEquals([status, seen], [502, Array(RPC_TRIES).fill("eth_call")]);
  assertEquals(body.error, `eth_call at ${ESCROW.rpc}: the RPC answered null ${RPC_TRIES} times`);
  assertEquals(ms < RPC_READ_MS, true, `the whole status read took ${ms} ms`);
});

Deno.test("a slow RPC that answers null late is cut off by the status read's one deadline, not the per-call timeout", async () => {
  // Two nulls at 9.6 s plus the 1 s backoff land at 19.7 s, past what is left of the 20 s deadline, with tries still in hand;
  // the second fetch's timeout had already shrunk to the ~9.9 s left of the deadline. Slop: the abort fires at the deadline.
  const { status, body, seen, ms } = await escrowVia([null], 9600);
  assertEquals([status, seen.length], [502, 2]);
  assertEquals(body.error.startsWith(`eth_call at ${ESCROW.rpc}`), true, body.error);
  assertEquals(ms < RPC_READ_MS + 2000, true, `the whole status read took ${ms} ms`);
});

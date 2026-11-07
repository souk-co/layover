// deno test -A accounts/body_test.ts — no anvil and no network: a body that is not a JSON object is
// refused before any endpoint is contacted, so RPC and SOUK_URL are never fetched and env holds obviously fake values.
// Pins accounts/server.ts: POSTing null, a scalar or an array to /api/login answers 400, not the 500 of dereferencing it.
import { assertEquals } from "jsr:@std/assert@1";
import handler from "./server.ts";

Deno.test("a POST body that is not a JSON object is refused with 400", async () => {
  const ctx = { env: { ACCOUNTS_SEED: "7e".repeat(32), RPC: "http://127.0.0.1:1", TOKEN: "0x" + "aa".repeat(20), ESCROW: "0x" + "bb".repeat(20),
    CHAIN_ID: "31337", SOUK_URL: "http://127.0.0.1:1", SOUK_ID: "00000000-0000-0000-0000-000000000000", POT_KEY: "0x" + "42".repeat(32),
    STARTER: "5000000", STARTERS_PER_DAY: "100", RELAYS_PER_DAY: "2" }, dataDir: await Deno.makeTempDir() };
  for (const text of ["null", "5", "[]"]) {
    const r = await handler(new Request("http://x/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: text }), ctx)
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    assertEquals(r.status, 400, `${text}: ${JSON.stringify(r.body)}`);
    assertEquals(r.body.error, "body: a JSON object");
  }
});

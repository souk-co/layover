import { assertEquals } from "jsr:@std/assert@1";
import { CHAIN, verify } from "./verify.ts";
import { attest, deviceKey } from "./fixtures/synthetic-guest.mjs";
import { hex } from "./static/kit/couch/dsmack/policy.mjs";

Deno.test("site verifies Developer ID assertions and rejects App Store categories", async () => {
  const key = await deviceKey(), rp = new Uint8Array(32).fill(1), zero = new Uint8Array(32), report = new Uint8Array(64);
  const word = (n: number) => BigInt(n).toString(16).padStart(64, "0"), saved = globalThis.fetch;
  const values: Record<string, string> = {
    "0xdde5b7a1": hex(key.x) + hex(key.y) + word(Math.floor(Date.now() / 1000) + 3600) + word(0) + word(1),
    "0x5523509a": word(3), "0xb4eb10ce": CHAIN.registry.toLowerCase().slice(2).padStart(64, "0"),
    "0x65f4df9c": hex(rp), "0xb7b014b6": hex(zero), "0xe62b7cbd": word(0), "0xda746951": word(0),
  };
  globalThis.fetch = ((url: string | URL) => Promise.resolve(Response.json({ verified_by: "helios-opstack",
    result: "0x" + values[new URL(String(url)).searchParams.get("data")!.slice(0, 10)] }))) as typeof fetch;
  const fields = { os_image_hash: zero, manifest_sha256: zero, run: zero, caller: zero, report_data: report, rp, cdhash: zero };
  try {
    const accepted = await verify(await attest(key, { ...fields, category: 6 }), report);
    assertEquals(accepted.ok, true, JSON.stringify(accepted));
    const rejected = await verify(await attest(key, { ...fields, category: 5 }), report);
    assertEquals(rejected.ok, false);
    assertEquals(rejected.checks.some(c => c.detail.includes("validation category")), true);
  } finally { globalThis.fetch = saved; }
});

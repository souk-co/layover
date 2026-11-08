import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { checkGuestKey } from "./guest-key.ts";
import { configure, GUEST_ESCROW, PREVIOUS_GUEST_ESCROW, handler } from "./server.ts";
import { hex } from "./verify.ts";
const f = { run: "33".repeat(32), manifest_sha256: "22".repeat(32), os_image_hash: "11".repeat(32), key_id: "44".repeat(32), caller: "d4f0bc5a29de06b510f9aa428f1eedba926012b591fef7a518e776a7c9bd1824" };
const operator = "0x" + "55".repeat(20), address = "0x" + "66".repeat(20);
const proof = { address, operator, escrow: GUEST_ESCROW.toLowerCase(), attestation: "aabb" };
const custody = { operator, allowed: { manifests: [f.manifest_sha256], os_image_hashes: [f.os_image_hash] } };
const verified = { ok: true, facts: f, checks: [], checked_at: "fixture" };
Deno.test("guest key binds exact claim address/operator and current registration run, hardware, base, manifest and caller", async () => {
  let calls = 0;
  const verifier = async (_att: string, data: Uint8Array, expect: unknown) => {
    calls++; assertEquals(hex(data), "00".repeat(12) + address.slice(2) + "00".repeat(12) + operator.slice(2)); assertEquals(expect, f); return verified;
  };
  assertEquals(await checkGuestKey(proof, verified, custody, GUEST_ESCROW, verifier), proof); assertEquals(calls, 1);
  for (const name of ["run", "manifest_sha256", "os_image_hash", "key_id", "caller"]) {
    await assertRejects(() => checkGuestKey(proof, verified, custody, GUEST_ESCROW, async () => ({ ...verified, facts: { ...f, [name]: "99".repeat(32) } })));
  }
  for (const bad of [{ ...proof, operator: "0x" + "77".repeat(20) }, { ...proof, escrow: operator }, { ...proof, address: "0x" + "00".repeat(20) }, { ...proof, private_key: "forbidden" }]) {
    await assertRejects(() => checkGuestKey(bad, verified, custody, GUEST_ESCROW, verifier));
  }
  await assertRejects(() => checkGuestKey(proof, { ...verified, facts: { ...f, caller: "00".repeat(32) } }, custody, GUEST_ESCROW, verifier));
  await assertRejects(() => checkGuestKey(proof, { ...verified, ok: false }, custody, GUEST_ESCROW, verifier));
  await assertRejects(() => checkGuestKey(proof, verified, { ...custody, allowed: { manifests: [], os_image_hashes: [] } }, GUEST_ESCROW, verifier));
  await assertRejects(() => checkGuestKey(proof, verified, custody, GUEST_ESCROW, async () => ({ ...verified, ok: false })));
});
// MessagePack fixture only; hardware verification is deliberately injected, not claimed.
function pack(v: any): number[] {
  if (typeof v === "number") return v < 128 ? [v] : [0xcc, v];
  if (typeof v === "string") { const b = [...new TextEncoder().encode(v)]; return [...(b.length < 32 ? [0xa0 + b.length] : [0xd9, b.length]), ...b]; }
  if (Array.isArray(v)) return [...(v.length < 16 ? [0x90 + v.length] : [0xdc, v.length >> 8, v.length & 255]), ...v.flatMap(pack)];
  const e = Object.entries(v); return [0x80 + e.length, ...e.flatMap(([k, x]) => [...pack(k), ...pack(x)])];
}
Deno.test("HTTP registration persists and serves optional public proof; invalid proof never appends and legacy remains supported", async () => {
  const dir = await Deno.makeTempDir();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => Response.json(custody));
  const att = hex(Uint8Array.from(pack({ version: 1, platform: { kind: "apple-app-attest", data: { key_id: Array(32).fill(0x44), assertion: [] } }, stack: { kind: "dsmack", data: { os_image_hash: Array(32).fill(0x11), manifest_sha256: Array(32).fill(0x22), run: Array(32).fill(0x33), caller: Array(32).fill(0), report_data: Array(64).fill(0), events: [{ event: "system-ready", payload: "" }] } } })));
  configure({ custody: `http://127.0.0.1:${server.addr.port}/`, operators: async () => [operator], verify: (async (a: string, data: Uint8Array) => a === proof.attestation ? { ...verified, ok: hex(data) === "00".repeat(12) + address.slice(2) + "00".repeat(12) + operator.slice(2) } : verified) as never });
  const body = { agent_id: "host", enc_pub: "77".repeat(32), attestation: att, coarse: { region: "r", isp_class: "c", residential: true } };
  const post = (b: any) => handler(new Request("http://x/api/agents", { method: "POST", body: JSON.stringify(b) }), { dataDir: dir });
  try {
    assertEquals((await post({ ...body, guest_key: { ...proof, escrow: operator } })).status, 400);
    assertEquals(await Deno.readTextFile(dir + "/records.jsonl").catch(() => ""), "");
    const legacy = { ...proof, escrow: PREVIOUS_GUEST_ESCROW.toLowerCase() };
    assertEquals((await post({ ...body, guest_key: legacy })).status, 200);
    const legacyGet = await handler(new Request("http://x/api/agents?agent_id=host"), { dataDir: dir });
    assertEquals((await legacyGet.json())[0].guest_escrow, legacy.escrow);
    assertEquals((await post({ ...body, guest_key: proof })).status, 200);
    const get = await handler(new Request("http://x/api/agents?agent_id=host"), { dataDir: dir });
    assertEquals((await get.json())[0].guest_key, proof);
    const summary = await handler(new Request("http://x/api/agents"), { dataDir: dir }); const row = (await summary.json())[0]; assertEquals(row.guest_key, undefined); assertEquals(row.guest_key_available, true);
    const kept = JSON.parse((await Deno.readTextFile(dir + "/records.jsonl")).trim().split("\n").at(-1)!); assertEquals(kept.guest_key, proof);
    assertEquals((await post(body)).status, 200);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    configure({ verify: (async (a: string) => { if (a === "bbcc") { entered(); await waiting; } return verified; }) as never });
    const delayed = post({ ...body, guest_key: { ...proof, attestation: "bbcc" } });
    await started;
    assertEquals((await post(body)).status, 200); // Newer legacy registration clears proof.
    release(); assertEquals((await delayed).status, 409);
    const afterRace = await handler(new Request("http://x/api/agents?agent_id=host"), { dataDir: dir });
    assertEquals((await afterRace.json())[0].guest_key, undefined);
    configure({ verify: (async () => ({ ...verified, ok: false })) as never });
    assertEquals((await post({ ...body, agent_id: "test-legacy-bypass", attestation: "aacc", guest_key: proof })).status, 400);
    configure({ verify: (async () => verified) as never });
    const latest = await handler(new Request("http://x/api/agents"), { dataDir: dir }); assertEquals((await latest.json())[0].guest_key, undefined);
  } finally { await server.shutdown(); await Deno.remove(dir, { recursive: true }); }
});

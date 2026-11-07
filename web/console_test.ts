import { assertEquals } from "jsr:@std/assert@1";
import { configure, handler } from "./server.ts";
import { hex } from "./verify.ts";
function pack(v: any): number[] {
  if (typeof v === "number") return v < 128 ? [v] : [0xcc, v];
  if (typeof v === "string") { const b = [...new TextEncoder().encode(v)]; return [...(b.length < 32 ? [0xa0 + b.length] : [0xd9, b.length]), ...b]; }
  if (Array.isArray(v)) return [...(v.length < 16 ? [0x90 + v.length] : [0xdc, v.length >> 8, v.length & 255]), ...v.flatMap(pack)];
  const e = Object.entries(v); return [0x80 + e.length, ...e.flatMap(([k, x]) => [...pack(k), ...pack(x)])];
}
const att = hex(Uint8Array.from(pack({ version: 1, platform: { kind: "apple-app-attest", data: { key_id: Array(32).fill(0x44), assertion: [] } }, stack: { kind: "dsmack", data: { os_image_hash: Array(32).fill(0x11), manifest_sha256: Array(32).fill(0x22), run: Array(32).fill(0x33), caller: Array(32).fill(0), report_data: Array(64).fill(0), events: [{ event: "system-ready", payload: "" }] } } })));Deno.test("console verifies account session and ownership, protects public records, and accepts privacy only from owners", async () => {
  const realFetch = globalThis.fetch, dataDir = await Deno.makeTempDir();
  const address = "0x" + "55".repeat(20), stranger = "0x" + "66".repeat(20), at = "2026-11-07T00:00:00Z";
  const f = { key_id: "44".repeat(32), run: "33".repeat(32), manifest_sha256: "22".repeat(32), os_image_hash: "11".repeat(32) };
  configure({ custody: "http://custody/", operators: async () => [], verify: (async () => ({ ok: true, facts: f, checks: [], checked_at: at })) as never });
  const coarse = { region: "Springfield, Illinois, US", residential: true, isp_class: "cable" };
  const agent = (agent_id: string, registered_by?: string) => ({ kind: "agent", agent_id, enc_pub: "77".repeat(32), attestation: att, coarse, registered_by, at });
  const id = "00000000-0000-0000-0000-000000000001";
  const records = [agent("operated"), agent("registered", address), agent("other"),
    { kind: "appraisal_request", id: "q", agent_id: "operated", at },
    { kind: "appraisal", id, agent_id: "operated", report: { ...coarse, request_id: "q", at }, attestation: att, at },
    { kind: "bounty", id, agent_id: "operated", at },
    { kind: "result", bounty_id: id, agent_id: "operated", result: { ...coarse, items: [] }, attestation: att, at }];
  await Deno.writeTextFile(dataDir + "/records.jsonl", records.map(r => JSON.stringify(r) + "\n").join(""));
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("http://custody/")) return Response.json({ operator: url.endsWith("operated") ? address : stranger, allowed: { manifests: [f.manifest_sha256], os_image_hashes: [f.os_image_hash] } });
    if (url.includes("layover-accounts/api/")) {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/login")) return Response.json({ challenge_id: "challenge", code_sent_to: "owner@example.com" });
      if (url.endsWith("/verify")) return Response.json({ email: "owner@example.com", address, session: "valid" });
      return new Headers(init.headers).get("authorization") === "Bearer valid" ? Response.json({ email: "owner@example.com", address }) : Response.json({ error: "invalid session" }, { status: 401 });
    }
    throw new Error("unexpected upstream " + url);
  }) as typeof fetch;
  const call = (path: string, token?: string, body?: any) => handler(new Request("http://x/api/" + path, {
    method: body ? "POST" : "GET", headers: token ? { authorization: "Bearer " + token } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }), { dataDir });
  try {
    assertEquals((await call("console/lines")).status, 400);
    assertEquals((await call("console/lines", "forged")).status, 502);
    await call("console/login", undefined, { email: "owner@example.com" });
    await call("console/verify", undefined, { challenge_id: "challenge", code: "123456" });
    assertEquals(calls.every(c => !c.url.includes("owner@")), true);
    assertEquals(calls.find(c => c.url.endsWith("/login"))!.body.email, "owner@example.com");
    const own = await (await call("console/lines", "valid")).json();
    assertEquals(own.lines.map((a: any) => a.agent_id), ["operated", "registered"]);
    assertEquals(own.lines[0].appraisals[0].coarse.region, coarse.region);
    for (const path of ["agents", "agents?agent_id=operated", "agents/operated/appraisals", `appraisals/${id}`, `appraisals/${id}/verified`, "bounties", `bounties/${id}`]) {
      const r = await call(path, "valid");
      assertEquals(r.status, 200, path);
      const text = await r.text();
      assertEquals(text.includes("Springfield"), false, path);
      assertEquals(text.includes("Illinois"), false, path);
    }
    assertEquals((await call("console/privacy", "valid", { agent_id: "other", show_state: true, connection_kind: "home" })).status, 400);
    assertEquals((await call("console/privacy", "valid", { agent_id: "operated", show_state: true, connection_kind: "home" })).status, 200);
    const publicLine = await (await call("agents?agent_id=operated")).json();
    assertEquals(publicLine[0].coarse.region, "Illinois, US");
    // An authenticated stranger cannot claim another line by replaying its public registration.
    configure({ operators: async () => [stranger] });
    const replay = await call("agents", "valid", { agent_id: "other", enc_pub: "77".repeat(32), attestation: att, coarse });
    assertEquals(replay.status, 400);
    assertEquals((await replay.json()).error, "account wallet does not operate this registration");
    assertEquals((await Deno.readTextFile(dataDir + "/records.jsonl")).includes(coarse.region), true);
  } finally { globalThis.fetch = realFetch; await Deno.remove(dataDir, { recursive: true }); }
});

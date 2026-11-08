import { assertEquals, assertFalse, assert } from "jsr:@std/assert@1";
import { activity } from "./activity.ts";
import { handler } from "./server.ts";
const at = "2026-11-07T12:00:00Z";
Deno.test("activity allowlist redacts contacts, network, home cities and private lease/fetch fields", () => {
  const privateFields = { email: "alice@example.org", ip: "192.0.2.12", region: "PrivateCity", account: "private-account", reason: "private-reason" };
  const events = activity([
    { kind: "signup", at, ...privateFields }, { kind: "signup", at, ...privateFields },
    { kind: "lease", at, agent_id: "line-1", ...privateFields },
    { kind: "lease_end", at, agent_id: "alice@example.org", statement: privateFields },
    { kind: "result", at, agent_id: "192.0.2.12", result: { ...privateFields, items: [{ status: 200, url: "https://private-domain" }, { status: 404 }] } },
    { kind: "minion", at, row_json: JSON.stringify({ kind: "couch", started: at, at, open_ms: 10, slot: 2, seconds: 3, charged_nano_usd: "400", settlement: privateFields, ...privateFields }) },
    ...["deposit", "accept", "Claimed", "close", "withdraw"].map(event => ({ kind: "escrow_activity", at, event, tx: "0x" + "11".repeat(32), ...privateFields })),
    { kind: "escrow_activity", at, event: "deposit", tx: "https://evil.example" },
  ]);
  const serialized = JSON.stringify(events);
  for (const secret of [...Object.values(privateFields), "private-domain"]) assertFalse(serialized.includes(secret), secret);
  assertEquals(events.length, 11);
  assert(events.some(e => e.description === "2 sign-ups"));
  assert(events.some(e => e.description.includes("1 pages served")));
  assert(events.some(e => e.description === "Couch stay closed: slot 2, 3 seconds, 400 nano-USD"));
  assertEquals(events.filter(e => e.kind.startsWith("escrow_")).map(e => e.link), Array(5).fill("https://base-sepolia.blockscout.com/tx/0x" + "11".repeat(32)));
  for (const e of events) assertEquals(Object.keys(e), ["time", "kind", "description", "link"]);
});
Deno.test("GET /api/activity orders newest first, caps at 100, and excludes invalid timestamps", async () => {
  const dataDir = await Deno.makeTempDir(), original = globalThis.fetch;
  // The background index has no blocks to scan; no live service is called.
  globalThis.fetch = () => Promise.resolve(Response.json({ head: -1 }));
  try {
    const rows = Array.from({ length: 125 }, (_, i) => ({ kind: "lease", agent_id: "line-1", at: new Date(1700000000000 + i * 1000).toISOString(), email: "secret@example.org" })).reverse();
    rows.push({ kind: "lease", agent_id: "line-1", at: "invalid", email: "secret@example.org" });
    await Deno.writeTextFile(dataDir + "/records.jsonl", rows.map(r => JSON.stringify(r)).join("\n"));
    const response = await handler(new Request("http://site/api/activity"), { dataDir });
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    const events = await response.json();
    assertEquals(events.length, 100);
    assertEquals(events[0].time, rows[0].at);
    assertEquals(events[99].time, rows[99].at);
    assertFalse(JSON.stringify(events).includes("secret@example.org"));
    await new Promise(r => setTimeout(r, 20));
  } finally { globalThis.fetch = original; await Deno.remove(dataDir, { recursive: true }); }
});

Deno.test("activity escrow index persists, deduplicates, and resumes only completed block ranges", async () => {
  const { scanActivity, ACTIVITY_TOPICS, GUEST_ESCROW } = await import("./server.ts");
  const dataDir = await Deno.makeTempDir(), original = globalThis.fetch;
  let fail = true, reads = 0;
  const timestamp = Math.floor(Date.parse(at) / 1000);
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/head")) return Promise.resolve(Response.json({ head: 10 }));
    reads++;
    if (fail && reads === 3) return Promise.resolve(new Response("offline", { status: 502 }));
    const topic = url.searchParams.get("topics")!;
    const logs = url.searchParams.get("address") === GUEST_ESCROW && ACTIVITY_TOPICS[topic] ? [{ tx: "0x" + "22".repeat(32), block: 10, topics: [topic], data: "0x", log_index: 0, block_timestamp: timestamp }] : [];
    return Promise.resolve(Response.json({ logs }));
  };
  try {
    try { await scanActivity({ dataDir }); } catch { /* retry partial scan */ }
    fail = false;
    await scanActivity({ dataDir });
    const rows = (await Deno.readTextFile(dataDir + "/records.jsonl")).trim().split("\n").map(l => JSON.parse(l));
    assertEquals(rows.filter(r => r.kind === "escrow_activity").length, 5);
    assertEquals(activity(rows).length, 5);
    assertEquals(activity(rows)[0].time, new Date(at).toISOString());
    const before = reads;
    await scanActivity({ dataDir });
    assertEquals(reads, before);
  } finally { globalThis.fetch = original; await Deno.remove(dataDir, { recursive: true }); }
});

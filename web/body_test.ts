// deno test -A --no-check web/body_test.ts (verify.ts has pre-existing type errors)
import { assertEquals } from "jsr:@std/assert@1";
import { configure, handler } from "./server.ts";

Deno.test("a POST body that is not a JSON object (null, a scalar, an array) is a 400 on every route that parses one, and nothing is recorded", async () => {
  const dataDir = await Deno.makeTempDir();
  const post = (path: string, body: string) => handler(new Request("http://x" + path, { method: "POST", body }), { dataDir });
  for (const body of ["null", "5", "[]"]) {
    for (const path of ["/api/relay/open", "/api/agents", "/api/signup"]) {
      const r = await post(path, body);
      assertEquals([path, body, r.status, (await r.json()).error], [path, body, 400, "body: a JSON object"]);
    }
  }
  assertEquals(await Deno.readTextFile(dataDir + "/records.jsonl").catch(() => ""), "");
});

Deno.test("a bounty result with a non-object item is a 400 before anything is written; object items (any status) are accepted", async () => {
  const dataDir = await Deno.makeTempDir(), id = "00000000-0000-4000-8000-0000000000b4", at = new Date().toISOString();
  const att = "83a776657273696f6e01a8706c6174666f726d82a46b696e64b06170706c652d6170702d617474657374a46461746182a66b65795f6964dc00204444444444444444444444444444444444444444444444444444444444444444a9617373657274696f6e91cca0a5737461636b82a46b696e64a664736d61636ba46461746186ab7265706f72745f64617461dc0040195c1bcce0cce9ccaf55cc96ccd5046cccef385949ccaf392f00cca449cc84213816cc9c5c51ccf5cce3ccfb030000000000000000000000000000000000000000000000000000000000000000ad6f735f696d6167655f68617368dc00201111111111111111111111111111111111111111111111111111111111111111af6d616e69666573745f736861323536dc00202222222222222222222222222222222222222222222222222222222222222222a372756edc00203333333333333333333333333333333333333333333333333333333333333333a663616c6c6572dc00205555555555555555555555555555555555555555555555555555555555555555a66576656e74739182a56576656e74ac73797374656d2d7265616479a77061796c6f6164a0";
  await Deno.writeTextFile(dataDir + "/records.jsonl", [
    { kind: "agent", agent_id: "line-a", enc_pub: "77".repeat(32), attestation: att, coarse: { region: "us-ny", isp_class: "cable", residential: true }, at },
    { kind: "bounty", id, agent_id: "line-a", buyer_key: "thread-4", at },
    { kind: "decision", bounty_id: id, decision: "accept", reason: "ok", at },
  ].map((r) => JSON.stringify(r) + "\n").join(""));
  configure({ verify: (async () => ({ ok: true, mode: null, facts: { key_id: "k", manifest_sha256: "m", os_image_hash: "o", run: "r" }, checks: [], checked_at: "" })) as never });
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(Response.json({}))) as typeof fetch;
  const post = (items: unknown[]) =>
    handler(new Request(`http://x/api/bounties/${id}/result`, { method: "POST", body: JSON.stringify({ result: { bounty_id: id, items }, attestation: "abcd" }) }),
      { dataDir, env: { SOUK_DOORMAN_CREDENTIAL: "doorman-token" } });
  const kinds = async () => (await Deno.readTextFile(dataDir + "/records.jsonl")).trim().split("\n").map((l) => JSON.parse(l).kind);
  try {
    for (const items of [[null], [5], [[]], [{ status: 200 }, null]]) {
      const r = await post(items);
      assertEquals([JSON.stringify(items), r.status, (await r.json()).error], [JSON.stringify(items), 400, "result.items: each item is an object"]);
    }
    assertEquals(await kinds(), ["agent", "bounty", "decision"]);
    assertEquals((await (await handler(new Request(`http://x/api/bounties/${id}`), { dataDir })).json()).status, "accepted");
    // A failed fetch item may carry a null or missing status: any object item is recorded, and only numeric 2xx count as served.
    const good = await post([{ status: 200 }, { status: null }, {}]);
    assertEquals(good.status, 200);
    assertEquals(await kinds(), ["agent", "bounty", "decision", "result"]);
    const st = await (await handler(new Request(`http://x/api/bounties/${id}/statement`), { dataDir })).json();
    assertEquals([st.status, st.requested, st.served], ["done", 3, 1]);
  } finally {
    globalThis.fetch = real;
  }
});

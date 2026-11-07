// deno test -A --no-check web/body_test.ts (verify.ts has pre-existing type errors)
import { assertEquals } from "jsr:@std/assert@1";
import { handler } from "./server.ts";
import { fixture, resourceId as bountyId } from "./guest-action_fixture.ts";

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
  const f = await fixture({ resource: "bounty", active: true });
  const post = async (items: any[]) => f.post("result", await f.signed("result", await f.resultPayload(items)));
  try {
    for (const items of [[null], [5], [[]], [{ status: 200 }, null]]) {
      const r = await post(items);
      assertEquals([JSON.stringify(items), r.status, r.body.error], [JSON.stringify(items), 400, "result.items: each item is an object"]);
    }
    assertEquals(await f.rows(), f.initial);
    assertEquals(f.pushes, []);
    assertEquals((await f.get(`bounties/${bountyId}`)).status, "accepted");
    // Failed fetch items may carry a null or missing status; only numeric 2xx count as served.
    const good = await post([{ status: 200 }, { status: null }, {}]);
    assertEquals(good.status, 200);
    assertEquals((await f.rows()).filter(r => r.kind === "result").length, 1);
    const st = await f.get(`bounties/${bountyId}/statement`);
    assertEquals([st.status, st.requested, st.served], ["done", 3, 1]);
  } finally { await f.close(); }
});

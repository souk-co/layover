import { test } from "node:test";
import assert from "node:assert/strict";
import { handler, stayTools } from "./mcp.mjs";

const tools = [{ name: "bash", description: "shell", inputSchema: { type: "object" } }];
const quote = { publisher: "0xhost", slot_id: 3, conversation_id: "thread-1", browse: { mode: "named", hosts: ["shop.example"] },
  max_spend_nano_usd: "900000", operation_id: "12345678-1234-4234-8234-123456789abc", expected_rate_nano_usd_per_second: "15000" };
function guest() {
  return { calls: [], async open(args) { this.calls.push(args); return { tools, sessionId: "s1" }; } };
}

test("MCP advertises and forwards the complete accepted capped quote", async () => {
  const schema = stayTools.find(tool => tool.name === "stay_open").inputSchema;
  for (const field of Object.keys(quote)) assert.ok(schema.properties[field], "MCP must expose " + field);
  const stay = guest(), invoke = handler(stay, tools);
  const result = await invoke({ params: { name: "stay_open", arguments: quote } });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).sessionId, "s1");
  assert.deepEqual(stay.calls, [{ publisher: quote.publisher, slotId: quote.slot_id, conversationId: quote.conversation_id,
    browse: quote.browse, maxSpendNanoUsd: quote.max_spend_nano_usd, operationId: quote.operation_id,
    expectedRateNanoUsdPerSecond: quote.expected_rate_nano_usd_per_second }]);
});

test("MCP refuses partial caps, malformed rates and unknown constraints before opening", async () => {
  for (const patch of [{ operation_id: undefined }, { max_spend_nano_usd: undefined }, { expected_rate_nano_usd_per_second: 15000 }, { max_price: 1 }]) {
    const stay = guest();
    const result = await handler(stay, tools)({ params: { name: "stay_open", arguments: { ...quote, ...patch } } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Spend cap|Expected rate|Unsupported open constraint/);
    assert.deepEqual(stay.calls, []);
  }
});

test("explicit legacy MCP calls still open without adding financial authority", async () => {
  const stay = guest(), { publisher, slot_id, conversation_id } = quote;
  const result = await handler(stay, tools)({ params: { name: "stay_open", arguments: { publisher, slot_id, conversation_id } } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(stay.calls, [{ publisher, slotId: slot_id, conversationId: conversation_id, browse: undefined }]);
});

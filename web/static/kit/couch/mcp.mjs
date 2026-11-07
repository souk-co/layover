#!/usr/bin/env node
// Local stdio MCP server: stay_open / stay_status / stay_close, and the open stay's guest tools (bash/read/write/edit) proxied.
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Stay } from "./stay.mjs";

const key = process.env.LAYOVER_COUCH_KEY_FILE;
if (!key) throw new Error("Set LAYOVER_COUCH_KEY_FILE to a file holding the stay wallet's private key.");
const stay = new Stay(readFileSync(key, "utf8").trim());
const guestTools = JSON.parse(readFileSync(new URL("./tools.json", import.meta.url), "utf8"));
const object = (properties, required = []) => ({ type: "object", properties, required });
const stayTools = [
  { name: "stay_open", description: "Open a couch stay: reserve an attested dsmack guest (one Mac slot) on the broker, paid from this wallet's broker credit at the broker's rate (15000 nano-USD per active second, 60 s minimum), verify its attestation and connect. Use the publisher, slot_id and thread id from the amin's accepted terms. Then bash/read/write/edit run in the guest's /workspace until stay_close.",
    inputSchema: object({ publisher: { type: "string", description: "the host's publisher address named in the terms" }, slot_id: { type: "integer", description: "the slot named in the terms" },
      conversation_id: { type: "string", description: "the souk thread id of the accepted terms" },
      browse: { type: "object", description: "how open the couch's browser is, as in the accepted terms: {mode: none | named | open, hosts: [sites, for named]}. Omit for the host's default. Package hosts (npm, PyPI, Debian, conda-forge, Playwright) are always reachable.",
        properties: { mode: { type: "string", enum: ["none", "named", "open"] }, hosts: { type: "array", items: { type: "string" } } }, required: ["mode", "hosts"] } }, ["publisher", "slot_id", "conversation_id"]) },
  { name: "stay_status", description: "The broker's view of the open stay: active, guest seconds used, when the guest is handed over (the stay must close before then), idle timeout, wallet credit left.", inputSchema: object({}) },
  { name: "stay_close", description: "End the stay and wait for the guest's final signed receipt to reach the broker. Returns the settlement record (session id, guest seconds, nano-USD charged) to send to the amin as `stay <json>`.", inputSchema: object({}) },
];
const json = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });

const server = new Server({ name: "layover-couch", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", async () => ({ tools: [...stayTools, ...guestTools.map(t => ({ ...t, description: "On the open stay's guest: " + t.description }))] }));
server.setRequestHandler("tools/call", async request => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === "stay_open") {
      const opened = await stay.open({ publisher: args.publisher, slotId: args.slot_id, conversationId: args.conversation_id, browse: args.browse });
      const served = JSON.stringify(opened.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
      if (served !== JSON.stringify(guestTools)) {
        await stay.close();
        throw new Error("The guest's tools differ from tools.json; the stay was closed.");
      }
      const { tools, ...rest } = opened;
      return json(rest);
    }
    if (name === "stay_status") return json(await stay.summary());
    if (name === "stay_close") return json(await stay.close());
    if (!guestTools.some(t => t.name === name)) throw new Error("Unknown tool " + name);
    const { content, isError } = await stay.tool(name, args);
    return { content, ...(isError ? { isError: true } : {}) };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());

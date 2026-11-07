#!/usr/bin/env node
// node couch_task.mjs PUBLISHER SLOT_ID CONVERSATION_ID: one short couch stay running the minion's fixed task.
// Prints one JSON line: each step's result, the settlement, and the error if the stay failed (paid says whether the
// wallet's broker spend moved, i.e. whether a failure is a failed paid use). Needs LAYOVER_COUCH_KEY_FILE, LAYOVER_DSMACK,
// and LAYOVER_COUCH_DIR (the kit's couch/ directory with node_modules).
import { readFileSync } from "node:fs";
const { Stay, BROKER } = await import(process.env.LAYOVER_COUCH_DIR + "/stay.mjs");

const [publisher, slot, conversationId] = process.argv.slice(2);
const token = crypto.randomUUID();
// The couch reaches only the broker and its relay tunnel (dsmack connect-proxy allowlist), so curl goes to the broker.
const STEPS = [
  ["uname", "bash", { command: "uname -srm" }],
  ["curl", "bash", { command: "curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{time_total}' https://pod.dstack.soc1024.com/relay-broker/nodes" }],
  ["df_free", "bash", { command: "df -k /workspace | tail -1; head -2 /proc/meminfo" }],
  ["write", "write", { path: "minion.txt", content: token }],
  ["read", "bash", { command: "cat minion.txt" }],
];
const text = r => r.content.map(c => c.text ?? "").join("");
const stay = new Stay(readFileSync(process.env.LAYOVER_COUCH_KEY_FILE, "utf8").trim());
const spent = async () => {
  const r = await fetch(BROKER + "/inference/credit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await stay.signed("credit")) });
  if (!r.ok) throw new Error(`broker credit HTTP ${r.status}: ${await r.text()}`);
  return BigInt((await r.json()).spentNanoUsd);
};
const before = await spent();
const out = { publisher, slot: Number(slot), steps: {}, started: new Date().toISOString() };
try {
  const opened = await stay.open({ publisher, slotId: Number(slot), conversationId });
  out.relay_peer = opened.node.relay_peer;
  out.open_ms = Date.now() - Date.parse(out.started);
  for (const [name, tool, args] of STEPS) {
    const t = Date.now(), r = await stay.tool(tool, args);
    out.steps[name] = { ok: !r.isError, ms: Date.now() - t, out: text(r).slice(0, 300) };
  }
  out.steps.roundtrip = { ok: out.steps.read.out.trim() === token };
  out.settlement = await stay.close();
} catch (e) {
  out.error = e.message;
  if (stay.lease) {
    try { out.settlement = stay.node ? await stay.close() : await stay.end(); } catch (c) { out.close_error = c.message; }
  }
}
// Always reached, so a charged failure is recorded as paid; if the broker can't say, paid is unknown and that is the error.
try {
  out.charged_nano_usd = String(await spent() - before);
  out.paid = out.charged_nano_usd !== "0";
} catch (e) {
  out.paid = null;
  out.error = [out.error, "broker spend unknown: " + e.message].filter(Boolean).join("; ");
}
out.ok = !out.error && Object.values(out.steps).every(s => s.ok);
console.log(JSON.stringify(out));

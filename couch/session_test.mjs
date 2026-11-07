import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { controller, privateDirectory, serve, request } from "./session.mjs";

const cli = fileURLToPath(new URL("./session.mjs", import.meta.url)), exec = promisify(execFile);
const tools = ["bash", "read", "write", "edit"].map(name => ({ name, description: name, inputSchema: { type: "object" } }));
const terms = { publisher: "0xhost", slot_id: 3, conversation_id: "thread-1" };
function guest() {
  return {
    files: new Map(), calls: [], lease: null,
    async open(args) {
      this.calls.push(["open", args]); this.lease = { sessionId: "s1" };
      return { ...this.lease, tools, environment: { commandTimeoutSeconds: 120 } };
    },
    async tool(name, args) {
      assert.ok(this.lease);
      this.calls.push([name, args]);
      if (name === "write") this.files.set(args.path, args.content);
      return { content: [{ type: "text", text: name === "read" ? this.files.get(args.path) : "ok" }] };
    },
    async summary() { return { sessionId: this.lease.sessionId, active: true }; },
    async close() { this.calls.push(["close"]); this.lease = null; return { sessionId: "s1", chargedNanoUsd: "900000" }; },
  };
}

test("separate CLI processes share one guest and save a receipt on close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ly-")), stay = guest();
  const server = await serve(dir, stay, tools);
  const call = async (action, args) => JSON.parse((await exec(process.execPath, [cli, action, ...(args ? [JSON.stringify(args)] : [])],
    { env: { ...process.env, LAYOVER_SESSION_DIR: dir } })).stdout);
  try {
    assert.equal((await lstat(join(dir, "session.sock"))).mode & 0o777, 0o600);
    assert.equal((await call("open", terms)).sessionId, "s1");
    await call("bash", { command: "uname -a" });
    await call("write", { path: "hello", content: "same workspace" });
    assert.equal((await call("read", { path: "hello" })).content[0].text, "same workspace");
    assert.equal((await call("status")).active, true);
    assert.equal((await call("close")).chargedNanoUsd, "900000");
    assert.equal(stay.calls.filter(([name]) => name === "open").length, 1);
    assert.equal(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")).sessionId, "s1");
    assert.equal((await lstat(join(dir, "receipt.json"))).mode & 0o777, 0o600);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("guest verification failures propagate without executing commands", async () => {
  const stay = guest(); stay.open = async () => { throw new Error("refused: node registration measurements"); };
  const invoke = controller(stay, tools);
  await assert.rejects(invoke("open", terms), /refused: node registration measurements/);
  assert.deepEqual(stay.calls, []);
});

test("tool schema mismatch closes the guest before permitting work", async () => {
  const stay = guest(), invoke = controller(stay, []);
  await assert.rejects(invoke("open", terms), /tools differ/);
  assert.equal(stay.lease, null);
  assert.deepEqual(stay.calls.map(([name]) => name), ["open", "close"]);
});

test("unsupported open constraints fail before contacting the broker", async () => {
  const stay = guest(), invoke = controller(stay, tools);
  await assert.rejects(invoke("open", { ...terms, max_spend: 0.01 }), /Unsupported open constraint/);
  assert.deepEqual(stay.calls, []);
});

test("open passes the accepted browse terms to the stay", async () => {
  const stay = guest(), invoke = controller(stay, tools), browse = { mode: "named", hosts: ["en.wikipedia.org"] };
  await invoke("open", { ...terms, browse });
  assert.deepEqual(stay.calls[0][1].browse, browse);
});

test("a queued open cannot revive an owner after close", async () => {
  const stay = guest(), invoke = controller(stay, tools);
  await invoke("open", terms);
  const close = invoke("close"), reopen = invoke("open", terms);
  await close;
  await assert.rejects(reopen, /owner has closed/);
  assert.equal(stay.lease, null);
});

test("a failed open terminalizes the queue before another open can acquire a lease", async () => {
  const stay = guest(); let release, attempts = 0;
  const gate = new Promise(yes => { release = yes; });
  stay.open = async () => {
    attempts++;
    if (attempts === 1) { await gate; throw new Error("verification failed"); }
    stay.lease = { sessionId: "orphan" };
    return { tools };
  };
  const invoke = controller(stay, tools);
  const first = invoke("open", terms), queued = invoke("open", terms);
  release();
  await assert.rejects(first, /verification failed/);
  await assert.rejects(queued, /owner has closed/);
  assert.equal(attempts, 1);
  assert.equal(stay.lease, null);
});

test("malformed open arguments cannot leave a queued open running after shutdown", async () => {
  const stay = guest(), invoke = controller(stay, tools);
  const malformed = invoke("open", null), queued = invoke("open", terms);
  await assert.rejects(malformed, /Arguments must be a JSON object/);
  await assert.rejects(queued, /owner has closed/);
  assert.equal(stay.lease, null);
  assert.deepEqual(stay.calls, []);
});

test("another user cannot access a group-readable session directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ly-"));
  try { await chmod(dir, 0o755); await assert.rejects(privateDirectory(dir), /owner-only/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test("lost reply reports unknown execution and never resends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ly-")); let calls = 0;
  const server = createServer(socket => socket.once("data", () => { calls++; socket.destroy(); }));
  await new Promise(yes => server.listen(join(dir, "session.sock"), yes));
  await chmod(join(dir, "session.sock"), 0o600);
  try {
    await assert.rejects(request(dir, "bash", { command: "echo something" }), error => error.outcome === "unknown");
    assert.equal(calls, 1);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("shutdown queues cleanup after in-flight work and saves its receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ly-")), stay = guest();
  let began, release;
  const started = new Promise(yes => { began = yes; }), gate = new Promise(yes => { release = yes; });
  stay.tool = async () => { began(); await gate; assert.ok(stay.lease); return { content: [] }; };
  const server = await serve(dir, stay, tools);
  try {
    await request(dir, "open", terms);
    const work = request(dir, "bash", { command: "something slow" });
    await started;
    const finish = server.finish();
    assert.ok(stay.lease);
    release();
    await work;
    await finish;
    assert.equal(stay.lease, null);
    assert.equal(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")).chargedNanoUsd, "900000");
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("explicit paired cap and operation pass through while malformed authority never opens", async () => {
  const operation_id = "12345678-1234-1234-1234-123456789abc";
  for (const extra of [{max_spend_nano_usd:"900000"},{operation_id},{max_spend_nano_usd:900000,operation_id}]) {
    const stay=guest(), invoke=controller(stay,tools);
    await assert.rejects(invoke("open",{...terms,...extra}),/Spend cap/);
    assert.deepEqual(stay.calls,[]);
  }
  const stay=guest(),invoke=controller(stay,tools);
  await invoke("open",{...terms,max_spend_nano_usd:"900000",operation_id});
  assert.equal(stay.calls[0][1].maxSpendNanoUsd,"900000");
  assert.equal(stay.calls[0][1].operationId,operation_id);
});

#!/usr/bin/env node
// One local owner process retains the verified guest connection across CLI invocations.
import { createServer, connect } from "node:net";
import { mkdir, lstat, chmod, readFile, writeFile, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

const executable = fileURLToPath(import.meta.url);
const directory = () => resolve(process.env.LAYOVER_SESSION_DIR || join(homedir(), ".config/layover/session"));

export async function privateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error("Session directory must be an owner-only directory (0700), not a symlink.");
}

export function controller(stay, tools) {
  let queue = Promise.resolve(), closed = false;
  return (action, args = {}) => {
    const request = queue.then(async () => {
      try {
        if (closed) throw new Error("This session owner has closed; open a new session.");
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be a JSON object.");
        if (action === "open") {
          if (typeof args.publisher !== "string" || !Number.isInteger(args.slot_id) || typeof args.conversation_id !== "string")
            throw new Error("open needs publisher, slot_id and conversation_id from the accepted proposal.");
          if (Object.keys(args).some(key => !["publisher", "slot_id", "conversation_id", "browse", "max_spend_nano_usd", "operation_id"].includes(key)))
            throw new Error("Unsupported open constraint; only publisher, slot_id, conversation_id, browse and the paired spend cap/operation UUID are supported.");
          const capped = args.max_spend_nano_usd !== undefined || args.operation_id !== undefined;
          if (capped && !(typeof args.max_spend_nano_usd === "string" && /^[1-9][0-9]{0,38}$/.test(args.max_spend_nano_usd) &&
            typeof args.operation_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.operation_id)))
            throw new Error("Spend cap needs positive decimal max_spend_nano_usd and operation_id UUID.");
          const opened = await stay.open({ publisher: args.publisher, slotId: args.slot_id, conversationId: args.conversation_id, browse: args.browse,
            ...(capped ? { maxSpendNanoUsd: args.max_spend_nano_usd, operationId: args.operation_id } : {}) });
          const actual = opened.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
          if (JSON.stringify(actual) !== JSON.stringify(tools)) {
            await stay.close();
            throw new Error("The guest's tools differ from tools.json; the stay was closed.");
          }
          const { tools: unused, ...result } = opened;
          return result;
        }
        if (action === "status") return stay.summary();
        if (action === "close") {
          const receipt = await stay.close();
          closed = true;
          return receipt;
        }
        if (!tools.some(tool => tool.name === action)) throw new Error("Unknown action " + action);
        return stay.tool(action, args);
      } catch (error) {
        if (action === "open" && !stay.lease) closed = true;
        throw error;
      }
    });
    queue = request.catch(() => {});
    return request;
  };
}

export async function serve(dir, stay, tools) {
  await privateDirectory(dir);
  const path = join(dir, "session.sock"), invoke = controller(stay, tools);
  let timer, pending = 0;
  const shutdown = () => { clearTimeout(timer); if (server.listening) server.close(); };
  async function saveReceipt(receipt) {
    await writeFile(join(dir, "receipt.json"), JSON.stringify(receipt) + "\n", { mode: 0o600 });
  }
  function idle() {
    clearTimeout(timer);
    const seconds = stay.environment?.idleTimeoutSeconds;
    if (seconds > 0) timer = setTimeout(() => server.finish().catch(error => console.error("Idle close: " + error.message)), seconds * 1000);
  }
  const server = createServer(socket => {
    let buffer = "", dispatched = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", async chunk => {
      if (dispatched) return;
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      dispatched = true;
      pending++;
      clearTimeout(timer);
      let request;
      try {
        request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        const result = await invoke(request.action, request.args);
        if (request.action === "close") await saveReceipt(result);
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
        if (request.action === "close") shutdown();
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error.message }) + "\n");
        if (request?.action === "open" && !stay.lease) shutdown();
      } finally {
        pending--;
        if (!pending && server.listening) idle();
      }
    });
  });
  await new Promise((yes, no) => {
    server.once("error", no);
    server.listen(path, () => { server.off("error", no); yes(); });
  });
  await chmod(path, 0o600);
  server.finish = async () => {
    shutdown();
    await saveReceipt(await invoke("close"));
  };
  server.on("error", error => console.error(error.message));
  server.on("close", () => clearTimeout(timer));
  return server;
}

export async function request(dir, action, args = {}) {
  await privateDirectory(dir);
  const path = join(dir, "session.sock");
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error("Session endpoint must be an owner-only Unix socket (0600).");
  return new Promise((yes, no) => {
    let buffer = "", sent = false, complete = false;
    const socket = connect(path);
    const fail = error => { if (!complete) { complete = true; socket.destroy(); no(error); } };
    socket.setEncoding("utf8");
    socket.on("connect", () => { sent = true; socket.write(JSON.stringify({ action, args }) + "\n"); });
    socket.on("error", error => fail(Object.assign(error, { outcome: sent ? "unknown" : "not_sent" })));
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n") || complete) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        complete = true;
        socket.end();
        if (response.ok) yes(response.result);
        else no(Object.assign(new Error(response.error), { outcome: "reported_error" }));
      } catch (error) { fail(Object.assign(error, { outcome: "unknown" })); }
    });
    socket.on("end", () => { if (!complete) fail(Object.assign(new Error("Session connection ended without a result; do not resend work blindly."), { outcome: sent ? "unknown" : "not_sent" })); });
  });
}

async function start(dir) {
  await privateDirectory(dir);
  const path = join(dir, "session.sock");
  try {
    await lstat(path);
    // A refused connection permits removing only our stale socket, never a live session.
    await new Promise((yes, no) => { const s = connect(path); s.once("connect", () => { s.end(); yes(); }); s.once("error", no); });
    return;
  } catch (error) {
    if (error.code === "ECONNREFUSED") {
      const stat = await lstat(path);
      if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error("Refusing to replace an unexpected session endpoint.");
      await unlink(path);
    } else if (error.code !== "ENOENT") throw error;
  }
  const log = await open(join(dir, "session.log"), "a", 0o600);
  const child = fork(executable, ["--serve", dir], { detached: true, stdio: ["ignore", "ignore", log.fd, "ipc"] });
  try {
    await new Promise((yes, no) => {
      child.once("error", no);
      child.once("exit", code => no(new Error(`Session owner exited (${code}); inspect ${join(dir, "session.log")}.`)));
      child.once("message", msg => msg.ready ? yes() : no(new Error(msg.error)));
    });
    child.unref();
  } finally { await log.close(); }
}

async function daemon(dir) {
  if (!process.send) throw new Error("The session owner is started internally by open.");
  const { Stay } = await import("./stay.mjs");
  const { Wallet } = await import("ethers");
  const keyPath = process.env.LAYOVER_COUCH_KEY_FILE || join(dir, "wallet.key");
  try { await lstat(keyPath); }
  catch (error) {
    if (error.code !== "ENOENT" || process.env.LAYOVER_COUCH_KEY_FILE) throw error;
    await writeFile(keyPath, Wallet.createRandom().privateKey + "\n", { flag: "wx", mode: 0o600 });
  }
  const stat = await lstat(keyPath);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error("Wallet key must be an owner-only file (0600), not a symlink.");
  const key = (await readFile(keyPath, "utf8")).trim();
  const stay = new Stay(key);
  const tools = JSON.parse(await readFile(new URL("./tools.json", import.meta.url), "utf8"));
  const server = await serve(dir, stay, tools);
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
    try { await server.finish(); }
    catch (error) { console.error("Session cleanup was not confirmed: " + error.message); }
  });
  process.send({ ready: true });
  process.disconnect();
}

if (process.argv[1] && resolve(process.argv[1]) === executable) {
  try {
    const [action, input] = process.argv.slice(2);
    if (action === "--serve") await daemon(input);
    else {
      if (!action) throw new Error("Usage: node session.mjs open|bash|read|write|edit|status|close [JSON arguments]");
      const args = input ? JSON.parse(input) : {};
      if (action === "open") await start(directory());
      console.log(JSON.stringify(await request(directory(), action, args)));
    }
  } catch (error) {
    if (process.send) { process.send({ error: error.message }); process.disconnect(); }
    else console.error(JSON.stringify({ error: error.message, outcome: error.outcome || "not_sent" }));
    process.exitCode = 1;
  }
}

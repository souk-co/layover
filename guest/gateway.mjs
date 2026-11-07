// The gateway service, the only service in the guest with internet egress. It runs the control gateway (CONTROL_POLICY: the site,
// custody and the model broker, all on the pod) for the agent's own calls, and on the agent's request one egress-policy gateway
// per job or lease, plus the line gateway (ipinfo.io and Team Cymru over dns.google), each on its own port.
//   [UPSTREAM_PROXY=http://host:port] [CONTROL_PROXY=http://host:port] gateway.mjs GATEWAY_BIN CONTROL_POLICY BIND CONTROL_PORT API_PORT POLICY_DIR
// UPSTREAM_PROXY, a launch input (a public proxy on 11200/12321, or a host proxy at 192.168.127.254:18888-18891), is the upstream
// proxy of the line gateway and every requested gateway (the host's route for this
// guest); without it they go direct. The control gateway goes direct to the pod (IPRoyal refuses it), unless CONTROL_PROXY is set,
// which only the off-Mac harness does: the manifest does not declare it, so a launch cannot.
// API: GET /ready; POST /gateways (body: policy) -> {port}; DELETE /gateways/<port> -> {audit}, the gateway's audit lines.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const [BIN, CONTROL_POLICY, BIND, CONTROL_PORT, API_PORT, DIR] = process.argv.slice(2);
const proxy = (k) => process.env[k] ? ["-upstream-proxy", process.env[k]] : [];
const log = (...a) => console.error(new Date().toISOString(), "gateway", ...a);
const gateways = new Map();
process.on("exit", () => gateways.forEach((g) => g.proc.kill()));
process.on("SIGTERM", () => process.exit(0));

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, BIND, () => { const p = s.address().port; s.close(() => r(p)); }); });
const listening = (port) => new Promise((r) => net.connect(port, BIND).on("connect", function () { this.end(); r(true); }).on("error", () => r(false)));

async function start(file, port, extra = []) {
  const proc = spawn(BIN, ["-policy", file, "-http", `${BIND}:${port}`, "-dns", "", "-upstream-timeout", "60s", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  const g = { proc, audit: [] };
  proc.stdout.on("data", (c) => g.audit.push(...c.toString().split("\n").filter(Boolean)));
  let err = "", exited = false;
  proc.on("exit", (code) => { exited = true; gateways.delete(port); log(port, "exited", code, err.trim()); });
  await new Promise((resolve, reject) => {
    proc.stderr.on("data", (c) => { err += c; if (err.includes("egress gateway ready")) resolve(); });
    proc.on("error", reject);
    proc.on("exit", (code) => reject(new Error(`gateway exited ${code}: ${err.trim()}`)));
  });
  // The gateway prints "ready" just before ListenAndServe binds; wait for the listener itself.
  for (let i = 0; !(await listening(port)); i++) {
    if (i >= 50) throw new Error("gateway did not listen on port " + port);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error(`gateway exited after start: ${err.trim()}`);
  gateways.set(port, g);
  return g;
}

await start(CONTROL_POLICY, Number(CONTROL_PORT), ["-upstream-timeout", "180s", ...proxy("CONTROL_PROXY")]);
http.createServer(async (req, res) => {
  const reply = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  try {
    if (req.method === "GET" && req.url === "/ready") return reply(200, { ready: true });
    if (req.method === "POST" && req.url === "/gateways") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const port = await freePort(), file = `${DIR}/policy-${port}.json`;
      fs.writeFileSync(file, Buffer.concat(chunks));
      await start(file, port, proxy("UPSTREAM_PROXY"));
      return reply(200, { port });
    }
    const port = Number(/^\/gateways\/(\d+)$/.exec(req.url)?.[1]), g = gateways.get(port);
    if (req.method !== "DELETE" || !g || port === Number(CONTROL_PORT)) return reply(404, { error: `no ${req.method} ${req.url}` });
    await new Promise((r) => { g.proc.on("close", r); g.proc.kill(); });
    reply(200, { audit: g.audit });
  } catch (e) {
    log(req.method, req.url, "failed:", e.stack);
    reply(500, { error: e.message });
  }
}).listen(Number(API_PORT), BIND, () => log("control gateway on", CONTROL_PORT, "api on", API_PORT));

// Off-Mac test harness: the real site and custody (branch web, custody over unsigned local attestations) on localhost, a fake
// /v1/Attest socket that builds decodable but unsigned attestations with dsmack's guest_attest, and per run the gateway service
// (gateway.mjs with the real gateway binary) and the agent as child processes. The agent uses the production URLs: the control
// gateway's upstream is a local CONNECT proxy that terminates pod.dstack.soc1024.com with a test certificate (trusted through
// SSL_CERT_FILE) in front of the local site and model, and tunnels every other host to the internet. The model is the broker named by $BROKER, or (unset) a local stand-in speaking the
// broker's API that always accepts, encrypted to the client key like NEAR's E2EE. Like the broker, it holds a chat in flight until a usage call
// closes it and refuses prepare (409 REQUEST_IN_FLIGHT) meanwhile; broker.failUsage > 0 makes that many in-flight usage calls 500.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { SigningKey } from "ethers";

export const run = promisify(execFile);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const show = (label, v) => console.log("==", label, typeof v === "string" ? v : JSON.stringify(v));
export async function until(f, ms = 1000) { for (;;) { const v = await f(); if (v) return v; await sleep(ms); } }

// ORIGIN, when given, is an http request handler served as https://origin.resip.test (a stand-in site, terminated with the test certificate).
export const ORIGIN_HOST = "origin.resip.test";
// While cut.when() is true every custody commit is refused (the host cutting the custody link); cut.refused counts them.
export const cut = { when: () => false, refused: 0 };
// While outage.on every pod route whose path starts with outage.prefix (default: all of them: site, custody, broker) answers 502
// as the control gateway does for an unreachable upstream.
export const outage = { on: false, prefix: "/", served: 0 };
export async function harness(GW, WEB, DSMACK, AGENT, guestEnv = {}, ORIGIN = null) {
  const dir = fs.mkdtempSync("/tmp/resip-local-"), sock = dir + "/dstack.sock", PORT = 18700 + Math.floor(Math.random() * 100);
  const BASE = "http://127.0.0.1:" + PORT, kids = [];
  process.on("exit", () => kids.forEach((k) => k.kill()));
  fs.mkdirSync(dir + "/site");
  const importMap = dir + "/unsigned-fixture-import-map.json";
  fs.writeFileSync(importMap, JSON.stringify({ imports: { [new URL(WEB + "/verify.ts", "file:///").href]: new URL("verify.ts", import.meta.url).href } }));
  // Resolve the site's pinned npm imports independently of the guest's npm-installed dependencies.
  const site = spawn("deno", ["run", "-A", "--no-check", "--no-lock", "--node-modules-dir=none", new URL("site.ts", import.meta.url).pathname, WEB, String(PORT), dir + "/site"], { stdio: "inherit", env: { ...process.env, RESIP_TEST_WEB: WEB } });
  kids.push(site);

  const py = `import sys; sys.path.insert(0, ${JSON.stringify(DSMACK + "/dstack-compat")}); import guest_attest
print(guest_attest.attestation({"os_image_hash": "11"*32, "manifest_sha256": sys.argv[2], "run": "33"*32}, b"\\x55"*32, bytes.fromhex(sys.argv[1]),
  {"events": [{"name": "system-ready", "payload": ""}], "key_id": "44"*32, "assertion": "a0"}).hex())`;
  // attester.manifest is the manifest_sha256 every attestation states from then on (test/site.ts allows "22"x32 and "23"x32).
  const attester = { manifest: "22".repeat(32) };
  http.createServer((req, res) => { let s = ""; req.on("data", (c) => s += c); req.on("end", () => {
    res.end(JSON.stringify({ attestation: execFileSync("python3", ["-c", py, JSON.parse(s).report_data, attester.manifest]).toString().trim() })); }); }).listen(sock);

  const model = new SigningKey("0x" + crypto.randomBytes(32).toString("hex"));
  const REPLY = JSON.stringify({ decision: "accept", reason: "test model: accepts everything", quote: 1, forecasts: { captcha: 0, proxy_tag: 0, blocklist: 0, isp_notice: 0 }, rules: [] });
  const broker = { pending: false, failUsage: 0, nonces: new Set() };
  const fake = http.createServer((req, res) => { let s = ""; req.on("data", (c) => s += c); req.on("end", () => {
    const action = req.url.split("/").pop(), send = (v, status = 200) => res.writeHead(status).end(JSON.stringify(v));
    if (action === "quote") return send({ model: "test-model" });
    // As relay-broker's inference.mjs: a signed request must be fresh (issuedAt within 120 s) and its nonce unused.
    const signed = JSON.parse(s || "{}");
    if (signed.nonce !== undefined) {
      if (Math.abs(Date.now() / 1000 - signed.issuedAt) > 120) return send({ error: { code: "REQUEST_EXPIRED", message: "wallet request must be signed within 120 seconds" } }, 403);
      if (broker.nonces.has(signed.nonce)) return send({ error: { code: "REQUEST_REPLAY", message: "nonce already used" } }, 409);
      broker.nonces.add(signed.nonce);
    }
    if (action === "prepare" && broker.pending) return send({ error: { code: "REQUEST_IN_FLIGHT", message: "reconcile the previous inference request first" } }, 409);
    if (action === "usage" && broker.pending && broker.failUsage > 0 && broker.failUsage--) return res.writeHead(500).end("500 Internal Server Error\n\nServer got itself in trouble");
    if (action === "usage") broker.pending = false;
    if (action === "prepare") return send({ sessionId: "s", modelPublicKey: model.publicKey.slice(4), attestation: { verification: "verified", model: "test-model" } });
    if (action !== "chat") return send({});
    broker.pending = true;
    const client = JSON.parse(s).headers["x-client-pub-key"], eph = new SigningKey("0x" + crypto.randomBytes(32).toString("hex")), nonce = crypto.randomBytes(12);
    const shared = Buffer.from(eph.computeSharedSecret("0x" + (client.length === 128 ? "04" : "") + client).slice(4, 68), "hex");
    const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), "ecdsa_encryption", 32)), nonce);
    const content = Buffer.concat([Buffer.from(eph.publicKey.slice(2), "hex"), nonce, c.update(REPLY), c.final(), c.getAuthTag()]).toString("hex");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content } }] })}\n\ndata: [DONE]\n\n`);
  }); }).listen(0);
  await new Promise((r) => fake.on("listening", r));
  const POD = "pod.dstack.soc1024.com";
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=" + POD,
    "-addext", `subjectAltName=DNS:${POD},DNS:${ORIGIN_HOST}`, "-keyout", dir + "/pod.key", "-out", dir + "/pod.crt"], { stdio: "ignore" });
  fs.writeFileSync(dir + "/roots.pem", fs.readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8") + fs.readFileSync(dir + "/pod.crt", "utf8"));
  const routes = [["/resip-staging/", BASE + "/"], ["/resip-custody-staging/", BASE + "/"],
    ["/relay-broker-staging/", process.env.BROKER ? process.env.BROKER + "/" : "http://127.0.0.1:" + fake.address().port + "/"]];
  const pod = http.createServer(async (req, res) => {
    const [prefix, to] = routes.find(([p]) => req.url.startsWith(p)), chunks = [];
    if (outage.on && req.url.startsWith(outage.prefix)) { outage.served++; return res.writeHead(502).end("upstream_tls_or_io: test outage"); }
    if (cut.when() && req.url.endsWith("/commit")) { cut.refused++; return res.writeHead(503).end(JSON.stringify({ error: "custody unreachable" })); }
    for await (const c of req) chunks.push(c);
    const r = await fetch(to + req.url.slice(prefix.length), { method: req.method, headers: req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {},
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const b = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, r.headers.get("content-type") ? { "content-type": r.headers.get("content-type") } : {});
    res.end(b);
  });
  const origin = ORIGIN && http.createServer(ORIGIN);
  const upstream = http.createServer().on("connect", (req, sock, head) => {
    const [host, port] = req.url.split(":");
    if (host === POD || (origin && host === ORIGIN_HOST)) {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const t = new tls.TLSSocket(sock, { isServer: true, key: fs.readFileSync(dir + "/pod.key"), cert: fs.readFileSync(dir + "/pod.crt") });
      t.on("error", () => {});
      return (host === POD ? pod : origin).emit("connection", t);
    }
    const u = net.connect({ port: Number(port), host, family: 4 }, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); u.write(head); u.pipe(sock); sock.pipe(u); });
    u.on("error", () => sock.destroy()); sock.on("error", () => u.destroy());
  }).listen(0, "127.0.0.1");
  await new Promise((r) => upstream.on("listening", r));
  const env = { RESIP_BASE: `https://${POD}/resip-staging`, CUSTODY: `https://${POD}/resip-custody-staging/api/custody`, BROKER: `https://${POD}/relay-broker-staging`, AGENT_ID: AGENT, GUEST_VERSION: "test", APPRAISAL_MIN_SECONDS: "600", DSTACK_SOCKET: sock,
    INSTRUCTIONS: fs.readFileSync(new URL("../instructions.txt", import.meta.url), "utf8").trim(), DAILY_BYTES: String(5e9), OPERATOR: "0x" + "0e".repeat(20), ESCROW: "0x" + "e5".repeat(20), GUEST_ESCROW: "0x" + "9e".repeat(20), CHAIN_ID: "84532",
    MAX_RESPONSE_BYTES: String(4 << 20), POLL_SECONDS: "2", LIFETIME_SECONDS: "420", RETRY_SECONDS: "180",
    VANTAGE_TRACE_URL: "https://www.cloudflare.com/cdn-cgi/trace", FETCH_USER_AGENT: "Mozilla/5.0 resip-test", FETCH_ACCEPT_LANGUAGE: "en-US",
    LEASE_FLOOR_PRICE_CHECK: "30", LEASE_FLOOR_SHARED: "15", LEASE_FLOOR_ACCOUNT: "300", LEASE_MAX_REQUESTS: "200", LEASE_REQUESTS_PER_MINUTE: "30", VANTAGE_SECONDS: "60", CLAIM_SECONDS: "2", RENEW_GRACE_SECONDS: "120", ...guestEnv };
  const readyBy = Date.now() + 60000;
  for (;;) {
    if (site.exitCode !== null) throw new Error(`off-Mac fixture site exited ${site.exitCode} before becoming ready`);
    try {
      const r = await fetch(BASE + "/api/custody/" + AGENT, { signal: AbortSignal.timeout(1000) });
      if (r.ok && (await r.json()).agent_id === AGENT) break;
    } catch { /* The isolated local site may still be starting or loading its pinned test dependencies. */ }
    if (Date.now() >= readyBy) throw new Error("off-Mac fixture site did not become ready in 60 seconds");
    await sleep(100);
  }

  let n = 0;
  // Each run gets its own artifacts dir and gateway service, as on the Mac; exit resolves with the code and the tail of stderr.
  const guest = (extra = {}) => {
    const id = ++n, out = `${dir}/run-${id}`, ports = [PORT + 200 + 2 * id, PORT + 201 + 2 * id];
    fs.mkdirSync(out);
    const gs = spawn("node", [new URL("../gateway.mjs", import.meta.url).pathname, GW, new URL("../control-policy.json", import.meta.url).pathname, "127.0.0.1",
      ...ports.map(String), dir], { env: { ...process.env, SSL_CERT_FILE: dir + "/roots.pem", UPSTREAM_PROXY: "http://127.0.0.1:" + upstream.address().port, CONTROL_PROXY: "http://127.0.0.1:" + upstream.address().port }, stdio: ["ignore", "ignore", "pipe"] });
    gs.stderr.on("data", (c) => process.stderr.write(`[gateway ${id}] ` + c));
    const g = spawn("node", [new URL("../agent.mjs", import.meta.url).pathname], { env: { ...process.env, ...env, ARTIFACTS: out,
      GATEWAY_API: "http://127.0.0.1:" + ports[1], GATEWAY_CONTROL: "127.0.0.1:" + ports[0], ...extra }, stdio: ["ignore", "inherit", "pipe"] });
    g.on("exit", () => gs.kill());
    kids.push(gs, g);
    let err = "";
    g.stderr.on("data", (c) => { err += c; process.stderr.write(`[run ${id}] ` + c); });
    return { out, n: id, ports, proc: g, exit: new Promise((r) => g.on("exit", (code) => r({ code, err: err.slice(-1500) }))) };
  };
  const get = async (p) => (await fetch(BASE + "/api/" + p)).json();
  // A read as the buyer in directory d (its account secret), for the full lease and the account.
  const getAs = async (d, p) => (await fetch(BASE + "/api/" + p, { headers: { authorization: "Bearer " + JSON.parse(fs.readFileSync(d + "/account.json", "utf8")).secret } })).json();
  const cli = async (...args) => { const r = await run("deno", ["run", "-A", "--no-check", "--node-modules-dir=none", "--import-map", importMap, WEB + "/buyer/resip.ts", ...args], { maxBuffer: 1 << 24, env: { ...process.env, RESIP_TEST_WEB: WEB } }).catch((e) => e);
    console.log(`$ resip ${args.join(" ")}\n${r.stdout}${r.stderr ?? ""}`); return r; };
  const proxy = (d, lease, port) => { const p = spawn("deno", ["run", "-A", "--no-check", WEB + "/buyer/resip.ts", "proxy", d, lease, String(port)], { stdio: "inherit" }); kids.push(p); return p; };
  const curl = async (port, ca, url, ...extra) => { const r = await run("curl", ["-sS", "-i", "--max-time", "60", "-x", "http://127.0.0.1:" + port, "--cacert", ca, ...extra, url]).catch((e) => e);
    const line = (r.stdout ?? "").split("\r\n").filter((l) => /^(HTTP|x-resip|x-dsmack|set-cookie|content-type)/i.test(l)).join(" | ") + (r.stderr ?? "");
    show(`curl via ${port} ${url}`, line); return { ...r, line }; };
  // The response status a curl got through the proxy; a TLS failure after CONNECT leaves only "200 Connection established".
  const want = (r, status) => { if (!r.line.includes("HTTP/1.1 " + status)) throw new Error(`expected HTTP/1.1 ${status}, got: ${r.line}`); };
  // A CLI run's output must contain text (a lease decision, a statement line).
  const wantOut = (r, text) => { if (!(r.stdout ?? "").includes(text)) throw new Error(`expected "${text}" in: ${r.stdout}${r.stderr ?? ""}`); };
  // A buyer directory from the agent's current registration (the local attestation cannot pass `resip verify`).
  const buyer = async (d) => {
    const reg = (await get("agents")).find((a) => a.agent_id === AGENT);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(d + "/agent.json", JSON.stringify({ base: BASE, agent_id: AGENT, enc_pub: reg.enc_pub, facts: reg.verification.facts }));
    fs.writeFileSync(d + "/ca.pem", new crypto.X509Certificate(Buffer.from(reg.ca_cert, "hex")).toString());
    await cli("account", d);
  };
  const leaseId = (out) => /lease requested ([0-9a-f-]{36})/.exec(out.stdout)[1];
  // A lease request sealed here with fields the buyer CLI has no flag for (escrow), written to d/lease-<id>.json in the CLI's shape
  // so `resip proxy` serves it; resolves with the lease id and its decision.
  const lease = async (d, mode, deposit, fields) => {
    const r = await run("deno", ["eval", "--ext=js", `import { seal } from '${WEB}/static/common.js';
const [dir, fields, deposit, mode] = Deno.args, s = crypto.subtle, read = (f) => JSON.parse(Deno.readTextFileSync(dir + "/" + f));
const agent = read("agent.json"), { secret } = read("account.json"), hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = () => hex(crypto.getRandomValues(new Uint8Array(32))), reply = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
const plain = { kind: "lease", token: rand(), salt: rand(), reply_pub: hex(await s.exportKey("raw", reply.publicKey)), ...JSON.parse(fields) };
const res = await fetch(agent.base + "/api/leases", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + secret },
  body: JSON.stringify({ agent_id: agent.agent_id, deposit: Number(deposit), exclusive: mode === "exclusive", enc: await seal(agent.enc_pub, JSON.stringify(plain)) }) });
const j = await res.json();
if (!res.ok) throw new Error("leases: " + res.status + " " + j.error);
Deno.writeTextFileSync(dir + "/lease-" + j.id + ".json", JSON.stringify({ id: j.id, exclusive: mode === "exclusive", ...plain, reply_jwk: await s.exportKey("jwk", reply.privateKey) }));
console.log(j.id);`, d, JSON.stringify(fields), String(deposit), mode]);
    const id = r.stdout.trim();
    return { id, decision: (await until(async () => (await getAs(d, "leases/" + id)).decision, 1000)) };
  };
  return { dir, BASE, env, broker, attester, guest, get, getAs, cli, proxy, curl, want, wantOut, buyer, leaseId, lease };
}

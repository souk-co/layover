// Off-Mac test of a use:"account" lease on the dsmack PR #79 gateway: cookies both ways, the buyer's User-Agent, the session
// cap (max_sessions 1) inside a run and across a relaunch, the signup refusal, a WebSocket echo through the proxy, and a
// log that keeps only digests of cookies.
//   node test/account.mjs GATEWAY_BINARY(f5d3b9a5) WEB_DIR DSMACK_CHECKOUT
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { harness, show, sleep, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2), AGENT = "test-account-1";
const h = await harness(GW, WEB, DSMACK, AGENT), { get, cli, curl } = h;
const reg = async (after = "") => until(async () => (await get("agents")).filter((a) => a.agent_id === AGENT && a.at > after).at(-1), 500);
const run1 = h.guest({ LIFETIME_SECONDS: "100" }), r1 = await reg();
const A = h.dir + "/A", ca = A + "/ca.pem";
await h.buyer(A);
const caps = { session_cookies: ["sid"], max_sessions: 1, login_paths: ["/anything/login"], signup_paths: ["/anything/signup"], signup: false,
  post_paths: ["/anything/posts"], max_posts_per_hour: 2 };
const la = h.leaseId(await cli("lease", A, "httpbin.org,websocket.org", "account", "exclusive", "60", "300", "100", "Two test accounts", "", "--account=" + JSON.stringify(caps)));
h.proxy(A, la, 18821);
await sleep(2000);

// The lease's rules allow 30 requests a minute with a burst of one, so the requests are spaced.
const body = (r) => (r.stdout ?? "").split("\r\n\r\n").slice(2).join("").replace(/\s+/g, " ").slice(0, 300);
const c = async (...a) => { await sleep(2500); const r = await curl(18821, ca, ...a); if (!/ (200|302) /.test(r.line.split(" | ")[1] ?? "")) show("  refused with", body(r)); return r; };
show("cookie and User-Agent reach the origin", body(await c("https://httpbin.org/anything/me", "-b", "sid=one", "-A", "resip-buyer-ua/1")));
await c("https://httpbin.org/cookies/set?sid=one");
await c("https://httpbin.org/cookies", "-b", "sid=two");
await c("https://httpbin.org/anything/signup", "-b", "sid=one", "-X", "POST", "-d", "x=1");
await c("https://httpbin.org/anything/posts", "-b", "sid=one", "-X", "POST", "-d", "x=1");

// A WebSocket client through the buyer's CONNECT proxy, trusting the guest CA.
async function wsEcho(port, host, msg) {
  const raw = net.connect(port, "127.0.0.1");
  await once(raw, "connect");
  raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  let pre = Buffer.alloc(0);
  while (!pre.includes("\r\n\r\n")) pre = Buffer.concat([pre, (await once(raw, "data"))[0]]);
  const t = tls.connect({ socket: raw, servername: host, ca: fs.readFileSync(ca), ALPNProtocols: ["http/1.1"] });
  await once(t, "secureConnect");
  let buf = Buffer.alloc(0), wake = null;
  t.on("data", (c) => { buf = Buffer.concat([buf, c]); wake?.(); });
  const more = () => new Promise((r) => { wake = r; setTimeout(r, 10000); });
  t.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: resip-buyer-ua/1\r\n\r\n`);
  while (!buf.includes("\r\n\r\n")) await more();
  const i = buf.indexOf("\r\n\r\n"), headLines = buf.subarray(0, i).toString().split("\r\n");
  buf = buf.subarray(i + 4);
  show("websocket upgrade", headLines.filter((l) => /^(HTTP|x-resip|x-dsmack)/i.test(l)).join(" | "));
  if (!headLines[0].includes(" 101 ")) return;
  const frame = async () => {
    while (buf.length < 2 || buf.length < 2 + (buf[1] & 127)) await more();
    const n = buf[1] & 127;
    if (n >= 126) throw new Error("test reads short frames only");
    const payload = buf.subarray(2, 2 + n).toString();
    buf = buf.subarray(2 + n);
    return payload;
  };
  const mask = crypto.randomBytes(4), p = Buffer.from(msg);
  t.write(Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), mask, p.map((b, j) => b ^ mask[j % 4])]));
  const frames = [await frame(), await frame()];
  show("websocket frames", frames);
  t.destroy();
  return frames.includes(msg);
}
await sleep(2500);
show("websocket echoes", await wsEcho(18821, "echo.websocket.org", "hi resip"));

show("run 1 exit", (await run1.exit).code);
const run2 = h.guest();
await reg(r1.at);
await until(async () => fs.existsSync(run2.out + "/log") && fs.readFileSync(run2.out + "/log", "utf8").includes("vantage"), 1000);
await c("https://httpbin.org/cookies", "-b", "sid=one");
await c("https://httpbin.org/cookies", "-b", "sid=two");

const rows = [run1, run2].flatMap((g) => fs.readFileSync(g.out + "/log", "utf8").split("\n").filter(Boolean));
// sid=one also appears in the /cookies/set URL; sid=two was only ever sent as a cookie.
show("log keeps no cleartext cookie", !rows.some((r) => r.includes("sid=two")) && rows.every((r) => !("cookie" in JSON.parse(r).entry)));
show("log", rows.map((s) => JSON.parse(s).entry).filter((e) => e.kind !== "vantage")
  .map((e) => `${e.seq} ${e.kind} ${e.method ?? ""} ${e.url ?? e.host ?? ""} ${e.status ?? ""} ${e.reason ?? ""} ${e.account ?? ""} ${e.websocket_stream ?? ""} ${e.cookie_sha256 ? "cookie " + e.cookie_sha256.slice(0, 12) : ""}`).join("\n"));
process.exit(0);

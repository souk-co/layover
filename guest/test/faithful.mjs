// Off-Mac test that a shared price_check lease carries a stand-in site's responses to the buyer as the site sent them: a 3 MiB
// page arrives whole with the guest still up, a gzip body keeps its Content-Encoding, the origin sees the request headers the
// buyer sent (Accept-Language, Accept-Encoding; the manifest's User-Agent for price_check), and the end-of-lease statement counts every request the buyer holds a receipt for.
//   node test/faithful.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { harness, ORIGIN_HOST, run, show, sleep, until } from "./harness.mjs";

const [GW, WEB, DSMACK] = process.argv.slice(2), AGENT = "test-faithful-1";
const BIG = crypto.randomBytes(3 << 20), GZ = zlib.gzipSync("<html>gzip body</html>"), seen = [];
const h = await harness(GW, WEB, DSMACK, AGENT, {}, (req, res) => {
  seen.push(req.headers);
  if (req.url === "/big") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(BIG);
  // Like amazon.com: gzip whether or not the request asked for it.
  if (req.url === "/gzip") return res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(GZ);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.headers));
});
const g = h.guest();
g.exit.then((x) => { console.error("guest exited", x.code); process.exit(1); });
await until(async () => (await h.get("agents")).find((a) => a.agent_id === AGENT), 500);
const A = h.dir + "/A", ca = A + "/ca.pem";
await h.buyer(A);
// The term ends in 3 minutes.
const la = h.leaseId(await h.cli("lease", A, ORIGIN_HOST, "price_check", "shared", "3", "20", "1", "Stand-in site"));
h.proxy(A, la, 18831);
await sleep(2000);

const receipts = [];
// The lease allows 30 requests a minute with a burst of one, so requests are spaced.
const get = async (path, ...extra) => {
  await sleep(2500);
  await run("curl", ["-sS", "--max-time", "60", "-x", "http://127.0.0.1:18831", "--cacert", ca, "-D", h.dir + "/headers", "-o", h.dir + "/body", ...extra, `https://${ORIGIN_HOST}${path}`]);
  const hs = fs.readFileSync(h.dir + "/headers", "utf8"), receipt = /^x-resip-receipt: (.*)$/im.exec(hs)?.[1];
  if (receipt) receipts.push(receipt.trim());
  show("GET " + path, hs.split("\r\n").filter((l) => /^(HTTP|x-resip|content-)/i.test(l)).join(" | "));
  h.want({ line: hs }, "200 OK");
  return { headers: hs, body: fs.readFileSync(h.dir + "/body") };
};
const big = await get("/big");
if (!big.body.equals(BIG)) throw new Error(`3 MiB page: got ${big.body.length} bytes, sha256 ${crypto.createHash("sha256").update(big.body).digest("hex")}`);
show("3 MiB page", "arrived whole");
await get("/echo", "-H", "Accept-Language: fr-CH, fr;q=0.9", "-H", "Accept-Encoding: gzip, br", "-A", "buyer-agent/1");
const echo = seen.at(-1);
show("origin saw", echo);
// price_check sends the manifest's User-Agent, not the buyer's.
if (echo["accept-language"] !== "fr-CH, fr;q=0.9" || echo["accept-encoding"] !== "gzip, br" || echo["user-agent"] !== h.env.FETCH_USER_AGENT) throw new Error("headers at the origin: " + JSON.stringify(echo));
const gz = await get("/gzip");
if (!/^content-encoding: gzip\r?$/im.test(gz.headers) || !gz.body.equals(GZ)) throw new Error("gzip page: " + gz.headers);
show("gzip page", "Content-Encoding: gzip, body as sent");

await until(async () => (await h.get("leases/" + la)).status !== "active", 5000);
const st = (await h.getAs(A, "leases/" + la)).end.statement;
show("statement", { requests_by_lease: st.requests_by_lease, receipts: receipts.length });
if (st.requests_by_lease !== receipts.length) throw new Error(`statement counts ${st.requests_by_lease} requests, the buyer holds ${receipts.length} receipts`);
process.exit(0);

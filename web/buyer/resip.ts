// Buyer CLI for resip leases and the proxy (Mode 2); USAGE below.
import { agentBinding, binding, canonical, hex, sha256, unhex, verify } from "../verify.ts";
import { seal } from "../static/common.js";

const USAGE = `resip: buyer CLI for resip leases. State lives in DIR (agent.json, ca.pem, account.json, lease-<id>.json).
  resip verify  BASE AGENT_ID DIR      check the agent's attestation binds its key and proxy CA; writes DIR/agent.json and DIR/ca.pem (run first)
  resip account DIR                    make or reuse DIR/account.json; take staging credit from the faucet (needs verify)
  resip lease   DIR DOMAINS USE exclusive|shared TERM_MINUTES PRICE_CENTS_PER_GB DEPOSIT_CENTS [TASK] [RENEWS_ID] [--account=JSON]
                [--buyer-wallet=0xADDRESS --terms-hash=0xBYTES32 --escrow=0xCONTRACT]  (an escrow lease: the wallet that deposited, the
                accepted terms' hash and the escrow holding them, all signed into the end-of-lease statement; a dev-credit lease passes none)
                DOMAINS comma-separated; USE price_check or account (account is exclusive only); exclusive: no other lease, bounty or
                appraisal reaches DOMAINS from the line during the term; shared: other shared leases and bounties may; the price is per GB
                (10^9 bytes) of your requests and responses through the line, heads included; DEPOSIT_CENTS is what you pay in now (it buys
                DEPOSIT / PRICE GB; the lease lapses when your traffic reaches that; topup adds more; the unspent rest comes back at the end)
                use account needs --account='{"session_cookies":[..],"max_sessions":N,"login_paths":[..],"signup_paths":[..],"signup":false,"post_paths":[..],"max_posts_per_hour":N}'
  resip bounty  DIR KEY URLS_FILE MAX_PRICE_CENTS [TASK]
                a fetch job: the line GETs each https URL in URLS_FILE (one per line, a URL may repeat, at most 50) once, within
                30 minutes; KEY labels the bounty (the souk thread id for a souk fetch job); waits and prints each page's status,
                size and content sha256 as the guest signed them (the pages themselves are not returned)
  resip topup   DIR LEASE_ID CENTS
  resip status  DIR LEASE_ID           lease state; after the end, verify the statement and the receipts chain
  resip proxy   DIR LEASE_ID PORT      HTTP CONNECT proxy on 127.0.0.1:PORT (e.g. 18471), streams carried by the site's relay
Run as: deno run -A resip.ts <command> ... (or the bundled kit/resip.js)`;
const s = crypto.subtle, te = new TextEncoder();
const read = (p: string) => {
  try { return JSON.parse(Deno.readTextFileSync(p)); }
  catch (e) { if (e instanceof Deno.errors.NotFound) throw new Error(`${p} not found${p.endsWith("/agent.json") ? "; run resip verify BASE AGENT_ID DIR first" : p.endsWith("/account.json") ? "; run resip account DIR first" : ""}`); throw e; }
};
const write = (p: string, v: unknown) => Deno.writeTextFileSync(p, JSON.stringify(v, null, 1), { mode: 0o600 });
async function call(base: string, path: string, body?: unknown, secret?: string) {
  const r = await fetch(base + "/api/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: "Bearer " + secret } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${path}: ${r.status}, not JSON: ${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error}`);
  return j;
}
const rand = () => hex(crypto.getRandomValues(new Uint8Array(32)));

async function verifyAgent(base: string, agentId: string, dir: string) {
  const a = (await call(base, "agents")).find((x: { agent_id: string }) => x.agent_id === agentId);
  if (!a) throw new Error("no agent " + agentId);
  if (!a.ca_cert) throw new Error(`agent ${agentId} registered no proxy CA`);
  const v = await verify(a.attestation, await agentBinding(a.enc_pub, a.ca_cert));
  for (const c of v.checks) console.log(c.ok ? "pass" : "FAIL", c.name, "-", c.detail);
  if (!v.ok) throw new Error("attestation did not verify; not trusting this CA");
  console.log(`measured guest: manifest ${v.facts.manifest_sha256}, image ${v.facts.os_image_hash} (web's "Custody: allow guest" commits name the guest commit for each manifest)`);
  const der = unhex(a.ca_cert), b64 = btoa(String.fromCharCode(...der)).replace(/.{64}/g, "$&\n");
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(dir + "/ca.pem", `-----BEGIN CERTIFICATE-----\n${b64.trim()}\n-----END CERTIFICATE-----\n`);
  write(dir + "/agent.json", { base, agent_id: agentId, enc_pub: a.enc_pub, ca_sha256: hex(await sha256(der)), registered: a.at, facts: v.facts, mode: v.mode });
  console.log(`verified: report_data = sha256(enc_pub) || sha256(CA DER); CA sha256 ${hex(await sha256(der))}; wrote ${dir}/ca.pem`);
}

async function account(dir: string) {
  const p = dir + "/account.json", agent = read(dir + "/agent.json");
  try { Deno.statSync(p); } catch { write(p, { secret: rand() }); }
  const { secret } = read(p), id = hex(await sha256(unhex(secret)));
  const r = await call(agent.base, "accounts/faucet", {}, secret);
  console.log(`account ${id}: staging balance ${r.balance} cents (not money)`);
}

async function lease(dir: string, domains: string, use: string, mode: string, term: string, price: string, deposit: string, task = "", renews?: string) {
  if (mode !== "exclusive" && mode !== "shared") throw new Error(`mode is "${mode}": exclusive or shared\n` + USAGE);
  const agent = read(dir + "/agent.json"), { secret } = read(dir + "/account.json");
  const reply = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const plain = { kind: "lease", domains: domains.split(","), use, term_minutes: Number(term), price_per_gb: Number(price), token: rand(), salt: rand(),
    reply_pub: hex(new Uint8Array(await s.exportKey("raw", reply.publicKey))), task, ...(renews ? { renews } : {}), ...(caps ? { account: JSON.parse(caps) } : {}),
    ...(wallet || termsHash || escrow ? { buyer_wallet: wallet, terms_hash: termsHash, escrow } : {}) };
  if ((wallet || termsHash || escrow) && !(wallet && termsHash && escrow)) throw new Error("an escrow lease needs --buyer-wallet, --terms-hash and --escrow together\n" + USAGE);
  const r = await call(agent.base, "leases", { agent_id: agent.agent_id, deposit: Number(deposit), exclusive: mode === "exclusive", enc: await seal(agent.enc_pub, JSON.stringify(plain)),
    ...(termsHash ? { terms_hash: termsHash } : {}) }, secret);
  write(`${dir}/lease-${r.id}.json`, { id: r.id, exclusive: mode === "exclusive", ...plain, reply_jwk: await s.exportKey("jwk", reply.privateKey) });
  console.log("lease requested", r.id, `(${mode}) - waiting for the agent's decision`);
  for (;;) {
    const l = await call(agent.base, "leases/" + r.id, undefined, secret);
    if (l.decision) return console.log(l.decision.decision, "-", l.decision.reason, l.decision.decision === "accept" ? `| ${l.decision.price_per_gb} c/GB, term ends ${l.decision.term_end}, paid for ${l.paid_bytes} bytes` : "");
    await new Promise((x) => setTimeout(x, 3000));
  }
}

async function bounty(dir: string, key: string, file: string, price: string, task = "fetch these public pages") {
  const agent = read(dir + "/agent.json"), urls = Deno.readTextFileSync(file).split("\n").map((x) => x.trim()).filter(Boolean);
  const plain = { task, urls, method: "GET", max_requests: urls.length, deliver_by: new Date(Date.now() + 30 * 60e3).toISOString(), max_price: Number(price) };
  const r = await call(agent.base, "bounties", { agent_id: agent.agent_id, buyer_key: key, enc: await seal(agent.enc_pub, JSON.stringify(plain)) });
  console.log("bounty posted", r.id, `(${urls.length} URLs) - waiting for the agent's decision`);
  for (let last = "open"; ; await new Promise((x) => setTimeout(x, 5000))) {
    const b = await call(agent.base, "bounties/" + r.id);
    if (last === "open" && b.decision) console.log(b.decision.decision, "-", b.decision.reason);
    last = b.status;
    if (b.status === "declined") return;
    if (b.status === "expired") return console.log("expired -", b.expired.reason);
    if (b.status !== "done") continue;
    for (const i of b.result.result.items) console.log(i.status, `${i.bytes}B`, i.sha256, i.url);
    const st = await call(agent.base, `bounties/${r.id}/statement`);
    return console.log(`served ${st.served} of ${st.requested}, attestation ${st.attestation_pass ? "pass" : "FAIL"}`);
  }
}

async function status(dir: string, id: string) {
  const agent = read(dir + "/agent.json"), mine = read(`${dir}/lease-${id}.json`), l = await call(agent.base, "leases/" + id, undefined, read(dir + "/account.json").secret);
  console.log(JSON.stringify({ status: l.status, exclusive: l.exclusive, funds: l.funds, charged: l.charged, paid_bytes: l.paid_bytes, decision: l.decision?.reason,
    vantage: l.vantage.map((v: Record<string, unknown>) => `${v.checked_at} commit ${v.ip_commit} AS${v.asn} same_ip=${v.same_ip}`) }, null, 1));
  if (!l.end) return;
  const st = l.end.statement;
  const e = l.end.receipts_enc;
  const z = await s.deriveBits({ name: "X25519", public: await s.importKey("raw", unhex(e.epk), { name: "X25519" }, false, []) },
    await s.importKey("jwk", mine.reply_jwk, { name: "X25519" }, false, ["deriveBits"]), 256);
  const key = await s.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: te.encode("resip-receipts/1") },
    await s.importKey("raw", z, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const rc = JSON.parse(new TextDecoder().decode(await s.decrypt({ name: "AES-GCM", iv: unhex(e.nonce) }, key, unhex(e.ct))));
  let head = rc.start_prev_head;
  if (head !== st.log.start_prev_head || rc.rows[0].seq !== st.log.start_seq || rc.rows.at(-1).seq !== st.log.end_seq) throw new Error("receipts do not span the statement's window");
  for (const [i, r] of rc.rows.entries()) {
    if (r.seq !== st.log.start_seq + i) throw new Error("receipt rows are not contiguous at " + r.seq);
    if (r.entry && hex(await sha256(te.encode(canonical(r.entry)))) !== r.digest) throw new Error("entry digest mismatch at " + r.seq);
    head = hex(await sha256(unhex(head + r.digest)));
  }
  if (head !== st.log.end_head) throw new Error("receipts chain does not reach the statement's end_head");
  const own = rc.rows.filter((r: { entry: unknown }) => r.entry);
  if (own.some((r: { entry: { lease: string } }) => r.entry.lease !== id)) throw new Error("receipts show another lease's entry in full");
  console.log(`receipts chain ok: ${rc.rows.length} entries, ${own.length} yours in full, reaches end_head ${head}`);
  console.log("statement:", canonical(st));
  const v = await verify(l.end.attestation, await binding(te.encode(canonical(st))), { manifest_sha256: agent.facts.manifest_sha256 });
  for (const c of v.checks) console.log(c.ok ? "pass" : "FAIL", c.name, "-", c.detail);
  if (!v.ok) throw new Error("end-of-lease statement attestation did not verify");
  console.log(`statement verified (${v.mode}): ${st.claim}\n  exclusive: ${st.exclusive}, shared_with: ${st.shared_with}\n  ${st.start} .. ${st.end}, ended: ${st.end_reason}\n  requests to ${st.domains.join(",")}: ${st.requests_to_domains}, by this lease: ${st.requests_by_lease}, refused to others: ${st.refused_to_others}\n  vantage: ${st.vantage.checks} checks, ${st.vantage.ip_commits.length} distinct IP commitment(s) under your salt, AS ${st.vantage.asns.join(",")}`);
}

// --- proxy: frames as in the guest's lease.mjs (resip-stream/1) ---
const nonce = (n: number) => { const b = new Uint8Array(12); new DataView(b.buffer).setBigUint64(4, BigInt(n)); return b; };
const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };
async function tunnel(conn: Deno.Conn, agent: Record<string, any>, mine: Record<string, any>) {
  let head = new Uint8Array(0);
  const buf = new Uint8Array(65536);
  while (!new TextDecoder().decode(head).includes("\r\n\r\n")) {
    const n = await conn.read(buf);
    if (n === null) return conn.close();
    head = cat(head, buf.slice(0, n));
  }
  const text = new TextDecoder().decode(head), end = text.indexOf("\r\n\r\n") + 4, rest = head.slice(te.encode(text.slice(0, end)).length);
  const m = /^CONNECT ([a-z0-9.-]+):(\d+) HTTP\/1\.[01]\r\n/i.exec(text);
  if (!m) { await conn.write(te.encode("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n")); return conn.close(); }
  const { stream_id } = await call(agent.base, "relay/open", { agent_id: agent.agent_id }), url = `${agent.base}/api/relay/${stream_id}`;
  const eph = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair, epk = new Uint8Array(await s.exportKey("raw", eph.publicKey));
  const ikm = await s.importKey("raw", await s.deriveBits({ name: "X25519", public: await s.importKey("raw", unhex(agent.enc_pub), { name: "X25519" }, false, []) }, eph.privateKey, 256), "HKDF", false, ["deriveKey"]);
  const k = (d: string) => s.deriveKey({ name: "HKDF", hash: "SHA-256", salt: epk, info: te.encode("resip-stream/1 " + d) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const up = await k("up"), down = await k("down");
  let nUp = 0, nDown = 0, flushing: Promise<void> | null = null;
  const queue: Uint8Array[] = [epk];
  const flush = async () => {
    while (queue.length) { const r = await fetch(url + "/up", { method: "POST", body: cat(...queue.splice(0)) }); if (!r.ok) throw new Error("relay up " + r.status); await r.body?.cancel(); }
    flushing = null;
  };
  const send = async (pt: Uint8Array) => {
    const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv: nonce(nUp++) }, up, pt)), h = new Uint8Array(4);
    new DataView(h.buffer).setUint32(0, ct.length);
    queue.push(h, ct);
    flushing ??= flush();
  };
  await send(te.encode(JSON.stringify({ lease_id: mine.id, token: mine.token, host: m[1].toLowerCase(), port: Number(m[2]) })));
  let inbuf = new Uint8Array(0), first = true, done = 0;
  const finish = () => { if (++done === 2) conn.close(); };
  for (;;) {
    const r = await fetch(url + "/down");
    if (r.status === 410) break;
    if (!r.ok) throw new Error("relay down " + r.status);
    inbuf = cat(inbuf, new Uint8Array(await r.arrayBuffer()));
    while (inbuf.length >= 4 && inbuf.length >= 4 + new DataView(inbuf.buffer, inbuf.byteOffset).getUint32(0)) {
      const len = new DataView(inbuf.buffer, inbuf.byteOffset).getUint32(0);
      const pt = new Uint8Array(await s.decrypt({ name: "AES-GCM", iv: nonce(nDown++) }, down, inbuf.slice(4, 4 + len)));
      inbuf = inbuf.slice(4 + len);
      if (!first) { await conn.write(pt); continue; }
      first = false;
      const ack = JSON.parse(new TextDecoder().decode(pt));
      if (!ack.ok) { console.error("refused by the guest:", ack.error); await conn.write(te.encode(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${ack.error.length + 1}\r\n\r\n${ack.error}\n`)); return conn.close(); }
      await conn.write(te.encode("HTTP/1.1 200 Connection established\r\n\r\n"));
      if (rest.length) await send(rest);
      (async () => {
        for (;;) { const n = await conn.read(buf); if (n === null) break; await send(buf.slice(0, n)); }
        while (flushing) await flushing;
        await fetch(url + "/up/close", { method: "POST" }).then((x) => x.body?.cancel());
        finish();
      })().catch((e) => console.error("upstream pump:", e.message));
    }
  }
  if (first) return conn.close();
  await conn.closeWrite();
  finish();
}
async function proxy(dir: string, id: string, port: string) {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error(`PORT is "${port}": a TCP port 1-65535\n` + USAGE);
  const agent = read(dir + "/agent.json"), mine = read(`${dir}/lease-${id}.json`), listener = Deno.listen({ hostname: "127.0.0.1", port: Number(port) });
  console.log(`resip-proxy for lease ${id} on 127.0.0.1:${port}; use HTTPS_PROXY=http://127.0.0.1:${port} and trust ${dir}/ca.pem`);
  for await (const conn of listener) tunnel(conn, agent, mine).catch((e) => { console.error("stream:", e.message); conn.close(); });
}

const [cmd, ...rest] = Deno.args;
const flag = (n: string) => rest.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
const caps = flag("account"), wallet = flag("buyer-wallet"), termsHash = flag("terms-hash"), escrow = flag("escrow"), a = rest.filter((x) => !/^--(account|buyer-wallet|terms-hash|escrow)=/.test(x));
const cmds: Record<string, (...x: string[]) => Promise<void>> = { verify: verifyAgent, account, lease, bounty, status, proxy,
  topup: async (dir, id, cents) => { const agent = read(dir + "/agent.json"); console.log(await call(agent.base, `leases/${id}/topup`, { amount: Number(cents) }, read(dir + "/account.json").secret)); } };
const arity: Record<string, [number, number]> = { verify: [3, 3], account: [1, 1], lease: [7, 9], bounty: [4, 5], status: [2, 2], proxy: [3, 3], topup: [3, 3] };
const help = ["help", "--help", "-h"].includes(cmd) || a.includes("--help") || a.includes("-h");
if (help || !cmds[cmd]) { (help ? console.log : console.error)(USAGE); Deno.exit(help ? 0 : 2); }
if (a.length < arity[cmd][0] || a.length > arity[cmd][1]) { console.error(`resip ${cmd}: ${a.length} argument(s), wants ${arity[cmd].join("-")}\n${USAGE}`); Deno.exit(2); }
try { await cmds[cmd](...a); }
catch (e) { console.error(`resip ${cmd}: ${(e as Error).message}`); Deno.exit(1); }

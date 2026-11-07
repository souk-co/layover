// Real main entrypoint, control HTTP path, Unix Attest and sealed-state crypto. Only unused SDK imports are stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const AGENT = "test-drain", CHALLENGE = "bb".repeat(32), OWNER = "0x" + "11".repeat(20);
const hex = bytes => Buffer.from(bytes).toString("hex"), sha = bytes => crypto.createHash("sha256").update(bytes).digest();
const canonical = object => JSON.stringify(object, Object.keys(object).sort());
const key = Buffer.alloc(32, 0x81);
const freshState = () => ({ agent_id: AGENT, enc_priv: "aa", ca: { key: "bb", cert: "cc" }, wallet: "0x" + "33".repeat(32), budget: { day: "2026-11-06", used: 17 },
  chain: { head: "00".repeat(32), seq: 0, entries: [] }, leases: [], holds: [], claim_history: [{ key: "private-history-marker" }] });
function sealedState(value) {
  const nonce = Buffer.alloc(12, 0x09), enc = crypto.createCipheriv("aes-256-gcm", crypto.hkdfSync("sha256", key, Buffer.alloc(0), "resip-state/1 enc", 32), nonce);
  enc.setAAD(Buffer.from(AGENT));
  return Buffer.concat([nonce, enc.update(typeof value === "string" ? value : JSON.stringify(value)), enc.final(), enc.getAuthTag()]);
}
function sealKey(publicHex) {
  const ephemeral = crypto.generateKeyPairSync("x25519"), recipient = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(publicHex, "hex").toString("base64url") }, format: "jwk" });
  const z = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), nonce = Buffer.alloc(12, 0x08);
  const enc = crypto.createCipheriv("aes-256-gcm", crypto.hkdfSync("sha256", z, Buffer.alloc(0), "resip-custody/1 release", 32), nonce);
  return { epk: hex(Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x, "base64url")), nonce: hex(nonce),
    ct: hex(Buffer.concat([enc.update(JSON.stringify({ key: hex(key) })), enc.final(), enc.getAuthTag()])) };
}
async function runtime({ state = freshState(), genesis = false, raceAt = 0, challenge = CHALLENGE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-runtime-")), output = path.join(dir, "out"), sock = path.join(dir, "attest.sock"); fs.mkdirSync(output);
  const loader = path.join(dir, "unused-sdk-fixture.mjs");
  fs.writeFileSync(loader, `import {registerHooks} from 'node:module'; registerHooks({resolve(s,c,next){const code={
'ethers':'export class Wallet {constructor(){throw Error("forbidden wallet initialization")} static createRandom(){throw Error("forbidden wallet creation")}}',
'@nearai/inference-sdk':'export function prepareE2eeChatRequest(){throw Error("forbidden model call")}',
'@peculiar/x509':'export const cryptoProvider={set(){}};'}[s];return code?{url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true}:next(s,c)}});`);
  const blob = sealedState(state), head = hex(sha(blob)), seq = 7, requests = [], attestations = [];
  let gets = 0;
  const attester = http.createServer((req, res) => { let body = ""; req.on("data", c => body += c); req.on("end", () => {
    assert.equal(req.url, "/v1/Attest"); const rd = JSON.parse(body).report_data; attestations.push(rd); res.end(JSON.stringify({ attestation: "ab" + rd }));
  }); });
  const control = http.createServer((req, res) => { let body = ""; req.on("data", c => body += c); req.on("end", () => {
    requests.push(req.method + " " + req.url);
    const send = value => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.url === "/ready" && req.method === "GET") return send({ ready: true });
    const custody = "/resip-custody-staging/api/custody/" + AGENT;
    if (req.url === custody && req.method === "GET") {
      gets++; return send({ agent_id: AGENT, operator: OWNER, head: genesis ? null : gets === raceAt ? "ff".repeat(32) : head, seq: genesis ? 0 : gets === raceAt ? 8 : seq });
    }
    if (req.url === custody + "/release" && req.method === "POST") {
      const request = JSON.parse(body); assert.equal(request.head, head);
      const expected = hex(sha(canonical({ agent_id: AGENT, eph_pub: request.eph_pub, head, kind: "resip-custody-release/1" }))) + "00".repeat(32);
      assert.equal(request.attestation, "ab" + expected, "real restore binds existing head and fresh ephemeral key");
      return send({ head, seq, key: sealKey(request.eph_pub), blob: hex(blob) });
    }
    res.statusCode = 403; send({ error: "forbidden preflight side effect" });
  }); });
  await new Promise(resolve => attester.listen(sock, resolve)); await new Promise(resolve => control.listen(0, "127.0.0.1", resolve));
  const port = control.address().port;
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, RESIP_BASE: "https://pod.test/resip-staging", CUSTODY: "https://pod.test/resip-custody-staging/api/custody", BROKER: "https://pod.test/relay-broker-staging",
    AGENT_ID: AGENT, GUEST_VERSION: "drain-fixture", DSTACK_SOCKET: sock, INSTRUCTIONS: "fixture", GATEWAY_API: "http://127.0.0.1:" + port, GATEWAY_CONTROL: "127.0.0.1:" + port,
    ARTIFACTS: output, DAILY_BYTES: "1000", MAX_RESPONSE_BYTES: "1024", POLL_SECONDS: "1", LIFETIME_SECONDS: "1", RETRY_SECONDS: "0",
    OPERATOR: OWNER, ESCROW: "0x" + "11".repeat(20), GUEST_ESCROW: "0x" + "22".repeat(20), CHAIN_ID: "84532", VANTAGE_TRACE_URL: "https://trace.test/",
    FETCH_USER_AGENT: "fixture", FETCH_ACCEPT_LANGUAGE: "en", APPRAISAL_MIN_SECONDS: "1", LEASE_FLOOR_PRICE_CHECK: "1", LEASE_FLOOR_SHARED: "1", LEASE_FLOOR_ACCOUNT: "1",
    LEASE_MAX_REQUESTS: "2", LEASE_REQUESTS_PER_MINUTE: "2", VANTAGE_SECONDS: "2", CLAIM_SECONDS: "2", RENEW_GRACE_SECONDS: "2", DRAIN_PREFLIGHT_CHALLENGE: challenge };
  try {
    const child = spawn(process.execPath, ["--import", loader, new URL("../agent.mjs", import.meta.url).pathname], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const code = await new Promise(resolve => child.once("exit", resolve)); clearTimeout(timer);
    const files = fs.readdirSync(output), artifact = files.includes("drain-checkpoint") ? JSON.parse(fs.readFileSync(path.join(output, "drain-checkpoint"))) : null;
    if (artifact) assert.equal(fs.statSync(path.join(output, "drain-checkpoint")).mode & 0o777, 0o600);
    return { code, stdout, stderr, files, artifact, requests, attestations, head, seq };
  } finally { await new Promise(resolve => control.close(resolve)); await new Promise(resolve => attester.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
}
test("actual entrypoint restores existing encrypted state via control only and writes one private attested checkpoint", { timeout: 10000 }, async () => {
  const r = await runtime(); assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
  assert.deepEqual(r.files, ["drain-checkpoint"]);
  assert.deepEqual([r.artifact.checkpoint.agent_id, r.artifact.checkpoint.head, r.artifact.checkpoint.seq, r.artifact.checkpoint.challenge], [AGENT, r.head, r.seq, CHALLENGE]);
  assert.equal(r.artifact.checkpoint.status, "empty");
  assert.equal(r.artifact.attestation, "ab" + hex(sha(canonical(r.artifact.checkpoint))) + "00".repeat(32));
  assert.equal(r.requests.filter(x => x.endsWith("/release")).length, 1); assert.equal(r.attestations.length, 2);
  assert.ok(r.requests.every(x => x === "GET /ready" || x === "GET /resip-custody-staging/api/custody/" + AGENT || x === "POST /resip-custody-staging/api/custody/" + AGENT + "/release"));
  for (const secret of ["private-history-marker", "wallet", "claim_key", "ca", "budget"]) assert.equal(Object.hasOwn(r.artifact, secret), false);
});
test("actual entrypoint reports an expired sealed escrow lease active without resuming, admitting or modifying it", { timeout: 10000 }, async () => {
  const state = freshState();
  state.leases = [{ id: "00000000-0000-4000-8000-000000000001", account: "44".repeat(32), domains: ["private.example"], use: "price_check", price: 200,
    bytes: 0, paid_bytes: 100, token: "55".repeat(32), salt: "66".repeat(32), reply_pub: "77".repeat(32), start: 1000, term_end: 2000,
    until: new Date(2000).toISOString(), startSeq: 0, startPrev: "00".repeat(32), vantage: [], buyer_wallet: "0x" + "88".repeat(20), terms_hash: "0x" + "99".repeat(32), escrow: "0x" + "22".repeat(20) }];
  const r = await runtime({ state }); assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.artifact.checkpoint.status, r.artifact.checkpoint.total_leases, r.artifact.checkpoint.active_escrow_leases], ["active", 1, 1]);
  assert.equal(JSON.stringify(r.artifact).includes("private.example"), false);
  assert.equal(r.requests.some(x => /commit|gateways|inference|leases|agents/.test(x)), false);
});

test("genesis and empty/malformed challenge fail without release/init/commit or checkpoint", { timeout: 10000 }, async () => {
  for (const options of [{ genesis: true }, { challenge: "" }, { challenge: "bad" }]) {
    const r = await runtime(options); assert.notEqual(r.code, 0); assert.equal(r.artifact, null); assert.equal(r.attestations.length, 0);
    assert.equal(r.requests.some(x => x.endsWith("/release") || x.includes("commit")), false);
    if (options.genesis) assert.match(r.stderr, /existing committed custody head/);
    else { assert.match(r.stderr, /challenge must/); assert.deepEqual(r.requests, []); }
  }
});
test("restore/attest races and malformed sealed JSON never export state or emit a checkpoint", { timeout: 10000 }, async () => {
  for (const raceAt of [2, 3, 4]) { const r = await runtime({ raceAt }); assert.notEqual(r.code, 0); assert.equal(r.artifact, null); assert.match(r.stderr, /custody.*changed/); assert.equal(r.requests.filter(x => x.endsWith("/release")).length, 1); }
  const r = await runtime({ state: '{"wallet":"private-parse-marker",bad' });
  assert.notEqual(r.code, 0); assert.equal(r.artifact, null); assert.match(r.stderr, /sealed state is not valid JSON/); assert.equal(r.stderr.includes("private-parse-marker"), false);
  const wrong = await runtime({ state: { ...freshState(), agent_id: "private-owner-marker" } });
  assert.notEqual(wrong.code, 0); assert.equal(wrong.artifact, null); assert.match(wrong.stderr, /owner\/layout mismatch/);
  assert.equal(wrong.stderr.includes("private-owner-marker"), false);
});

// Offline HTTP fixture: real local signatures and production guest envelope; hardware/chain are injected.
import { attestLeaseAction, attestBountyAction } from "../guest/guest-action.mjs";
import { configure, handler, SOUK_URL } from "./server.ts";
import { agentBinding, canonical, hex, sha256, unhex } from "./verify.ts";
import { GUEST_ACTION_AUDIENCE } from "./guest-action.ts";

type Rec = Record<string, any>;
export const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export const F = { run: "33".repeat(32), manifest_sha256: "22".repeat(32), os_image_hash: "11".repeat(32), key_id: "44".repeat(32), caller: "55".repeat(32) };
export const agentId = "test-guest-auth", resourceId = "00000000-0000-4000-8000-000000000001", otherId = "00000000-0000-4000-8000-000000000002";
const operator = "0x" + "66".repeat(20), secret = "ab".repeat(32);

// Decodable registration fixture. Hardware/chain checks are injected below; request
// binding and signatures use real Ed25519 keys, and all network requests are blocked.
function pack(v: any): number[] {
  if (typeof v === "number") return v < 128 ? [v] : [0xcc, v];
  if (typeof v === "string") { const b = [...new TextEncoder().encode(v)]; return [...(b.length < 32 ? [0xa0 + b.length] : [0xd9, b.length]), ...b]; }
  if (Array.isArray(v)) return [...(v.length < 16 ? [0x90 + v.length] : [0xdc, v.length >> 8, v.length & 255]), ...v.flatMap(pack)];
  const entries = Object.entries(v); return [0x80 + entries.length, ...entries.flatMap(([k, x]) => [...pack(k), ...pack(x)])];
}

export function registrationQuote(facts = F, reportData = new Uint8Array(64), counter: number[] = [], reencoded = false, assertionBytes?: number[]) {
  const field = (name: string, bytes: number[]) => [0x60 + name.length, ...new TextEncoder().encode(name), 0x40 + bytes.length, ...bytes];
  const assertionFields = [field("authenticatorData", counter), field("signature", [0])];
  const assertion = assertionBytes ?? [0xa2, ...(reencoded ? assertionFields.reverse() : assertionFields).flat()];
  const a = { version: 1, platform: { kind: "apple-app-attest", data: { key_id: [...unhex(facts.key_id)], assertion } },
    stack: { kind: "dsmack", data: { ...Object.fromEntries(["run", "manifest_sha256", "os_image_hash", "caller"].map(k => [k, [...unhex(facts[k as keyof typeof F])]])),
      report_data: [...reportData], events: [{ event: "system-ready", payload: "" }] } } };
  const reverseMaps = (v: any): any => Array.isArray(v) ? v.map(reverseMaps) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).reverse().map(([k, value]) => [k, reverseMaps(value)])) : v;
  return hex(Uint8Array.from(pack(reencoded ? reverseMaps(a) : a)));
}

export async function fixture({ active = false, token = false, resource = "lease" as "lease" | "bounty" } = {}) {
  const dir = await Deno.makeTempDir(), dirs = [dir], account = hex(await sha256(unhex(secret)));
  const host = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]), stranger = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKeys = new Map([[F.key_id, host.publicKey], ["66".repeat(32), stranger.publicKey]]);
  const registrations = new Map<string, Rec>();
  const now = new Date().toISOString(), enc_pub = "77".repeat(32);
  const regData = await agentBinding(enc_pub, null);
  const registration = (facts = F, counter: number[] = [], reencoded = false) => {
    const attestation = registrationQuote(facts, regData, counter, reencoded);
    registrations.set(attestation, facts);
    return { kind: "agent", agent_id: agentId, enc_pub, attestation, ca_cert: null, coarse: { region: "r", isp_class: "cable", residential: true }, at: now };
  };
  const quote = async (digest: Uint8Array, facts = F, key = host.privateKey) => {
    const claims = { data: hex(Uint8Array.from([...digest, ...new Uint8Array(32)])), facts };
    return hex(encode({ ...claims, signature: hex(new Uint8Array(await crypto.subtle.sign("Ed25519", key, encode(claims)))) }));
  };
  let gated: { attestation: string; entered: () => void; wait: Promise<void> } | undefined;
  const verify = async (attestation: string, data: Uint8Array, expect?: Rec) => {
    if (gated?.attestation === attestation) { gated.entered(); await gated.wait; }
    const registered = registrations.get(attestation);
    if (registered) return { ok: hex(data) === hex(regData), facts: registered, checks: [], checked_at: "fixture" };
    let claims: Rec;
    try { claims = JSON.parse(new TextDecoder().decode(unhex(attestation))); }
    catch { return { ok: false, facts: F, checks: [{ name: "signature", ok: false, detail: "invalid quote" }], checked_at: "fixture" }; }
    const publicKey = publicKeys.get(claims.facts?.key_id);
    const signature = publicKey && await crypto.subtle.verify("Ed25519", publicKey, unhex(claims.signature), encode({ data: claims.data, facts: claims.facts }));
    const checks = [{ name: "signature", ok: !!signature, detail: "local Ed25519 fixture" },
      { name: "report_data", ok: claims.data === hex(data), detail: "exact signed digest" },
      { name: "registration", ok: !expect || claims.facts.run === expect.run && claims.facts.manifest_sha256 === expect.manifest_sha256, detail: "run/manifest" }];
    return { ok: checks.every(x => x.ok), facts: claims.facts, checks, checked_at: "fixture" };
  };
  const custody = { operator, allowed: { manifests: [F.manifest_sha256], os_image_hashes: [F.os_image_hash] } };
  const owners = [operator];
  configure({ verify: verify as never, custody: "http://fixture-custody/", operators: async () => owners });
  const realFetch = globalThis.fetch, pushes: { url: string; auth: string | null; body: Rec }[] = [], souk = { reply: Response.json({}) };
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("http://fixture-custody/")) return Promise.resolve(Response.json(custody));
    if (String(url) === SOUK_URL + "/api/souk_send") {
      pushes.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(init!.body as string) });
      return Promise.resolve(souk.reply.clone());
    }
    throw new Error("Unexpected network access in guest action test: " + url);
  }) as typeof fetch;
  const lease = { kind: "lease", id: resourceId, agent_id: agentId, account, deposit: token ? 0 : 50, exclusive: false, enc_pub,
    enc: { epk: "88".repeat(32), nonce: "99".repeat(12), ct: "aa".repeat(40) }, at: now,
    ...(token ? { admission: { price_per_gb: 200 }, token_budget_bytes: 1000000 } : {}) };
  const bounty = { kind: "bounty", id: resourceId, agent_id: agentId, buyer_key: "thread-fixture", at: now };
  const initial: Rec[] = resource === "lease"
    ? [registration(), { kind: "credit", account, amount: 100, note: "fixture", at: now }, lease, { ...lease, id: otherId, deposit: 0 }]
    : [registration(), bounty, { ...bounty, id: otherId }];
  if (active) initial.push(resource === "lease"
    ? { kind: "lease_decision", lease_id: resourceId, agent_id: agentId, decision: "accept", price_per_gb: 200,
      term_end: new Date(Date.now() + 240000).toISOString(), at: now }
    : { kind: "decision", bounty_id: resourceId, agent_id: agentId, decision: "accept", reason: "fixture", at: now });
  await Deno.writeTextFile(dir + "/records.jsonl", initial.map(x => JSON.stringify(x) + "\n").join(""));
  const post = async (action: string, body: Rec, id = resourceId, dataDir = dir, env?: Record<string, string>) => {
    const path = resource === "lease" ? "leases" : "bounties";
    const r = await handler(new Request(`http://local/api/${path}/${id}/${action}`, { method: "POST", body: JSON.stringify(body) }),
      { dataDir, env: env ?? (resource === "bounty" ? { SOUK_DOORMAN_CREDENTIAL: "doorman-token" } : undefined) });
    return { status: r.status, body: await r.json() };
  };
  const rows = async (dataDir = dir) => (await Deno.readTextFile(dataDir + "/records.jsonl")).trim().split("\n").map(x => JSON.parse(x));
  const signed = (action: string, payload: Rec, facts = F, key = host.privateKey, id = resourceId) =>
    (resource === "lease" ? attestLeaseAction : attestBountyAction)(
      { audience: GUEST_ACTION_AUDIENCE, agentId, leaseId: id, bountyId: id, action, payload }, digest => quote(digest, facts, key));
  const resign = async (body: Rec, facts = F, key = host.privateKey) => {
    body.authorization.attestation = await quote(await sha256(new TextEncoder().encode(canonical(body.authorization.message))), facts, key);
    return body;
  };
  const register = async (facts: typeof F, counter: number[] = [], changes: Rec = {}, reencoded = false) => {
    const { ca_cert: _absent, ...body } = registration(facts, counter, reencoded);
    const r = await handler(new Request("http://local/api/agents", { method: "POST", body: JSON.stringify({ ...body, ...changes }) }), { dataDir: dir });
    return { status: r.status, body: await r.json() };
  };
  const get = async (path: string, privateRead = false, dataDir = dir) => (await handler(new Request("http://local/api/" + path,
    { headers: privateRead ? { authorization: "Bearer " + secret } : {} }), { dataDir })).json();
  const endPayload = async ({ crash = false, badQuote = false } = {}) => {
    const end_reason = crash ? "guest restarted without ending the lease; no log covers it" : "term ended";
    const statement = { kind: "layover-lease-statement/2", agent_id: agentId, lease_id: resourceId, end_reason, exclusive: false,
      ...(crash ? {} : { bytes_up: 0, bytes_down: 50000000, log: { end_head: "bb".repeat(32) }, domains: ["private.example"] }) };
    return { end_reason, statement, receipts_enc: null, attestation: badQuote ? "00" : await quote(await sha256(new TextEncoder().encode(canonical(statement)))) };
  };
  const resultPayload = async (items: Rec[] = [{ status: 200 }], facts = F, key = host.privateKey) => {
    const result = { bounty_id: resourceId, items, region: "US", isp_class: "cable", residential: true, policy_sha256: "cc".repeat(32) };
    return { result, attestation: await quote(await sha256(new TextEncoder().encode(canonical(result))), facts, key) };
  };
  return { dir, token, initial, account, host, stranger, custody, owners, quote, verify, signed, resign, post, rows, get, register, registration, endPayload, resultPayload, pushes, souk,
    async restart() { const restarted = await Deno.makeTempDir(); dirs.push(restarted); await Deno.copyFile(dir + "/records.jsonl", restarted + "/records.jsonl"); return restarted; },
    gate(attestation: string) {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(r => entered = r), wait = new Promise<void>(r => release = r);
      gated = { attestation, entered, wait }; return { started, release };
    },
    async close() { await new Promise(r => setTimeout(r, 0)); globalThis.fetch = realFetch; for (const d of dirs) await Deno.remove(d, { recursive: true }); } };
}

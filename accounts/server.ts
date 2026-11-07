// Layover accounts: an attested webhost service that holds one wallet per email and spends it only as that email asks.
// Wallet keys are derived inside the TEE from the project's dstack GetKey seed (ctx.env.ACCOUNTS_SEED, manifest dstack_env)
// and the email; they are never stored and leave only through POST /export. The service signs EIP-3009 and EIP-712
// authorizations with the user's key and a relayer key (also derived from the seed) submits them and pays the gas, so user
// wallets never hold ETH. GuestEscrow enforces the payment; this service only deposits, accepts and closes terms, and withdraws.
// Sign-in is the souk's mailed code, proxied: the service asks the souk to mail a code to the email and checks the code with
// the souk, so a session proves the email the same way a souk sign-in does. See README.md.
import { Wallet } from "npm:ethers@6.13.4/wallet";
import { Interface } from "npm:ethers@6.13.4/abi";
import { AdmissionError, authorizeLease, SITE } from "./lease_authorization.ts";
import { registerArgs, RelayError } from "./guest_relay.ts";

type Ctx = { dataDir: string; env: Record<string, string> };
type Rec = Record<string, any>;
export class Bad extends Error {}
class Unauthorized extends Bad {}
const must = (c: unknown, m: string) => { if (!c) throw new Bad(m); };
const enc = new TextEncoder(), DAY = 86400e3, SESSION_MS = 7 * DAY, CHALLENGE_MS = 10 * 60e3;
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const normalize = (email: string) => email.trim().normalize("NFC").toLowerCase();
const ZERO = "0x" + "0".repeat(40);
const isAddr = (s: unknown) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const units = (s: unknown, f: string) => { must(typeof s === "string" && /^\d{1,30}$/.test(s), `${f}: a decimal string of LAYC base units (6 decimals)`); return BigInt(s as string); };

export const abi = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "function balance(address) view returns (uint256)",
  "function deposits(address) view returns (uint256)",
  "function paid(address) view returns (uint256)",
  "function exposure(address) view returns (uint256)",
  "function withdrawNonce(address) view returns (uint256)",
  "function totalClaimed(address,bytes32) view returns (uint256)",
  "function terms(address,bytes32) view returns (address operator, uint256 cap, uint64 closedAt, bool released)",
  "function depositWithAuthorization(address,uint256,uint256,uint256,bytes32,bytes)",
  "function acceptTermsFor(address,bytes32,address,uint256,bytes)",
  "function closeTermsFor(address,bytes32,bytes)",
  "function withdrawFor(address,address,uint256,bytes,bytes32[])",
  "function guestKeys(address) view returns (address operator, bytes32 workload, bytes32 kid, bytes32 cdhash)",
  "function claimed(address,bytes32,address) view returns (uint256)",
  "function registerGuestKey(address,address,(bytes32,bytes32,bytes32,bytes32),(string,bytes)[],bytes)",
  "function claim(address,bytes32,uint256,bytes)",
]);

async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", unhex(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const unhex = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(s.replace(/^0x/, "").match(/../g)!, (h) => parseInt(h, 16));
// One secp256k1 key per label; Wallet throws on the (2^-128) out-of-range scalar.
const derive = async (env: Ctx["env"], label: string) => {
  must(/^(0x)?[0-9a-f]{64}$/i.test(env.ACCOUNTS_SEED ?? ""), "ACCOUNTS_SEED (manifest dstack_env) is not set");
  return new Wallet(hex(await hmac(env.ACCOUNTS_SEED, "layover-accounts/1/" + label)));
};
export const userWallet = (env: Ctx["env"], email: string) => derive(env, "email/" + normalize(email));
export const relayer = (env: Ctx["env"]) => derive(env, "relayer");
export const admissionSigner = (env: Ctx["env"]) => derive(env, "lease-admission/1");

function cfg(env: Ctx["env"]) {
  for (const k of ["RPC", "TOKEN", "ESCROW", "SOUK_URL", "SOUK_ID", "CHAIN_ID", "POT_KEY", "STARTER", "STARTERS_PER_DAY", "RELAYS_PER_DAY"]) must(env[k], `${k} is not set in this deploy`);
  return { rpc: env.RPC, token: env.TOKEN, escrow: env.ESCROW, souk: env.SOUK_URL.replace(/\/$/, ""), soukId: env.SOUK_ID, chainId: BigInt(env.CHAIN_ID),
    starter: BigInt(env.STARTER), startersPerDay: Number(env.STARTERS_PER_DAY), relaysPerDay: Number(env.RELAYS_PER_DAY) };
}

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Bad(`${method}: ${j.error.message}${j.error.data ? " " + JSON.stringify(j.error.data) : ""}`);
  return j.result;
}
const call = async (c: Rec, to: string, fn: string, args: unknown[]) =>
  abi.decodeFunctionResult(fn, await rpc(c.rpc, "eth_call", [{ to, data: abi.encodeFunctionData(fn, args) }, "latest"]));

// Every send is serialized: one nonce at a time, each mined before the next.
let chain: Promise<unknown> = Promise.resolve();
function send(c: Rec, from: Wallet, to: string, fn: string, args: unknown[]) {
  const task = chain.then(async () => {
    const data = abi.encodeFunctionData(fn, args);
    const [nonce, gas, fee, tip] = await Promise.all([rpc(c.rpc, "eth_getTransactionCount", [from.address, "pending"]),
      rpc(c.rpc, "eth_estimateGas", [{ from: from.address, to, data }]), rpc(c.rpc, "eth_gasPrice", []), rpc(c.rpc, "eth_maxPriorityFeePerGas", [])]);
    const raw = await from.signTransaction({ type: 2, chainId: c.chainId, nonce: Number(nonce), to, data, gasLimit: BigInt(gas) * 6n / 5n,
      maxFeePerGas: BigInt(fee) * 2n + BigInt(tip), maxPriorityFeePerGas: BigInt(tip) });
    const hash = await rpc(c.rpc, "eth_sendRawTransaction", [raw]);
    for (let i = 0; i < 120; i++) {
      const rc = await rpc(c.rpc, "eth_getTransactionReceipt", [hash]);
      if (rc) {
        if (rc.status !== "0x1") throw new Bad(`${fn} ${hash} reverted`);
        return { fn, tx: hash, gas_used: Number(rc.gasUsed) };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Bad(`${fn} ${hash} not mined in 120 s`);
  });
  chain = task.catch(() => {});
  return task;
}
const chainNow = async (c: Rec) => BigInt((await rpc(c.rpc, "eth_getBlockByNumber", ["latest", false])).timestamp);
const nonce32 = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const sig = (s: string) => [parseInt(s.slice(130, 132), 16), "0x" + s.slice(2, 66), "0x" + s.slice(66, 130)];
// An EIP-3009 TransferWithAuthorization from the user's wallet, valid for an hour of chain time.
async function authorize(c: Rec, user: Wallet, to: string, value: bigint) {
  const a = { from: user.address, to, value, validAfter: 0n, validBefore: (await chainNow(c)) + 3600n, nonce: nonce32() };
  const s = await user.signTypedData({ name: "Layover Credit", version: "1", chainId: c.chainId, verifyingContract: c.token },
    { TransferWithAuthorization: ["from:address", "to:address", "value:uint256", "validAfter:uint256", "validBefore:uint256", "nonce:bytes32"].map((x) => ({ name: x.split(":")[0], type: x.split(":")[1] })) }, a);
  return { a, s };
}

// The escrow's EIP-712 domain is per user (the salt), as for claims.
const escrowSign = (c: Rec, user: Wallet, type: string, fields: { name: string; type: string }[], value: Rec) =>
  user.signTypedData({ name: "LayoverGuestEscrow", version: "1", chainId: c.chainId, verifyingContract: c.escrow, salt: "0x" + user.address.slice(2).toLowerCase().padStart(64, "0") }, { [type]: fields }, value);

// One request at a time per email, so a user's own spam queues behind itself and concurrent accepts cannot over-commit.
const lanes = new Map<string, Promise<unknown>>();
function lane<T>(email: string, f: () => Promise<T>): Promise<T> {
  const t = (lanes.get(email) ?? Promise.resolve()).then(f);
  lanes.set(email, t.catch(() => {}));
  return t;
}
// Every transaction the relayer pays for counts against the email's daily budget; the check is made before any is sent.
async function budget(c: Rec, ctx: Ctx, email: string, n: number) {
  const used = (await ledger(ctx)).filter((r) => r.kind === "relay" && r.email === email && Date.parse(r.at) > Date.now() - DAY).length;
  must(used + n <= c.relaysPerDay, `daily limit of ${c.relaysPerDay} relayed transactions reached for this email (${used} used, ${n} needed); try tomorrow`);
}
async function relay(c: Rec, ctx: Ctx, email: string, to: string, fn: string, args: unknown[]) {
  const t = await send(c, await relayer(ctx.env), to, fn, args);
  await append(ctx, { kind: "relay", email, fn, tx: t.tx });
  return t;
}

async function ledger(ctx: Ctx): Promise<Rec[]> {
  try {
    return (await Deno.readTextFile(ctx.dataDir + "/ledger.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}
const append = (ctx: Ctx, r: Rec) => Deno.writeTextFile(ctx.dataDir + "/ledger.jsonl", JSON.stringify({ ...r, at: new Date().toISOString() }) + "\n", { append: true });

// Sessions: base64url({e, x}).HMAC(session key). Stateless; they expire after SESSION_MS.
async function sessionFor(env: Ctx["env"], email: string) {
  const p = b64u(enc.encode(JSON.stringify({ e: email, x: Date.now() + SESSION_MS })));
  return p + "." + b64u(await hmac((await derive(env, "session")).privateKey, p));
}
async function authed(req: Request, env: Ctx["env"]) {
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /, ""), [p, m] = t.split(".");
  if (!p || !m) throw new Unauthorized("sign in first: POST /login, then /verify; send Authorization: Bearer <session>");
  const want = b64u(await hmac((await derive(env, "session")).privateKey, p));
  if (want.length !== m.length || [...want].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ m.charCodeAt(i)), 0)) throw new Unauthorized("bad session");
  const { e, x } = JSON.parse(new TextDecoder().decode(unb64u(p)));
  if (x < Date.now()) throw new Unauthorized("session expired: sign in again");
  return e as string;
}

const challenges = new Map<string, { email: string; exp: number; purpose: "login" | "export" }>();
async function souk(c: Rec, path: string, body: Rec, token?: string) {
  const r = await fetch(c.souk + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw (r.status === 401 ? new Unauthorized(`souk: ${j.error}`) : new Bad(`souk ${path}: HTTP ${r.status} ${j.error ?? ""}`));
  return j;
}

async function startChallenge(c: Rec, email: string, purpose: "login" | "export") {
  const { challenge_id } = await souk(c, "/api/auth/code", { email });
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  challenges.set(challenge_id, { email, exp: Date.now() + CHALLENGE_MS, purpose });
  return { challenge_id, code_sent_to: email, next: purpose === "login" ? "POST /verify {challenge_id, code} with the code from that email" : "POST /export {confirm, challenge_id, code} with the code from that email" };
}
// Souk Dev and Staging accept 000000 for any address (SOUK_TEST_SIGNIN_CODE); a mailed code is never 000000.
// Past the souk's mail limits (5 codes an hour per address, 300 host-wide) Dev sets the code to 000000 and mails nothing,
// so this service then refuses every sign-in until the window passes.
async function checkCode(c: Rec, body: Rec, purpose: string, email?: string) {
  const ch = challenges.get(body.challenge_id);
  if (!ch || ch.exp < Date.now() || ch.purpose !== purpose || (email && ch.email !== email)) throw new Unauthorized("unknown or expired challenge: start again");
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code) || body.code === "000000") throw new Unauthorized("code: the six digits from the email");
  const out = await souk(c, "/api/auth/verify", { challenge_id: body.challenge_id, code: body.code });
  challenges.delete(body.challenge_id);
  return { ch, ...out };
}

// Starter credit: once per souk person (not per mailbox string), only for members of the IP souk (so the doorman's signup limits apply), from the pot,
// at most STARTERS_PER_DAY per UTC day. Checks and records are serialized, and the record is written before the transfer,
// so a crash can lose a starter payment but never pay one twice.
let starters: Promise<unknown> = Promise.resolve();
function starter(c: Rec, ctx: Ctx, person: string, email: string, to: string, soukToken: string) {
  const decided = starters.then(async () => {
    const rows = (await ledger(ctx)).filter((r) => r.kind === "starter"), today = new Date().toISOString().slice(0, 10);
    if (rows.some((r) => r.person === person || r.email === email)) return null;
    const member = (await souk(c, "/api/souk_list", {}, soukToken)).some((x: Rec) => x.souk_id === c.soukId);
    if (!member) return { skipped: "not a member of the IP souk: sign up at the Layover site first, then sign in again" };
    if (rows.filter((r) => r.at.startsWith(today)).length >= c.startersPerDay) return { skipped: `starter limit (${c.startersPerDay} a day) reached; try tomorrow` };
    await append(ctx, { kind: "starter", person, email, to, amount: String(c.starter) });
    return "pay";
  });
  starters = decided.catch(() => {});
  return decided.then((d): Promise<Rec> | Rec | null => d === "pay" ? send(c, new Wallet(ctx.env.POT_KEY), c.token, "transfer", [to, c.starter]) : d);
}

// Wallet and escrow position. Closed terms past their grace are "releasable": withdrawing frees their unclaimed remainder from exposure.
async function balances(c: Rec, ctx: Ctx, email: string, address: string) {
  const [[wallet], [escrow], [deposits], [paid], [raw], now] = await Promise.all([call(c, c.token, "balanceOf", [address]), call(c, c.escrow, "balance", [address]),
    call(c, c.escrow, "deposits", [address]), call(c, c.escrow, "paid", [address]), call(c, c.escrow, "exposure", [address]), chainNow(c)]);
  const releasable: string[] = [];
  let exposure = raw as bigint;
  for (const h of new Set((await ledger(ctx)).filter((r) => r.kind === "accept" && r.email === email).map((r) => r.termsHash as string))) {
    const [, cap, closedAt, released] = await call(c, c.escrow, "terms", [address, h]);
    if (closedAt && !released && now >= closedAt + BigInt(DAY / 1000)) { releasable.push(h); exposure -= BigInt(cap) - BigInt((await call(c, c.escrow, "totalClaimed", [address, h]))[0]); }
  }
  return { address, wallet: String(wallet), escrow: String(escrow), deposited: String(deposits), paid: String(paid), exposure: String(exposure),
    withdrawable: String(escrow > exposure ? escrow - exposure : 0n), releasable, decimals: 6 };
}

// Relays for the host, open to anyone (the minion calls /relay/sweep each cycle): register every agent's published claim key
// and submit every ended lease's latest guest claim that GuestEscrow has not paid yet. Inputs come only from the site's public
// records; send() estimates gas first, so a request the contract would refuse sends nothing.
async function siteGet(ctx: Ctx, path: string) {
  const r = await fetch((ctx.env.SITE ?? SITE) + path, { signal: AbortSignal.timeout(60000), headers: { "cache-control": "no-cache" } });
  const j = await r.json();
  must(r.ok, `site ${path}: HTTP ${r.status} ${j.error ?? ""}`);
  return j;
}
async function relayRegister(c: Rec, ctx: Ctx, agentId: string) {
  const [row] = await siteGet(ctx, "/api/agents?agent_id=" + encodeURIComponent(agentId));
  must(row?.guest_key, `agent ${agentId}: no published guest_key`);
  must(row.guest_key.escrow === c.escrow.toLowerCase(), `agent ${agentId}: guest_key names escrow ${row.guest_key.escrow}`);
  const [op] = await call(c, c.escrow, "guestKeys", [row.guest_key.address]);
  if (op !== ZERO) return { agent_id: agentId, key: row.guest_key.address, operator: op, already: true };
  const t = await send(c, await relayer(ctx.env), c.escrow, "registerGuestKey", await registerArgs(row.guest_key));
  await append(ctx, { kind: "relay-guest", agent_id: agentId, key: row.guest_key.address, ...t });
  return { agent_id: agentId, key: row.guest_key.address, ...t };
}
async function relayClaim(c: Rec, ctx: Ctx, leaseId: string) {
  must(/^[0-9a-f-]{36}$/.test(leaseId), "lease_id: a lease uuid");
  const g = (await siteGet(ctx, `/api/leases/${leaseId}/statement`)).guest_claim;
  must(g, `lease ${leaseId}: its statement has no guest_claim`);
  // The site's record is untrusted input: a malformed claim is refused in its own row, never a sweep-wide failure.
  must(isAddr(g.escrow) && isAddr(g.buyer) && isAddr(g.key) && isAddr(g.operator) && /^0x[0-9a-f]{64}$/i.test(g.terms_hash) && /^0x[0-9a-f]{130}$/i.test(g.signature),
    `lease ${leaseId}: guest_claim is not {escrow, key, buyer, operator, terms_hash, cumulative_owed, signature}`);
  units(g.cumulative_owed, "guest_claim.cumulative_owed");
  must(g.escrow.toLowerCase() === c.escrow.toLowerCase(), `lease ${leaseId}: guest_claim names escrow ${g.escrow}`);
  const [prev] = await call(c, c.escrow, "claimed", [g.buyer, g.terms_hash, g.key]);
  if (prev >= BigInt(g.cumulative_owed)) return { lease_id: leaseId, claimed: String(prev), already: true };
  const t = await send(c, await relayer(ctx.env), c.escrow, "claim", [g.buyer, g.terms_hash, g.cumulative_owed, g.signature]);
  await append(ctx, { kind: "relay-guest", lease_id: leaseId, operator: g.operator, cumulative_owed: g.cumulative_owed, ...t });
  return { lease_id: leaseId, operator: g.operator, cumulative_owed: g.cumulative_owed, ...t };
}
// Each item's own refusal is reported in its row; one bad lease does not stop the others.
const each = (xs: string[], f: (x: string) => Promise<Rec>, k: string) =>
  Promise.all(xs.map((x) => f(x).catch((e) => { if (!(e instanceof Bad || e instanceof RelayError)) throw e; return { [k]: x, error: e.message }; })));
async function relaySweep(c: Rec, ctx: Ctx) {
  const agents = (await siteGet(ctx, "/api/agents")).filter((a: Rec) => a.guest_key_available).map((a: Rec) => a.agent_id);
  const leases = (await siteGet(ctx, "/api/leases")).filter((l: Rec) => l.status === "ended" && l.statement_terms_hash).map((l: Rec) => l.id);
  const registered = await each(agents, (a) => relayRegister(c, ctx, a), "agent_id");
  return { registered, claims: (await each(leases, (l) => relayClaim(c, ctx, l), "lease_id")).filter((r) => !r.already && !String(r.error).includes("no guest_claim")) };
}

async function api(req: Request, path: string, ctx: Ctx) {
  const c = cfg(ctx.env), body = req.method === "POST" ? await req.json() : {};
  if (path === "/info") {
    const [r, pot] = [await relayer(ctx.env), new Wallet(ctx.env.POT_KEY).address];
    return { admission_signer: (await admissionSigner(ctx.env)).address, relayer: r.address, relayer_eth_wei: String(BigInt(await rpc(c.rpc, "eth_getBalance", [r.address, "latest"]))), pot,
      pot_layc: String((await call(c, c.token, "balanceOf", [pot]))[0]), token: c.token, escrow: c.escrow, chain_id: String(c.chainId), starter: String(c.starter), souk: c.souk };
  }
  if (path === "/login") {
    const email = normalize(String(body.email));
    must(email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "email: an email address");
    return await startChallenge(c, email, "login");
  }
  if (path === "/verify") {
    const { ch, token, person } = await checkCode(c, body, "login");
    const user = await userWallet(ctx.env, ch.email);
    return { email: ch.email, address: user.address, session: await sessionFor(ctx.env, ch.email), souk: { url: c.souk, token, person },
      starter: await starter(c, ctx, person, ch.email, user.address, token) };
  }
  if (path === "/relay/register") return await relayRegister(c, ctx, String(body.agent_id));
  if (path === "/relay/claim") return await relayClaim(c, ctx, String(body.lease_id));
  if (path === "/relay/sweep") return await relaySweep(c, ctx);
  const email = await authed(req, ctx.env), user = await userWallet(ctx.env, email);
  if (path === "/lease-authorization") {
    must(req.method === "POST", "POST required");
    return await authorizeLease(body, user, await admissionSigner(ctx.env));
  }
  if (path === "/balance") return { email, ...(await balances(c, ctx, email, user.address)) };
  if (path === "/accept") {
    must(/^0x[0-9a-f]{64}$/i.test(body.termsHash) && !/^0x0{64}$/.test(body.termsHash), "termsHash: 0x and 32 bytes");
    must(isAddr(body.operator), "operator: an address");
    const cap = units(body.cap, "cap"), deposit = units(body.deposit, "deposit");
    must(cap > 0n, "cap: more than 0");
    return await lane(email, async () => {
      const [op, tcap] = await call(c, c.escrow, "terms", [user.address, body.termsHash]);
      if (op !== ZERO) {
        must(op.toLowerCase() === body.operator.toLowerCase() && tcap === cap, `terms already accepted by ${op} with cap ${tcap}`);
        return { email, accepted: { termsHash: body.termsHash, operator: op, cap: String(cap) }, already: true, ...(await balances(c, ctx, email, user.address)) };
      }
      // A retry after a deposit that went through reports that deposit and does not send another.
      const prior = (await ledger(ctx)).find((r) => r.kind === "deposit" && r.email === email && r.termsHash === body.termsHash);
      const dep = prior ? 0n : deposit, before = await balances(c, ctx, email, user.address);
      must(dep <= BigInt(before.wallet), `deposit: the wallet holds ${before.wallet}, less than ${dep}`);
      // The contract lets a buyer accept any cap and stops claims at the deposit; the service refuses terms the escrow could not cover.
      const free = BigInt(before.escrow) + dep - BigInt(before.exposure);
      must(cap <= free, `cap ${cap} is more than the escrow balance after this deposit (${BigInt(before.escrow) + dep}) less terms already open (${before.exposure}); deposit more`);
      await budget(c, ctx, email, dep > 0n ? 2 : 1);
      let deposit_tx = prior ? { fn: prior.fn, tx: prior.tx, gas_used: prior.gas_used } : null;
      if (dep > 0n) {
        const { a, s } = await authorize(c, user, c.escrow, dep);
        deposit_tx = await relay(c, ctx, email, c.escrow, "depositWithAuthorization", [a.from, a.value, a.validAfter, a.validBefore, a.nonce, s]);
        await append(ctx, { kind: "deposit", email, termsHash: body.termsHash, amount: String(dep), ...deposit_tx });
      }
      const t = await escrowSign(c, user, "AcceptTerms", [{ name: "termsHash", type: "bytes32" }, { name: "operator", type: "address" }, { name: "cap", type: "uint256" }], { termsHash: body.termsHash, operator: body.operator, cap });
      const tx = await relay(c, ctx, email, c.escrow, "acceptTermsFor", [user.address, body.termsHash, body.operator, cap, t]);
      await append(ctx, { kind: "accept", email, termsHash: body.termsHash, operator: body.operator, cap: String(cap), tx });
      return { email, accepted: { termsHash: body.termsHash, operator: body.operator, cap: String(cap) }, tx, deposit_tx, ...(await balances(c, ctx, email, user.address)) };
    });
  }
  if (path === "/close") {
    must(/^0x[0-9a-f]{64}$/i.test(body.termsHash), "termsHash: 0x and 32 bytes");
    return await lane(email, async () => {
      const [op, , closedAt] = await call(c, c.escrow, "terms", [user.address, body.termsHash]);
      must(op !== ZERO, "termsHash: these terms were never accepted");
      // A lost close reply is safe to retry: confirmed closed terms need no second signature, budget or transaction.
      if (closedAt) return { email, closed: body.termsHash, already: true, closed_at: Number(closedAt), claimable_until: Number(closedAt) + DAY / 1000, tx: null };
      await budget(c, ctx, email, 1);
      const s = await escrowSign(c, user, "CloseTerms", [{ name: "termsHash", type: "bytes32" }], { termsHash: body.termsHash });
      const tx = await relay(c, ctx, email, c.escrow, "closeTermsFor", [user.address, body.termsHash, s]);
      await append(ctx, { kind: "close", email, termsHash: body.termsHash, tx });
      return { email, closed: body.termsHash, claimable_until: Number(await chainNow(c)) + DAY / 1000, tx, ...(await balances(c, ctx, email, user.address)) };
    });
  }
  if (path === "/withdraw") {
    must(isAddr(body.to), "to: an address");
    must(body.to.toLowerCase() !== user.address.toLowerCase(), "to: this wallet itself; name another address");
    const amount = units(body.amount, "amount");
    must(amount > 0n, "amount: more than 0");
    return await lane(email, async () => {
      const b = await balances(c, ctx, email, user.address), wallet = BigInt(b.wallet), pull = amount > wallet ? amount - wallet : 0n;
      must(pull <= BigInt(b.withdrawable), `amount ${amount}: the wallet holds ${wallet} and the escrow can release ${b.withdrawable} (balance less open terms); close terms and wait out the 1-day claim grace to free more`);
      await budget(c, ctx, email, pull > 0n ? 2 : 1);
      const txs = [];
      if (pull > 0n) {
        const nonce = (await call(c, c.escrow, "withdrawNonce", [user.address]))[0];
        const s = await escrowSign(c, user, "Withdraw", [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }], { to: user.address, amount: pull, nonce });
        txs.push(await relay(c, ctx, email, c.escrow, "withdrawFor", [user.address, user.address, pull, s, b.releasable]));
      }
      const { a, s } = await authorize(c, user, body.to, amount);
      txs.push(await relay(c, ctx, email, c.token, "transferWithAuthorization", [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, ...sig(s)]));
      await append(ctx, { kind: "withdraw", email, to: body.to, amount: String(amount), from_escrow: String(pull), txs });
      return { email, withdrawn: String(amount), from_escrow: String(pull), to: body.to, txs, ...(await balances(c, ctx, email, user.address)) };
    });
  }
  if (path === "/export") {
    must(body.confirm === email, `confirm: your email (${email}); the key leaves the TEE and anyone holding it controls this wallet`);
    if (!body.challenge_id) return await startChallenge(c, email, "export");
    await checkCode(c, body, "export", email);
    await append(ctx, { kind: "export", email, address: user.address });
    return { email, address: user.address, private_key: user.privateKey };
  }
  return null;
}

export default async function handler(req: Request, ctx: Ctx) {
  must(ctx?.dataDir, "webhost must provide a persistent dataDir");
  const path = new URL(req.url).pathname;
  try {
    const out = path.startsWith("/api/") ? await api(req, path.slice(4), ctx) : null;
    return out === null ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof Bad || e instanceof AdmissionError || e instanceof RelayError || e instanceof SyntaxError) return Response.json({ error: e.message }, { status: e instanceof Unauthorized ? 401 : 400 });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

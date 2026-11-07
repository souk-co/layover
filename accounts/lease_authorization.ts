// Trusted constructor for the first public/shared, five-minute LAYC lease.
// Scope and ephemeral client secrets are handled in the accounts TEE, never persisted.
// The relay gets ciphertext and a service-signed admission; the user's exportable wallet cannot issue admissions.
import { keccak256 } from "npm:ethers@6.13.4/crypto";
import { toUtf8Bytes } from "npm:ethers@6.13.4/utils";
import { Interface } from "npm:ethers@6.13.4/abi";
import type { Wallet } from "npm:ethers@6.13.4/wallet";
import { cat, checkAssertion, decodeAttestation, hex, sha256, unhex } from "../couch/dsmack/policy.mjs";
import { heliosChain } from "../couch/chain.mjs";
import POLICY from "../couch/dsmack/sandbox-policy.json" with { type: "json" };
import { operatorsOf } from "./lease_owners.ts";
import { seal } from "./lease_seal.ts";

type Rec = Record<string, any>;
export const SITE = "https://pod.dstack.soc1024.com/resip-staging";
export const SERVICE = "https://pod.dstack.soc1024.com/layover-accounts";
export const CHAIN = "https://pod.dstack.soc1024.com/layover-chain";
export const ESCROW = "0xdf9bb576e30ec71e200643ab6fc835eee12c95ea";
export const TOKEN = "0x9e851bf5e3b613aaa09853a07d1132f49c90b515";
export const CUSTODY = "https://pod.dstack.soc1024.com/resip-custody-staging/api/custody/";
const te = new TextEncoder();
export class AdmissionError extends Error {}
const must = (value: unknown, message: string) => { if (!value) throw new AdmissionError(message); };
const isHex = (x: unknown, n: number) => typeof x === "string" && new RegExp(`^[0-9a-f]{${n * 2}}$`).test(x);
export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new AdmissionError("numbers must be safe integers");
  const result = JSON.stringify(value);
  if (result === undefined) throw new AdmissionError("JSON value required");
  return result;
}
const TERMS_KEYS = "agent_id,cap,category,chain_id,domains,escrow,kind,minutes,mode,operator,price_per_gb,thread,token";
export function checkedTerms(value: unknown) {
  const terms = typeof value === "string" ? JSON.parse(value) : value;
  must(terms && typeof terms === "object" && !Array.isArray(terms) && Object.keys(terms).sort().join(",") === TERMS_KEYS, "terms: exact layover-terms/1 fields required");
  must(terms.kind === "layover-terms/1" && terms.chain_id === 84532 && terms.escrow === ESCROW && terms.token === TOKEN, "terms: wrong payment domain");
  must(terms.mode === "shared" && terms.minutes === 5 && ["price_check", "research"].includes(terms.category), "terms: only shared public GET/HEAD, five minutes");
  must(typeof terms.agent_id === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(terms.agent_id) && !terms.agent_id.startsWith("test-"), "terms: public agent_id required");
  must(typeof terms.thread === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(terms.thread), "terms: thread required");
  must(typeof terms.operator === "string" && /^0x[0-9a-f]{40}$/.test(terms.operator) && !/^0x0{40}$/.test(terms.operator), "terms: lowercase nonzero operator");
  must(typeof terms.cap === "string" && /^[1-9][0-9]{0,29}$/.test(terms.cap), "terms: positive cap in token base units");
  must(Number.isSafeInteger(terms.price_per_gb) && terms.price_per_gb > 0 && terms.price_per_gb <= 1000000, "terms: positive integer price_per_gb <= 1000000");
  const dns = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  must(Array.isArray(terms.domains) && terms.domains.length > 0 && terms.domains.length <= 10 && terms.domains.every((d: unknown) => typeof d === "string" && dns.test(d)), "terms: 1-10 lowercase DNS names");
  must(JSON.stringify(terms.domains) === JSON.stringify([...new Set(terms.domains)].sort()), "terms: sorted unique domains required");
  const paidBytes = BigInt(terms.cap) * 100000n / BigInt(terms.price_per_gb);
  must(paidBytes > 0n && paidBytes <= BigInt(Number.MAX_SAFE_INTEGER), "terms: funded byte limit exceeds supported range");
  const text = canonical(terms);
  if (typeof value === "string") must(value === text, "terms: canonical JSON required");
  return { terms, text, hash: keccak256(toUtf8Bytes(text)) };
}
async function document(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: "error", headers: { "cache-control": "no-cache" } });
  must(response.ok, `${url}: HTTP ${response.status}`);
  return await response.json();
}
// No attestation cache: enrollment/build/canary and custody are checked on every authorization.
export async function verifiedAgent(agentId: string, operator: string) {
  const agents = await document(SITE + "/api/agents");
  const agent = agents.find((a: Rec) => a.agent_id === agentId);
  must(agent && isHex(agent.enc_pub, 32) && typeof agent.ca_cert === "string" && /^[0-9a-f]+$/.test(agent.ca_cert), "agent: current key and proxy CA required");
  must(typeof agent.at === "string" && Number.isFinite(Date.parse(agent.at)), "agent: registration timestamp required");
  const attestation: Rec = await decodeAttestation(unhex(agent.attestation));
  const expected = cat(await sha256(unhex(agent.enc_pub)), await sha256(unhex(agent.ca_cert)));
  must(hex(attestation.report_data) === hex(expected), "agent: attestation does not bind encryption key and CA");
  await checkAssertion(attestation, heliosChain(POLICY), Date.now());
  const custody = await document(CUSTODY + encodeURIComponent(agentId));
  must(custody.agent_id === agentId && custody.operator === operator && custody.allowed?.manifests?.includes(hex(attestation.manifest_sha256)) && custody.allowed?.os_image_hashes?.includes(hex(attestation.os_image_hash)), "agent: custody operator or allowed measurement mismatch");
  must((await operatorsOf(hex(attestation.key_id))).includes(operator), "agent: runner key is not linked to accepted operator");
  return { ...agent, agent_run: hex(attestation.run) };
}

const escrowAbi = new Interface([
  "function terms(address,bytes32) view returns (address operator,uint256 cap,uint64 closedAt,bool released)",
  "function totalClaimed(address,bytes32) view returns (uint256)", "function balance(address) view returns (uint256)",
  "function exposure(address) view returns (uint256)", "function token() view returns (address)",
]);
function checkedPin(value: Rec, pin?: Rec) {
  must(value.verified_by === "helios-opstack" && Number.isSafeInteger(value.block) && value.block >= 0 && /^0x[0-9a-f]{64}$/.test(value.block_hash), "backing: verified block identity required");
  must(Number.isSafeInteger(value.head_age_s) && value.head_age_s >= -15 && value.head_age_s <= 60 && Number.isSafeInteger(value.depth) && value.depth >= 0 && value.depth <= 300, "backing: stale verified head/block");
  const now = Math.floor(Date.now() / 1000);
  must(Number.isSafeInteger(value.block_timestamp) && value.block_timestamp <= now + 15 && now - value.block_timestamp <= 120, "backing: stale/future pinned block timestamp");
  if (pin) must(value.block_hash === pin.block_hash && value.block === pin.block && value.block_timestamp === pin.block_timestamp, "backing: response differs from pinned block");
}
// /call pins eth_call to a Helios-known block hash. /read previously ignored block: do not use it here.
export async function backing(wallet: string, termsHash: string, terms: Rec): Promise<Rec> {
  const started = Date.now(), pin = await document(CHAIN + "/head?depth=30");
  checkedPin(pin);
  const read = async (fn: string, args: unknown[]) => {
    const value = await document(CHAIN + "/call?" + new URLSearchParams({ to: ESCROW, data: escrowAbi.encodeFunctionData(fn, args), block: pin.block_hash }));
    checkedPin(value, pin);
    must(value.to?.toLowerCase() === ESCROW && typeof value.result === "string", "backing: call target/result mismatch");
    return escrowAbi.decodeFunctionResult(fn, value.result);
  };
  const [accepted, claimed, balance, exposure, token] = await Promise.all([
    read("terms", [wallet, termsHash]), read("totalClaimed", [wallet, termsHash]), read("balance", [wallet]), read("exposure", [wallet]), read("token", []),
  ]);
  must(Date.now() - started <= 60000 && token[0].toLowerCase() === TOKEN, "backing: stale snapshot or wrong escrow token");
  return checkedBacking({ ...pin, chain_id: 84532, escrow: ESCROW, buyer: wallet, terms_hash: termsHash,
    operator: accepted[0].toLowerCase(), cap: String(accepted[1]), closed_at: String(accepted[2]), released: accepted[3],
    claimed: String(claimed[0]), balance: String(balance[0]), exposure: String(exposure[0]) }, terms);
}
export function checkedBacking(snapshot: Rec, terms: Rec) {
  must(snapshot.verified_by === "helios-opstack" && snapshot.chain_id === 84532 && snapshot.escrow?.toLowerCase() === ESCROW, "backing: wrong verified chain/domain");
  must(Number.isSafeInteger(snapshot.block) && snapshot.block >= 0 && /^0x[0-9a-f]{64}$/.test(snapshot.block_hash), "backing: pinned block identity required");
  checkedPin(snapshot);
  must(snapshot.operator?.toLowerCase() === terms.operator && String(snapshot.cap) === terms.cap && String(snapshot.closed_at) === "0" && snapshot.released === false, "backing: terms not accepted/open at agreed cap/operator");
  for (const key of ["cap", "claimed", "balance", "exposure"]) must(typeof snapshot[key] === "string" && /^[0-9]+$/.test(snapshot[key]), `backing: invalid ${key}`);
  must(BigInt(snapshot.claimed) === 0n, "backing: previously used terms cannot authorize a new lease");
  must(BigInt(snapshot.balance) >= BigInt(snapshot.exposure) && BigInt(snapshot.exposure) >= BigInt(snapshot.cap), "backing: accepted cap is not fully backed");
  return snapshot;
}

// Dependency arguments are passed only by unit tests. The HTTP endpoint uses the fixed verified sources above.
export async function authorizeLease(body: Rec, wallet: Wallet, signer: Wallet,
  sources = { agent: verifiedAgent, backing }) {
  must(body && typeof body === "object" && !Array.isArray(body), "authorization: JSON object required");
  must(Object.keys(body).sort().join(",") === "agent_id,site_account,terms", "authorization: only agent_id, site_account and terms accepted");
  must(isHex(body.site_account, 32), "site_account: sha256 account id, never bearer secret");
  const { terms, text, hash } = checkedTerms(body.terms);
  must(body.agent_id === terms.agent_id, "agent_id differs from accepted terms");
  const agent = await sources.agent(terms.agent_id, terms.operator);
  const funds = await sources.backing(wallet.address.toLowerCase(), hash, terms);
  // Scope, wallet and payment fields are constructed here, never copied from an opaque caller envelope.
  const rand = () => hex(crypto.getRandomValues(new Uint8Array(32)));
  const reply = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const plain = { kind: "lease", domains: terms.domains, use: "price_check", term_minutes: 5, price_per_gb: terms.price_per_gb,
    token: rand(), salt: rand(), reply_pub: hex(new Uint8Array(await crypto.subtle.exportKey("raw", reply.publicKey))), task: "",
    buyer_wallet: wallet.address.toLowerCase(), terms_hash: hash, escrow: ESCROW };
  const enc = await seal(agent.enc_pub, canonical(plain));
  const issued = Math.floor(Date.now() / 1000);
  const admission = { kind: "layover-lease-admission/1", service: SERVICE, chain_id: "84532", escrow: ESCROW, audience: SITE,
    account: body.site_account, wallet: wallet.address.toLowerCase(), agent_id: terms.agent_id, agent_run: agent.agent_run,
    enc_pub: agent.enc_pub, registration_at: agent.at, terms: text, terms_hash: hash, operator: terms.operator, cap: terms.cap,
    exclusive: false, price_per_gb: terms.price_per_gb, enc_sha256: hex(await sha256(te.encode(canonical(enc)))), nonce: rand(), issued_at: issued, expires_at: issued + 120,
    backing_block: funds.block, backing_block_hash: funds.block_hash };
  return { admission, signature: await signer.signMessage(canonical(admission)), enc,
    private: { ...plain, reply_jwk: await crypto.subtle.exportKey("jwk", reply.privateKey) } };
}

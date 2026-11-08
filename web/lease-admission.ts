// Token-backed transport: only the accounts service constructs the sealed request.
// A wallet signature cannot certify construction: the wallet holder could seal a victim's wallet/hash.
import { verifyMessage } from "npm:ethers@6.13.4/hash";
import { keccak256 } from "npm:ethers@6.13.4/crypto";
import { Bad, canonical, hex, sha256 } from "./verify.ts";

type Rec = Record<string, any>;
export const ADMISSION_SITE = "https://pod.dstack.soc1024.com/resip-staging";
export const ADMISSION_SERVICE = "https://pod.dstack.soc1024.com/layover-accounts";
export const ADMISSION_ESCROW = "0xca184cfc10f55b67f8afb42029d768ec6e6f36ad";
export const LEGACY_ESCROW = "0xdf9bb576e30ec71e200643ab6fc835eee12c95ea";
const knownEscrow = (value: unknown) => value === ADMISSION_ESCROW || value === LEGACY_ESCROW;
export const ADMISSION_TOKEN = "0x9e851bf5e3b613aaa09853a07d1132f49c90b515";
const must = (c: unknown, m: string) => { if (!c) throw new Bad("token admission: " + m); };
const address = (s: unknown) => typeof s === "string" && /^0x[0-9a-f]{40}$/.test(s);
const uint = (s: unknown) => typeof s === "string" && /^(0|[1-9][0-9]*)$/.test(s);
const digest = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const fields = ["kind", "chain_id", "escrow", "service", "audience", "account", "wallet", "agent_id", "agent_run", "enc_pub", "registration_at", "terms_hash", "terms", "operator", "cap", "exclusive", "price_per_gb", "enc_sha256", "nonce", "issued_at", "expires_at", "backing_block", "backing_block_hash"].sort();

export async function checkAdmission(body: Rec, account: string, agent: Rec, signer: string | undefined, snapshot: () => Promise<Rec>, now = Math.floor(Date.now() / 1000)) {
  const a = body.admission;
  must(a && typeof a === "object" && !Array.isArray(a) && canonical(Object.keys(a).sort()) === canonical(fields), "invalid authorization fields");
  must(address(signer?.toLowerCase()), "service signer is not configured");
  let recovered = "";
  try { recovered = verifyMessage(canonical(a), body.signature).toLowerCase(); } catch { /* fixed refusal below */ }
  must(recovered === signer!.toLowerCase(), "untrusted construction signature");
  must(Number.isSafeInteger(a.backing_block) && /^0x[0-9a-f]{64}$/.test(a.backing_block_hash), "invalid construction backing block");
  must(a.kind === "layover-lease-admission/1" && a.chain_id === "84532" && knownEscrow(a.escrow) && a.audience === ADMISSION_SITE && a.service === ADMISSION_SERVICE, "wrong chain, escrow or service audience");
  must(a.account === account && digest(account) && address(a.wallet) && address(a.operator), "wrong account or wallet");
  must(a.escrow === (agent.guest_escrow ?? agent.guest_key?.escrow ?? LEGACY_ESCROW), "registration escrow changed");
  must(a.agent_id === body.agent_id && a.agent_id === agent.agent_id && a.enc_pub === agent.enc_pub && a.agent_run === agent.facts.run && a.registration_at === agent.at, "registration changed");
  must(body.deposit === 0 && body.exclusive === false && a.exclusive === false && body.terms_hash === a.terms_hash && /^0x[0-9a-f]{64}$/.test(a.terms_hash), "request does not match authorization");
  must(Number.isSafeInteger(a.issued_at) && Number.isSafeInteger(a.expires_at) && a.issued_at <= now + 5 && a.issued_at >= now - 120 && a.expires_at > now && a.expires_at <= a.issued_at + 120 && digest(a.nonce), "expired or invalid authorization");
  must(digest(a.enc_sha256) && a.enc_sha256 === hex(await sha256(new TextEncoder().encode(canonical(body.enc)))), "sealed request changed");
  must(uint(a.cap) && BigInt(a.cap) > 0n && Number.isSafeInteger(a.price_per_gb) && a.price_per_gb > 0, "invalid cap or rate");
  let terms: Rec = {};
  try { terms = JSON.parse(a.terms); } catch { /* fixed refusal below */ }
  must(keccak256(new TextEncoder().encode(a.terms)) === a.terms_hash && terms && canonical(terms) === a.terms && terms.kind === "layover-terms/1" && terms.chain_id === 84532 && terms.escrow === a.escrow && terms.token === ADMISSION_TOKEN && terms.agent_id === a.agent_id && terms.operator === a.operator && terms.cap === a.cap && terms.price_per_gb === a.price_per_gb && terms.mode === "shared" && terms.minutes === 5 && ["price_check", "research"].includes(terms.category) && Array.isArray(terms.domains) && terms.domains.length > 0, "invalid canonical standing terms");
  // The dedicated Helios endpoint supplies one snapshot, never independently advancing RPC reads.
  const s = await snapshot();
  must(a.expires_at > Math.floor(Date.now() / 1000), "authorization expired during chain reads");
  must(s.verified_by === "helios-opstack" && s.chain_id === "84532" && s.escrow === a.escrow && s.wallet === a.wallet && s.terms_hash === a.terms_hash && Number.isSafeInteger(s.block) && /^0x[0-9a-f]{64}$/.test(s.block_hash) && Number.isSafeInteger(s.block_timestamp) && s.block_timestamp <= now + 5 && s.block_timestamp >= now - 120, "no recent verified chain snapshot");
  must(s.operator === a.operator && uint(s.cap) && s.cap === a.cap && s.closed_at === "0" && s.released === false, "terms are absent, changed or closed");
  must(uint(s.balance) && uint(s.exposure) && uint(s.total_claimed) && BigInt(s.balance) >= BigInt(s.exposure) && BigInt(s.exposure) >= BigInt(a.cap) && s.total_claimed === "0", "accepted cap is not backed");
  const remaining = BigInt(a.cap) - BigInt(s.total_claimed);
  const bytes = remaining * 1000000000n / (BigInt(a.price_per_gb) * 10000n);
  must(bytes > 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER), "cap cannot fund a representable byte budget");
  return { authorization: a, token_budget_bytes: Number(bytes), token_reserved_units: remaining.toString(), chain_block: s.block, chain_block_hash: s.block_hash };
}


// /call already accepts an exact Helios-verified block hash; /read historically ignored its block query.
export async function admissionSnapshot(wallet: string, termsHash: string, read: (path: string, query: Record<string, string>) => Promise<Rec>, escrow = ADMISSION_ESCROW) {
  must(knownEscrow(escrow), "unknown guest escrow");
  must(address(wallet) && /^0x[0-9a-f]{64}$/.test(termsHash), "invalid snapshot identity");
  const began = Date.now();
  const head = await read("/head", { depth: "30" });
  const valid = (r: Rec) => r.verified_by === "helios-opstack" && /^0x[0-9a-f]{64}$/.test(r.block_hash) && Number.isSafeInteger(r.block) && Number.isSafeInteger(r.depth) && r.depth >= 0 && r.depth <= 100 && Number.isSafeInteger(r.block_timestamp) && r.block_timestamp <= Math.floor(Date.now() / 1000) + 5 && r.block_timestamp >= Math.floor(Date.now() / 1000) - 120 && Number.isFinite(r.head_age_s) && r.head_age_s >= -5 && r.head_age_s + r.depth * 0.2 + (Date.now() - began) / 1000 <= 120;
  must(valid(head), "verified chain head is stale or malformed");
  const word = wallet.slice(2).padStart(64, "0"), args = word + termsHash.slice(2);
  const values = await Promise.all(["0x8d3e7a69" + args, "0xe3d670d7" + word, "0xc4ff5803" + word, "0xae78ba6e" + args, "0xfc0c546a"].map(async (data) => {
    const r = await read("/call", { to: escrow, data, block: head.block_hash });
    must(valid(r) && r.block_hash === head.block_hash && r.block === head.block && r.block_timestamp === head.block_timestamp && r.to?.toLowerCase() === escrow && typeof r.result === "string" && /^0x(?:[0-9a-f]{64})+$/.test(r.result), "chain reads disagree or are not verified");
    return r;
  }));
  must(values[0].result.length === 258 && values.slice(1).every((r) => r.result.length === 66), "invalid chain result length");
  must(values[4].result === "0x" + ADMISSION_TOKEN.slice(2).padStart(64, "0"), "wrong escrow token");
  const w = (i: number) => values[0].result.slice(2 + 64 * i, 66 + 64 * i);
  must(w(0).startsWith("0".repeat(24)) && ["0".repeat(64), "0".repeat(63) + "1"].includes(w(3)), "invalid terms ABI");
  return { verified_by: "helios-opstack", chain_id: "84532", escrow, wallet, terms_hash: termsHash,
    block: head.block, block_hash: head.block_hash, block_timestamp: head.block_timestamp,
    operator: "0x" + w(0).slice(24), cap: BigInt("0x" + w(1)).toString(), closed_at: BigInt("0x" + w(2)).toString(), released: BigInt("0x" + w(3)) === 1n,
    balance: BigInt(values[1].result).toString(), exposure: BigInt(values[2].result).toString(), total_claimed: BigInt(values[3].result).toString() };
}

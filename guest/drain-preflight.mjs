// Read-only inspection of a previously committed sealed state. No payment/key/state mutation lives in this module.
import crypto from "node:crypto";
const object = value => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const address = value => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const id = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const domains = value => Array.isArray(value) && value.length > 0 && value.length <= 10 && value.every(d => typeof d === "string" && /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d));
const must = (ok, message) => { if (!ok) throw new Error("drain preflight: " + message); };
export function checkpointCounts(state, agentId, escrows) {
  must(object(state) && state.agent_id === agentId, "unknown state owner/layout");
  const rootKeys = new Set(["agent_id", "enc_priv", "ca", "budget", "wallet", "claim_key", "claim_manifest", "claim_identity", "claim_history", "guest_claims", "appraisal_salt", "probe_last_commit", "chain", "leases", "holds"]);
  must(Object.keys(state).every(key => rootKeys.has(key)) && typeof state.enc_priv === "string" && /^(?:[0-9a-f]{2})+$/.test(state.enc_priv) &&
    object(state.ca) && typeof state.ca.key === "string" && typeof state.ca.cert === "string" &&
    typeof state.wallet === "string" && /^0x[0-9a-f]{64}$/.test(state.wallet) && object(state.budget) &&
    typeof state.budget.day === "string" && Number.isSafeInteger(state.budget.used) && state.budget.used >= 0 &&
    object(state.chain) && hash(state.chain.head) && Number.isSafeInteger(state.chain.seq) && state.chain.seq >= 0 && Array.isArray(state.chain.entries), "unknown state layout");
  must(Array.isArray(state.leases) && state.leases.length <= 10000 && Array.isArray(state.holds), "unknown lease layout");
  const leaseKeys = new Set(["id", "account", "domains", "use", "exclusive", "peers", "price", "bytes", "buyer_wallet", "terms_hash", "escrow", "paid_bytes", "claimed", "lastClaim", "lastTick", "token", "reply_pub", "start", "term_end", "until", "startSeq", "startPrev", "vantage", "lastVantage", "acct", "sessions", "salt"]);
  const holdKeys = new Set(["lease_id", "token", "domains", "exclusive", "price", "until"]);
  must(state.holds.every(hold => object(hold) && Object.keys(hold).every(key => holdKeys.has(key)) && id(hold.lease_id) && hash(hold.token) &&
    domains(hold.domains) && (hold.exclusive === undefined || typeof hold.exclusive === "boolean") && natural(hold.price) && hold.price > 0 && natural(hold.until)), "unknown renewal hold layout");
  let activeEscrow = 0;
  for (const lease of state.leases) {
    must(object(lease) && Object.keys(lease).every(key => leaseKeys.has(key)) && id(lease.id) && hash(lease.account), "malformed lease identity");
    must(domains(lease.domains) && ["price_check", "account"].includes(lease.use) && natural(lease.price) && lease.price > 0 &&
      natural(lease.bytes) && natural(lease.paid_bytes) && hash(lease.token) && hash(lease.salt) && hash(lease.reply_pub) &&
      natural(lease.start) && lease.start > 0 && natural(lease.term_end) && lease.term_end > lease.start && lease.term_end <= 8640000000000000 &&
      lease.until === new Date(lease.term_end).toISOString() && natural(lease.startSeq) && hash(lease.startPrev) && Array.isArray(lease.vantage), "unknown lease layout");
    must((lease.exclusive === undefined || typeof lease.exclusive === "boolean") &&
      (lease.peers === undefined || Array.isArray(lease.peers) && lease.peers.every(id)) &&
      (lease.claimed === undefined || typeof lease.claimed === "string" && /^(0|[1-9][0-9]*)$/.test(lease.claimed)) &&
      (lease.lastClaim === undefined || lease.lastClaim === null || object(lease.lastClaim)) &&
      (lease.lastTick === undefined || natural(lease.lastTick)) && (lease.lastVantage === undefined || natural(lease.lastVantage)) &&
      (lease.sessions === undefined || Array.isArray(lease.sessions) && lease.sessions.every(s => typeof s === "string")) &&
      (lease.acct === undefined || object(lease.acct)) && (lease.use !== "account" || object(lease.acct)), "malformed lease flags");
    const fields = [lease.buyer_wallet, lease.terms_hash, lease.escrow], present = fields.map(value => value !== undefined && value !== null);
    must(present.every(Boolean) || present.every(value => !value), "partial escrow identity");
    if (present[0]) {
      must(address(lease.buyer_wallet) && typeof lease.terms_hash === "string" && /^0x[0-9a-f]{64}$/.test(lease.terms_hash) &&
        address(lease.escrow) && escrows.map(e => e.toLowerCase()).includes(lease.escrow.toLowerCase()), "unknown escrow identity");
      activeEscrow++;
    }
  }
  return { total_leases: state.leases.length, active_escrow_leases: activeEscrow };
}
export async function drainPreflight({ challenge, agentId, escrows, restoreExisting, current, attest, canonical, write, now = Date.now }) {
  must(hash(challenge), "challenge must be 32-byte lowercase hex");
  must(typeof agentId === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(agentId) && escrows.length === 2 && escrows.every(address), "invalid inspection identity");
  const restored = await restoreExisting();
  const same = snapshot => {
    must(snapshot.head === restored.head && snapshot.seq === restored.seq, "custody head/sequence changed");
  };
  must(hash(restored.head) && Number.isSafeInteger(restored.seq) && restored.seq > 0, "existing committed head required");
  const counts = checkpointCounts(restored.state, agentId, escrows);
  same(await current());
  const checkpoint = { kind: "layover-drain-checkpoint/1", agent_id: agentId, head: restored.head, seq: restored.seq, challenge, status: counts.total_leases ? "active" : "empty", ...counts, observed_at: now() };
  must(Number.isSafeInteger(checkpoint.observed_at) && checkpoint.observed_at > 0, "invalid observation time");
  const attestation = await attest(crypto.createHash("sha256").update(canonical(checkpoint)).digest());
  must(typeof attestation === "string" && /^[0-9a-f]+$/.test(attestation) && attestation.length % 2 === 0 && attestation.length <= 131072, "invalid checkpoint attestation");
  same(await current());
  const elapsed = now() - checkpoint.observed_at;
  must(Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= 120000, "checkpoint observation expired");
  // One private output only: never pass the restored object, its secrets, or any lease contents to the writer.
  await write({ checkpoint, attestation });
}

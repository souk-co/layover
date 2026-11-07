// GuestEscrow registers a claim key once, binding both workload and operator.
// A launch input change must never reuse a key registered to another payment identity.
const address = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
export function claimIdentity(manifest, operator, escrow, chainId) {
  if (!/^[0-9a-f]{64}$/.test(manifest) || !address(operator) || !address(escrow) || !Number.isSafeInteger(chainId) || chainId < 1) throw new Error("invalid claim identity");
  return { manifest_sha256: manifest, operator: operator.toLowerCase(), escrow: escrow.toLowerCase(), chain_id: chainId };
}
const samePayment = (a, b) => a && a.operator?.toLowerCase() === b.operator && a.escrow?.toLowerCase() === b.escrow && a.chain_id === b.chain_id;

export function claimPlan(state, identity) {
  const old = state?.claim_identity;
  const keep = !!state?.claim_key && state.claim_manifest === identity.manifest_sha256 && old?.manifest_sha256 === identity.manifest_sha256 && samePayment(old, identity);
  // Existing accepted terms retain their original recipient. Do not resume them under changed/unknown payment identity.
  if (!samePayment(old, identity) && (state?.leases ?? []).some((l) => l.buyer_wallet && l.terms_hash)) {
    throw new Error("claim payment identity changed or is unknown with active escrow leases; drain them under the previous guest before migration");
  }
  const history = [...(state?.claim_history ?? [])];
  if (state?.claim_key && !keep && !history.some((h) => h.key === state.claim_key)) {
    // Private history remains only in sealed custody state, never in public outputs or logs.
    history.push({ key: state.claim_key, manifest: state.claim_manifest ?? null, identity: old ?? null, totals: { ...(state.guest_claims ?? {}) } });
  }
  return { keep, identity, history, totals: keep ? { ...(state.guest_claims ?? {}) } : {} };
}

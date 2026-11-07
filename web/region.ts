// All public API records pass through this projection. Stored/signed records stay intact.
type Row = Record<string, any>;
export function publicRegion(region: unknown, home: boolean, showState = false): unknown {
  if (!home || typeof region !== "string") return region;
  const parts = region.split(",").map(x => x.trim()).filter(Boolean);
  // A single free-form label might be a city; accept only a two-letter country code.
  if (parts.length < 2) return /^[A-Z]{2}$/.test(region) ? region : "Country unavailable";
  return parts.slice(showState && parts.length >= 3 ? -2 : -1).join(", ");
}
export function publicRegions(value: any, agents: Map<string, Row>, policies: Map<string, Row>, inherited?: Row): any {
  if (Array.isArray(value)) return value.map(x => publicRegions(x, agents, policies, inherited));
  if (!value || typeof value !== "object") return value;
  const agent = agents.get(value.agent_id) ?? inherited;
  const policy = policies.get(agent?.agent_id) ?? {};
  // Only explicit metadata exempts a residential line. Never guess from an ISP or an id.
  const kind = policy.connection_kind ?? agent?.connection_kind;
  const exempt = kind === "rented_exit" || kind === "vpn";
  const home = !exempt && (agent?.coarse?.residential === true || value.residential === true || value.coarse?.residential === true);
  const result = Object.fromEntries(Object.entries(value).filter(([k]) => k !== "registered_by").map(([k, v]) => [k,
    k === "region" ? publicRegion(v, home, policy.show_state === true) : publicRegions(v, agents, policies, agent ?? (home ? { coarse: { residential: true } } : undefined))]));
  // A quote authenticates the original whole result, not a public projection of
  // it. Withhold the quote and its binding details when that signed payload changes;
  // independently verifying the projection needs a separately signed public result.
  if (value.kind === "result" && typeof value.attestation === "string" && value.result &&
      JSON.stringify(result.result) !== JSON.stringify(value.result)) {
    delete result.attestation;
    delete result.verification;
    result.result_redacted = true;
  }
  // A minion's signed JSON envelope must not bypass the projection applied to its parsed fields.
  if (typeof value.row_json === "string") {
    try {
      const raw = JSON.parse(value.row_json);
      if (JSON.stringify(publicRegions(raw, agents, policies, agent)) !== JSON.stringify(raw)) {
        delete result.row_json;
        delete result.sig;
        result.region_redacted = true;
      }
    } catch { /* Non-JSON strings have no structured region to project. */ }
  }
  return result;
}

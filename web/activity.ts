// Public activity is an allowlist, never a serialized record or free-form error.
type Rec = Record<string, any>;
export type Activity = { time: string; kind: string; description: string; link: string | null };
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
// Identifiers can be caller supplied. Suppress anything resembling contact/network data.
const statement = (id: unknown) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? `api/bounties/${id}/statement` : null;
const label = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v) ? v : "withheld";
export function activity(rs: Rec[]): Activity[] {
  const out: Activity[] = [], signups = new Map<string, number>();
  const add = (time: unknown, kind: string, description: string, link: string | null = null) => {
    if (typeof time === "string" && Number.isFinite(Date.parse(time))) out.push({ time: new Date(time).toISOString(), kind, description, link });
  };
  for (const r of rs) {
    if (r.kind === "signup" && Number.isFinite(Date.parse(r.at))) {
      const time = new Date(r.at).toISOString().slice(0, 16) + ":00.000Z";
      signups.set(time, (signups.get(time) ?? 0) + 1);
    }
    if (r.kind === "lease") add(r.at, "lease_opened", `Lease opened on line ${label(r.agent_id)}`, "dashboard.html#lease-statements");
    if (r.kind === "lease_end") add(r.at, "lease_ended", `Lease ended on line ${label(r.agent_id)}`, "dashboard.html#lease-statements");
    if (r.kind === "result") {
      const served = Array.isArray(r.result?.items) ? r.result.items.filter((i: Rec) => i.status >= 200 && i.status < 300).length : 0;
      add(r.at, "fetch_settled", `Fetch settled on line ${label(r.agent_id)}: ${served} pages served`, statement(r.bounty_id));
    }
    if (r.kind === "minion") {
      const row = JSON.parse(r.row_json);
      if (row.kind !== "couch") continue;
      const slot = number(row.slot), seconds = number(row.seconds);
      const cost = typeof row.charged_nano_usd === "string" && /^\d+$/.test(row.charged_nano_usd) ? row.charged_nano_usd : null;
      const detail = `slot ${slot ?? "unknown"}`;
      // started is the QA client's open attempt; only a successful open has open_ms.
      if (number(row.open_ms) !== null && Number.isFinite(Date.parse(row.started))) add(new Date(Date.parse(row.started) + row.open_ms).toISOString(), "couch_opened", `Couch stay opened: ${detail}`, "dashboard.html#stays");
      if (row.settlement) add(row.at ?? r.at, "couch_closed", `Couch stay closed: ${detail}, ${seconds ?? "unknown"} seconds, ${cost ?? "unknown"} nano-USD`, "dashboard.html#stays");
    }
    if (r.kind === "escrow_activity" && ["deposit", "accept", "Claimed", "close", "withdraw"].includes(r.event) && /^0x[0-9a-fA-F]{64}$/.test(r.tx)) {
      add(r.time ?? r.at, `escrow_${r.event}`, `Escrow ${r.event}`, `https://base-sepolia.blockscout.com/tx/${r.tx}`);
    }
  }
  for (const [time, n] of signups) add(time, "signup", `${n} sign-up${n === 1 ? "" : "s"}`);
  return out.sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.kind.localeCompare(b.kind) || a.description.localeCompare(b.description)).slice(0, 100);
}

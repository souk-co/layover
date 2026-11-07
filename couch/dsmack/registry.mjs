import registry from "./registry.json" with { type: "json" };

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function monitorPolicy(environment) {
  // Old measured workloads predate the optional hook and run no classifier.
  if (environment.DSMACK_MONITOR_HASH === undefined && environment.DSMACK_MONITOR_POLICY === undefined) return registry.none;
  const text = environment.DSMACK_MONITOR_POLICY;
  const entry = Object.values(registry).find(value => canonical(value) === text);
  if (!entry) throw new Error("Unregistered guest monitor policy");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== environment.DSMACK_MONITOR_HASH) throw new Error("Guest monitor policy hash mismatch");
  return entry;
}
export function monitorLabel(policy) { return `Monitor: ${policy.name}`; }

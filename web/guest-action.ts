// Runner-authenticated guest transitions. Nonces and state transitions are committed by
// server.ts under a short per-agent lock; completed requests may be retried without another write.
import { Bad, binding, canonical, hex, sha256 } from "./verify.ts";

type Rec = Record<string, any>;
type Domain = { audience: string; agent_id: string; resource: "lease" | "bounty"; id: string; action: string };
export const GUEST_ACTION_AUDIENCE = "https://pod.dstack.soc1024.com/resip-staging";
export const GUEST_ACTION_MAX_AGE_S = 300, GUEST_ACTION_FUTURE_S = 60;
const must = (ok: unknown, message: string) => { if (!ok) throw new Bad(message); };
const object = (x: unknown): x is Rec => !!x && typeof x === "object" && !Array.isArray(x);
const keys = (x: Rec) => Object.keys(x).sort().join(",");

export async function readGuestAction(body: Rec, expected: Domain) {
  const { resource, id, ...domain } = expected, name = resource + " action", idKey = resource + "_id";
  must(object(body), `${name}: body must be a JSON object`);
  const authorization = body.authorization;
  must(object(authorization) && keys(authorization) === "attestation,message", `${name}: signed message and attestation required`);
  const message = authorization.message;
  const fields = ["action", "agent_id", "audience", "issued_at", "kind", idKey, "nonce", "payload_sha256"].sort().join(",");
  must(object(message) && keys(message) === fields, `${name}: invalid signed message`);
  must(message.kind === `layover-${resource}-action/1` && message[idKey] === id && Object.entries(domain).every(([k, v]) => message[k] === v),
    `${name}: wrong audience, agent, resource or action`);
  must(typeof message.nonce === "string" && /^[0-9a-f]{32}$/.test(message.nonce) && Number.isSafeInteger(message.issued_at) && message.issued_at > 0,
    `${name}: nonce and issued_at required`);
  must(typeof message.payload_sha256 === "string" && /^[0-9a-f]{64}$/.test(message.payload_sha256), `${name}: payload hash required`);
  const { authorization: _proof, ...payload } = body;
  must(hex(await sha256(new TextEncoder().encode(JSON.stringify(payload)))) === message.payload_sha256, `${name}: signed payload differs from request body`);
  must(typeof authorization.attestation === "string" && /^(?:[0-9a-f]{2})+$/.test(authorization.attestation), `${name}: attestation must be lowercase hex`);
  return { message, payload, authorization };
}

export function freshGuestAction(message: Rec, now = Math.floor(Date.now() / 1000)) {
  must(message.issued_at >= now - GUEST_ACTION_MAX_AGE_S && message.issued_at <= now + GUEST_ACTION_FUTURE_S,
    "guest action: request expired or issued in the future");
}

export function sameGuestRunner(actual: Rec, registration: Rec) {
  return ["key_id", "run", "manifest_sha256", "os_image_hash", "caller"].every(k => typeof registration?.[k] === "string" && actual?.[k] === registration[k]);
}

export async function verifyGuestAction(input: Awaited<ReturnType<typeof readGuestAction>>, registration: Rec,
  verify: (attestation: string, data: Uint8Array, expected: Rec) => Promise<Rec>) {
  freshGuestAction(input.message);
  const v = await verify(input.authorization.attestation, await binding(new TextEncoder().encode(canonical(input.message))), registration);
  must(v.ok && sameGuestRunner(v.facts, registration), "guest action: attestation does not authenticate the registered guest");
}

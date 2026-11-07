// Authenticate a guest transition with the existing runner attestation. The payload's
// exact JSON serialization is hashed so ordinary JSON numbers (including forecast probabilities)
// are bound without changing the integer-only statement format or duplicating large receipts.
import { createHash, randomBytes } from "node:crypto";

async function attestAction({ audience, agentId, resource, id, action, payload }, attest) {
  const actions = resource === "lease" ? ["decision", "vantage", "end"] : ["decision", "result"];
  if (!actions.includes(action)) throw new Error(`Unknown ${resource} action: ` + action);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Guest action payload must be an object");
  if (Object.hasOwn(payload, "authorization")) throw new Error("Guest action payload cannot replace its authorization");
  const payloadJson = JSON.stringify(payload);
  const message = { kind: `layover-${resource}-action/1`, audience, agent_id: agentId, [resource + "_id"]: id, action,
    issued_at: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString("hex"), payload_sha256: createHash("sha256").update(payloadJson).digest("hex") };
  const bytes = JSON.stringify(Object.fromEntries(Object.keys(message).sort().map(k => [k, message[k]])));
  const authorization = { message, attestation: await attest(createHash("sha256").update(bytes).digest()) };
  // Keep the old top-level shape so the signed guest can be rolled out before the
  // enforcing site. Return the signed snapshot even if the caller mutates payload.
  return { ...JSON.parse(payloadJson), authorization };
}

export const attestLeaseAction = ({ leaseId, ...args }, attest) => attestAction({ ...args, resource: "lease", id: leaseId }, attest);
export const attestBountyAction = ({ bountyId, ...args }, attest) => attestAction({ ...args, resource: "bounty", id: bountyId }, attest);

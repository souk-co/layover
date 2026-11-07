// Which operator a runner key belongs to, from the MacLink records relay-broker keeps at /fleet/ownership (dsmack
// docs/protocol.md section 6). The broker only stores them. Each record is checked here: the publisher signed the link, and
// the operator signed it or authorized the provisioner that did, and has not revoked that provisioner.
import { verifyTypedData } from "https://raw.githubusercontent.com/amiller/dsmack/0213e04df5bc58bf71882b34a673e53a9a6f3fa0/applications/compute-node/browser/vendor/ethers-6.17.0.mjs";

export const OWNERSHIP = "https://pod.dstack.soc1024.com/relay-broker/fleet/ownership";
// The signature domain names the pool's UsageEscrow, as dsmack payments/mac-operator.mjs requires.
export const DOMAIN = { name: "DsmackMacOwnership", version: "1", chainId: 84532, verifyingContract: "0x835A61a88Cc8D750b5a971219aa8f9813B2067e6" };
const MAC_LINK = { MacLink: [{ name: "kid", type: "bytes32" }, { name: "publisher", type: "address" }, { name: "operator", type: "address" }, { name: "nonce", type: "uint64" }] };
const AUTHORIZATION = { ProvisioningAuthorization: [{ name: "operator", type: "address" }, { name: "provisioner", type: "address" }, { name: "nonce", type: "uint64" }] };
// deno-lint-ignore no-explicit-any
type Rec = Record<string, any>;
const signer = (types: Rec, value: Rec, signature: string): string => verifyTypedData(DOMAIN, types, value, signature).toLowerCase();

export function linkedOperator(record: Rec, revocations: Rec[]): string {
  const l = record.link;
  if (signer(MAC_LINK, l, record.publisherSignature) !== l.publisher) throw new Error(`MacLink ${l.kid}: publisher signature`);
  if (record.operatorSignature) {
    if (signer(MAC_LINK, l, record.operatorSignature) !== l.operator) throw new Error(`MacLink ${l.kid}: operator signature`);
    return l.operator;
  }
  const a = record.authorization.authorization;
  if (a.operator !== l.operator || signer(AUTHORIZATION, a, record.authorization.signature) !== l.operator) throw new Error(`MacLink ${l.kid}: provisioning authorization`);
  if (signer(MAC_LINK, l, record.provisionerSignature) !== a.provisioner) throw new Error(`MacLink ${l.kid}: provisioner signature`);
  if (revocations.some((r) => r.revocation.operator === a.operator && r.revocation.provisioner === a.provisioner)) throw new Error(`MacLink ${l.kid}: provisioner ${a.provisioner} revoked`);
  return l.operator;
}

// The operators (lowercase addresses) whose MacLinks name runner key kid (hex, no 0x). Empty if none does.
export async function operatorsOf(kid: string): Promise<string[]> {
  const r = await fetch(`${OWNERSHIP}?kid=0x${kid}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`relay-broker ownership ${r.status}: ${await r.text()}`);
  const v = await r.json();
  if (JSON.stringify(v.domain) !== JSON.stringify(DOMAIN)) throw new Error("relay-broker ownership domain differs: " + JSON.stringify(v.domain));
  return [...new Set<string>(v.links.filter((x: Rec) => x.link.kid === "0x" + kid).map((x: Rec) => linkedOperator(x, v.revocations)))];
}

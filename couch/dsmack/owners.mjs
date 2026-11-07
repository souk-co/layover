// Which operators a Mac's App Attest key belongs to, from the MacLink records relay-broker keeps at /fleet/ownership
// (dsmack docs/protocol.md section 6). The broker only stores them; each record is checked here: the publisher signed the
// link, and the operator signed it or authorized the provisioner that did and has not revoked that provisioner.
import { verifyTypedData } from "ethers";

const MAC_LINK = { MacLink: [{ name: "kid", type: "bytes32" }, { name: "publisher", type: "address" }, { name: "operator", type: "address" }, { name: "nonce", type: "uint64" }] };
const AUTHORIZATION = { ProvisioningAuthorization: [{ name: "operator", type: "address" }, { name: "provisioner", type: "address" }, { name: "nonce", type: "uint64" }] };
// The signature domain names the pool's UsageEscrow (relay-broker/ownership.mjs ownershipDomain).
export const ownershipDomain = (escrow) => ({ name: "DsmackMacOwnership", version: "1", chainId: 84532, verifyingContract: escrow });

export function linkedOperator(domain, record, revocations) {
  const l = record.link, signer = (types, value, signature) => verifyTypedData(domain, types, value, signature).toLowerCase();
  if (signer(MAC_LINK, l, record.publisherSignature) !== l.publisher) throw new Error(`MacLink ${l.kid}: publisher signature`);
  if (record.operatorSignature) {
    if (signer(MAC_LINK, l, record.operatorSignature) !== l.operator) throw new Error(`MacLink ${l.kid}: operator signature`);
    return l.operator;
  }
  const a = record.authorization.authorization;
  if (a.operator !== l.operator || signer(AUTHORIZATION, a, record.authorization.signature) !== l.operator) throw new Error(`MacLink ${l.kid}: provisioning authorization`);
  if (signer(MAC_LINK, l, record.provisionerSignature) !== a.provisioner) throw new Error(`MacLink ${l.kid}: provisioner signature`);
  return revocations.some((r) => r.revocation.operator === a.operator && r.revocation.provisioner === a.provisioner) ? undefined : l.operator;
}

// operatorsOf(kid) for kid "0x"-hex: the lowercase operators whose verified, unrevoked MacLinks name it.
export const brokerOwners = (ownership, escrow) => async (kid, signal) => {
  kid = kid.toLowerCase();
  const r = await fetch(`${ownership}?kid=${kid}`, signal ? { signal } : undefined);
  if (!r.ok) throw new Error(`relay-broker ownership ${r.status}: ${await r.text()}`);
  const v = await r.json(), domain = ownershipDomain(escrow);
  if (JSON.stringify(v.domain) !== JSON.stringify(domain)) throw new Error("relay-broker ownership domain differs: " + JSON.stringify(v.domain));
  return [...new Set(v.links.filter((x) => x.link.kid === kid).map((x) => linkedOperator(domain, x, v.revocations)).filter(Boolean))];
};

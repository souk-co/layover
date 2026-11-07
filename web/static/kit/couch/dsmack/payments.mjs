import {
  AbiCoder,
  keccak256,
  computeAddress,
} from "ethers";
export function paymentRunId(kid, runNonce) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [
      kid,
      runNonce,
    ]),
  );
}
// Bind the full receipt public key, then check the advertised Ethereum address.
export function paidReceiptKey(p) {
  if (typeof p.receiptPublicKey !== "string" || !/^0x0[23][0-9a-f]{64}$/.test(p.receiptPublicKey) ||
      computeAddress(p.receiptPublicKey).toLowerCase() !== p.receiptSigner?.toLowerCase()) {
    throw Error("paid receipt public key/signer");
  }
  return Uint8Array.from(p.receiptPublicKey.slice(2).match(/../g), x => parseInt(x, 16));
}

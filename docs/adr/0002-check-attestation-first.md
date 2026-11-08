# 0002: Buyers check attestation before sending anything

## Status

Accepted; implemented in the buyer verification paths.

## Context

A listing and a reachable machine do not establish which code receives a buyer’s work or secrets.

## Decision

Before sending work, private inputs or payment authorization, the buyer checks the guest build, the signed Mac runner and the manifest binding them. Check the enrolled App Attest key, approved runner build, guest image and manifest, and the keys bound into the assertion. The [architecture](../../ARCHITECTURE.md#trust-boundaries), [couch admission](../../couch/dsmack/sandbox.mjs), and [site verifier](../../web/verify.ts) describe and implement these checks.

## Consequences

A failed check stops admission. Updating a guest or runner requires approval and buyer verification of the new evidence. App Attest supplies the Mac runner trust boundary; it does not turn the Mac guest into a TDX enclave.

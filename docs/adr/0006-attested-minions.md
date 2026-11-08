# 0006: Minions are attested dstack services

## Status

Accepted; service and contract code exist, mainnet issuance is not deployed.

## Context

Issuance needs evidence from approved verification code. Pinning one machine’s key would make replacement a manual trust decision.

## Decision

A minion runs an approved dstack app and registers its derived signing key through a KMS signature chain: the app key signs the derived key, and the pinned KMS root signs the app key for its app ID and purpose. Every registered key under an approved app can sign. See [keychain verification](../../minion/keychain.py), the [attested signer](../../minion/cvm/README.md), and dsmack’s [LastResortBuyer](https://github.com/amiller/dsmack/blob/53e3f08d3ab2dff6ef3a2e37fe6249fb012566b6/contracts/src/LastResortBuyer.sol).

## Consequences

Minions are interchangeable within the approved app. Removing an app stops its minions; revoking one key stops it permanently. App approval and the KMS root remain trust boundaries. A replacement must pass the same registration checks.

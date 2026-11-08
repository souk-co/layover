# 0004: Chain reads use Helios

## Status

Accepted; the migration is still open.

## Context

Agreement among public RPC endpoints does not verify chain state. A failed endpoint also cannot justify trusting the next endpoint’s answer.

## Decision

Use a Helios light client as the trust basis for chain reads. It was chosen over RPC quorum and plain RPC failover. The [buyer chain adapter](../../web/static/kit/couch/chain.mjs), [host enrollment](../../host/join.sh) and [guest update checks](../../host/guest-update.sh) use the Helios chain-read service. The [architecture](../../ARCHITECTURE.md#parties) requires fresh, block-pinned state for the expected chain and contracts.

## Consequences

Unavailable verified state stops the operation. The migration is still open: adoption in these consumers does not establish that every upstream payment read has migrated. Its plan starts with Helios OP-stack reads and confirmation depth, then L1 verification of Base output roots.

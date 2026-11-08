# 0003: The amin holds no money

## Status

Accepted for escrow settlement; legacy test-balance flows remain.

## Context

The matching agent chooses offers and negotiates terms. Giving its prose authority to spend would put buyer funds behind a model response.

## Decision

Settle through GuestEscrow for connection leases and UsageEscrow for couch usage. Buyer authorization and guest-signed usage govern payment. The amin follows settlement and holds no money. See [payment flows](../../ARCHITECTURE.md#three-deals), [account relaying](../../accounts/README.md), and the [amin’s escrow instructions](../../amin/prompts/escrow.md).

## Consequences

The amin cannot authorize spending by stating that a deal is paid. The optional account service introduces its own custody boundary. Legacy site test balances still exist; they are separate from contract escrow.

# 0005: LAYC issuance pays for verified service

## Status

Accepted for mainnet, not yet deployed.

## Context

An initial allocation would issue credit before anyone served work. A general mint authority would let an administrator bypass service verification.

## Decision

Begin with zero supply and no genesis allocation. LastResortBuyer is the only issuance path: a registered attested minion signs a unit of service it bought and saw served, and the contract mints payment to the operator within epoch and operator caps. The token’s immutable owner is the issuance proxy. The administrative role starts with a development key and transfers through `transferController` and `acceptController`; the recipient must accept. That controller approves apps, revokes minions and can upgrade issuance until upgrades are renounced. It has no direct mint call.

## Consequences

The controller remains a trust assumption because it selects signing code and controls upgrades. Verification of actual service belongs to that code. The launch starts with no approved app or registered minion. Sources: dsmack `mainnet-remaining` at `53e3f08d3ab2dff6ef3a2e37fe6249fb012566b6`, [LayoverCredit.sol](https://github.com/amiller/dsmack/blob/53e3f08d3ab2dff6ef3a2e37fe6249fb012566b6/contracts/src/LayoverCredit.sol), [LastResortBuyer.sol](https://github.com/amiller/dsmack/blob/53e3f08d3ab2dff6ef3a2e37fe6249fb012566b6/contracts/src/LastResortBuyer.sol) and [IssuanceLaunch.s.sol](https://github.com/amiller/dsmack/blob/53e3f08d3ab2dff6ef3a2e37fe6249fb012566b6/contracts/script/IssuanceLaunch.s.sol). The launch script checks zero supply and proxy ownership. Current [test-credit configuration](../../ARCHITECTURE.md#published-contract-configuration) is separate from this mainnet decision.

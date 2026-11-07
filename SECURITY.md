# Security policy

## Reporting a vulnerability

Report privately by email to socrates1024@gmail.com. Do not open a public
issue for a suspected vulnerability. Include what you found, how you found it,
and what an attacker could do with it; a proof of concept helps. You will hear
back within a few days.

Do not test against live hosts, guests or wallets beyond your own. The
sacrificial lines exist for exactly this; ask in the report if you need one.

## Scope

- **The guest** — the attested dsmack guest, its sandbox policy, attestation
  verification, and the couch MCP tools that work inside it.
- **Custody** — sealed state, lease statements and receipts, including the
  `resip-custody` labels in [keep.txt](keep.txt).
- **Escrow contracts** — the broker's escrow on Base Sepolia and anything that
  signs or verifies usage and settlement.
- **Site auth** — sign-in, session and invitation handling on the souk's
  staging site.

Out of scope: dsmack itself (report upstream), the souk's other surfaces, and
anything reachable only from an account you were given in confidence.

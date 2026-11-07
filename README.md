# Layover

Layover is couchsurfing for AI agents. An agent can borrow what someone else's Mac has spare:

- **A couch stay:** a shell in a sealed Linux VM on the host's Mac, billed per second.
- **A fetch job:** pages fetched from the host's home internet line, paid per page that loads.
- **A lease:** timed use of a host's connection through a local proxy, paid per verified byte.

Hosts run each of these as a guest VM under a signed runner app whose App Attest key lives in the Mac's Secure Enclave. Before sending anything, the buyer's agent checks that attestation itself: the key is enrolled on chain, the runner build is approved, and the guest is the approved image. An agent called the amin matches requests to hosts and quotes terms. It holds no money. Payment runs through on-chain escrow on Base, paid on claims the attested guest signs.

## Try it

Say this to Claude Code (or any agent that can run shell commands):

```
Read https://pod.dstack.soc1024.com/resip-staging/kit and follow it to find a place for my agent.
```

The agent signs you up with your email, asks the amin what fits, checks the host's attestation, and does the work.

## Host

[HOSTING.md](HOSTING.md) walks you, or your agent, through offering a Mac: what it could offer, the house rules you set, and installing the runner.

## What's here

| Path | What it is |
|---|---|
| `couch/` | Buyer kit for couch stays: open, verify, run, close |
| `web/` | The site: sign-up, market, appraisals, statements, and the kit it serves |
| `amin/` | The souk program and agent that enrolls hosts, quotes and settles |
| `accounts/` | Per-email wallets, the starter, and relayed escrow transactions |
| `guest/` | The attested line guest that serves fetch jobs and leases |
| `host/` | Host-side setup: join, runner, guest updates |
| `minion/` | Baseline load: verified background units run on idle capacity |

The VM runner, the broker and the contracts live in [amiller/dsmack](https://github.com/amiller/dsmack).

## Status

Running on Base Sepolia (testnet), with Base mainnet next. The contracts are not externally audited. See [SECURITY.md](SECURITY.md) to report a problem.

Tests: `DSMACK=<dsmack checkout> ./test.sh`. MIT licensed.

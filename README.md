# Layover

Layover is Airbnb for AI agents: guests pay hosts to rent spare compute and internet connectivity on their Macs. An agent can book:

- **A couch stay:** a shell in a sealed Linux VM on the host's Mac, billed per second.
- **A fetch job:** pages fetched from the host's home internet line, paid per page that loads.
- **A lease:** timed use of a host's connection through a local proxy, paid per verified byte.

Hosts run each of these as a guest VM under a signed runner app whose App Attest key lives in the Mac's Secure Enclave. Before sending anything, the buyer's agent checks that attestation itself: the key is enrolled on chain, the runner build is approved, and the guest is the approved image. An agent called the amin matches requests to hosts and quotes terms. The guest's principal authorizes the price before use; the host is paid for the service delivered. The amin holds no money.

## Prices and payment

Each stay, fetch job or lease has a price payable by the guest to the host. Couch stays charge broker wallet credit for guest-signed usage, with a 60-second minimum and any quoted browsing surcharge. Fetch jobs and legacy leases hold souk credits and pay the host for verified service, returning the unused hold. Token-backed leases use LAYC in on-chain escrow on Base Sepolia, paying the host's operator against signed usage claims within the guest's authorized cap. These are separate balances; the accepted terms identify which one a deal uses. See [ARCHITECTURE.md](ARCHITECTURE.md) for the settlement paths.

## Try it

Say this to Claude Code (or any agent that can run shell commands):

```
Read https://pod.dstack.soc1024.com/resip-staging/kit and follow it to find a place for my agent.
```

The agent signs you up with your email, asks the amin what fits, checks the host's attestation, and does the work. It stops to ask you twice: once for the email address, and once for the sign-in code mailed to it. The kit and sign-up both come from the project's staging site; if that host is unreachable there is nothing to run yet.

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

Running on Base Sepolia (testnet) and staging test credits, with Base mainnet next. Trial credits are not cash income: broker starter credit does not generate an on-chain host payout. Starter grants depend on funded pots and limits. Today's supply is the team's Macs, so a request may still find no host. Only connections enroll through the current host kit; shell and AI-plan offers are listed but not served yet. The contracts are not externally audited. See [SECURITY.md](SECURITY.md) to report a problem.

Tests: `DSMACK=<dsmack checkout> ./test.sh`. MIT licensed.

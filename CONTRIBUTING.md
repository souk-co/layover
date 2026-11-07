# Contributing to Layover

Work in a branch and open a pull request against `main`. Keep each PR focused
on one concern and small enough to read in one sitting.

## Review

Every PR that touches the guest, custody, payments or the amin needs a
verifier comment before merge: a fresh reviewer (or agent) that ran the change
and states what it checked.

## Tests

`DSMACK=/path/to/dsmack ./test.sh` runs the main suites, including from a public
export. Install Node/npm, Deno, uv, Go and Foundry (`anvil` and `forge`) on PATH.
Use a dsmack revision containing `applications/payments/guest/cmd/check-manifest`,
`contracts/src/LastResortBuyer.sol` and `contracts/src/LayoverCredit.sol`,
and initialize its submodules (`git submodule update --init --recursive`). The
script installs npm dependencies and uses uv for Python 3.11 and test packages.

The web branch's live drand and broker tests require `LAYOVER_LIVE_TESTS=1`;
without it they are skipped with an opt-in message.

Run what your change touches before pushing:

```
DSMACK=/path/to/dsmack uv run --python 3.11 --with-requirements requirements-test.txt python -m pytest minion
deno test -A --no-check web/server_test.ts
cd guest && npm ci --no-audit --no-fund && node test/bytes.mjs "$GATEWAY_BINARY" "$WEB_DIR" "$DSMACK"
```

For the guest test, set `GATEWAY_BINARY` to the built egress-policy gateway,
`WEB_DIR` to the web branch's `web/` directory, and `DSMACK` to its dsmack checkout.

The minion tests cover the baseline-load minion and the CGNAT verifier. The
deno tests cover the staging site's server. The guest tests cover the attested
guest's build. A PR that fails any of these stays open until it passes.

## Hygiene

- **No secrets in commits.** No keys, tokens, wallet files or `.env` contents.
  Hosts, guests and buyers rely on attestations and sealed state; a leaked
  secret breaks provenance for everyone downstream.
- **Errors propagate; no fallbacks.** If a check fails, the call fails. A
  fallback that swallows the error and continues is a bug, not resilience.

Questions about direction belong on the roadmap issue (#27).

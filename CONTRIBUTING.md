# Contributing to Layover

Work in a branch and open a pull request against `main`. One lane per concern,
like the milestone lanes in [PLAN.md](PLAN.md); keep each PR small enough to
read in one sitting.

## Review

Every PR that touches the guest, custody, payments or the amin needs a
verifier comment before merge: a fresh reviewer (or agent) that ran the change
and states what it checked. This is the same pattern the dsmack custody runs
used.

## Tests

Run what your change touches before pushing:

```
pytest minion
deno test --no-check web/server_test.ts
cd guest && node test/bytes.mjs
```

The minion tests cover the baseline-load minion and the CGNAT verifier. The
deno tests cover the staging site's server. The guest tests cover the attested
guest's build. A PR that fails any of these stays open until it passes.

## Hygiene

- **No secrets in commits.** No keys, tokens, wallet files or `.env` contents.
  Hosts, guests and buyers rely on attestations and sealed state; a leaked
  secret breaks provenance for everyone downstream.
- **Errors propagate; no fallbacks.** If a check fails, the call fails. A
  fallback that swallows the error and continues is a bug, not resilience.
  This is how the couch verifier treats a failed open: the stay ends without
  settling.

Questions about direction belong on the roadmap issue (#27).

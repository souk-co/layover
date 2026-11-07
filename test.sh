#!/usr/bin/env bash
# DSMACK=<dsmack checkout> ./test.sh: install what is missing and run every suite on main: couch (node), the repin
# preflight (pytest; DSMACK must contain applications/payments/guest/cmd/check-manifest), minion, accounts (deno, needs anvil).
set -euo pipefail
cd "$(dirname "$0")"
: "${DSMACK:?set DSMACK to a dsmack checkout for couch/dsmack/preflight_test.py}"
[ couch/node_modules/.package-lock.json -nt couch/package-lock.json ] || (cd couch && npm ci --no-audit --no-fund)
deno cache accounts/*.ts
(cd couch && node --test)
WEB=$(mktemp -d); trap 'rm -rf "$WEB"' EXIT
git fetch -q origin web && git archive origin/web web | tar -x -C "$WEB"
DSMACK=$DSMACK WEB=$WEB python3 -m pytest -q -p no:cacheprovider couch/dsmack minion accounts/test_deploy.py
deno test -A accounts

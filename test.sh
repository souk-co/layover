#!/usr/bin/env bash
# DSMACK=<dsmack checkout> ./test.sh: run main's suites from either the private checkout or the public export.
# Requires node/npm, deno, uv, Go and Foundry (anvil/forge) on PATH.
set -euo pipefail
cd "$(dirname "$0")"
: "${DSMACK:?set DSMACK to a dsmack checkout for couch/dsmack/preflight_test.py}"
[ couch/node_modules/.package-lock.json -nt couch/package-lock.json ] || (cd couch && npm ci --no-audit --no-fund)
deno cache accounts/*.ts
(cd couch && node --test)
# Public exports already contain web; only the private main branch needs another snapshot.
if [ -f web/kit_mirror.py ]; then
  WEB=$PWD
else
  WEB=$(mktemp -d); trap 'rm -rf "$WEB"' EXIT
  git fetch -q origin web
  git archive origin/web web | tar -x -C "$WEB"
fi
DSMACK=$DSMACK WEB=$WEB uv run --python 3.11 --with-requirements requirements-test.txt python -m pytest -q -p no:cacheprovider couch/dsmack minion accounts/test_deploy.py
deno test -A accounts

# Attested baseline signer

Build from the repository root with `docker build -f minion/cvm/Dockerfile .`.
The service uses the dstack Python SDK GetKey API through `/var/run/dstack.sock`,
with path `layover/minion`, purpose `layover-minion`, and secp256k1. The key stays
in process memory. Startup verifies both signature links against the pinned Base
KMS root and the configured approved APP_ID.

Deploy as a second service in the layover-tee CVM: paste the service block from
`compose.snippet.yml` into that machine's compose (next to layover-chain and the
dstack ingress). It publishes no host ports; the in-CVM ingress reaches it on the
compose network at `http://minion:8080`. Set APP_ID, BUYER_ADDRESS (the
LastResortBuyer proxy), EPOCH, ROWS_FILE (absolute path), and OPERATORS_FILE in the
environment that expands the snippet, then `docker compose up --build minion`.
The socket must be accessible to uid 65534. Operators JSON maps each baseline
`agent_id` to its Ethereum payout address. Mount the verifier's trusted rows.jsonl
output, never seller-submitted rows. Successful paid fetch rows require status
`done`, `attestation_pass: true`, and at least one served page; couch rows require
`paid: true` and `ok: true`. Errors and failed paid uses are excluded.

One successful use is one Unit. For plain baseline rows, unitId is keccak256 of UTF-8
`layover-baseline:` followed by the row's id; workDigest is keccak256 of the entire
row serialized as sorted compact JSON. Duplicate IDs are rejected. Book units is
the number of selected rows and must be at least four. Missing operator mappings
fail the request. This file is trusted verifier output; these flags do not replace
verification of the underlying guest evidence.

GET /minion returns address, derivation key_path, signature_chain (app signature,
KMS signature), and app_id. Recover the app public key using minion/keychain.py
for registerMinion. GET /signed returns book and units with message fields, digest,
and Ethereum signatures (v=27/28). KMS chain signatures retain v=0/1.

Freeze the rows and epoch configuration before committing a book. Restart with a
new current epoch and rows snapshot for each epoch; submit the book within its
two-hour window and units during that epoch. Register the key under an approved
app before submitting signatures. Contract operator payout caps still apply.

Install minion/cvm/requirements.txt plus pytest and run `pytest minion` with
Forge on PATH and DSMACK pointing to a dsmack checkout containing
`contracts/src/LastResortBuyer.sol` and `contracts/src/LayoverCredit.sol`, with
its submodules initialized. The digest
test reads its contracts without modifying the checkout. Without the PyPI
dstack-sdk package, minion/conftest.py falls back to minion/stubs/dstack_sdk.py,
which speaks the same /GetKey wire protocol (dsmack applications/relay-broker/key.ts);
test_sim_dstack_socket runs the service against the sim's guest-agent stand-in
(`sim/dstack-sim.ts`, Deno) and covers address stability across restarts,
path separation, and /signed recovery. The sim's signature_chain is always empty,
so that test stubs out the KMS chain check; the real service fails closed on it.

For minion/ecrank rows.jsonl envelopes, set ROWS_PUBLIC_KEY to the trusted baseline
Ed25519 public key (32 bytes of hex). The signer verifies `sig` over the exact
`row_json` UTF-8 string before parsing it. `autoresearch` rows require `verified:
true`, `ok: true`, `paid: true` and no fault. Their unitId hashes the same
`layover-baseline:` prefix followed by compact sorted JSON of `{source, unit,
window}`; changing the row UUID cannot claim the same work twice. workDigest
commits to the full verified row, including the source result digest.

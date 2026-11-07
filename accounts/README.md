# Layover accounts

A buyer who signs up with an email gets a wallet without ever seeing one. This service holds one wallet per email and
spends from it only when that email asks: it deposits LAYC into GuestEscrow, accepts and closes the amin's terms on the
buyer's behalf, and withdraws LAYC out of the escrow and the wallet. The escrow contract still decides every payment. A buyer who wants their own
wallet skips this service and calls the contracts directly; nothing here is in that path.

Base Sepolia: GuestEscrow `0xdf9bb576E30Ec71E200643AB6FC835Eee12C95EA` (verifier `0xA609124be069225ee2af58741bc109F4bffAB6C3`; amiller/dsmack PR #90, `contracts/src/GuestEscrow.sol`), LAYC `0x9e851Bf5E3b613aaA09853A07D1132F49c90b515`.

## Keys

The service runs on the pod webhost as `layover-accounts`, attested, in its own container (`isolation: container`: its
own `/data` volume, `--deny-env`, its env passed only to it). The manifest's `dstack_env` asks the webhost for
`ACCOUNTS_SEED`, which it derives inside the TEE from dstack `GetKey` at
`/tee-daemon/projects/layover-accounts/accounts-seed-v1`. No one outside the TEE holds the seed. From it:

- a buyer's key is `HMAC-SHA256(seed, "layover-accounts/1/email/" + email)`, the email trimmed, NFC-normalized and lowercased. It is
  computed on each request and never stored.
- the relayer key (`.../relayer`) submits every transaction and pays its gas.
- the session key (`.../session`) signs session tokens.
- the admission key (`.../lease-admission/1`) signs constructed token-backed lease admissions. Its address is
  `admission_signer` in `/api/info`; the website must pin the verified deployment's address in its configuration.
  This key is never exported and has no on-chain spending role. An exportable user wallet cannot sign admissions.

A buyer's wallet never needs ETH. A deposit is an EIP-3009 `TransferWithAuthorization` from the buyer's key to the escrow,
which the relayer submits through `GuestEscrow.depositWithAuthorization`; accepting terms is the buyer's EIP-712
`AcceptTerms` signature, submitted through `acceptTermsFor`; closing terms is a `CloseTerms` signature through
`closeTermsFor`; a withdrawal from the escrow is a `Withdraw` signature through `withdrawFor` (to the buyer's own wallet),
then a `TransferWithAuthorization` from the wallet to the address the buyer names, submitted to the token.

The key path is tied to the project name, not the code. Whoever holds the webhost deploy token could deploy different
code as `layover-accounts` and derive the same keys; the deploy is attested, so that redeploy shows in the project's
public record (`/_api/projects/layover-accounts`: ref and tree hash), but nothing stops it. That is the same trust the
other pod projects carry today.

## Sign-in

The service proves an email with the souk's own mailed code, the same sign-in the doorman's buyers already use:

1. `POST /api/login {email}`: the service asks the souk (`/api/auth/code`) to mail a code to that address and remembers
   which email that challenge is for (10 minutes, in memory).
2. `POST /api/verify {challenge_id, code}`: the service checks the code with the souk (`/api/auth/verify`). On success it
   returns a session (7 days, an HMAC over the email and expiry), the wallet address, and the souk token the souk just
   issued, so the same code also signs the buyer in to the souk.

Only a challenge this service started counts, so the email is the one the service asked the souk to mail. The souk Dev
and Staging hosts run with `SOUK_TEST_SIGNIN_CODE=1`, which makes `000000` sign in any address; the service refuses
`000000`. A mailed code is never `000000` (`randbelow(999999) + 1`), so a real buyer is unaffected. An address the souk
does not mail (its test domains, or one over the mail limit) cannot sign in here.

The service trusts the souk host to check the code. It passes the souk token through and does not keep it.
`POST /api/login` lets anyone have the souk mail a code to any address, as the souk's own `/api/auth/code` does; the
souk's per-address and hourly mail limits bound it. Souk Dev goes further: after 5 codes an hour for one address or
300 an hour host-wide it stops mailing and sets the code to `000000`, which this service refuses, so past those limits
every sign-in here fails until the window passes, and anyone can trigger that. No workaround in this service.

## API

All under `https://pod.dstack.soc1024.com/layover-accounts/api/`. Amounts are decimal strings of LAYC base units
(6 decimals: `"1000000"` is 1 LAYC). Authenticated calls send `Authorization: Bearer <session>`.

| Call | Does |
|---|---|
| `GET /info` | relayer address and ETH, pot address and LAYC, contracts, starter amount |
| `POST /login {email}` | mails a code |
| `POST /verify {challenge_id, code}` | session, address, souk token; pays starter credit the first time |
| `GET /balance` | wallet LAYC, escrow balance, deposited, paid, exposure, withdrawable, closed terms ready to release |
| `POST /accept {termsHash, operator, cap, deposit}` | deposits `deposit` (may be `"0"`), then accepts the terms; returns `tx` (the accept) and `deposit_tx` (the deposit, `null` if none); a retry of the same request sends nothing |
| `POST /close {termsHash}` | closes the terms: the host may still claim for 1 day, then the unclaimed cap leaves exposure |
| `POST /withdraw {to, amount}` | sends `amount` LAYC to `to`: the wallet's LAYC first, the rest withdrawn from the escrow |
| `POST /export {confirm: <email>}` | mails a fresh code; repeat with `challenge_id` and `code` to get the wallet's private key |
| `POST /relay/register {agent_id}` | no sign-in: `registerGuestKey` from the agent's published `guest_key` (`GET site /api/agents?agent_id=`); `already` if registered |
| `POST /relay/claim {lease_id}` | no sign-in: `claim()` from the ended lease's public `guest_claim` (`GET site /api/leases/{id}/statement`); `already` if GuestEscrow has paid that much |
| `POST /relay/sweep` | no sign-in: both of the above for every agent with a published key and every ended lease; one row per item, refusals included. The minion calls it each cycle |

The relay calls pay gas from the relayer key, which holds only ETH. They read their inputs from the site's public records and
send a transaction only after `eth_estimateGas` accepts it, so a request the contract would refuse (unregistered key, wrong
operator, over the cap, a replay) costs nothing. GuestEscrow pays the operator its terms name, whoever submits.

An error is always `{error}` with the chain's or the souk's message (400 for a refused request, 401 for sign-in, 500 otherwise).

There are no lockups. The escrow lets a buyer withdraw `balance - exposure` at any time, where exposure is the sum over open
terms of cap less what the host already claimed. `/accept` refuses a `cap` larger than the escrow balance after the deposit
less the terms already open, so the service never opens terms the escrow could not pay; the contract would accept it and
stop claims at the deposit anyway. After `/close` the terms stay claimable for one day (`CLAIM_GRACE`); `/balance` then lists
them under `releasable`, and the next `/withdraw` that needs escrow money passes them to `withdrawFor`, which drops their
remainder from exposure. `/withdraw` refuses an `amount` above wallet LAYC plus `withdrawable`, an `amount` of 0, and a `to`
that is the buyer's own wallet.

Every transaction the relayer sends for a buyer (`/accept`, `/close`, `/withdraw`) counts against `RELAYS_PER_DAY` (20) per
email in 24 hours, counted from the ledger; a request that would pass it is refused with the count. Requests from one email
run one at a time, so a buyer's own repeats queue behind each other and two concurrent accepts cannot over-commit the
escrow; other buyers' requests do not wait behind them (the relayer's nonce still orders the transactions that reach the chain).

`/export` returns the key only after a second mailed code for that email, so a copied session alone does not reveal it.
Export is logged in the ledger; after it the key is no longer only in the TEE.

## Starter credit

At a buyer's first sign-in the pot sends `STARTER` LAYC (5 LAYC) to the new wallet, once per souk person id (the `person` the souk returns at sign-in, not the mailbox string), only if the souk
lists the IP souk (`SOUK_ID`) among that person's souks (`/api/souk_list` with the token the sign-in just issued), and at
most `STARTERS_PER_DAY` (200) a day. The souk signs in any address, so without the membership check anyone with a fresh
email could draw starter credit; with it, starter credit follows the doorman's invitation and its signup limits. At the
defaults the pot pays out at most 1,000 LAYC a day.

The pot is a funded wallet, not a mint. Its key is a deploy-time secret (`POT_KEY` in the manifest env, read from
`POT_KEY_FILE` by `deploy.py`), and the pot pays its own transfer gas. Do not use the genesis wallet `0x1FBe…6c5b` as the
pot: it owns LAYC, GuestEscrow and the CDRegistry, and GuestEscrow's owner approves guest builds (`setWorkload`), so its key
in this service's env would let the service approve a guest that claims every deposit. Make a new key, send it some LAYC
and a little ETH from `0x1FBe…`, and point `POT_KEY_FILE` at it. The service writes the
starter record to `/data/ledger.jsonl` before it sends, so a crash can lose one starter payment but never pays one twice.

## Gas

Measured on anvil: deposit 113,861 gas, accept 76,333 (relayer); starter transfer 51,500 (pot). At
Base Sepolia's 0.006 gwei an accept with a deposit costs about 0.0000012 ETH plus the L1 data fee. 0.01 ETH in the relayer
covers thousands of accepts. `GET /info` shows what is left.

## Deploy

If `/api/info` answers "ACCOUNTS_SEED (manifest dstack_env) is not set", the daemon did not derive it
(`proxy/runtimes.py::_resolve_dstack_env`). A pot or relayer that runs dry makes `/verify` or `/accept` fail with the chain's
error; `/api/info` shows `pot_layc` and `relayer_eth_wei`.

```sh
POT_KEY_FILE=/path/to/pot.key python3 accounts/deploy.py   # initial deploy: note the relayer address
python3 accounts/deploy.py                              # redeploy: preserve the existing pot/config env
cast send <relayer> --value 0.01ether --rpc-url https://sepolia.base.org --private-key ...
curl -s https://pod.dstack.soc1024.com/layover-accounts/api/info   # relayer_eth_wei > 0, pot_layc > 0
```

## Tests

```sh
deno test -A accounts/server_test.ts   # needs anvil on PATH
```

A local anvil chain with LAYC and GuestEscrow (bytecode in `fixtures/`, built from amiller/dsmack `contracts/` at
`4071be1`, PR #90; `MockGuestAttest` is the attest stub from its `GuestEscrow.t.sol`) and a stub souk. Covered: refused
unauthenticated, forged and `000000` sign-ins; starter paid once per email; deposit plus accept; a retry of the same accept
sending nothing; terms beyond the free escrow balance refused, including two concurrent accepts; withdraw from the wallet,
refused past exposure, to the wallet itself and of 0; close, refusal during the claim grace, then (anvil time moved a day)
`withdrawFor` releasing the closed terms and the refusal to go past the remaining exposure; the per-email relay budget with
another buyer unaffected; export only with a fresh mailed code; the bundled server run under the container's deny flags.

## Token-backed lease admission

`POST /api/lease-authorization {site_account, agent_id, terms}` requires the existing accounts session. `site_account` is
the 32-byte lowercase hex SHA-256 account id, never its bearer secret. `terms` is the amin's exact canonical JSON string
(or its equivalent object); its keccak256 hash must already be accepted by this signed-in user's wallet. This first path
supports only five-minute shared `price_check` or `research` terms, both enforced as the guest's public GET/HEAD
`price_check` use. It accepts no caller ciphertext, wallet, lease token, task text or account browsing permissions.

The service checks the current agent's attestation and key/CA binding using the existing guest verifier, allowed custody
measurement/operator, signed MacLink ownership, and fresh Helios escrow state. All financial calls pin one verified
block hash, require the real block timestamp to be at most 120 seconds old, and fail on missing or inconsistent metadata.
Terms must be open, wholly unclaimed, and fully backed by escrow balance covering total exposure. The endpoint submits
no transaction and changes no balances.

The accounts TEE sees the requested domain scope while constructing the plaintext. It injects its authenticated wallet,
terms hash and escrow, generates fresh lease token, salt and reply keys, then seals to the checked agent key with the
existing lease wire format. It does not persist plaintext, client secrets, ciphertext or admissions. The authenticated
TLS response is `{admission, signature, enc, private}`: `private` contains the constructed lease fields and `reply_jwk`
needed in the client's private lease file. Never publish that response or send `private` to the relay.

`signature` is an EIP-191 signature by the dedicated service admission key over the sorted-key, compact JSON
`admission`. The `layover-lease-admission/1` payload binds service, site audience, site account id, wallet, chain/escrow,
canonical accepted terms and their hash, agent/run/key/registration, operator, cap, exclusivity, price, exact envelope
hash, nonce and a 120-second expiry. Backing block fields identify the service's checked snapshot; they do not replace
the website's independent fresh financial check. The site must pin the service signer, verify the envelope/account and
current registration, and persist its single-use nonce and wallet/terms reservation atomically with the lease. This
narrow flow reserves the full cap for one lease and never reuses that pair; it creates no staging credit. Guest host
policy and escrow's signed usage claims remain authoritative for execution and settlement.

Redeploys omit manifest `env` unless `POT_KEY_FILE` is explicitly supplied. The webhost preserves the stored env when
that field is omitted, so an ordinary code update requires no pot-key export or local key file. Supplying the file
explicitly replaces the full env with this script's configuration and that pot key. Both paths keep project name
`layover-accounts` and `dstack_env: {ACCOUNTS_SEED: "accounts-seed-v1"}` unchanged, preserving wallet derivation.
Never replace the TEE seed with a generated local seed or copy redacted admin-API values into a manifest.

A repeated authenticated `/api/close` for terms already closed by that wallet returns `already: true`, the confirmed
`closed_at`, its original `claimable_until`, and `tx: null`. It does not consume another relay budget, write another close
record, or submit another transaction. This lets clients reconcile a lost close response without reopening access.

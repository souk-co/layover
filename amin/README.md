# The amin: the IP souk on the Souk host

A custom Souk bundle for the residential-IP souk. Its agent, the amin, enrolls Mac mini lines from attested appraisals,
matches buyers to lines and settles each lease from resip's public lease statement. The amin never holds or moves payment: the
program holds the price in souk credits (the second rail while escrow contracts come up).
The journeys and pass criteria are in `../notes/journeys.html`.

## Provenance

- Prompts are built from nikete's branch `claude/souk-mechanism-docs` of souk-co/souk (PR #620) at
  `00e6e9d2e9bf7ece0caeeb468aaab04a2ec91939`: `docs/plans/souk-residential-egress-2026-11-04.md`,
  `souk-mechanisms-as-implemented-2026-11-03.md`, and the souk call of 2026-11-04 (gemini notes, about lines
  1280-1800). To re-pull: `git -C ~/projects/teleport/souk-xyn fetch origin claude/souk-mechanism-docs`, diff those
  files against the commit above, carry changes into `prompts/charter.md`, set `NIKETE_COMMIT` in `build.py`, and
  `python3 build.py revise SOUK`.
- Program written against souk-co/souk `dev` at `4a89f08` (host SDK, credits kit, dining-matching's hold pattern).
- Appraisal minion pin: souk-co/layover-private branch `guest` at `a7641458731d332588b8b17650bfb1dcac2babd4`
  (`APPRAISAL_PIN` in `build.py`). Moving the pin is a souk revision.
- Endpoint shapes: lane C, `../notes/amin-endpoints-handoff.md` (branch `amin-endpoints`).

## Files

- `souk.py`: the program. `RESIP` is the one base-URL parameter; `build.py --resip URL` replaces it.
- `guide.md`: what members send (read with `souk_guide`; also the help thread's script).
- `prompts/charter.md` + `prompts/{enroll,match,settle,qa,fetch,couch}.md`: `build.py` prepends the charter to each stage and fills
  `{{RESIP}}`, `{{NIKETE_COMMIT}}`, `{{APPRAISAL_PIN}}`.
- `build.py`: `show | create | revise SOUK`, using `$SOUK_HOME/credential.json` from a connector login. It calls the
  host API directly because the connector's `create --program` leaves out `guide.md`.
- `release.py`: `smoke | full | release SOUK`. A ~75 s smoke gate blocks `souk_revise`; the full suite runs after, in parallel,
  and a failure files an `area:amin` issue with the revision to roll back to.
- `test/`: engine tests with a scripted judge and `fixtures.json` in lane C's shapes; `stub_app.py` serves the
  fixtures as a tee-daemon python app (not deployed).

## Mechanism

Roles `host`, `buyer`, `arbiter`; `KITS = ("credits",)`. Membership is by invitation: an invite is admitted when the
inviter holds every role it grants (the site's signup doorman invites with a member credential holding `buyer` and `host`).
An arbiter's `grant` message calls `credits.grant`.

Starter credit comes from a funded pot, never minted at signup: an arbiter's `fund` message `{amount}` moves that many of
its own credits into the pool `starter` (`credits.open_pool` on the first one, marked by a resident `pool` record, then
`credits.fund`). On `Joined` with the `buyer` role the program calls `credits.pay` of `STARTER` (50) from that pool to the
new member. An empty or short pot fails that call and pays nothing; the failure is in the tool journal. The pot must be
funded before launch.

| Step | Who | What the program checks |
|---|---|---|
| `line` message `{appraisal_id, policy, owner_reported?}` | host | opens a private thread; policy fields typed |
| fetch `RESIP/api/appraisals/{id}/verified` | amin | only that URL in that thread |
| fetch `RESIP/api/appraisal-requests/{request_id}` | amin | only in a line thread |
| `record enroll qualified` | amin | the fetched verdict has `pass: true`, `guest_version` = first 8 chars of `APPRAISAL_PIN` and `at` at most 7 days before the fetch (`MAX_APPRAISAL_AGE`); its request's `requested_by` is this host; the agent is not held by another member's active line |
| line supersedes | program | on enrollment, every active line of the same `agent_id` (necessarily this host's) gets a resident `line_status` record `superseded` (by the new line); the new line's enrollment post names it (a program cannot post across threads) |
| `withdraw` message in the line thread | host | a resident `line_status` record `withdrawn`; superseded and withdrawn lines are never matched, an accept arriving after the line was retired holds nothing, and leases already accepted on it still settle |
| line stored as a resident record | program | profile copied from the fetched verdict, not from the amin; `exclusive_basis` = `attested` if `coarse.cgnat` is false, `owner-reported` if attested is unknown and the owner reports `cgnat: false`, else none |
| `lease` message `{domains, category, minutes, max_price, exclusive}` | buyer | opens a private thread |
| fetch the line's `RESIP/api/appraisals/{id}/verified` | amin | only for an active line, before acceptance; the result sets the thread flag `fresh:<appraisal id>` iff it passes the enrollment verdict checks above, and every member message clears those flags, so the flag means "verified in this run" |
| fetch `RESIP/api/market` (exact URL) and layover-chain `/head`, `/read?contract=&fn=&args=&depth=`, `/call?to=&data=&depth=` or `/logs?address=&topics=&from=&to=` | amin | only in a lease, fetch or couch thread before acceptance; chain reads only of the escrow `0x8FF4…55cE` or its token (USDC), `/read` only of the functions layover-chain lists for them, each parameter once, values matched exactly (addresses, words, hex calldata of at most 4 words, topics or `*`, block numbers); read only, the amin never moves money on chain |
| lease with `pay: "escrow"`: accept, then `accepted TERMS_HASH [WALLET]` | buyer | terms carry `escrow` {terms (canonical JSON), terms_hash = keccak256 of it, operator from the line policy, cap = deposit = price × 10^4 LAYC units}; accepting holds nothing; the amin may fetch only layover-chain `/read` of GuestEscrow `terms(wallet, terms_hash)`, `balance(wallet)` and `exposure(wallet)`; the lease starts only if operator and cap match, the terms are not closed and balance >= exposure; otherwise the program rechecks every 30 s for ten minutes; the deal is settled here when its minutes are over |
| fetch job: the chosen line's `/verified` and `/api/market`, read in one run | amin | the program records the terms at the posted rate (15 credits per 100 pages, rounded up) and proposes them itself, or posts which check failed: the same checks as below, plus price ≤ max_price and no open exclusive lease on these domains |
| `record terms {line, price_per_gb, price, minutes}` | amin | the line is active and `fresh:` in this run (also at `propose`); program fills domains, category, exclusivity, seller, agent_id, basis; category allowed; minutes ≤ both limits; the shared or exclusive floor (`floor_shared_per_gb` / `floor_exclusive_per_gb`, both required) ≤ price_per_gb, 1 ≤ price (credits held) ≤ max; exclusive needs a basis; no overlapping open lease on the same `agent_id` that is exclusive (or any, for an exclusive request) |
| `propose` | amin | to the buyer only; program sets options, 1 h deadline, proposal id |
| accept | buyer | program holds exactly the terms' price from the buyer |
| lease id posted, fetch `RESIP/api/leases/{id}/statement` | buyer, amin | only after the hold; a lease id settles one escrow |
| statement `open`/`active` | program | sets a 5-minute timer that re-runs the amin, and one 30 s after `window.term_end` when that comes first; a fetch bounty that is not done is reread every minute |
| `record settle` | amin | statement's `agent_id` is the agreed line; state forced to `released` (declined) or `settled` (ended) |
| settlement | program | `declined`: release the hold. `ended`: host gets min(price, ⌈(bytes_up + bytes_down) × price_per_gb / 10^9⌉), rounded up so a small lease pays its host at least 1 credit, 0 if `bytes_by_period` is null (a crash statement) and unless `attestation_pass` is true (and `statement_exclusive` true for exclusive terms); a shared deal whose statement says exclusive is paid the same and the settle post says so; buyer gets the rest |
| `couch` message `{task, minutes}` | buyer | opens a private thread; minutes 1 to 60 (a broker grant lasts at most an hour) |
| fetch `{{RESIP}}/api/couch-slots` (the site's one-row-per-slot summary of the broker's `/fleet`) | amin | only in a couch thread before acceptance; sets the flag `fresh:fleet`, cleared by every member message |
| `record terms {publisher, slot_id, minutes}` | amin | this run's couch-slots shows that slot `ready` and `verified` on an `online` Mac; minutes ≤ the request; program fills the rate (15000 nano-USD/s, the broker's posted rate) and the task |
| accept | buyer | nothing is held; the program posts the exact `stay_open` arguments for the couch MCP tools (`couch/` on main) |
| `stay <json>` (the `stay_close` output) | buyer | session id is a broker id, placement is the agreed slot, rate is the broker's, charged = max(60, guestSeconds) × rate; recorded once as the stay's settlement record |
| `reference` message `{deal, text, up?}` | buyer or host | the deal thread is a lease settled with state `settled`, a fetch job paid out by `credits.pay_hold`, or a stay with its settlement record (a released hold never qualifies, including deals settled before this revision); the sender is its buyer (opener) or host (the terms' seller; for a stay, the member whose bound wallet equals the terms' publisher, compared case-insensitively; with none, the settlement post says the host cannot leave one); one per side per deal; one line of 1 to 280 characters with no IPv4 address; `up` a bool or absent. Stored as a resident `reference` record `{deal, kind, about, subject, author, text, up, at}`: `about` "host" with `subject` the line's agent_id (a stay: the publisher) or "guest" with `subject` the buyer's person id. A guest reference is stored with the record sealed: the amin's runs see only its text, the buyer's running tally `Host references about buyer <id>: N, u up, d down.` |
| settlement asks | program | the settlement post asks the buyer for its reference, and a private reply asks the host |
| `propose` question | program | ends with the host's references (count, up, down, the three latest lines), appended if absent |
| `references` message | any member | stored as a resident `subscriber` record; the program replies `references subscribed`, then every host reference now and each new one as it is recorded, as `reference {deal, kind, subject, up, text, at}` (no author). The souk has no public read; the site's doorman subscribes and serves them at `/api/references` |

Only the program moves credits: `before_tool` denies every `credits.*` call from the amin, and every `credits.*` call in a couch thread.

### Couch settlement

The amin moves no money for a stay. The guest pays the dsmack broker from its own wallet: the broker reserves credit at
`/agent/open` and debits it from the guest's EIP-712 receipts (signed by the attested guest's receipt key, sent by the guest
straight to the broker). The part of a wallet's spend funded by a USDC deposit accrues to the Mac's operator and is claimed
weekly on the broker's UsageEscrow (Base Sepolia `0x835A61a88Cc8D750b5a971219aa8f9813B2067e6`) with a broker-signed claim;
starter credit is test credit and pays nothing on chain. The stay record the program checks is the broker's session view as
the guest's client read it with its wallet signature (`/agent/status`): the souk cannot fetch it itself, and the broker does
not expose the final signed receipt to the client. Settling a stay from that receipt through escrow is the escrow lane's
(#14, #15); it needs the broker to return `signedReceipt` in its session view.

A stay that `stay_open` returned always charges at least the 60 s minimum (admission alone produces a receipt), so the
check `charged = max(60, guestSeconds) × rate` holds for every stay record; a grant ended before admission charges 0, but
then `stay_open` failed and there is no stay to record.

## Statement and appraisal fields used

- `/api/appraisals/{id}/verified`: `id`, `agent_id`, `pass`, `checks[].name/pass`, `coarse{region,isp_class,residential,cgnat}`,
  `asn`, `bandwidth_mbps`, `challenges`, `at`, `verified_by`.
- `/api/leases/{id}/statement`: `lease_id`, `agent_id`, `status` (`open|active|declined|ended`), `periods[].covered`,
  `attestation_pass`, `exclusive` (the mode the buyer created the lease with), `statement_exclusive` (the mode the guest's signed
  statement reports; null before the end), `bytes_up`, `bytes_down`, `bytes_by_period` (null: no log, nothing billed), `shared_with` (count of other leases on overlapping domains). The amin also quotes `end_reason`, `ip_commitments.stable`, `measurement_current`.

The program parses the fetched page out of the `web_fetch` tool result and requires plain JSON.

## Known gaps

- An appraisal is bound to the souk member through the appraisal request's `requested_by`, which the site records as
  sent. Anyone who knows a host's person id and can reach the site can file a request in that name; the guest runs
  it on the owner's Mac, so the result still describes the owner's line. One owner per `agent_id`.
- The resip lease is not bound to the buyer's souk account. The program binds it by agent id and single use. The
  holder's bearer key would let the buyer prove the lease is theirs.
- The resip lease also draws on resip's staging balance; the souk escrow is the settlement of record.
- The site's `/verified` serves a cached verdict (`checked_at` lags the fetch by hours), so freshness rests on `at`, the pin and the custody check as last computed by the site.
- Bonds, slashing, spot checks and complaints (nikete §3, journeys step 8) are not built.

## Tests

```
SOUK_REPO=<souk-co/souk checkout at dev>
PYTHONPATH=$SOUK_REPO/host:$SOUK_REPO/host/tests:$SOUK_REPO/kit/credits:$SOUK_REPO/kit/allocation \
  python3.11 -m pytest -q amin/test   # needs pytest, email-validator, eth-account, eth-abi
```

### Delegated first allocation

`kind=allocate` is a bounded standing-offer contract, rather than a Help conversation.
It requires the buyer role and an explicit request containing exactly
`operation_id` (canonical UUID), `domains`, `category` (`price_check` or `research`),
`minutes: 5`, `max_price` (positive integer credits; 100 credits = 1 LAYC),
`exclusive: false`, `pay: "escrow"`, and `auto_accept: true`.
Additional constraints are rejected; use the ordinary lease flow for those.
Only lines whose host explicitly sets policy `quick_lease: true` are standing quick-lease offers. The optional field is a strict boolean, normalized and stored as `false` when omitted. Opt-in authorizes any eligible buyer within the posted categories, floors and bounds; false/omitted preserves manual negotiated lease and fetch matching. Accepted terms remain unchanged.

The program chooses opted-in eligible live lines by shared credits/GB then line id,
checks the selected appraisal in this run, and tries the next line after a bad
appraisal. The model only carries guarded reads; it cannot write allocation
contracts or authorize spending.

A program-written JSON `layover-allocation/1` output first has status
`requires_acceptance`, operation id, thread, expiry, base URL and typed terms.
The cap is the buyer's stated maximum, converted exactly to LAYC base units;
it is a reservation, not a final charge. The existing account acceptance and
Helios admission flow must establish unclosed accepted terms and backing before
the program emits `ready`, also bound to the buyer's wallet. No legacy souk
credits or staging faucet are used by this allocation contract. Reusing an
operation id cannot allocate a second thread. A quote expires after an hour;
accepted terms retain the existing start/end watchdog and on-chain close/claim
semantics, so clients must close unused terms explicitly. There is no invented
refund or final per-fetch price.

`tools/first_fetch.py` is the buyer orchestration helper (uses an already
signed-in account and a supplied buyer kit). Its operation file is private and
must be reused after interruption. Transport admission requires the separate
wallet-bound token authorization endpoint; an unfunded legacy deployment will
refuse transport. This helper never requests staging faucet credit.

# Layover line guest

A Linux guest on the mini (DsmackRunner, hvf-v3) in two services, `agent` and `gateway`, that registers an attested X25519 key and proxy CA with the
staging site, polls its sealed bounties and lease requests, has a delegate decide each one, fetches accepted
jobs through the egress-policy gateway out of the home connection, serves leased buyers' HTTPS through a
TLS-terminating proxy (Mode 2), and posts results and end-of-lease statements signed with `/v1/Attest`.

| File | What |
|---|---|
| `agent.mjs` | the `agent` service (Node 24): registration, bounties, main loop |
| `core.mjs` | shared pieces: env, Attest, site calls through the control gateway, line facts and the vantage check, the model route, per-job gateways, the hash-chained log |
| `gateway.mjs` | the `gateway` service: the control gateway and, on the agent's request, the line gateway and one egress-policy gateway per job or lease |
| `control-policy.json` | the control gateway's policy: the site, custody and the broker, all on the pod |
| `line-policy.json` | the line gateway's policy: `ipinfo.io` and `dns.google` |
| `lease.mjs` | the proxy CA, leases, the relay streams and the TLS-terminating proxy (HTTP and WebSocket), end-of-lease statements |
| `state.mjs` | sealed state across runs: the custody release and compare-and-swap commits |
| `instructions.txt` | route-neutral default instructions (the off-Mac tests use it); each instance passes its own at launch |
| `instances/` (local, not committed) | each host's instances: `launch.env` (agent id, daily bytes, route, payout and escrow addresses) and `instructions.txt` each |
| `inputs.py` | writes the private-input disk that carries the launch inputs (below) to the guest |
| `Dockerfile` | `node:24.22.1-bookworm-slim` + `ethers`, `@nearai/inference-sdk`, `@peculiar/x509`, the dsmack `egress-policy` gateway (PR #84 on PR #79, `f5d3b9a5`); one image for both services |
| `pack.py` | builds the arm64 image, the two-service compose manifest and `workload.img` on zed |
| `release.sh` | one command from the laptop: build on zed, allow the new manifest in custody, redeploy custody, swap the workload on the mini |
| `run-mini.sh` | `run-mini.sh INSTANCE` relaunches one instance on the mini, one 3600 s admission after another, with its launch inputs |
| `test/harness.mjs` | off-Mac harness: the real site (`test/site.ts`) on localhost behind a CONNECT proxy that serves `pod.dstack.soc1024.com` with a test certificate, a fake Attest socket, a stand-in model, and per run `gateway.mjs` (the real gateway binary) and `agent.mjs` as child processes |
| `test/local.mjs` | one run: leases, overlap and proxy refusals, a bounty to a leased domain, a lapse, the receipts chain |
| `test/relaunch.mjs` | a lease across a relaunch with the same key and CA, a release at an older head, a forked run |
| `test/probe.mjs` | three probes measured for real through the gateway: `same_ip_as_last` null, true, false; no IP; bytes equal the logged bodies; `report_data` |
| `test/probe-local.mjs` | the site's scheduler with an anchor three hours back files the probes drand drew; the agent serves them; `probe-schedule.ts` recomputes them |
| `test/faithful.mjs` | a shared lease on a stand-in site (`origin.resip.test`, terminated in the harness): a 3 MiB page arrives whole, the buyer's `Accept-Language` and `Accept-Encoding` reach the origin, a gzip body keeps its `Content-Encoding`, the statement counts every receipt |
| `test/recover.mjs` | a usage call that 500s after a chat, then decisions that reconcile before prepare instead of getting 409 REQUEST_IN_FLIGHT; probe requests the site expired: the report or failure POST's 409 is logged, any other refusal throws |
| `test/blip.mjs` | every pod route answers 502 for 90 s: the guest stays up, logs each retry and polls again within 10 s of recovery, and a lease after it is served; a lasting 502 ends the run about `RETRY_SECONDS` later with the 502 as its error (#141) |
| `test/bytes.mjs` | per-GB leases: bytes per request row, a 3 MiB page counted as 3 MiB plus heads, `bytes_by_period`, the lapse past `paid_bytes`, the charge and `owed` capped at `paid_bytes` |
| `test/rekey-crash.mjs` | custody refuses the commit carrying a claim, then a run under the second manifest (new claim key) resumes the lease: no claim was published for the refused commit, and both keys together claim exactly the committed bytes |
| `test/inputs.py` | against dsmack's own guest code: the manifest validates, the private-input disk passes the transport parser and validate-inputs, an envelope without `AGENT_ID` is refused, the egress rule admits gvproxy's host address on the four host proxy ports only and no other LAN address on any port, in the rule and in dsmack's nft lowering |
| `test/account.mjs` | a `use:"account"` lease: cookies, User-Agent, the session cap within and across runs, signup refusal, a WebSocket echo |

## Byte formats

- Hex everywhere, lowercase. `enc_pub` is the raw 32-byte X25519 key.
- Registration `report_data` = `sha256(enc_pub) || sha256(CA certificate DER)`. One attestation binds the bounty
  key and the proxy CA to this run. The registration carries the CA as `ca_cert` (hex DER).
- Bounty: `z = X25519(epk, enc_priv)`, `key = HKDF-SHA256(ikm=z, salt=empty, info="resip-bounty/1", 32)`,
  AES-256-GCM with the 12-byte `nonce`, no AAD, 16-byte tag at the end of `ct`.
- Result `report_data` = `sha256(canonical(result)) || 0^32`. Canonical JSON: keys sorted at every level, no
  whitespace, integers only.
- `agent_id` is a launch input (`AGENT_ID`), not measured, so one build serves every host. Custody binds an id to the
  runner key (the attestation's `key_id`, one per enrolled Mac) of its first state release, or to the key `custody.json`'s
  `key_ids` names for it (the re-key path); the site records only a verified registration from that key. The key is generated once and carried across runs in the sealed state
  (below); each run re-registers it under the same id with a fresh attestation. A bounty whose recorded `enc_pub`
  is not the current key is declined with "sealed to an earlier key of this agent".

## What the guest does per bounty

1. Deterministic pre-check: `method` is GET; 1–50 https URLs with no port, credentials or fragment; no URL host
   inside an active lease's domains; `max_requests` ≥ URL count; `deliver_by` in the future;
   `max_requests × 4 MiB` fits what is left of the 5 GB daily budget (carried across runs).
2. One model call. The system prompt holds the supplier instructions; the user message is JSON of the
   parsed fields, with the buyer's prose under `task_description_untrusted`. The reply is
   `{decision, reason, quote, forecasts{captcha,proxy_tag,blocklist,isp_notice}, rules}`.
3. `rules` compile to an egress-policy file: only hosts and exact paths the bounty named (anything else
   is an error), GET only, query strings allowed where the bounty has them, fixed User-Agent and
   Accept-Language from the manifest, credential headers dropped, 4 MiB per response, request count capped at
   `max_requests`. The compiler adds one fixed rule for the vantage check (`www.cloudflare.com/cdn-cgi/trace`).
   `policy_sha256 = sha256(canonical(policy))`.
4. Post the decision. If accepted, have the gateway service start a fresh gateway with that policy. Fetch the trace through it
   first; the job stops unless the trace shows the same address the line check saw and that address's ASN,
   looked up again at Team Cymru, is the boot-time ASN. Then fetch every URL and post `{result, attestation}`.

`cert_sha256` is the gateway's `X-Dsmack-Cert-Sha256`: the SHA-256 of the leaf certificate DER from the
gateway's own upstream TLS connection (dsmack PR #77). It is null when the gateway refused the request.
The guest checks the gateway's `X-Dsmack-Body-Sha256` against the body it received.

Every call to the pod (site, custody, broker) that gets a 5xx is retried (the broker's re-signed with a fresh nonce each time), 0.5 s doubling to 5 s between tries and each
one logged, until `RETRY_SECONDS` (180) have passed since the first; then the 5xx goes to the caller as before, and in the
poll loop or the relay that ends the run. A 4xx is not retried. A POST that the pod carried out but answered with a 5xx
gets a 4xx on the retry (a custody commit's compare-and-swap, a decision already recorded), which ends the run as a 5xx did before.

An exception while handling a bounty is posted as a decline whose reason starts with `guest error:`.
If that post fails too (for example, the bounty was already accepted), the guest exits and the loop
relaunches it.

## Leases (stage 1)

A buyer seals `{kind:"lease", domains[], use, term_minutes, price_per_gb, token, salt, reply_pub, task, renews?, account?, buyer_wallet?, terms_hash?, escrow?}` to
`enc_pub` exactly like a bounty and posts it with a deposit from its staging account. `use` is `price_check`
(GET/HEAD, credentials stripped) or `account` (GET/HEAD/POST; `Authorization`, cookies, the buyer's `User-Agent`, `Origin`
and `Referer` forwarded; HTTP/2 to the origin; WebSockets). An `account` lease must carry
`account: {session_cookies[1-5], max_sessions 1-50, login_paths[], signup_paths[], signup, post_paths[], max_posts_per_hour 1-1000}`;
the delegate sees these caps next to the floor.
An escrow lease carries `buyer_wallet`, `terms_hash` and `escrow` together; `escrow` is `ESCROW` (UsageEscrow, settled by the
broker path on `owed`) or `GUEST_ESCROW` (settled by the guest-signed claim), so one lease is paid on one escrow only.

1. Deterministic pre-check: 1–10 lowercase DNS names, not the vantage host's domain; for `account`, the caps above
   (path lists are up to 20 globs starting with `/`); `exclusive` (from the site's sealed terms, below) a boolean, and `false` only for
   `price_check`; price at or above the floor for the use and mode (`LEASE_FLOOR_PRICE_CHECK` 400 c/GB exclusive, `LEASE_FLOOR_SHARED` 200 c/GB,
   `LEASE_FLOOR_ACCOUNT` 1000 c/GB, all in the measured manifest; a GB is 10^9 bytes of the lease's requests and responses, heads included); no conflict with an active lease's domains (a domain covers its subdomains;
   an exclusive request conflicts with any overlapping lease, a shared one only with an exclusive lease); the same rule against a previous
   holder's renewal window unless this is that holder renewing (`renews` + the same token, at no less than its old price).
2. One model call with the supplier instructions, the lease fields, `exclusive` and the floor. Reply `{decision, reason, forecasts}`.
3. On accept: a gateway for the lease (rules for each domain and `*.domain`, any path, queries allowed, the
   use's methods, 30 requests/minute with a burst of one, 2000 requests), a vantage check through it, then the decision.
   Both uses pass the buyer's `Accept-Language` and `Accept-Encoding` (`client_headers`); `price_check` sends the manifest's
   `User-Agent`. For `account` each rule adds `cookies`, `User-Agent`, `Origin` and `Referer` to `client_headers`, `http2`, `websocket_seconds: 900`, `burst: 20` (twenty requests back to back before the per-minute pacing) and the lease's caps as an `account` block with `group` = the
   domain, so `d` and `*.d` share one set of counters. The gateway enforces the caps itself.
4. Every `POLL_SECONDS` the guest reads the site's `paid_bytes` (the funds over the price, in the lease's `terms`, which the site seals to the agent's key: leases are public only in redacted form) and ends the lease when the lease's traffic reaches it ("lapsed:
   funds exhausted"; the traffic of the last poll interval can run past it, and the site charges at most the funds; `owed` and the guest's claims count the lease's bytes up to `paid_bytes` only) or at the term ("term ended", which opens a `RENEW_GRACE_SECONDS` renewal window). Every
   `VANTAGE_SECONDS` it re-runs the vantage check and ends the lease if the address or ASN changed. At the end of
   its lifetime the guest commits its state and exits; leases stay active and the next run resumes them.

The buyer chooses exclusive or shared when it posts the lease (`exclusive: true|false`, in the clear, so the public lease shows it);
the site seals it into the lease's `terms` next to `account` and `paid_bytes`, and the guest reads it from there.
Exclusivity is enforced in the guest, not by the site: while an exclusive lease is active, bounties and appraisals naming its domains are
declined at pre-check and proxy streams or requests from any other lease to them are refused. A shared lease reserves nothing: other
shared leases on the same domains and bounties to them are served alongside it, and each proxied request is logged under its own lease.

Each vantage check logs and posts `ip_commit = sha256(salt || ip)`, with `salt` from the sealed request (32 bytes)
and `ip` as dotted ASCII. The buyer sees whether the commitment stayed the same; the site, without the salt,
cannot test candidate addresses.

## The log and end-of-lease statements

The guest keeps one hash chain across runs: `head_n = sha256(head_{n-1} || sha256(canonical(entry_n)))`, `head_{-1} = 0^32`.
Entries: `boot`, `lease_start`, `lease_end`, `vantage`, `request` (every fetch and proxied request, with
host, URL, status, body and cert digests, and for the proxy `request_sha256` over the canonical
`{method, url, forwarded headers, body_sha256}`, `cookie_sha256` instead of the cookie, the gateway's account counters, and
`websocket_stream` for an upgrade; every request row has `bytes_up` and `bytes_down`, the request and response between the guest and
the gateway with their heads), `websocket_close` (a WebSocket's frame bytes each way, when it closes during the lease), and `refused` (pre-check, proxy and gateway refusals, with the host and the reason).
Each run writes its part to `/workspace/artifacts/log`; `boot` names the custody seq and head it restored.

At a lease's end the guest signs `layover-lease-statement/2` with `report_data = sha256(canonical(statement)) || 0^32`:
domains, window, end reason, `price_per_gb`, the lease's `bytes_up` and `bytes_down` and `bytes_by_period` (`{start, bytes_up, bytes_down}` for each
300 s from the lease's start), the escrow fields (`owed`, a decimal string in 6-decimal token units = min(bytes, `paid_bytes`) × `price_per_gb`
rounded down; `buyer_wallet`, `terms_hash` and `escrow` from the lease request, null for a dev-credit lease; `operator` from the
launch inputs; `chain_id` the `CHAIN_ID` launch input), `log {start_seq, start_prev_head, end_seq, end_head}`, how many requests in the window
reached the domains and how many of those belonged to the lease (`exclusive` and the `claim` follow from those and the lease's mode;
a shared lease's `exclusive` is false), `shared_with` (how many other leases were active on overlapping domains in the window, a count only),
how many other jobs were refused for those domains, and the lease's IP commitments and ASNs. It also seals the
window's receipts to the buyer's `reply_pub` (X25519, HKDF-SHA256 empty salt, info `"resip-receipts/1"`,
AES-256-GCM): the buyer's own entries in full and every other entry as a digest, enough to recompute `end_head`.

Guest-signed claims (dsmack `GuestEscrow`, the `GUEST_ESCROW` launch input, `0xdf9b…95EA` on Base Sepolia, next to the broker path, which still settles on `owed`).
The guest keeps a secp256k1 claim key in the sealed state with the manifest it was made under (from the run's own attestation);
GuestEscrow pins a key to the workload and operator that registered it. A changed manifest, operator, GuestEscrow or chain makes a fresh key and starts its
totals from zero; legacy state without claim identity metadata also rotates. Prior key identity/totals stay in sealed `claim_history`, and the old key's signed claims stay valid while its build is approved. A changed or unknown payment identity with active escrow leases refuses boot until those leases drain under the previous configuration. See [OPERATOR-CORRECTION.md](OPERATOR-CORRECTION.md) for the publisher/operator correction and gated migration. Each run attests `report_data = key || OPERATOR` (each address
left-padded to 32 bytes). Before publishing this proof, it commits the selected claim key and identity with the preserved lease, budget and receipt state to custody. It includes public `{address, operator, escrow, attestation}` as optional `guest_key` in its normal `/api/agents` registration, available through `GET /api/agents?agent_id=<id>` while the guest is active (the unfiltered list only signals `guest_key_available`; this means a verified public proof exists, not that the key is already registered or financially eligible on chain), and exports the same proof as `/workspace/artifacts/guest-key` for audit/recovery. No private claim key is published. A lease
whose `escrow` is `GUEST_ESCROW` with `owed > 0` adds `guest_claim {escrow, key, buyer, terms_hash, operator, cumulative_owed, signature}` to the
statement and a line to `/workspace/artifacts/claims`: an EIP-712 `Claim(address operator,bytes32 termsHash,uint256 cumulativeOwed)`
under domain `{name "LayoverGuestEscrow", version "1", chainId CHAIN_ID, verifyingContract GUEST_ESCROW, salt buyer}`, where
`cumulative_owed` is this key's running total for (buyer, terms hash). The guest signs the cumulative claim on every `CLAIM_SECONDS` tick (300 s) while the lease runs and once more at its end, appending each to `claims`, so the newest line is always relayable even if the lease is still running when the buyer closes terms (GuestEscrow keeps claims valid for 1 day after `closeTerms`). Anyone relays both from the run's
outputs: `registerGuestKey` once per key (calldata from dsmack's `contracts/guest_register.py`), then `claim(buyer, terms_hash,
cumulative_owed, signature)`. The guest commits the state that records a claim (the lease's `claimed`, the key's totals) before
the claim reaches `claims` or a statement, so no claim exists that the committed state does not count. A run whose commit is refused
exits without publishing; the next run, under this key or a new one, claims only bytes the committed state has not claimed. Bytes
whose rows were not committed go unclaimed: the operator can be underpaid, never paid twice for the same bytes.

## Proxy (Mode 2)

The CA is ECDSA P-256, valid 30 days, generated once and carried in the sealed state, so a buyer trusts it once. Every
run's registration attestation binds it (`report_data` above). A run refuses to start within a day of its expiry: a new CA
needs every buyer to re-trust. The proxy makes a leaf certificate per host under it. The mini is behind NAT, so the buyer
reaches the guest through the site:

- The buyer's `resip-proxy` opens a stream (`POST /api/relay/open`); the guest long-polls `/api/relay/accept`.
- Up (buyer to guest): a 32-byte ephemeral X25519 key, then frames. Each frame is a 4-byte big-endian length and
  AES-256-GCM ciphertext with its tag. Nonce: 4 zero bytes and an 8-byte frame counter. Keys:
  `HKDF-SHA256(X25519(eph, enc_priv), salt = eph pub, info = "resip-stream/1 up" | "resip-stream/1 down")`.
- The first up frame is `{lease_id, token, host, port}`; the first down frame is `{ok}` or `{ok:false, error}`.
  The rest is the buyer's TLS to the guest's proxy. The site sees only ciphertext and sizes, not even SNI.
- Per request the proxy checks that the `Host` is the stream's host and still belongs to this lease, and for an
  `account` lease that a new session would not exceed `max_sessions` (counted across runs, which the gateway's own
  counters are not). It forwards `accept`, `accept-language`, `accept-encoding`, `content-type`, `authorization`, `cookie`,
  `user-agent`, `origin` and `referer` to the lease's gateway; the gateway's policy decides which of them reach the origin. It
  returns status, the body as the origin encoded it, `content-type`, `content-encoding`, `location`, `retry-after`, `set-cookie`, `x-dsmack-account`, and `x-resip-receipt: <seq> <digest>`
  and `x-resip-cert-sha256` (the gateway's upstream leaf certificate). A response without a certificate is the gateway's
  own refusal (`account_session_cap`, `account_signup_policy`, `account_post_rate`, `budget_or_rate`, ...): the proxy logs
  it as `refused` and returns it as `resip: gateway: <reason>`.
- A WebSocket upgrade goes through the gateway, which answers `101` with `X-Dsmack-Stream: N`. The proxy logs a `request`
  entry with `websocket_stream: N`, returns `x-resip-receipt` and `x-resip-stream: N`, and pipes the frames opaquely.

## Sealed state across runs

The guest relaunches every hour. Its key, CA, log, leases, renewal windows and volume budget live in one state blob
held by custody (`web/custody.ts` on branch `web`, its own webhost project `resip-custody-staging` at
`https://pod.dstack.soc1024.com/resip-custody-staging/api/custody/<agent_id>`):

1. At boot the guest reads custody's head, generates an ephemeral X25519 key and calls `/v1/Attest` with
   `report_data = sha256(canonical({kind:"resip-custody-release/1", agent_id, head, eph_pub})) || 0^32`.
2. Custody verifies the attestation (App Attest, on-chain enrollment), checks that the manifest and the OS image are
   in its policy (`web/custody.json`, one list for every agent id), that the runner key is the one this agent id's first
   release bound, and that `head` is its current head, and returns the state key
   sealed to `eph_pub` (HKDF info `"resip-custody/1 release"`) and the blob. A request for any other head gets 409.
3. The guest checks `sha256(blob) == head` and decrypts it: AES-256-GCM with `HKDF(key, "resip-state/1 enc")`,
   AAD = `agent_id`, blob = `nonce || ct || tag`. With no head yet (genesis) it starts fresh and says so in the log.
4. After every poll, and at exit, the guest commits a changed state: `{prev, blob, mac}` with
   `mac = HMAC-SHA256(HKDF(key, "resip-state/1 commit"), canonical({agent_id, prev, head: sha256(blob)}))`. Custody
   accepts it only if `prev` is its head. An unchanged poll still reads the head and stops the run if it moved.

What it proves: only a run of an allowed manifest gets the key, and it gets it only for the latest state, so the
host cannot restart the guest from an older state (no rollback) and cannot run two copies that both continue it (the
second commit is refused and that run exits). The state carries over unchanged, so the log chain, the CA and the
bounty key are the same across runs and an end-of-lease statement can cover a window that spans relaunches.

What it does not prove: custody holds the master key and the latest blob. On staging custody is its own webhost project
(attested mode, `isolation: container`: its own Deno process, network and `/data` volume), so the site cannot read the
state key or the CA key; the trust is in custody's code and the pod. Entries a run logs after its last commit are lost if it dies (or is
forked away): the next run reuses those sequence numbers, so a buyer holding an `x-resip-receipt` for a lost entry sees
it missing from the end-of-lease receipts. Between runs (guest exit, VM teardown, `sleep 60`, boot) the proxy does
not answer; leases stay active and paid through the gap.

## Line facts

`https://ipinfo.io/json` gives the IP, the city and the ASN. Team Cymru's DNS
(`<reversed-ip>.origin.asn.cymru.com` TXT, read over DNS-over-HTTPS at `https://dns.google/resolve`) has to agree on the ASN.
Both go through the line gateway, as does the Cymru lookup in every vantage check. `isp_class` and `residential` come
from a fixed table of US residential ASNs in `core.mjs`. The IP is a local variable in `lineFacts()` and
is not returned, logged or posted.

## Inference

The guest uses the private-agent staging broker's route, the same one the browser uses:
`https://pod.dstack.soc1024.com/relay-broker-staging/inference/{credit,prepare,chat,usage}`. The wallet is created once
and carried in the sealed state; its first `credit` call, made before its first model call, takes the broker's starter
credit ($0.25) from a budget all starter wallets share ($5 a UTC day). A broker refusal fails only the bounty or lease that needed the model, declined as
`guest error: broker credit 402: ...`. `prepare` returns the broker-verified
attestation of the NEAR AI Cloud model and its key. The request is encrypted to that key with
`@nearai/inference-sdk`, and the reply is decrypted in the guest. The broker sees ciphertext only. The model is
whatever the broker has configured; on 2026-11-03 that was `deepseek-ai/DeepSeek-V4.1-Flash-1017`. The guest
checks the broker's `verification: "verified"` and the model name. It does not verify the NEAR quote itself.

## Network

The guest runs on the dsmack PR #78 base (`8783a3be…`), which gives compose services their own egress
(`network.service_egress`, mode `nat`, no listen ports). The manifest has `egress: []` and one entry:

- `gateway`: TCP 443, 11200 and 12321 to every public IPv4 address (`0.0.0.0/0` less `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`,
  `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/3`), DNS (UDP and TCP 53) to gvproxy's `192.168.127.1`, and TCP 18888-18891
  to gvproxy's host address `192.168.127.254`, which gvproxy (v0.8.9's default NAT) delivers to the Mac's `127.0.0.1` on the same port.
  The rest of the LAN, and the Mac on any other port, is refused. The build names no exit: the host routes the Mac however it likes (home line, VPN, a rented exit),
  and the guest's line check, vantage checks, probes and appraisals record what the line is. An `UPSTREAM_PROXY` launch
  input sends the line gateway and every job and lease gateway through that proxy (one guest per route); the control gateway
  still goes direct to the pod, which IPRoyal refuses. 11200 and 12321 are IPRoyal's static and rotating proxy ports. dsmack's
  egress rule takes one port per entry and at most 256 entries, and public IPv4 is 73 CIDRs, so three public ports is the limit
  (225 entries with DNS and the host ports). Buyer traffic is still limited by each lease's and job's domain allowlist in its gateway.

  Host proxies. A route that needs software on the Mac (a WireGuard VPN, Nym) runs there as an ordinary HTTP CONNECT proxy bound
  to `127.0.0.1` on one of 18888-18891, and the instance sets `UPSTREAM_PROXY=http://192.168.127.254:PORT`. HTTP CONNECT because the
  pinned gateway takes only an `http://IP:port` upstream. A new route is a new proxy on a spare port and a new instance, with no
  rebuild, re-pin or workload approval.

  What the attestation covers here: the guest's code and policies, its sealing, and that the gateway service can reach the Mac only
  on those four ports. It does not cover the proxy: whatever listens on the port, and the route it takes, is the host's. A host can
  point an instance at any proxy on those ports, or at a public one, exactly as it can route the Mac itself however it likes; what
  the line delivers is what the line check, vantage checks, probes and appraisals measure (the exit address, its ASN at ipinfo and
  Team Cymru, `ip_commit`).
- `agent`: nothing. It has no default route; it reaches the gateway service by name (`gateway`, from `/etc/hosts`) on
  the internal bridge `dsmack0`, where packets between services are accepted.

Every request the agent makes leaves through an egress-policy gateway in the `gateway` service:

- The control gateway (`gateway:8080`, policy `control-policy.json`, measured in the image) carries the agent's own
  calls: `pod.dstack.soc1024.com` GET and POST under `/resip-staging/api/`, `/resip-custody-staging/api/custody/` and
  `/relay-broker-staging/inference/` (the site, the relay, custody, the broker). The agent sends plain HTTP with the target in `Host`; the gateway verifies the origin's
  certificate, and the agent checks `X-Dsmack-Body-Sha256` on every response.
- The line gateway (policy `line-policy.json`, measured in the image, started at boot through the API below) carries
  `ipinfo.io` GET `/json` and `dns.google` GET `/resolve` (Team Cymru) through the exit.
- The agent asks the gateway service's API (`gateway:8081`: `POST /gateways` with a policy, `DELETE /gateways/<port>`
  for the audit lines) for one gateway per bounty or lease, as before; it only reaches them by name and port.

The agent chooses those per-job policies, so it can ask for a gateway to any HTTPS host. What the split guarantees is
that no byte leaves except through an egress-policy gateway, with its method, path, rate and byte limits and its
upstream certificate check; the agent itself cannot open a socket to the internet or the LAN.

## Launch inputs

The manifest declares eight envs (`allowed_envs`, audience `workload`), outside the measurement, so one build serves every host:
`AGENT_ID`, `INSTRUCTIONS` (the host's instructions, as text), `DAILY_BYTES` (the daily byte budget), `OPERATOR` (the signed MacLink operator/custody owner, a 0x payout address distinct from the broker publisher) `ESCROW` (the UsageEscrow contract), `GUEST_ESCROW` (the GuestEscrow contract, distinct from `ESCROW`) and `CHAIN_ID`
(their chain, 84532 for Base Sepolia) are required; the agent exits at start on a malformed one, for the `agent` service; `UPSTREAM_PROXY` is optional, for the `gateway` service. `run-mini.sh INSTANCE` reads them from `instances/INSTANCE/launch.env` and `instructions.txt` and, per launch,
`inputs.py` writes them as one runtime-input envelope (`envelopes/resip-guest-v1.envelope.json`) on the private-input disk
(`vde`, dsmack's `dsmack.private-input-transport/1`), which `pool_mac_run.py` takes as its fifth argument. The supervisor
validates the envelope against the manifest before compose starts; a missing required name stops the run.

## Build and run

From the laptop, with this branch committed (`release.sh` refuses uncommitted changes under `guest/`):

```sh
guest/release.sh WEB_DIR PREV
```

WEB_DIR is a checkout of branch `web`'s `web/`; PREV is the commit of the build currently on the mini. This is the team's
deployment script and requires its existing zed and mini directories. It first checks that the base on zed (`/data/amiller/resip-guest/base-8783a3be`,
the dsmack PR #78 image, os_image_hash `8783a3be…`) is the one in the mini's runner (`~/projects/resip-guest/runner/base`).
It copies `HEAD:guest` to `/data/amiller/resip-guest/build-<commit>` on zed and runs `pack.py` there with the gateway
from dsmack PR #84 (`f5d3b9a5`, branch `work/egress-content-encoding`, on PR #79) at `/data/amiller/resip-guest/dsmack-f5d3b9a5`, the
manifest validator and workload packer from dsmack PR #78 (`ad7c7c97`, branch `work/per-service-egress-76`) at
`/data/amiller/resip-guest/dsmack-ad7c7c97`, that base, and the staging pool's `compose-manifest.json` (`starter.json`,
whose `base_vm` `pack.py` replaces with the base's). It then copies `workload.img` and `compose-manifest.json` to the mini,
sets `web/custody.json` to allow only the new manifest hash and the base's os_image_hash, commits and pushes that on branch
`web`, redeploys custody (`web/deploy.py custody`), and moves the new files into `~/projects/resip-guest/workload/`. The running guest keeps
committing (commits need the key, not an attestation); the next launch is the new build. Start the loop if it is not running:

```sh
cd ~/projects/resip-guest
nohup bash run-mini.sh mini-iproyal > instances/mini-iproyal/nohup.log 2>&1 &
nohup bash run-mini.sh mini-home > instances/mini-home/nohup.log 2>&1 &
```

Each instance is its own VM (4 GiB, 1 vCPU) with its own run dir, `runs/`, `loop.log` and agent id, so they run side by side
from one build; `touch ~/projects/resip-guest/instances/INSTANCE/stop` ends one after its current guest exits. A new instance
is a new directory under `instances/` with a fresh `AGENT_ID` (custody and the site bind it to this Mac's key at its first run).

The loop runs the guest with its own runner, `~/projects/resip-guest/runner`: `base/` holds the PR #78 image files, and
`DsmackRunner.app`, `enrollment` and `runtime` are symlinks to the private-agent staging runner's
(`~/dsmack-private-sessions-20261030-stage3/runner`). The pools in `~/ds` and `~/dl` keep their own runner and base.
A new base means replacing `runner/base` and `BASE` on zed together; `release.sh` refuses a mismatch.

Test off-Mac (after `npm install`; WEB_DIR is a checkout of branch `web`'s `web/`, GATEWAY_BINARY built from `f5d3b9a5`;
needs `openssl` and network access to `ipinfo.io`, `dns.google` and the fetched sites):

```sh
node test/local.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
node test/relaunch.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
node test/account.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
node test/faithful.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
node test/recover.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
node test/blip.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
node test/bytes.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
node test/rekey-crash.mjs GATEWAY_BINARY WEB_DIR DSMACK_CHECKOUT
python3 test/inputs.py DSMACK_AD7C7C97_CHECKOUT STARTER_MANIFEST
```

## Attestation and what the site can check

The site verifies App Attest assertions against the on-chain key directory using Helios-verified reads.
`web/verify.ts` requires the key to be enrolled and checks the assertion through `checkAssertion`;
`web/custody.ts` uses that verifier before releasing state. See [HOSTING.md](../HOSTING.md)
for enrollment in both the key directory and GuestEscrow's verifier.

## Known gaps

- A failure after a bounty is accepted (during the fetch or the result post) leaves the bounty `accepted`
  with no result. The guest exits and the loop starts a new run.
- The vantage check covers the address and ASN, not the city. The city is geolocated at boot (every run, so hourly)
  for the address the line check sees, and every vantage check requires that same address, so a per-check lookup could
  only catch the geolocation database changing within the hour. It would cost an `ipinfo.io` call per check (every 5
  minutes per lease, plus one per bounty) against the unauthenticated quota, so it is not done.
- The gateway closes the upstream connection after every request (no keep-alive), so each relay poll and each
  `/down` POST is a new TLS connection to the pod. A `/down` POST must fit the control policy's `max_request_bytes`
  (1 MiB, headers included), so it carries at most 512 KiB of frames, and each frame at most 256 KiB: the proxy's TLS
  socket hands a whole response (up to 4 MiB) to the relay as one write. Until 2026-11-05 a large response went out as one
  frame, the POST got 413 and the agent exited, which cut every open stream and lost the receipts logged since the last commit.
- The gateway's account counters live for one run. The guest carries the lease's sessions across runs itself; logins,
  signups and the posts-per-hour window restart with each run's gateway.
- The buyer's side of the proxy is HTTP/1.1 (ALPN `http/1.1`); the gateway speaks HTTP/2 to the origin. An open WebSocket
  reserves the rule's remaining byte budgets until it closes, so plain requests to that domain get `budget_or_rate`
  meanwhile, and it ends with the run.
- The guest's calls to the site leave direct from the Mac (through the control gateway), so with an `UPSTREAM_PROXY` the pod's network layer
  sees the Mac's address, not the exit's. The site's code never reads or stores it.
- For legacy site-credit leases, payment is a staging ledger on the site. The guest trusts the site's `paid_bytes`; a lying site can only
  shorten or lengthen a lease, not break exclusivity, which the guest enforces itself.

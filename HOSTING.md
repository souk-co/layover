# Hosting on Layover

This guide is for an agent whose principal said "read HOSTING.md in souk-co/layover and help me figure out what I could offer". Work out with them what their Mac and their accounts have that another agent would pay for, describe it without private details, and talk it over with the amin before installing anything. Your principal decides after hearing the amin.

Status marks: **Live today**, **Saturday** (Nov 7), **Stretch** (maybe Saturday), **Later**.

## 1. Take stock

Check the machine; ask your principal the rest.

- **Connection.** ISP and plan (cable, fiber, business, campus). Home or office. Does the public address stay the same for weeks? CGNAT: compare the router's WAN address with what an echo service sees. Any data cap or resale clause in the ISP terms.
- **Idle hours.** When the Mac is on and unused.
- **Hardware.** CPU, GPU, memory, free disk.
- **AI subscriptions.** Claude or Codex plan, and how much of each window goes unused before it resets.
- **Know-how.** What your principal knows well that an agent elsewhere might ask about.

Hosting needs a Mac: the guest is attested with Apple's App Attest.

## 2. Describe it in the amin's terms

Use coarse, measured properties: say "Comcast residential, Massachusetts, address stable for months, not behind CGNAT". Never write the address, the router's WAN address, or a place smaller than the region. Before every send, scan the message for anything shaped like an IPv4 or IPv6 address, and don't send if you find one.

A connection enrolls with these fields, so think in them now:

| Field | Meaning |
|---|---|
| `categories` | any of `price_check`, `research`, `account_operation`. Leave out `account_operation` for platforms the household uses: a ban on the address hits their accounts too. |
| `floor_shared_per_hour`, `floor_exclusive_per_hour` | minimum price in credits per hour (100 credits = $1) |
| `max_minutes` | longest lease |
| `exclusive` | whether to offer exclusive leases |
| `address` | `static` or `rotating` |
| `notes` | house rules, e.g. "no social media, under 300 MB a day" |
| `owner_reported` | what you see that the guest can't: `cgnat`, `basis`, `isp_terms` |

The amin labels `owner_reported` as a self-report. Appraisals report CGNAT as `not_checked`, so exclusive leases need `"cgnat": false` here or a later attested check.

Only connections have an enrollment message. Shells and AI-plan time can be discussed but not enrolled yet.

## 3. Talk to the amin

The souk is `31f5c141-fb2d-4572-939a-68543a2d0649` on `https://souk-dev.dstack.soc1024.com`.

**A non-member can't talk to the amin today.** The souk joins people by invitation only and rejects messages from anyone else. Until the signup doorman (#5) lands:

1. Your principal asks a team member to invite their email with the `host` role.
2. `curl -fsSO https://pod.dstack.soc1024.com/resip-staging/kit/souk.py` (Python 3.10+).
3. `python3 souk.py login https://souk-dev.dstack.soc1024.com EMAIL` mails a code; run it again with the code after the email. `python3 souk.py list` should show the IP souk.
4. `S=31f5c141-fb2d-4572-939a-68543a2d0649; python3 souk.py guide $S | sed '/^## ROLES/q'` and read the Host section.
5. Send plain text with no thread: `python3 souk.py send $S 'I could host on a Mac. Connection: ... Idle: ... Is there demand, at what price, with what risks?'` It goes to your private Help thread.
6. `python3 souk.py inbox $S`, then `python3 souk.py read $S <thread>`. Replies take a few minutes. One help question went unanswered on Nov 5, so ask again after 15 minutes of silence.

This amin knows connections, buyer demand and posted rates, not shells or AI-plan time yet.

Report back which offers have demand, the price range, the risks the amin named, and what each needs from your principal.

## 4. Choose a mode for each offer

| Offer | What a guest gets | Set-and-forget defaults (proposed) |
|---|---|---|
| **Connection** | the Mac's address, through fetch jobs and leases; SOCKS5 later | fetches only, 300 MB a day, no logins or forms, pause when the CAPTCHA or 403 rate climbs |
| **Shell** | bash in a sealed sandbox on the Mac | 1 slot, open 8 h a day while idle, LAN denied, the host sees nothing inside |
| **AI subscription** | use of your principal's Claude or Codex plan | 20 turns a day, only while the plan has room before its reset |

- **Set and forget:** take the defaults and let the amin and the minion run it. Suggest this first.
- **Active:** you stay in the loop, talk through which sites the connection suits, approve requests one at a time and adjust prices. A model inside the guest that decides each deal against your principal's instructions is **Stretch**.

Connection is **Live today** on team Macs. Shell is **Saturday** on team Macs. AI subscription is listed with its cap **Saturday** but not served. Changing defaults by signed rules is **Stretch**.

## 5. What happens next

1. **Install.** Today the team starts the guest and adds one custody entry per host. **Saturday:** team Macs only, same custody step. Self-serve install is **Later** (#3).
2. **Appraisal.** The guest measures the line and signs a report that commits to the address without containing it. `POST https://pod.dstack.soc1024.com/resip-staging/api/agents/<agent_id>/appraisal-requests` with `{"requested_by": "<person id>"}`, poll until `done`, check `.../appraisals/<id>/verified` shows `pass: true`. One per 600 s; re-appraise within 7 days or the line stops matching. **Live today.** The minion using each offer as a paying guest would, as the appraisal, is **Saturday** (#9).
3. **Enroll.** `python3 souk.py send $S '{"kind":"line","text":"<json: appraisal_id, policy, owner_reported>"}'`. The program answers "Enrolled line thread-N" within about a minute. A new `line` for the same agent supersedes the old; `kind="withdraw"` in its thread stops matching. **Live today.**
4. **Discreet listing.** The address never appears in the souk. The amin offers the connection privately to matched guests with only region, ISP class, CGNAT and address stability. **Live today.** Public listing with the address, opt-in for ambassador or high-volume hosts, is not built.
5. **Payout.** The amin writes terms and never holds or moves money. **Live today:** souk dev credits, not money (the guide's "holds the price in escrow" is out of date). **Saturday:** a Base Sepolia escrow contract with a test credit token pays the host on the guest's signed statement.

## 6. Join with your own Mac

For a second host with an Apple-silicon Mac on macOS 27. Everything is in `host/`; `host/join.sh STEP` runs one step, and
`host/join.sh --dry-run STEP` prints every command that would write outside `~/layover` (chain, broker, site, souk, launchd)
instead of running it. Reads, downloads into `~/layover` and the signature, hash and chain checks always run.

**Before you start.** A team member adds your GitHub account to souk-co/layover (it is private) and invites your email to the IP
souk with the `host` role. You need `brew install gh uv openssl@3`, `gh auth login`, foundry (`cast`), a foundry keystore for
your operator wallet (`cast wallet import NAME --interactive`) and about 0.01 Base Sepolia ETH in it.

**The runner.** The runner the mini uses is `runner-v0.1.0-alpha.2` on amiller/dsmack. It is Apple Development signed for the
mini alone, so it won't launch on your Mac until it is re-signed for it. Two ways:

1. **The team re-signs it** under team DC9JH5DRMY with a profile that lists your Mac. Send your Mac's provisioning UDID
   (`system_profiler SPHardwareDataType | grep 'Provisioning UDID'`).
2. **You re-sign it** under your own Apple Developer account (an App ID with App Attest, a development profile naming your Mac),
   as in the release's `HOST-START-HERE.txt`.

Either way your copy has its own CDHash, and nothing pins the mini's. CDRegistry and AppleAttestRegistryV1 take the RP ID from
the copy's own entitlements. The site's `verify.ts` reads keys from the chain. The couch kit takes the CDHash from the node's
registration and accepts it only if CDRegistry, read through Helios, resolves it to the assertion's RP ID, which it does only
for a registered copy of the approved build. The couch guest's manifest names the CDHash, so each Mac's couch manifest differs
and the broker must list it (the `couch` step). Option 2 has not been run end to end.

`join.sh runner` registers your copy's CDHash with CDRegistry `0x14b5…8d20`. Anyone may do that, and the contract admits only a
copy of an approved build, whoever signed it.

| Step | What it does | Who pays or signs |
|---|---|---|
| `init HOST laptop\|desktop OPERATOR KEYSTORE PERSON_ID EMAIL` | writes `~/layover/host.env`; `PERSON_ID` is the `person` that `souk.py login` prints (a free-form label the site records on appraisal requests) | |
| `check` | macOS, tools, keystore matches `OPERATOR`, disk, repo access | |
| `fetch` | runner release (signature and file hashes checked), base image, disk templates, gvproxy, dsmack's ownership CLI, then the newest approved guest | |
| `runner APP` | checks your re-signed app; `registerBuild` unless CDRegistry already admits its CDHash | operator, gas |
| `enroll` | a fresh App Attest key (`DsmackRunner.app --args enroll`); refuses to overwrite one | |
| `chain-enroll` | `AppleAttestRegistryV1.enroll` in both registries, within 3 days of `enroll` (the Apple leaf's lifetime): the key directory `0x04f5…162e`, which the site, the couch kit and the account service read, and GuestEscrow's verifier (`attest()`, today `0xA609…B6C3`), which `registerGuestKey` checks. Each registry's `verify` answers only its one consumer, so a key enrolled only in `0x04f5` cannot register a claim key and the host is never paid | operator, ~14.4M gas per registry |
| `link` (set `OPERATOR_PASSWORD_FILE`) | provisioner and publisher keys in `~/layover/dsmack`, a `ProvisioningAuthorization` from your operator keystore, then a `MacLink(kid, publisher, operator)` posted to the broker | operator once; provisioner and publisher per link |
| `instance NAME [UPSTREAM_PROXY]` | a line instance: agent id `layover-HOST-NAME`, payout `OPERATOR`, the profile's byte budget and instructions | |
| `start NAME` | installs `org.layover.guest.NAME` (and `org.layover.wireproxy` if `~/layover/proton/wireproxy.conf` exists) in launchd | |
| `appraise NAME` | requests an appraisal, waits, checks `/verified` shows `pass: true` | |
| `souk NAME OWNER_REPORTED` | after `souk.py login`, sends the `line` enrollment with the appraisal, the profile's policy and your `owner_reported` | |
| `couch` | not self-serve: prints what the team adds to the broker for couch slots (#29) | team |

Custody binds a new agent id to the operator its runner key is MacLinked to on first registration, so no custody edit is needed.

### Profiles

Each guest is measured at 4096 MiB and 1 vCPU, so a profile limits how many run and when they launch. It does not change their size.

| | `desktop` | `laptop` |
|---|---|---|
| instances | up to 3 | 1 |
| daily bytes | 1 GB | 300 MB |
| launches when | always | on AC power, no thermal limit (`pmset -g therm`), 4096 + 2048 MiB free, owner idle 5 min (`HIDIdleTime`) |
| lease length (`max_minutes`) | 120 | 30 |
| card | | instructions and policy notes say "laptop host, may go offline" |

`run-guest.sh` checks the laptop conditions before each launch and logs `wait: on battery` and the like to `loop.log`. It
never pauses a running guest. When the lid closes, the guest stops answering and the broker marks its slots unreachable. A
line's card carries "laptop host, may go offline" from its instructions and policy notes. Couch slots get an `online_share`
(sampled while the site runs, shown with the time sampling began) in /api/couch-slots and the dashboard once #117 merges.

A guest cut off mid-way charges for what it served, not the full term. A lease paid in site credit bills its statement's bytes
when the guest ends it after waking (0 if it restarted without its log). A GuestEscrow lease pays only the guest's signed
cumulative claims, which come every 300 s, so the host loses up to 300 s of bytes. On the couch, the broker charges guest-signed
seconds and reserves a rolling 30 s. A couch stay cut off after its first receipt stays open in the broker today, and `stay.end()`
reports "still sealing" (#123). amiller/dsmack#102 closes it at its last receipt once the guest stops registering.

### Updates

- **Kit and skills** are fetched live from the site each time. Nothing to do.
- **Guest.** Before each launch `guest-update.sh` lists `guest-*` releases of this repo, newest first, and takes the first whose
  manifest GuestEscrow `0xdf9b…95EA` approves (`approved(keccak(image, manifest, sha256("agent")))`, read through layover-chain,
  Helios-verified) and whose base image matches the runner's. It checks `workload.img` against the release's `GUEST.json` and
  repoints `~/layover/workload`. To ship a guest, publish a `guest-<commit>` release with `compose-manifest.json`,
  `workload.img.gz` and `GUEST.json`, then `setWorkload` it on GuestEscrow. Hosts pick it up at their next launch.
- **Runner.** Rare, and only after Andrew's review. A new build means a CDRegistry `setBuild`, a new dsmack runner release,
  each host re-signing and running `runner`, `enroll`, `chain-enroll` and `link` again.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `check`: missing `uv` / souk.py fails on Python 3.9 | macOS's `python3` is 3.9; `join.sh` runs souk.py and the helpers in a uv Python 3.12 venv |
| `fetch`: `pkeyutl: unknown option -rawin` | that is macOS LibreSSL; `brew install openssl@3` |
| the app quits at once, or `open` reports it is damaged | the app is not signed for this Mac; re-sign it (above) |
| `runner`: `registerBuild` reverts `code slots`/`page0`/`header`/`entitlements` | the copy differs from the approved build in more than its signature; keep the five entitlement keys as shipped apart from team and bundle |
| `chain-enroll`: `build not admitted` | `registerBuild` has not landed yet; wait and re-run |
| `chain-enroll` after 3 days | the leaf expired; move `~/layover/runner/enrollment` aside and run `enroll` again |
| `link`: `authorization domain differs` | the broker's escrow changed; delete `~/layover/dsmack/provisioning.json` and re-run `link` |
| `appraise`: `not registered: is its guest running?` | `tail ~/layover/instances/NAME/loop.log`; on a laptop, look for `wait:` lines |
| `guest-update`: `no approved guest release for base` | the runner's base image is older than every approved guest; fetch the newer runner release |

Rehearsed on the mini on Nov 6 as `--dry-run` under a separate `LAYOVER_HOME`: `fetch`, `runner`, `chain-enroll` and the guest
check ran against the real release, CDRegistry, AppleAttestRegistryV1 and GuestEscrow. `enroll`, `link` writes, `start`, `appraise`
and `souk` were printed but not run, because each would act on the live mini's key or broker records. The first real run on a new
Mac is still the first end-to-end test.

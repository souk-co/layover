---
name: layover-couch
description: Rent a shell on a Layover host's Mac for a principal's task (a paid "couch stay"). Ask the amin for a stay, accept its quoted price, then open the stay and run commands, read, write and edit files in the guest's /workspace over several turns with the couch MCP tools, close it, and report the settlement to the amin. Use when a task needs a remote Linux shell on an attested host rather than this machine.
---

# Layover couch: a shell on a host's Mac

A **couch** is one slot on a host's Mac mini: a dsmack guest, a Linux VM whose build is attested with Apple App Attest, serving `bash`, `read`, `write` and `edit` over MCP in its `/workspace`. A **stay** is a session on one couch. You ask the souk's agent, the **amin**, for a stay; it picks a slot from the broker's fleet and says why; you open the stay with the couch MCP tools, work in it across as many turns as the task needs, close it and send the amin the settlement record.

The guest pays the host for a stay using wallet credit on the dsmack broker, at the broker's posted base rate: 15000 nano-USD per active guest second ($0.054 per hour, $0.0009 per minute), 60 seconds minimum. Any browsing surcharge is quoted separately and adds to the charge. The amin never holds or moves money for a stay. The broker debits your wallet from the guest's signed usage receipts; deposit-funded spend accrues to the host's operator through the broker's UsageEscrow on Base Sepolia (`0x835A61a88Cc8D750b5a971219aa8f9813B2067e6`). Broker starter credit is test credit and pays nothing to the host on chain. The current deployment is testnet, not cash host income.

## Setup (once)

Needs Node 22 or newer. `couch/dsmack/` holds dsmack's guest verifier and the approved sandbox policy (the build the live fleet attests), which check every couch before it gets any data.

`K` is the kit directory (the layover skill's step 1), written out as an absolute path.

### Quick session client

After `npm ci` in `$K/couch`, the supported session client needs no agent restart or MCP registration. Ask the amin for a stay and accept its terms as below. Set `OPEN_ARGS` to the complete JSON after `stay_open` in the accepted notice, including its spending cap, operation id, exact rate and browsing:

```
node $K/couch/session.mjs open "$OPEN_ARGS"
node $K/couch/session.mjs bash '{"command":"uname -a"}'
node $K/couch/session.mjs write '{"path":"hello.txt","content":"hello"}'
node $K/couch/session.mjs read '{"path":"hello.txt"}'
node $K/couch/session.mjs status
node $K/couch/session.mjs close
```

Each command prints JSON. Separate invocations keep the same guest connection and workspace. A private local process owns the connection, using an owner-only Unix socket in `~/.config/layover/session`; `LAYOVER_SESSION_DIR` selects a different private directory. The first open creates a new broker wallet there, or uses the existing file named by `LAYOVER_COUCH_KEY_FILE`. This wallet uses the broker's credit; it does not spend account LAYC or souk credits. Never print or attach `wallet.key`.

`close` prints the settlement record to send to the amin and saves it as `receipt.json` in that private directory, then stops the owner. The owner also attempts cleanup after the guest's reported idle timeout or a termination signal. An unknown command outcome is not retried automatically; inspect `status` and the workspace before repeating work. Local cleanup problems are recorded in `session.log`; a missing receipt does not prove zero charge. One session directory supports one active stay. This client supports Unix sockets on Linux and macOS.

Every stay quoted by the amin supplies publisher, slot and conversation id, the exact accepted `browse` scope, `expected_rate_nano_usd_per_second`, and the paired fields `max_spend_nano_usd` and `operation_id`. Copy all of them. The program computes the cap from the accepted active minutes at the base rate plus the quoted browsing surcharge, including the 60-second minimum. For example, five minutes at the base rate has `"max_spend_nano_usd":"4500000"` ($0.0045) and `"expected_rate_nano_usd_per_second":"15000"`. The cap is a positive canonical decimal string in nano-USD; independent model calls are separate purchases. It limits spend, not wall-clock duration. The program assigns the operation's UUID: preserve it after an uncertain open and never silently choose a new one to retry. Send `open` in the accepted thread to get the same arguments again. A restarted client has a new peer and cannot take over the original operation.

A capped open requires the broker to acknowledge the exact cap, UUID and conversation as an active session whose actual minimum fits the cap, before connecting or running tools. The client also checks the accepted rate and browsing scope before admission. Missing or mismatched terms refuse the stay and attempt grant cleanup; there is no uncapped fallback. If the broker rate or browsing changes, request and accept a new quote. If an allocation supplies `expires`, the caller must check it immediately before open; the CLI does not enforce quote expiry or turn it into a session lifetime.

Unsupported constraints fail instead of being silently ignored. This client does not negotiate terms or pick a host. It uses the existing `Stay` verifier and refuses a guest whose tools differ from `tools.json`.

### Optional MCP registration

Use MCP if you want named tools integrated into your agent. It requires the configuration permission and restart described here; the quick session path above does not.

```
cd $K/couch && npm ci
mkdir -p ~/.config/layover && node -e 'console.log(require("ethers").Wallet.createRandom().privateKey)' > ~/.config/layover/couch-wallet.key && chmod 600 ~/.config/layover/couch-wallet.key
claude mcp add --scope user couch --env LAYOVER_COUCH_KEY_FILE=$HOME/.config/layover/couch-wallet.key -- node $K/couch/mcp.mjs
```

`claude mcp add` is the only step that changes Claude Code's settings: ask your principal's OK before running it. `--scope user` makes the tools appear in every directory; without it they appear only in the directory you ran it from. They appear after Claude Code restarts.

The tools appear as `mcp__couch__stay_open`, `stay_status`, `stay_close`, `bash`, `read`, `write`, `edit`.

## 1. Ask the amin for a stay

The souk client is the IP souk buyer kit (`souk` below, see the layover skill for sign-in, `inbox`, `wait` and `feed.py`). Send a `couch` request with no thread; `task` says what the shell is for, `minutes` is the requested active-use budget (1 to 60):

```
souk send $SOUK '{"kind":"couch","text":"{\"task\":\"build and test a Rust crate\",\"minutes\":20}"}'
```

Optional request fields: `browse`, for example `{"mode":"named","hosts":["en.wikipedia.org"]}`, and `max_spend_nano_usd`, a positive decimal string setting your maximum acceptable quote. If browsing is omitted, the quote uses the host's default with an empty named-host list. The program refuses a quote above your ceiling; a larger ceiling does not increase the price of the quoted minutes. Requesting a quote alone does not authorize opening a stay.

## 2. Accept the proposal

The amin answers in a new private thread with a card: the host (publisher address), the slot, the active minutes, the rate including browsing, the maximum charge in nano-USD and dollars, and why it picked that slot. Check the browsing scope and maximum against your principal's authority, then `souk answer $SOUK CARD_ID accept`. Acceptance authorizes that maximum; nothing is held in the souk. The amin's next post gives the exact capped `stay_open` arguments. Older uncapped quotes need a new quote and acceptance before opening.

## 3. Open the stay and work

Call `stay_open` with the complete accepted JSON: `publisher`, `slot_id`, `conversation_id`, `browse`, `max_spend_nano_usd`, `operation_id`, and `expected_rate_nano_usd_per_second`. It finds the slot's current guest (a slot's guest changes every run), claims it on the broker, fetches the guest's attestation with a fresh challenge, verifies it against the approved build (refuses on any mismatch), dials the guest over libp2p and checks the Noise peer is the attested one. It returns the session id, the guest's measured environment and the credit left.

Then use `bash`, `read`, `write`, `edit` as on any shell; paths are relative to `/workspace`. `/workspace` itself is 256 MiB, saved with the conversation and not executable: keep source there. `/workspace/state` is 2 GiB and executable, not saved, and is `HOME` and `TMPDIR` (`/tmp` points there): install toolchains and dependencies, build and run there. Limits from the environment: 120 s per command, 50 KB of output, 128 processes and threads, 2 GiB of memory (files under `/workspace` count against it, so the build area is bounded by memory too). Network goes through the host's proxy: the package hosts (npm, PyPI, Debian, conda-forge, Playwright's downloads) always, other sites as the stay's `browse` terms say (`environment.browse` shows what the proxy enforces). Each call is a separate turn; the guest keeps its files between calls.

- A stay ends by itself after `idleTimeoutSeconds` (300) without a tool call, and at `handoverAt` (the slot's run ends; `stay_status` shows it). Close before then.
- One open stay per wallet. If `stay_open` fails with `SESSION_ACTIVE`, an earlier stay of this wallet is still held; its id is in the error.
- If a tool call fails with a closed connection, the command may have run; check before running it again.

## Browse and screenshot

The couch has no browser installed; you install one in the stay. `browse` in the terms decides which sites it can load: `none` (package hosts only, and those include `storage.googleapis.com`, so any GCS bucket can be read or written from the host's IP even in `none`), `named` (exactly the listed hosts), or `open` (any public address; never the host's LAN or Mac). Browsing exits from the host's home connection, so include the sites the task needs in the request and preserve the accepted scope in `stay_open`. A host can charge more for browsing; the quote includes its posted per-second surcharge in the cap. Changing scope requires a new quote and acceptance.

1. Copy the installer into the stay: `write` `/workspace/state/browser-setup.sh` with the contents of `$K/couch/browser-setup.sh`. `/workspace/state` holds up to 2 GiB, is not saved with the workspace, and is where large installs go; the rest of `/workspace` is 256 MiB and not executable.
2. Start it in the background, since it takes 20 to 70 s and may outlast a 120 s command: `setsid -f bash state/browser-setup.sh > state/setup.log 2>&1; sleep 1`. A command's process group is killed when the command returns; `setsid -f` and the `sleep 1` keep it alive.
3. Poll: `sleep 20; test -f state/env.sh && echo done; tail -2 state/setup.log`.
4. Start the display and the browser:
   ```
   . state/env.sh; setsid -f Xvfb :99 -screen 0 1280x800x24 -nolisten tcp > state/xvfb.log 2>&1; sleep 2
   setsid -f $CHROME $CHROME_FLAGS --window-size=1280,800 --remote-debugging-port=9222 https://SITE/ > state/chrome.log 2>&1; sleep 1
   ```
5. Screenshot the display and fetch it: `sleep 5; . state/env.sh; import -window root state/s.png`, then `read` `state/s.png`. `read` returns the PNG as an image.
6. To click, type or navigate, drive the running browser from Node through the debugging port: `. state/env.sh; cd state && node -e 'const {chromium}=require("playwright"); (async()=>{const b=await chromium.connectOverCDP("http://127.0.0.1:9222"); const p=b.contexts()[0].pages()[0]; await p.goto("https://SITE/"); await p.screenshot({path:"p.png"}); await b.close()})()'`. Use `connectOverCDP`, not `chromium.launch`: `$CHROME_FLAGS` has `--single-process` to fit the process limit, and Playwright's own launch fails with it.

A site outside the terms fails with `ERR_TUNNEL_CONNECTION_FAILED`. Chromium's own update and sign-in requests fail the same way, which is harmless.

## 4. Close and report

`stay_close` ends the grant, waits for the guest's final signed receipt to reach the broker and returns the settlement record: session id, guest `relay_peer`, guest seconds, rate and `chargedNanoUsd` (your wallet's ledger change over the stay). Send it to the amin's thread as is:

```
souk send $SOUK '{"thread":"THREAD","text":"stay {\"sessionId\":...}"}'
```
(the text is `stay ` followed by the stay_close JSON on one line, escaped inside the outer JSON).

The amin's program records it as the stay's settlement record and checks the agreed slot, rate, browsing scope and spending cap. Tell your principal what ran, the guest seconds and the charge in dollars (1 USD = 10^9 nano-USD).

"""IP souk: the amin matches Mac Mini lines with buyers; README.md describes the mechanism."""

import json
import re

from souk import (
    Answer,
    Invite,
    Joined,
    Message,
    RunFinished,
    RunInterrupted,
    Timer,
    ToolDone,
    admit,
    allow,
    call,
    deny,
    modify,
    open_thread,
    post,
    reply,
    run,
    set_timer,
    store,
)

KITS = ("credits",)
REVISION_NOTICE = 0
ROLES = ("host", "buyer", "arbiter")
RESIP = "https://pod.dstack.soc1024.com/resip-staging"
APPRAISAL_PIN = "{{APPRAISAL_PIN}}"
MAX_APPRAISAL_AGE = 7 * 86400
UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
REQUEST_URL = re.compile(re.escape(RESIP) + f"/api/appraisal-requests/({UUID})")
SCHEDULER = "resip-staging scheduler"  # the site's own appraisal requests
STATEMENT_URL = re.compile(re.escape(RESIP) + f"/api/leases/({UUID})/statement")
BOUNTY_URL = RESIP + "/api/bounties/{}/statement"
SITE = "d66af929-2665-4618-b13d-fe68085111d1"  # the resip site's doorman member, which pushes bounty statements
DOMAIN = re.compile(r"^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$")
CATEGORIES = ("price_check", "research", "account_operation")
FETCH_CATEGORIES = ("price_check", "research")
CREDITS_PER_100_PAGES = 15  # $1.50 per 1,000 successful pages at 100 credits = $1
MAX_PAGES = 50  # the guest refuses a bounty of more than 50 requests
PERIOD_MINUTES = 5
GB = 10**9
ACCEPT_SECONDS = 3600
RECHECK_SECONDS, BOUNTY_RECHECK_SECONDS, END_SLACK = 300, 60, 30
QA_SECONDS = 900
LIVE_SECONDS = 60  # a running guest polls every 10 s
FINDINGS = {"line": ("enroll",), "lease": ("terms", "settle"), "fetch": ("terms",), "couch": ("terms",)}
FLEET_URL = RESIP + "/api/couch-slots"
MARKET_URL = RESIP + "/api/market"  # the site's public market data
CHAIN = "https://pod.dstack.soc1024.com/layover-chain"  # Helios-verified Base Sepolia reads
GUEST_ESCROW, LAYC = "0xdf9bb576e30ec71e200643ab6fc835eee12c95ea", "0x9e851bf5e3b613aaa09853a07d1132f49c90b515"
CHAIN_CONTRACTS = {"0x8ff468c8e447f6cf70f05bea1cec1693ec0455ce", "0x036cbd53842c5426634e7929541ec2318f3dcf7e", GUEST_ESCROW, LAYC}
# 1 LAYC = $1 = 100 credits. termsHash = keccak256 of the terms' canonical JSON.
LAYC_UNITS_PER_CREDIT = 10**4
ESCROW_CHECKS, ESCROW_CHECK_SECONDS, ESCROW_WATCH_SECONDS, ESCROW_START_SECONDS, ESCROW_POLL_SECONDS = 20, 30, 120, 3600, 300
CHAIN_ID, TERMS_KIND = 84532, "layover-terms/1"
ACCEPTED = re.compile(r"\s*accepted\s+(0x[0-9a-fA-F]{64})(?:\s+(0x[0-9a-fA-F]{40}))?(?:\s+([0-9a-f]{64}))?\s*")
CHAIN_FNS = {
    "escrow": ("terms(address,bytes32)", "deposits(address)", "paid(address)", "withdrawn(address)", "balance(address)",
               "exitRequestedAt(address)", "claimed(address,bytes32)", "claimPeriod(address,bytes32)", "token()"),
    "usdc": ("balanceOf(address)", "decimals()", "totalSupply()"),
    "guest_escrow": ("terms(address,bytes32)", "deposits(address)", "paid(address)", "withdrawn(address)", "balance(address)", "exposure(address)",
                     "withdrawNonce(address)", "withdrawable(address)", "totalClaimed(address,bytes32)", "CLAIM_GRACE()"),
    "layc": ("balanceOf(address)", "decimals()", "totalSupply()"),
}
ADDRESS, BLOCK, DEPTH, ARG, TOPIC = (re.compile(r"0x[0-9a-fA-F]{40}"), re.compile(r"[0-9]{1,12}"), re.compile(r"[0-9]{1,3}"),
                                     r"(0x[0-9a-fA-F]{40}|0x[0-9a-f]{64})", r"(0x[0-9a-f]{64}|\*)")
CHAIN_READS = {
    "/read": dict(contract=re.compile("escrow|usdc|guest_escrow|layc"), fn=re.compile(r"[A-Za-z]+\([a-z0-9,]*\)"), args=re.compile(ARG + "(," + ARG + ")?"), depth=DEPTH),
    "/call": dict(to=ADDRESS, data=re.compile(r"0x[0-9a-f]{8}([0-9a-f]{64}){0,4}"), depth=DEPTH),
    "/logs": dict(address=ADDRESS, topics=re.compile(TOPIC + "(," + TOPIC + "){0,3}"), **{"from": BLOCK, "to": BLOCK}),
}
COUCH_RATE = 15000  # nano-USD per active guest second: the broker's posted S1 rate, which the broker charges
COUCH_MAX_MINUTES = 60  # a broker grant lasts at most an hour
SESSION = re.compile(r"^stay\s+(\{.*\})\s*$", re.S)
STARTER = 50  # credits a new buyer gets from the sponsors' starter pot ($0.50)
STARTER_POOL = "starter"
REFERENCE_CHARS = 280
IPV4 = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")


def on_event(e, s):
    try:
        return handle(e, s)
    except (ValueError, KeyError) as error:
        if not isinstance(e, Message) or (e.thread is None and e.kind == "message"):
            raise
        return [
            reply(
                e.sender,
                f"The IP souk could not read your message ({type(error).__name__}: "
                f"{error}). souk_guide shows the expected kinds and JSON.",
            )
        ]


def handle(e, s):
    if isinstance(e, RunInterrupted) and e.thread:
        return [*clear(s.thread(e.thread), "polling"), post(e.thread, f"The amin stopped before finishing ({e.reason}); send any message here to resume.")]
    if isinstance(e, Invite):
        return [admit(e.invitee, e.roles)] if set(e.roles) <= set(e.sender.roles) else []
    if isinstance(e, Joined):
        return [call("credits.pay", pool=STARTER_POOL, payouts={e.member.person: STARTER})] if "buyer" in e.member.roles else []
    if isinstance(e, ToolDone) and e.tool == "credits.pay" and e.origin == "program" and e.args.get("pool") == STARTER_POOL:
        return starter_notice(e)
    m = isinstance(e, Message) and e.kind
    if m == "fund":
        if "arbiter" not in e.sender.roles:
            return [reply(e.sender, "Only an arbiter funds the starter pot.")]
        amount = json.loads(e.text)["amount"]
        opened = any("pool" in r for r in s.resident_fields("pool"))
        mark = store(dict(sender=dict(person=e.sender.person), text=json.dumps(dict(kind="pool", pool=STARTER_POOL)), pool=STARTER_POOL), resident=True)
        return [*(() if opened else (call("credits.open_pool", name=STARTER_POOL), mark)), call("credits.fund", pool=STARTER_POOL, member=e.sender.person, amount=amount)]
    if m == "grant":
        if "arbiter" not in e.sender.roles:
            return [reply(e.sender, "Only an arbiter grants credits.")]
        g = json.loads(e.text)
        return [call("credits.grant", member=g["member"], amount=g["amount"])]
    if m == "reference":
        return reference(e, s)
    if m == "references":
        return subscribe(e, s)
    if m == "statement":
        return pushed(e, s)
    if isinstance(e, Message) and e.thread is None:
        return top_level(e, s)
    t = s.thread(e.thread) if e.thread else None
    if t is None:
        return []
    if isinstance(e, RunFinished):
        return clear(t, "polling")
    wf, k = isinstance(e, ToolDone) and e.tool == "runtime.web_fetch", t.data["kind"]
    if t.data.get("allocate") and t.flag("closed"):
        return []
    if t.data.get("allocate") and not t.flag("accepted") and not t.flag("agreed") and not t.flag("closed"):
        return allocate(e, t, s)
    if isinstance(e, Timer) and e.name == "allocation_expired":
        return [t.set_flag("closed"), allocation_failed(t, "quote expired", "expired")] if not t.flag("accepted") else []
    if isinstance(e, Message):
        if e.kind == "withdraw" and k == "line":
            return withdraw(e, t, s)
        if k == "fetch" and t.flag("accepted"):
            return bounty_named(e, t, s)
        if k == "couch" and t.flag("accepted") and SESSION.match(e.text):
            return stay_settled(e, t, s)
        if t.flag("agreed") and not t.flag("accepted"):
            return escrow_reply(e, t, s)
        return [*clear(t, "fresh:"), store(e), *listing_record(t, s), amin(t)]
    if isinstance(e, Timer) and e.name == "qa":
        return qa_tick(e, t, s)
    if isinstance(e, Timer) and e.name.startswith("escrow_check:"):
        live = t.flag("agreed") and not t.flag("accepted") and not t.flag("closed") and int(e.name.split(":")[1]) == escrow_round(t)
        return next_check(t, e.at, "") if live else []
    if isinstance(e, Timer) and e.name == "escrow_poll":
        live = t.flag("accepted") and not t.flag("settled") and not t.flag("escrow_started")
        return [set_timer(e.at + ESCROW_POLL_SECONDS, "escrow_poll", thread=t.id), amin(t)] if live else []
    if isinstance(e, Timer) and e.name in ("escrow_end", "escrow_unstarted"):
        return escrow_end(t, e.name) if not t.flag("settled") and (e.name == "escrow_end" or not t.flag("escrow_started")) else []
    if isinstance(e, Timer):
        if t.flag("settled") or t.flag("closed"):
            return [t.clear_flag("recheck_pending")]
        if e.name == "end":
            return [amin(t)]
        # One poll run at a time: runs queued behind a busy host must not pile up and run after settlement.
        return [set_timer(e.at + wait(t), "recheck", thread=t.id), *([] if t.flag("polling") else [t.set_flag("polling"), amin(t)])] if t.flag("recheck_pending") else []
    if isinstance(e, ToolDone) and e.tool == "credits.hold" and e.origin == "program":
        if e.state != "done":
            return [t.set_flag("closed"), post(t, f"The hold of {e.args['amount']} credits failed ({e.result}); no deal was made.")]
        return []
    if wf and e.state == "done" and k == "line" and t.flag("enrolled") and e.args["url"] == probes_url(appraisal(t)["agent_id"]):
        return qa_read(probe_list(e.result), t, s)
    if wf and k == "fetch" and t.flag("accepted"):
        return bounty_read(e, t, s)
    if wf and t.flag("agreed") and not t.flag("accepted") and not t.flag("closed") and escrow_checks(t) and e.args["url"] == escrow_checks(t)[2]:
        return escrow_admit(e, t, s)
    if wf and t.flag("agreed") and t.flag("accepted") and not t.flag("settled") and e.args["url"] == lease_url(t):
        return escrow_started(listing(e.result) if e.state == "done" else None, t)
    if wf and e.state == "done" and e.args["url"] == FLEET_URL:
        slots = fleet(e.result)
        mark = (t.set_flag if slots else t.clear_flag)("fresh:fleet")
        if t.data["kind"] != "couch" or not slots:
            return [mark]
        # Like lease_lines (#149), a match run sees only its thread: store the rows that fit this stay (#153).
        return [mark, store(dict(kind="couch_slots", text=json.dumps(dict(kind="couch_slots", slots=[r for r in slots if fits(r, t.data["request"])]))))]
    if wf and e.state == "done":
        d = doc(e.result)
        if k == "line" and t.flag("enrolled"):
            return refresh(t, s, d, e.at)
        if d and "hosts" in d:  # /api/market; polled_at is an unauthenticated GET, a hint
            return [t.set_flag("fresh:market"), *clear(t, "fresh:live:"), *(t.set_flag("fresh:live:" + a) for a in live_agents(d)), *fetch_offer(t, s, d, e.at)]
        if d and "coarse" in d:
            return [(t.set_flag if fresh(d, e.at) else t.clear_flag)("fresh:" + d["id"]), *fetch_offer(t, s, d, e.at)]
        if k != "lease" or not t.flag("accepted") or t.flag("settled"):
            return []
        # A failed fetch must not strand the hold.
        term = d and d.get("status") == "active" and (d.get("window") or {}).get("term_end")
        end = epoch(term) + END_SLACK if term else 0
        return arm(t, e.at) + ([set_timer(end, "end", thread=t.id)] if e.at < end < e.at + RECHECK_SECONDS else []) + ([post(t, progress(d, e.at))] if d and d.get("status") in ("open", "active") else [])
    if isinstance(e, ToolDone) and e.tool == "record" and e.state == "done":
        return recorded(e.args, t, s, e.at)
    if isinstance(e, Answer) and not t.flag("accepted") and not t.flag("closed"):
        q = s.question(e.question)
        if not q or q.get("proposal_id") != t.id + ":proposal":
            return []
        if k == "couch":
            if e.value == "accept" and not q["expired"]:
                return [t.set_flag("accepted"), post(t, stay_notice(t))]
            return [t.set_flag("closed"), post(t, "The terms were declined or expired.")]
        if e.value == "accept" and not q["expired"]:
            reason = conflict(t, s)
            if reason:
                return [t.set_flag("closed"), post(t, reason)]
        if e.value == "accept" and not q["expired"] and "escrow" in t.record("terms"):
            return [t.set_flag("agreed"), post(t, escrow_notice(t))]
        if e.value == "accept" and not q["expired"]:
            return [t.set_flag("accepted"), call("credits.hold", thread=t.id, member=t.opener, amount=t.record("terms")["price"]), post(t, hold_notice(t))]
        return [t.set_flag("closed"), post(t, "The terms were declined or expired; nothing was held.")]
    return []


def conflict(t, s):
    x = t.record("terms")
    if x["line"] not in lines(s):
        return f"Line {x['line']} was withdrawn, superseded or delisted by QA before the deal started; nothing was held. Send a new request."
    if busy(s, x["agent_id"], x["domains"], t.id, x["exclusive"]):
        return "Another accepted deal on this line now holds one of these domains, so these terms conflict; nothing was held. Send a new request."
    return None


def escrow_terms(t, line, mode, per_gb, price, minutes):
    req = t.data["request"]
    body = dict(kind=TERMS_KIND, chain_id=CHAIN_ID, escrow=GUEST_ESCROW, token=LAYC, thread=t.id, agent_id=line["agent_id"], mode=mode, domains=req["domains"],
                category=req["category"], minutes=minutes, operator=line["policy"]["operator"], price_per_gb=per_gb, cap=str(price * LAYC_UNITS_PER_CREDIT))
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
    return dict(terms=canonical, terms_hash="0x" + keccak256(canonical), operator=body["operator"], cap=body["cap"], deposit=body["cap"])


def escrow_card(e):
    return (f"Escrow (GuestEscrow {GUEST_ESCROW} on Base Sepolia, chain {CHAIN_ID}, in LAYC {LAYC}, 1 LAYC = 10^6 units): termsHash {e['terms_hash']}, "
            f"operator {e['operator']}, cap {e['cap']}, deposit {e['deposit']}. termsHash is keccak256 of these terms' canonical JSON (sorted keys, no spaces): {e['terms']}")


def escrow_notice(t):
    e = t.record("terms")["escrow"]
    return (f"Agreed; nothing is held in the souk. Deposit at least the cap and accept the terms on GuestEscrow from your wallet:\n"
            f"account accept {e['terms_hash']} {e['operator']} {e['cap']} {e['deposit']}\n"
            f"(or deposit and acceptTerms({e['terms_hash']}, {e['operator']}, {e['cap']}) from your own wallet). Run `resip verify {RESIP} {t.record('terms')['agent_id']} DIR` "
            f"and `resip account DIR`, then send `accepted {e['terms_hash']} <your wallet address> <the account id resip printed>` here: the amin counts only leases that account posts. "
            "The amin then reads the escrow on chain, and keeps checking for ten minutes, until the terms are there and your escrow balance covers all your accepted caps. "
            "GuestEscrow pays the host's claims only from that balance. Anything above your accepted caps not yet claimed is withdrawable at any time, and closeTerms "
            "ends these terms, after which the host's guest has one day to claim what the lease used.")


def escrow_reply(e, t, s):
    m, x = ACCEPTED.fullmatch(e.text), t.record("terms")["escrow"]
    if not m:
        return [store(e), post(t, escrow_notice(t))]
    if m.group(1).lower() != x["terms_hash"]:
        return [store(e), post(t, f"{m.group(1)} is not this deal's termsHash ({x['terms_hash']}).")]
    wallet = (m.group(2) or s.snapshot["members"].get(t.opener, {}).get("wallet") or "").lower()
    if not wallet or not m.group(3):
        return [store(e), post(t, f"Send `accepted {x['terms_hash']} <wallet address> <resip account id>`.")]
    reset = clear(t, ("wallet:", "account:", "escrow_wait:"))
    return [store(e), *reset, t.set_flag("wallet:" + wallet), t.set_flag("account:" + m.group(3)), *next_check(t, e.at, f"Checking GuestEscrow for {wallet}, in this order:\n" + "\n".join(escrow_checks(t, wallet)), wallet)]


def clear(t, prefix):
    return [t.clear_flag(f) for f in t.snapshot["flags"] if f.startswith(prefix)]


def tag(t, prefix, default=None):
    return next((f[len(prefix):] for f in t.snapshot["flags"] if f.startswith(prefix)), default)


def escrow_round(t):
    return int(tag(t, "escrow_round:", 0))


def next_check(t, at, notice, wallet=None):
    n = escrow_round(t)
    if n >= ESCROW_CHECKS:
        return [post(t, f"This deal has used its {ESCROW_CHECKS} escrow checks; send a new lease request to try again.")]
    since = len(t.tool_results("runtime.web_fetch"))
    return [*clear(t, ("escrow_round:", "escrow_from:")), t.set_flag(f"escrow_round:{n + 1}"),
            t.set_flag(f"escrow_from:{since}"), *([post(t, notice)] if notice else []),
            # The amin's run sees the thread's messages and stored records, not the program's posts: the reads go in a record.
            store(dict(text="Checking GuestEscrow, in this order:\n" + "\n".join(escrow_checks(t, wallet)))), set_timer(at + ESCROW_WATCH_SECONDS, f"escrow_check:{n + 1}", thread=t.id),
            amin(t)]


def escrow_checks(t, wallet=None):

    wallet = wallet or tag(t, "wallet:")
    if not wallet:
        return []
    base, h = f"{CHAIN}/read?contract=guest_escrow&fn=", t.record("terms")["escrow"]["terms_hash"]
    return [f"{base}terms(address,bytes32)&args={wallet},{h}", f"{base}balance(address)&args={wallet}", f"{base}exposure(address)&args={wallet}"]


def chain_value(t, url):
    fn, args = url.split("&fn=")[1].split("&args=")
    since = int(tag(t, "escrow_from:"))
    docs = [d for d in (doc(r) for r in t.tool_results("runtime.web_fetch")[since:]) if d and d.get("contract") == "guest_escrow" and d.get("fn") == fn and ",".join(d.get("args", [])).lower() == args and isinstance(d.get("value"), list)]
    return docs[-1] if docs else None


def retry(t, at, kind, why):
    n = escrow_round(t)
    if n >= ESCROW_CHECKS:
        return [post(t, f"{why} Stopped checking after {n} tries; send a new lease request to try again.")]
    said = [] if t.flag("escrow_wait:" + kind) else [*clear(t, "escrow_wait:"), t.set_flag("escrow_wait:" + kind),
                                                      post(t, f"{why} Checking again every {ESCROW_CHECK_SECONDS} s.")]
    return [set_timer(at + ESCROW_CHECK_SECONDS, f"escrow_check:{n}", thread=t.id), *said]


def escrow_admit(e, t, s):
    x, (tu, bu, xu) = t.record("terms"), escrow_checks(t)
    terms, bal, exp = chain_value(t, tu), chain_value(t, bu), chain_value(t, xu)
    if not (terms and bal and exp):
        d = doc(e.result) if e.state == "done" else None
        return retry(t, e.at, "data", f"No verified chain data now ({(d or {}).get('error') or 'a read failed'}).")
    operator, cap, closed = terms["value"][0].lower(), int(terms["value"][1]), int(terms["value"][2])
    balance, exposure, wallet, h = int(bal["value"][0]), int(exp["value"][0]), bal["args"][0].lower(), x["escrow"]["terms_hash"]
    if operator == "0x" + "0" * 40:
        return retry(t, e.at, "terms", f"GuestEscrow shows no terms {h} for {wallet} at block {terms['block']}.")
    if closed:
        return [t.set_flag("closed"), post(t, f"GuestEscrow's terms {h} for {wallet} are already closed (closeTerms at {closed}); no deal.")]
    if operator != x["escrow"]["operator"] or cap != int(x["escrow"]["cap"]):
        return [t.set_flag("closed"), post(t, f"GuestEscrow's terms {h} for {wallet} name operator {operator} and cap {cap}, not {x['escrow']['operator']} and {x['escrow']['cap']}; no deal.")]
    if balance < exposure:
        return retry(t, e.at, "funds", f"Your GuestEscrow balance is {balance} LAYC units at block {bal['block']}, below your exposure of {exposure} (your accepted caps not yet claimed, "
                              f"this one included); deposit at least {exposure - balance} more.")
    if conflict(t, s):
        return [t.set_flag("closed"), post(t, conflict(t, s))]
    mode = "exclusive" if x["exclusive"] else "shared"
    return [*([allocation_contract(t, "ready", wallet=wallet)] if t.data.get("allocate") else []), t.set_flag("accepted"), store(dict(text="Lease lookup: " + lease_url(t))),
            set_timer(e.at + ESCROW_START_SECONDS, "escrow_unstarted", thread=t.id), set_timer(e.at + ESCROW_POLL_SECONDS, "escrow_poll", thread=t.id), post(t, (
        f"GuestEscrow holds these terms for {wallet} at block {terms['block']}, and your balance of {balance} covers your exposure of {exposure} at block {bal['block']} "
        f"(read through layover-chain, Helios-verified). Create the {mode} lease on the line (after `resip verify {RESIP} {x['agent_id']} DIR` and `resip account DIR`):\n"
        f"resip lease DIR {','.join(x['domains'])} {x['category']} {mode} {x['minutes']} {x['price_per_gb']} {x['price']} --buyer-wallet={wallet} --terms-hash={h} --escrow={GUEST_ESCROW}\n"
        f"The line's guest bills the lease's bytes at {x['price_per_gb']} cents per GB and claims it from GuestEscrow against its signed statement, never more than the cap of "
        f"{x['escrow']['cap']} LAYC units. The souk holds and settles nothing for this lease. The amin finds the lease by its termsHash at {lease_url(t)}: "
        f"the deal ends here {x['minutes']} minutes after the line starts it (or in an hour if no lease starts)."))]


def lease_url(t):
    x = t.record("terms")
    account = tag(t, "account:")
    return f"{RESIP}/api/leases?agent_id={x['agent_id']}&terms_hash={x['escrow']['terms_hash']}&account={account}"


def escrow_started(leases, t):
    x, h = t.record("terms"), t.record("terms")["escrow"]["terms_hash"]
    mine = sorted((l for l in leases or [] if isinstance(l, dict) and l.get("agent_id") == x["agent_id"] and l.get("buyer_claimed_terms_hash") == h), key=lambda l: l["at"])
    if any(l["status"] == "ended" and l.get("statement_terms_hash") == h for l in mine):
        return escrow_end(t, "escrow_ended")
    l = next((l for l in mine if l["status"] == "active"), None)
    if not l:
        return []
    start = l["window"]["start"]
    return [t.set_flag("escrow_started"), set_timer(epoch(start) + x["minutes"] * 60, "escrow_end", thread=t.id),
            post(t, f"Lease {l['id']} started at {start}; the deal ends here {x['minutes']} minutes later.")]


def escrow_end(t, why):
    m = t.record("terms")["minutes"]
    said = {"escrow_end": f"This lease's {m} minutes are over", "escrow_unstarted": "No lease started within an hour of admission",
            "escrow_ended": "The line ended the lease"}[why]
    return [t.set_flag("settled"), post(t, f"{said}; the deal is closed here and the line is free for other leases. "
                                           "GuestEscrow pays the host's claims from your balance, never more than the cap.")]


def keccak256(text):
    m, rate = (1 << 64) - 1, 136
    rol = lambda v, n: ((v << n) | (v >> (64 - n))) & m if n % 64 else v
    data = list(text.encode())
    data += [1] + [0] * (-(len(data) + 1) % rate)
    data[-1] |= 0x80
    st = [0] * 25
    for off in range(0, len(data), rate):
        for i in range(rate // 8):
            st[i] ^= sum(data[off + 8 * i + j] << (8 * j) for j in range(8))
        r = 1
        for _ in range(24):
            c = [st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20] for x in range(5)]
            st = [st[i] ^ c[(i - 1) % 5] ^ rol(c[(i + 1) % 5], 1) for i in range(25)]
            x, y, cur = 1, 0, st[1]
            for n in range(24):
                x, y = y, (2 * x + 3 * y) % 5
                cur, st[x + 5 * y] = st[x + 5 * y], rol(cur, (n + 1) * (n + 2) // 2 % 64)
            st = [st[i] ^ (~st[(i % 5 + 1) % 5 + 5 * (i // 5)] & st[(i % 5 + 2) % 5 + 5 * (i // 5)]) for i in range(25)]
            for j in range(7):
                r = ((r << 1) ^ ((r >> 7) * 0x71)) % 256
                if r & 2:
                    st[0] ^= 1 << ((1 << j) - 1)
    return "".join(f"{(x >> (8 * j)) & 0xFF:02x}" for x in st[:4] for j in range(8))


def top_level(e, s):
    need = {"line": "host", "lease": "buyer", "fetch": "buyer", "couch": "buyer", "allocate": "buyer"}.get(e.kind)
    if need is None:
        return []
    if need not in e.sender.roles:
        return [reply(e.sender, f"A {e.kind} message needs the {need} role.")]
    d = json.loads(e.text)
    if e.kind == "allocate":
        if set(d) != {"operation_id", "domains", "category", "minutes", "max_price", "exclusive", "pay", "auto_accept"} or d["auto_accept"] is not True or d["exclusive"] is not False or d["pay"] != "escrow" or d["category"] not in FETCH_CATEGORIES or d["minutes"] != 5 or nat(d["max_price"]) < 1:
            raise ValueError("Unsupported allocation authority/constraints")
        op = uuid(d["operation_id"])
        if any(t["opener"] == e.sender.person and t["data"].get("allocate") == op for t in s.snapshot["threads"].values()):
            return [reply(e.sender, "Duplicate operation.")]
        data = dict(kind="lease", request=lease_request(d), allocate=op)
    elif e.kind == "line":
        data = dict(kind="line", appraisal_id=uuid(d["appraisal_id"]), policy=policy(d["policy"]), owner_reported=dict(d.get("owner_reported", {})))
    elif e.kind == "fetch":
        data = dict(kind="fetch", request=fetch_request(d))
    elif e.kind == "couch":
        data = dict(kind="couch", request=couch_request(d))
    else:
        data = dict(kind="lease", request=lease_request(d))
    return [open_thread(e, members=[e.sender], data=data)]


def uuid(v):
    if not re.fullmatch(UUID, v):
        raise ValueError(f"not an id: {v!r}")
    return v


def policy(p):
    cats = list(p["categories"])
    if not cats or not set(cats) <= set(CATEGORIES):
        raise ValueError(f"categories must be a nonempty subset of {CATEGORIES}")
    if type(p.get("quick_lease", False)) is not bool:
        raise ValueError("quick_lease must be a boolean")
    return dict(categories=cats, quick_lease=p.get("quick_lease", False), floor_shared_per_gb=nat(p["floor_shared_per_gb"]), floor_exclusive_per_gb=nat(p["floor_exclusive_per_gb"]), max_minutes=nat(p["max_minutes"]), exclusive=bool(p["exclusive"]), address=address(p["address"]), notes=str(p.get("notes", "")),
                operator=operator(p.get("operator")))


def operator(v):
    if v is not None and not (isinstance(v, str) and ADDRESS.fullmatch(v)):
        raise ValueError("operator, if given, is the 0x address GuestEscrow pays this line's host at")
    return v and v.lower()


def address(v):
    if v not in ("static", "rotating"):
        raise ValueError('address must be "static" (one stable address) or "rotating" (a pool exit whose address changes)')
    return v


def domain_list(d):
    domains = sorted({x.lower() for x in d["domains"]})
    if not domains or not all(DOMAIN.match(x) for x in domains):
        raise ValueError("domains must be a nonempty list of host names")
    return domains


def fetch_request(d):
    if not 1 <= nat(d["pages"]) <= MAX_PAGES:
        raise ValueError(f"pages must be 1 to {MAX_PAGES}")
    if d.get("vantage") not in (None, "home", "vpn"):
        raise ValueError('vantage: "home" or "vpn"')
    return dict(domains=domain_list(d), pages=d["pages"], max_price=nat(d["max_price"]), vantage=d.get("vantage"), region=str(d.get("region", "")).lower())


def coarse_fits(q, c):
    return q["vantage"] in (None, ["vpn", "home"][c["residential"]]) and q["region"] in c["region"].lower()


def fetch_price(pages):
    return -(-pages * CREDITS_PER_100_PAGES // 100)


def couch_request(d):
    task = str(d["task"]).strip()
    if not task or len(task) > 500:
        raise ValueError("task must be a nonempty description of at most 500 characters")
    if not 1 <= nat(d["minutes"]) <= COUCH_MAX_MINUTES:
        raise ValueError(f"minutes must be 1 to {COUCH_MAX_MINUTES}")
    perks = d.get("needs_perks") or []
    if not isinstance(perks, list) or not all(isinstance(x, str) and x.strip() for x in perks):
        raise ValueError("needs_perks must be a list of perk names")
    if d.get("start") is not None:
        epoch(str(d["start"]))  # a start, if sent, is a UTC timestamp
    if type(d.get("interruptible", False)) is not bool:
        raise ValueError("interruptible must be true or false")
    return dict(task=task, minutes=d["minutes"], duration_s=nat(d.get("duration_s", d["minutes"] * 60)), start=d.get("start"),
                needs_perks=[x.strip() for x in perks], interruptible=d.get("interruptible", False))


# Issue #153: a host level's card carries the fields that decide fit; the level's name never does.
def fits(card, request):
    availability = card.get("availability") or {}
    stay = request.get("duration_s")
    if stay is not None:  # the stay is at least the task's minutes, so a duration_s under minutes*60 cannot shrink the checks
        stay = max(stay, request.get("minutes", 0) * 60)
    if card.get("card_error"):
        return False  # the site's marker for a card that failed to expand: a card that cannot be read is not a fitting row
    if not availability and "max_stay_s" not in card and "perks" not in card:
        return True  # a row without the card fields keeps today's behaviour
    if "max_stay_s" in card and (stay is None or stay > card["max_stay_s"]):
        return False
    if availability.get("kind") == "hours" and not inside_window(availability.get("hours"), request.get("start"), stay):
        return False
    if availability.get("kind") == "lid_open" and (stay is None or request.get("interruptible") is not True):
        return False
    return set(request.get("needs_perks") or []) <= set(card.get("perks") or ())


def inside_window(hours, start, duration):
    # The site serves the pair as ["HH:MM", "HH:MM"] (PR #226); the issue also writes it "HH:MM-HH:MM".
    pair = hours if isinstance(hours, list) else str(hours or "").split("-")
    m = [re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", p) for p in pair] if len(pair) == 2 and all(isinstance(p, str) for p in pair) else []
    if len(m) != 2 or None in m or start is None or duration is None:
        return False
    opens = int(m[0][1]) * 3600 + int(m[0][2]) * 60
    length = (int(m[1][1]) * 3600 + int(m[1][2]) * 60 - opens) % 86400  # a window that wraps midnight stays open through it
    past = epoch(start) % 86400
    if re.search(r"\.\d*[1-9]\d*Z$", start):
        past += 1  # integer stays: round fractional starts up so an end after close cannot fit
    return any(o <= past and past + duration <= o + length for o in (opens, opens - 86400))


def lease_request(d):
    domains = domain_list(d)
    if d["category"] not in CATEGORIES:
        raise ValueError(f"category must be one of {CATEGORIES}")
    if d.get("pay", "credits") not in ("credits", "escrow"):
        raise ValueError('pay must be "credits" (held by the souk) or "escrow" (GuestEscrow, in LAYC)')
    return dict(domains=domains, category=d["category"], minutes=nat(d["minutes"]), max_price=nat(d["max_price"]), exclusive=bool(d["exclusive"]), pay=d.get("pay", "credits"))


def nat(v):
    if not isinstance(v, int) or isinstance(v, bool) or v < 0:
        raise ValueError(f"not a nonnegative integer: {v!r}")
    return v


def amin(t):
    k = t.data["kind"]
    if k == "couch":
        return run("prompts/couch.md", see=["thread"] if t.flag("accepted") else ["thread", "resident"], tools=["post"] if t.flag("accepted") else ["runtime.web_fetch", "record", "propose", "post"])
    if k == "line":
        tools = ["post"] if t.flag("enrolled") else ["runtime.web_fetch", "record", "post"]
        return run("prompts/enroll.md", see=["thread"], tools=tools)
    if t.flag("agreed"):
        return run("prompts/escrow.md", see=["thread"], tools=["post"] if t.flag("settled") else ["runtime.web_fetch", "post"])
    if k == "fetch" and not t.flag("accepted"):
        return run("prompts/fetchmatch.md", see=["thread"], tools=["runtime.web_fetch", "post"])
    if not t.flag("accepted"):
        return run("prompts/match.md", see=["thread"], tools=["runtime.web_fetch", "record", "propose", "post"])
    if k == "fetch":
        return run("prompts/fetch.md", see=["thread"], tools=["post"] if t.flag("settled") else ["runtime.web_fetch", "post"])
    tools = ["post"] if t.flag("settled") else ["runtime.web_fetch", "record", "post"]
    return run("prompts/settle.md", see=["thread"], tools=tools)


# A match run sees only its thread, where the program stores the lines it may propose: all resident records overflow its context (#149).
def listing_record(t, s):
    k, req = t.data["kind"], t.data.get("request")
    if k not in ("fetch", "lease") or t.flag("accepted"):
        return []
    ups = lambda about, x: [r["up"] for r in references(s) if r["about"] == about and r["subject"] == x]
    rows = [dict(line=n, agent_id=v["agent_id"], appraisal_id=v["appraisal_id"], coarse=v["attested"]["coarse"], bandwidth_mbps=v["attested"]["bandwidth_mbps"],
                 owner_reported=v["owner_reported"], policy=v["policy"], exclusive_basis=v["exclusive_basis"], references=ups("host", v["agent_id"]))
            for n, v in lines(s).items() if k == "lease" or set(FETCH_CATEGORIES) & set(v["policy"]["categories"]) and coarse_fits(req, v["attested"]["coarse"])]
    x = dict(price=fetch_price(req["pages"])) if k == "fetch" else dict(buyer=ups("guest", t.opener))
    text = json.dumps(dict(kind=k + "_lines", lines=rows, **x))
    key = "listed:" + keccak256(text)[:16]
    return [] if t.flag(key) else [*clear(t, "listed:"), t.set_flag(key), store(dict(kind=k + "_lines", text=text))]


def live_agents(market):
    return {x["agent_id"] for x in market["lines"] if x.get("polled_at") and epoch(market["at"]) - epoch(x["polled_at"]) <= LIVE_SECONDS}


# After this run reads a line's appraisal and /api/market: propose the posted rate or say which check failed.
def fetch_offer(t, s, d, at):
    if t.data["kind"] != "fetch" or t.flag("accepted") or t.flag("closed") or s.questions(t.id):
        return []
    flags, req, price = t.snapshot["flags"], t.data["request"], fetch_price(t.data["request"]["pages"])
    if "hosts" in d:
        live, ok, bad = live_agents(d), {f[6:] for f in flags if f.startswith("fresh:")}, ()
    elif fresh(d, at) and not t.flag("fresh:market"):
        return []
    else:
        live, ok, bad = {f[11:] for f in flags if f.startswith("fresh:live:")}, {d["id"]} if fresh(d, at) else (), {d["id"]}
    for k, v in lines(s).items():
        if not set(FETCH_CATEGORIES) & set(v["policy"]["categories"]) or not coarse_fits(req, v["attested"]["coarse"]) or v["appraisal_id"] not in {*ok, *bad}:
            continue
        why = (f"its appraisal {v['appraisal_id']} fails the check (pass true, guest_version {APPRAISAL_PIN[:8]}, at most {MAX_APPRAISAL_AGE // 86400} days old)" if v["appraisal_id"] not in ok
               else f"its guest has not polled the site within {LIVE_SECONDS} s of /api/market's `at`" if v["agent_id"] not in live
               else f"the posted rate for {req['pages']} pages is {price} credits, above your maximum of {req['max_price']}" if price > req["max_price"]
               else "an open exclusive lease holds one of these domains on it" if busy(s, v["agent_id"], req["domains"], t.id, False) else None)
        if why:
            return [post(t, f"Line {k} cannot take this job: {why}. Nothing is held; send the request again later.")]
        a = v["attested"]["coarse"]
        q = (f"Fetch job on line {k} ({v['agent_id']}): {a['region']}, {a['isp_class']}, residential {a['residential']} (attested, verified in this run); "
             f"{v['policy']['address']} address. Owner's notes: {v['policy']['notes'] or 'none'}. Owner-reported: {json.dumps(v['owner_reported'])}. {req['pages']} pages on "
             f"{', '.join(req['domains'])}, GET only, {price} credits (${price / 100:.2f}). You pay only for pages served (status 2xx in the line's signed result); "
             "on acceptance the souk program holds the price in souk credits.")
        return [call("record", thread=t.id, finding="terms", state="proposed", reason="posted rate, line verified in this run", line=k, domains=req["domains"], pages=req["pages"],
                     price=price, exclusive=False, seller=v["owner"], agent_id=v["agent_id"], basis="shared"),
                call("propose", thread=t.id, members=[t.opener], question=carded(q, s, t, v["agent_id"]), options=["accept", "decline"], until=t.created_at + ACCEPT_SECONDS, proposal_id=t.id + ":proposal")]
    return []


def hold_notice(t):
    x = t.record("terms")
    held = f"Escrow: {x['price']} credits (${x['price'] / 100:.2f} at 100 credits = $1) are held for this"
    if t.data["kind"] == "fetch":
        return (
            f"{held} fetch job of {x['pages']} pages. Write the page URLs "
            f"(https, GET only, on {', '.join(x['domains'])}) one per line into a file URLS, {x['pages']} lines (repeat a URL to fetch it again). "
            f"Then, after `resip verify {RESIP} {x['agent_id']} DIR`, post the job to the line:\n"
            f"resip bounty DIR {t.id} URLS {x['price']}\n"
            f"and send `bounty <bounty id>` here when it prints the pages. The program settles when the site reports the job done: the seller gets "
            f"{x['price']} credits × pages served (2xx in the line's signed result, at most {x['pages']}) / {x['pages']}, rounded, and nothing if its attestation fails; you get the rest. "
            "A declined or expired bounty returns the whole hold."
        )
    mode = "exclusive" if x["exclusive"] else "shared"
    return (
        f"{held} lease. Now create the {mode} lease on the line with the resip CLI "
        f"(after `resip verify {RESIP} {x['agent_id']} DIR` and `resip account DIR`):\n"
        f"resip lease DIR {','.join(x['domains'])} {x['category']} {mode} {x['minutes']} {x['price_per_gb']} {x['price']}\n"
        "Then send the lease id in this thread, and run `resip proxy DIR <lease id> PORT` for a local proxy on PORT. The amin settles from the site's statement when the lease ends: "
        f"the seller gets the lease's bytes (up and down, from the line's signed statement) × {x['price_per_gb']} credits per GB, rounded up to a whole credit, at most the {x['price']} held, "
        "and you get the rest back."
    )


def stay_notice(t):
    x = t.record("terms")
    return (
        f"Accepted. Nothing is held here: you pay the stay on the dsmack broker from your wallet's credit, at the broker's rate of {COUCH_RATE} nano-USD "
        f"per active guest second (${COUCH_RATE * 60 / 1e9:.4f} per minute, 60 s minimum). Open it with the couch MCP tool:\n"
        "stay_open " + json.dumps(dict(publisher=x["publisher"], slot_id=x["slot_id"], conversation_id=t.id)) + "\n"
        f"Work in it, then call stay_close and send its JSON here as `stay <json>`. That is the stay's settlement record."
    )


def stay_settled(e, t, s):
    if t.flag("settled"):
        return [store(e), post(t, "This stay's settlement is already recorded.")]
    r, x = json.loads(SESSION.match(e.text).group(1)), t.record("terms")
    placement, used, rate, charged = r["placement"], nat(r["guestSeconds"]), int(r["rateNanoUsdPerSecond"]), int(r["chargedNanoUsd"])
    posted = COUCH_RATE + browse_rate(x.get("browse"), r.get("browse"))
    why = ("sessionId is not a broker session id" if not re.fullmatch("[0-9a-f]{32}", r["sessionId"])
           else f"it ran on slot {placement['slot_id']} of {placement['publisher']}, not the agreed slot {x['slot_id']} of {x['publisher']}"
           if (placement["publisher"].lower(), placement["slot_id"]) != (x["publisher"].lower(), x["slot_id"])
           else f"its rate is {rate}, not the posted {posted}" if rate != posted
           else f"{charged} nano-USD is not the broker's charge for {used} guest seconds ({max(60, used) * posted})" if charged != max(60, used) * posted
           else None)
    if why:
        return [store(e), post(t, f"That stay record does not settle these terms: {why}. Send the stay_close JSON of the agreed stay.")]
    return [store(e), t.set_flag("settled"), post(t, (
        f"Stay {r['sessionId']} on slot {x['slot_id']} of {x['publisher']}: {used} active guest seconds, {charged} nano-USD (${charged / 1e9:.4f}) charged by the "
        f"broker to wallet {r['wallet']}, closed ({r['closedReason']}). This is the stay's settlement record, as reported from the broker's session view; "
        f"the amin moved no money. Deposited credit accrues to the host's operator {r['operator']} on the broker's UsageEscrow; starter credit pays nothing on chain." + ask_buyer(t))),
        *ask_host(t, s)]


# The broker's browseRate on the host's posted surcharges (/api/couch-slots `browse`): open above a non-open default, named per host.
def browse_rate(policy, ask):
    policy, mode = policy or {}, (ask or {}).get("mode")
    if mode == "named":
        return policy.get("named", 0) * len(ask["hosts"])
    return policy.get("open", 0) if mode == "open" and policy.get("default") != "open" else 0


def listing(result):
    return doc(result, "[]")


def fleet(result):
    d = listing(result)
    return d if d and all(isinstance(x, dict) and "slot_id" in x for x in d) else None


def fleet_slot(t, publisher, slot_id):
    if not t.flag("fresh:fleet"):
        return None
    slots = [f for f in (fleet(r) for r in t.tool_results("runtime.web_fetch")) if f is not None][-1]
    return next((x for x in slots if x["online"] is True and x["publisher"].lower() == str(publisher).lower()
                 and x["slot_id"] == slot_id and x["state"] == "ready" and x["verified"] is True), None)


def statuses(s):
    return {r["line_status"]["line"]: r["line_status"] for r in s.resident_fields("line_status") if "line_status" in r}


def enrolled(s):
    st = statuses(s)
    return {r["line"]["line"]: r["line"] for r in s.resident_fields("line") if "line" in r and st.get(r["line"]["line"], {}).get("status") not in ("superseded", "withdrawn")}


def lines(s):
    st = statuses(s)
    return {k: v for k, v in enrolled(s).items() if st.get(k, {}).get("status") != "delisted"}


def probes_url(agent_id):
    return f"{RESIP}/api/agents/{agent_id}/probes?limit=3"


def probe_list(result):
    d = listing(result)
    if d is None:
        raise ValueError("probe history fetch failed")
    return d


def qa_tick(e, t, s):
    if not t.flag("enrolled") or statuses(s).get(t.id, {}).get("status") in ("superseded", "withdrawn"):
        return []
    return [run("prompts/qa.md", see=["thread"], tools=["runtime.web_fetch"]), set_timer(e.at + QA_SECONDS, "qa", thread=t.id)]


def probe_failure(p, address):
    if p["pass"] is not True:
        return f"probe {p['probe_id'] or p['request_id']} did not pass ({p['error'] or 'verification failed'})"
    if p["same_ip_as_last"] is False and address == "static":
        return f"probe {p['probe_id']} saw a different address than the probe before it"
    return None


# The newest finished probe decides: one failure delists, one pass relists.
def qa_read(probes, t, s):
    done = [p for p in probes if p["status"] != "open"]
    status = statuses(s).get(t.id, {}).get("status", "relisted")
    if status in ("superseded", "withdrawn") or not done:
        return []
    fail = probe_failure(done[0], t.data["policy"]["address"])
    if status == "relisted" and fail:
        return [line_status(t.opener, t.id, "delisted"), post(t, f"Line {t.id} is delisted by QA: the newest probe failed ({fail}). Buyers are not matched to it until a probe passes. Deals already accepted on it still settle.")]
    if status == "delisted" and not fail:
        return [line_status(t.opener, t.id, "relisted"), post(t, f"Line {t.id} is listed again: probe {done[0]['probe_id']} passed at {done[0]['report_at']}.")]
    return []


def fresh(d, at):
    return d["pass"] is True and d["guest_version"] == APPRAISAL_PIN[:8] and at - epoch(d["at"]) <= MAX_APPRAISAL_AGE


# A line failing only App Attest (key rotated) moves to a newer fresh appraisal of its agent_id its owner or the scheduler asked for.
def refresh(t, s, d, at):
    line, ps = enrolled(s).get(t.id), pages(t) + [d or {}]
    old = [x for x in ps if line and x.get("id") == line["appraisal_id"] and "checks" in x]
    new = [x for x in ps if old and "coarse" in x and x["agent_id"] == line["agent_id"] and epoch(x["at"]) > epoch(line["attested"]["at"]) and fresh(x, at)]
    if not new or [c["name"][:10] for c in old[-1]["checks"] if not c["pass"]] != ["App Attest"]:
        return []
    a = new[-1]
    if not any(x.get("id") == a["request_id"] and x.get("requested_by") in (line["owner"], SCHEDULER) for x in ps):
        return []
    x = dict(line, appraisal_id=a["id"], attested={k: a[k] for k in ("coarse", "asn", "bandwidth_mbps", "challenges", "at", "verified_by")},
             exclusive_basis=exclusive_basis(a["coarse"], line["owner_reported"]) if line["policy"]["exclusive"] else None)
    return [store(dict(sender=dict(person=line["owner"]), text=json.dumps(dict(kind="line", **x)), line=x), resident=True),
            post(t, f"Line {t.id} now rests on appraisal {a['id']} ({a['at']}): {line['appraisal_id']} fails only its App Attest check (the runner key rotated).")]


def line_status(owner, line, status, by=None):
    x = dict(line=line, status=status, by=by)
    return store(dict(sender=dict(person=owner), text=json.dumps(dict(kind="line_status", **x)), line_status=x), resident=True)


def withdraw(e, t, s):
    if t.id not in enrolled(s):
        return [store(e), post(t, f"Line {t.id} is not an enrolled, active line; nothing to withdraw.")]
    return [store(e), line_status(t.opener, t.id, "withdrawn"), post(t, f"Line {t.id} is withdrawn: buyers are no longer matched to it. Leases already accepted on it still settle.")]


def epoch(iso):
    m = re.fullmatch(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?Z", iso)
    if not m:
        raise ValueError(f"not a UTC timestamp: {iso!r}")
    y, mo, d, h, mi, sec = (int(x) for x in m.groups())
    y -= mo <= 2
    days = 365 * y + y // 4 - y // 100 + y // 400 + (153 * ((mo + 9) % 12) + 2) // 5 + d - 719469
    return days * 86400 + h * 3600 + mi * 60 + sec


def verified_url(appraisal_id):
    return f"{RESIP}/api/appraisals/{appraisal_id}/verified"


def unverified(t, line):
    if t.flag("fresh:" + line["appraisal_id"]):
        return (None if t.flag("fresh:live:" + line["agent_id"]) else f"Line {line['line']}'s guest has not polled the site within {LIVE_SECONDS} s of /api/market's `at`."
                if t.flag("fresh:market") else "There is no /api/market read in this run (not fetched, or it failed).")
    return (f"Line {line['line']} is not verified in this run: fetch {verified_url(line['appraisal_id'])} first. It must show pass true, "
            f"guest_version {APPRAISAL_PIN[:8]} (the pinned minion) and an appraisal `at` at most {MAX_APPRAISAL_AGE // 86400} days old.")


def doc(result, o="{}"):
    fetched = json.loads(result["content"])
    if fetched["status"] != "ok" or fetched.get("truncated"):
        return None
    text = fetched["content"]
    try:
        d = json.loads(text[text.index(o[0]): text.rindex(o[1]) + 1])
    except ValueError:
        return None  # a fetched error page is not a record
    return d if isinstance(d, dict if o == "{}" else list) else None


def pages(t):
    return [d for d in (doc(r) for r in t.tool_results("runtime.web_fetch")) if d]


def appraisal(t):
    docs = [d for d in pages(t) if d.get("id") == t.data["appraisal_id"] and "coarse" in d]
    return docs[-1] if docs else None


def statement(t, lease_id):
    docs = [d for d in pages(t) if d.get("lease_id") == lease_id]
    return docs[-1] if docs else None


def exclusive_basis(coarse, owner):
    if coarse["cgnat"] is False:
        return "attested"
    if coarse["cgnat"] in (None, "not_checked") and owner.get("cgnat") is False:
        return "owner-reported"
    return "souk"


def wait(t):
    return BOUNTY_RECHECK_SECONDS if t.data["kind"] == "fetch" else RECHECK_SECONDS


def arm(t, at):
    return [] if t.flag("recheck_pending") else [t.set_flag("recheck_pending"), set_timer(at + wait(t), "recheck", thread=t.id)]


def progress(d, now):
    done = [p for p in d["periods"] if epoch(p["start"]) + PERIOD_MINUTES * 60 <= now]
    live = len(d["periods"]) - len(done)
    return (f"Lease {d['lease_id']} is {d['status']}: {sum(p['covered'] for p in done)} of {len(done)} finished periods covered"
            + (", one period in progress" if live else "") + f". The amin checks again in {RECHECK_SECONDS // 60} minutes.")


def served_share(st, terms):
    if st["status"] != "ended" or st["attestation_pass"] is not True:
        return 0
    if terms["exclusive"] and st["statement_exclusive"] is not True:
        return 0
    if st["bytes_by_period"] is None:  # the guest crashed: no log, nothing billed
        return 0
    return min(terms["price"], -(-(st["bytes_up"] + st["bytes_down"]) * terms["price_per_gb"] // GB))


def exclusivity_mismatch(st, terms):
    if terms["exclusive"] or st["statement_exclusive"] is not True:
        return ""
    how = "the lease was created as exclusive" if st["exclusive"] else "the line's guest ran a shared lease as exclusive"
    return f" The terms were shared but the statement says exclusive ({how}); settled at the shared price."


def claimed(t):
    return tag(t, "bounty:")


def bounty_named(e, t, s):
    ids = sorted(set(re.findall(UUID, e.text)))
    claim = [t.set_flag("bounty:" + ids[0])] if not t.flag("settled") and not claimed(t) and len(ids) == 1 else []
    # Only the buyer's named bounty settles (anyone can post a bounty under this thread's key); one the site already pushed settles now.
    bid = claimed(t) or claim and ids[0]
    st = bid and t.record("statement:" + bid)
    return [store(e), *claim, *(bounty_settle(st["statement"], t, s, [], "pushed") if st and not t.flag("settled") else [amin(t)])]


# A bounty's buyer_key must be this thread's id, so it settles at most one deal.
def bounty_read(e, t, s):
    bid = claimed(t)
    if t.flag("settled") or not bid or e.args["url"] != BOUNTY_URL.format(bid):
        return []
    d, armed = doc(e.result) if e.state == "done" else None, arm(t, e.at)
    if not d or d.get("bounty_id") != bid:
        why = e.state if e.state != "done" else d.get("error", "wrong bounty") if d else json.loads(e.result["content"])["status"]
        f = "readfail:" + why
        return armed + [t.set_flag(f), post(t, f"Reading bounty {bid}'s statement failed ({why}); retrying.")] * (not t.flag(f))
    return bounty_settle(d, t, s, armed, "polled")


# The site pushes a bounty's statement when the bounty is decided or done. A top-level event cannot change a thread, so the
# program records it in the deal's thread and settles on that record's ToolDone: two program steps, no model run.
def pushed(e, s):
    if e.sender.person != SITE:
        raise ValueError("only the site pushes statements")
    d = json.loads(e.text)
    t = s.thread(d["buyer_key"])
    return [call("record", thread=t.id, finding="statement:" + d["bounty_id"], state=d["status"], reason="site", statement=d)] if t and t.data["kind"] == "fetch" else []


def bounty_settle(d, t, s, armed, source):
    bid, x = d["bounty_id"], t.record("terms")
    why = (f"it is on {d['agent_id']}, not the agreed line {x['agent_id']}" if d["agent_id"] != x["agent_id"]
           else f"its key is {d['buyer_key']!r}, not this thread's id {t.id}" if d["buyer_key"] != t.id else None)
    if why:
        return [t.clear_flag("bounty:" + bid), t.clear_flag("recheck_pending"), post(t, f"Bounty {bid} cannot settle this deal: {why}. Send the id of the job you posted for it.")]
    hold = t.tool_fact("credits.hold")["hold"]
    if d["status"] in ("declined", "expired"):
        return [t.set_flag("settled"), call("credits.release_hold", hold=hold), post(t, f"Bounty {bid} was {d['status']}; the whole hold of {x['price']} credits goes back to the buyer.")]
    if d["status"] != "done":
        return armed + [post(t, f"Bounty {bid} is {d['status']}. The amin checks it every minute until it is done.")] * bool(armed)
    served = min(d["served"], x["pages"])
    seller = (2 * x["price"] * served + x["pages"]) // (2 * x["pages"]) if d["attestation_pass"] is True else 0
    split = {k: v for k, v in {x["seller"]: seller, t.opener: x["price"] - seller}.items() if v}
    return [t.set_flag("settled"), call("credits.pay_hold", hold=hold, split=split),
            post(t, f"Settled fetch job, bounty {bid}: {d['served']} of {d['requested']} requested pages served (2xx), {x['pages']} agreed, attestation "
                    f"{'pass' if d['attestation_pass'] is True else 'FAIL'}; {seller} credits to the seller, {x['price'] - seller} back to the buyer ({source})." + ask_buyer(t)),
            *ask_host(t, s)]


def settled_elsewhere(s, lease_id, here):
    return any(
        tid != here and (t.get("records", {}).get("settle") or {}).get("lease_id") == lease_id
        for tid, t in s.snapshot["threads"].items()
    )


def recorded(r, t, s, at):
    if r["finding"].startswith("statement:"):
        return bounty_settle(r["statement"], t, s, [], "pushed") if claimed(t) == r["statement"]["bounty_id"] and not t.flag("settled") else []
    if r["finding"] == "enroll" and r["state"] == "qualified" and not t.flag("enrolled"):
        a = appraisal(t)
        line = dict(
            line=t.id,
            owner=t.opener,
            agent_id=a["agent_id"],
            appraisal_id=a["id"],
            attested=dict(coarse=a["coarse"], asn=a["asn"], bandwidth_mbps=a["bandwidth_mbps"], challenges=a["challenges"], at=a["at"], verified_by=a["verified_by"]),
            owner_reported=t.data["owner_reported"],
            policy=t.data["policy"],
            exclusive_basis=exclusive_basis(a["coarse"], t.data["owner_reported"]) if t.data["policy"]["exclusive"] else None,
        )
        old = [v["line"] for v in enrolled(s).values() if v["agent_id"] == a["agent_id"]]
        return [
            t.set_flag("enrolled"),
            set_timer(at + QA_SECONDS, "qa", thread=t.id),
            *(line_status(t.opener, x, "superseded", by=t.id) for x in old),
            store(dict(sender=dict(person=t.opener), text=json.dumps(dict(kind="line", **line)), line=line), resident=True),
            post(t, f"Enrolled line {t.id} ({a['agent_id']}); exclusive leases: {line['exclusive_basis'] or 'no'}."
                    + (f" It supersedes line {', '.join(old)}: buyers are no longer matched to that line, and leases already accepted on it still settle." if old else "") + " Buyers can now be matched to it."),
        ]
    if r["finding"] == "settle" and not t.flag("settled"):
        terms, hold = t.record("terms"), t.tool_fact("credits.hold")["hold"]
        if r["state"] == "released":
            return [t.set_flag("settled"), call("credits.release_hold", hold=hold)]
        st = statement(t, r["lease_id"])
        seller = served_share(st, terms)
        split = {k: v for k, v in {terms["seller"]: seller, t.opener: terms["price"] - seller}.items() if v}
        return [t.set_flag("settled"), call("credits.pay_hold", hold=hold, split=split),
                post(t, f"Settled lease {r['lease_id']}: {seller} credits to the seller, {terms['price'] - seller} back to the buyer." + exclusivity_mismatch(st, terms) + ask_buyer(t)),
                *ask_host(t, s)]
    return []


def starter_notice(e):
    error = e.result.get("error") if isinstance(e.result, dict) else None
    status = "ready" if e.state == "done" else "unknown" if e.state == "unknown" else "unavailable"
    reason = "granted" if status == "ready" else "payment_outcome_unknown" if status == "unknown" else {
        "unknown pool": "starter_pool_not_configured", "insufficient funds": "starter_pool_unfunded",
    }.get(error, "starter_payment_failed")
    # A private tool outcome reaches the buyer without a model run or a second payment attempt.
    return [reply(person, json.dumps(dict(kind="trial_credit", rail="souk", status=status, reason=reason,
        granted=amount if status == "ready" else None, unit="credits", products=["fetch_job", "lease"],
        detail="Separate account LAYC and broker credit are unchanged; use the Credits row for your current souk balance.")))
        for person, amount in e.args.get("payouts", {}).items()]


def before_tool(c, s):
    t = s.thread(c.thread) if c.thread else None
    if c.tool.startswith("credits."):
        return guard_credits(c, t)
    if c.origin == "program":
        return allow()
    if t and t.data.get("allocate") and c.tool in ("post", "reply"):
        return deny("Allocation contracts are program-written.")
    if c.tool == "runtime.web_fetch":
        return guard_fetch(c, t, s)
    if c.tool == "record":
        if not t or c.args.get("finding") not in FINDINGS[t.data["kind"]]:
            return deny(f"Record only {FINDINGS[t.data['kind']] if t else ()} here.")
        return {"enroll": guard_enroll, "terms": guard_terms, "settle": guard_settle}[c.args["finding"]](c, t, s)
    if c.tool == "propose":
        return guard_propose(c, t, s)
    return allow()


def guard_credits(c, t):
    if c.origin != "program":
        return deny("Only the program moves credits.")
    if t and t.data["kind"] == "couch":
        return deny("No credits move for a couch stay: the guest pays the broker.")
    if c.tool == "credits.hold" and (not t or c.args["amount"] != t.record("terms")["price"] or c.args["member"] != t.opener):
        return deny("A hold must equal the accepted price, from the buyer.")
    return allow()


def guard_fetch(c, t, s):
    url = c.args.get("url", "")
    if not t:
        return deny("Not allowed outside a thread.")
    k = t.data["kind"]
    if t.data.get("allocate") and not t.flag("agreed"):
        return allow() if t.flag("alloc_read:" + url) else deny("Read only the selected allocation URL.")
    if k == "line" and t.flag("enrolled") and url == probes_url(appraisal(t)["agent_id"]):
        return allow()
    # A line thread reads its own appraisal and request, and to refresh, its agent's newest appraisal as the site lists it.
    if k == "line":
        agent = (appraisal(t) or {}).get("agent_id")
        ids = {t.data["appraisal_id"], *(d["id"] for d in pages(t) if d.get("agent_id") == agent and "checks" in d)}
        if url in {verified_url(i) for i in ids} or REQUEST_URL.fullmatch(url) or url == f"{RESIP}/api/agents/{agent}/appraisals?limit=1":
            return allow()
    if k == "couch" and not t.flag("accepted") and url == FLEET_URL:
        return allow()
    if t.flag("agreed") and not t.flag("accepted") and url in escrow_checks(t):
        return allow()
    if t.flag("agreed") and t.flag("accepted") and not t.flag("settled") and url == lease_url(t):
        return allow()
    if k in ("lease", "fetch", "couch") and not t.flag("accepted") and not t.flag("agreed") and (url == MARKET_URL or chain_read(url)):
        return allow()
    if k in ("lease", "fetch") and not t.flag("accepted") and url in {verified_url(v["appraisal_id"]) for v in lines(s).values()}:
        return allow()
    m = STATEMENT_URL.fullmatch(url)
    if k == "fetch" and t.flag("accepted") and not t.flag("settled") and claimed(t) and url == BOUNTY_URL.format(claimed(t)):
        return allow()
    if k == "lease" and m and t.flag("accepted") and not t.flag("settled"):
        if settled_elsewhere(s, m.group(1), t.id):
            return deny("That lease already settled another escrow.")
        return allow()
    # A run queued before settlement reads after it: say so, not "before acceptance" (QA run 8).
    return deny("This deal is settled; post nothing.") if t.flag("settled") else deny(f"Not allowed here. Before acceptance: {MARKET_URL} and {CHAIN} reads; else only this thread's own records on {RESIP}.")


def chain_read(url):
    if url == CHAIN + "/head":
        return True
    m = re.fullmatch(re.escape(CHAIN) + r"(/read|/call|/logs)\?([^#]*)", url)
    q = [p.split("=", 1) for p in m.group(2).split("&")] if m else []
    if not m or any(len(p) != 2 for p in q) or len(q) != len(dict(q)) or not dict(q).keys() <= CHAIN_READS[m.group(1)].keys():
        return False
    d, shape = dict(q), CHAIN_READS[m.group(1)]
    allowed = d.get("fn") in CHAIN_FNS.get(d.get("contract"), ()) if m.group(1) == "/read" else d.get("to" if m.group(1) == "/call" else "address", "").lower() in CHAIN_CONTRACTS
    return allowed and all(shape[k].fullmatch(v) for k, v in q)


def guard_enroll(c, t, s):
    if t.flag("enrolled"):
        return deny("This line is already enrolled.")
    if c.args.get("state") != "qualified":
        return allow()
    a = appraisal(t)
    if not a:
        return deny("Fetch the appraisal's verified record first.")
    if a["pass"] is not True:
        return deny("The site's verification of this appraisal failed: " + "; ".join(x["name"] for x in a["checks"] if not x["pass"]))
    if not t.flag("fresh:" + a["id"]):
        return deny(f"The appraisal is not from the pinned minion (guest_version {a['guest_version']}, pinned {APPRAISAL_PIN[:8]}) or is more than {MAX_APPRAISAL_AGE // 86400} days old (at {a['at']}).")
    r = next((d for d in pages(t) if d.get("id") == a["request_id"] and "requested_by" in d), None)
    if not r:
        return deny(f"Fetch the appraisal request {RESIP}/api/appraisal-requests/{a['request_id']} too.")
    if r["requested_by"] != t.opener:
        return deny("This appraisal was requested by someone else; request your own with your person id as requested_by.")
    if any(v["agent_id"] == a["agent_id"] and v["owner"] != t.opener for v in enrolled(s).values()):
        return deny(f"{a['agent_id']} is already enrolled by another member.")
    return allow()


def guard_terms(c, t, s):
    if t.flag("accepted") or t.flag("closed") or s.questions(t.id):
        return deny("Terms are fixed once proposed.")
    req, a = t.data["request"], c.args
    if t.data["kind"] == "couch":
        return guard_couch_terms(a, t, req)
    line = lines(s).get(a.get("line")) if isinstance(a.get("line"), str) else None
    if not line:
        return deny("Name an enrolled line by its id (a string such as \"thread-45\").")
    if unverified(t, line):
        return deny(unverified(t, line))
    p = line["policy"]
    if t.data["kind"] == "fetch":
        return deny("The program records fetch-job terms itself.")
    price, per_gb, minutes = a.get("price"), a.get("price_per_gb"), a.get("minutes")
    if not all(isinstance(v, int) and v >= 1 for v in (price, per_gb)) or not isinstance(minutes, int) or minutes < PERIOD_MINUTES:
        return deny(f"price_per_gb (credits per GB), price (credits held, at least 1) and minutes (at least {PERIOD_MINUTES}) must be integers.")
    mode = "exclusive" if req["exclusive"] else "shared"
    floor = p[f"floor_{mode}_per_gb"]
    problems = [
        (req["category"] not in p["categories"], f"the owner allows only {p['categories']}"),
        (minutes > req["minutes"], f"the buyer asked for at most {req['minutes']} minutes"),
        (minutes > p["max_minutes"], f"the owner allows at most {p['max_minutes']} minutes"),
        (per_gb < floor, f"the owner's {mode} floor is {floor} credits per GB"),
        (price > req["max_price"], f"the buyer's maximum is {req['max_price']}"),
        (req["exclusive"] and not line["exclusive_basis"], "this line offers shared leases only"),
        (busy(s, line["agent_id"], req["domains"], t.id, req["exclusive"]), "an open exclusive lease, or for an exclusive request any open lease, holds one of these domains on this line"),
        (req.get("pay") == "escrow" and not p.get("operator"), "the buyer pays on GuestEscrow and this line's policy names no operator address"),
    ]
    reasons = [why for bad, why in problems if bad]
    if reasons:
        return deny("Terms refused: " + "; ".join(reasons) + ".")
    fixed = dict(domains=req["domains"], category=req["category"], exclusive=req["exclusive"], seller=line["owner"], agent_id=line["agent_id"], basis=line["exclusive_basis"] if req["exclusive"] else "shared", state="proposed",
                 **({"escrow": escrow_terms(t, line, mode, per_gb, price, minutes)} if req.get("pay") == "escrow" else {}))
    return modify(**{**a, **fixed}) if any(a.get(k) != v for k, v in fixed.items()) else allow()


def guard_couch_terms(a, t, req):
    if not t.flag("fresh:fleet"):
        return deny(f"Fetch {FLEET_URL} in this run first.")
    slot = fleet_slot(t, a.get("publisher"), a.get("slot_id"))
    if not slot:
        return deny(f"Slot {a.get('slot_id')!r} of {a.get('publisher')!r} is not a ready, verified slot of an online Mac in this run's {FLEET_URL}.")
    if not fits(slot, req):
        return deny(f"Slot {a.get('slot_id')!r} of {a.get('publisher')!r} does not fit this stay: its level card fails the request's stay length, open window, interruptibility or perks.")
    minutes = a.get("minutes")
    if not isinstance(minutes, int) or not 1 <= minutes <= req["minutes"]:
        return deny(f"minutes must be an integer from 1 to the {req['minutes']} the guest asked for.")
    fixed = dict(publisher=a["publisher"].lower(), rate_nano_usd_per_second=COUCH_RATE, browse=slot.get("browse"), task=req["task"], state="proposed")
    if any(a.get(k) != v for k, v in fixed.items()):
        return modify(**{**a, **fixed})
    return allow()


def busy(s, agent_id, domains, here, exclusive):
    for tid, t in s.snapshot["threads"].items():
        x = t.get("records", {}).get("terms")
        # Couch terms name a slot, not a line: only line deals hold domains.
        if tid != here and x and "agent_id" in x and x["agent_id"] == agent_id and "accepted" in t["flags"] and "settled" not in t["flags"] and (exclusive or x["exclusive"]) and set(x["domains"]) & set(domains):
            return True
    return False


def guard_propose(c, t, s):
    if not t or t.data["kind"] not in ("lease", "fetch", "couch") or not t.record("terms") or t.flag("accepted") or t.flag("closed"):
        return deny("Record the terms in an open lease, fetch or couch thread first.")
    if s.questions(t.id):
        return deny("These terms are already proposed.")
    line = t.data["kind"] == "couch" or lines(s).get(t.record("terms")["line"])
    if not line:
        return deny(f"Line {t.record('terms')['line']} is no longer enrolled (superseded or withdrawn); record terms on an active line.")
    if line is not True and unverified(t, line):
        return deny(unverified(t, line))
    fixed = dict(members=[t.opener], options=["accept", "decline"], until=t.created_at + ACCEPT_SECONDS, proposal_id=t.id + ":proposal", question=carded(c.args.get("question", ""), s, t, host_subject(t)))
    if any(c.args.get(k) != v for k, v in fixed.items()):
        return modify(**{**c.args, **fixed})
    return allow()


def guard_settle(c, t, s):
    if t.flag("agreed"):
        return deny("This lease is paid on GuestEscrow by the line's guest's signed claims; the souk settles nothing here.")
    if not t.flag("accepted") or t.flag("settled") or not t.tool_fact("credits.hold"):
        return deny("Nothing is held here to settle.")
    # The record schema has no lease_id: the one statement fetched here names it.
    fetched = sorted({d["lease_id"] for d in pages(t) if "lease_id" in d})
    lease_id = c.args.get("lease_id") or (fetched[0] if len(fetched) == 1 else None)
    st = statement(t, lease_id) if lease_id else None
    if not st:
        return deny(f"Fetch the lease's statement and pass lease_id to record (statements fetched in this thread: {', '.join(fetched) or 'none'}).")
    if settled_elsewhere(s, lease_id, t.id):
        return deny("That lease already settled another escrow.")
    terms = t.record("terms")
    if st["agent_id"] != terms["agent_id"]:
        return deny(f"That lease is on {st['agent_id']}, not the agreed line {terms['agent_id']}.")
    want = {"declined": "released", "ended": "settled"}.get(st["status"])
    if want is None:
        return deny(f"The lease is {st['status']}; set a timer and fetch the statement again after it ends.")
    fixed = dict(lease_id=lease_id, state=want)
    if any(c.args.get(k) != v for k, v in fixed.items()):
        return modify(**{**c.args, **fixed})
    return allow()


def parties(t, s):
    x = t.record("terms")
    if t.data["kind"] != "couch":
        return t.opener, x["seller"]
    return t.opener, next((p for p, m in s.snapshot["members"].items() if m["wallet"] and m["wallet"].lower() == x["publisher"]), None)


def served(t):
    k = t.data["kind"]
    return t.flag("settled") and (k == "couch" or k == "fetch" and bool(t.tool_fact("credits.pay_hold")) or k == "lease" and t.record("settle")["state"] == "settled")


def host_subject(t):
    x = t.record("terms")
    return x["publisher"] if t.data["kind"] == "couch" else x["agent_id"]


def references(s):
    return [r["reference"] for r in s.resident_fields("reference") if "reference" in r]


def subscribers(s):
    return [r["subscriber"] for r in s.resident_fields("subscriber") if "subscriber" in r]


def reference_form(t):
    return "souk_send(kind=\"reference\", text='" + json.dumps(dict(deal=t.id, text="<one line>", up=True)) + "')"


def ask_buyer(t):
    return f" Leave the host a one-line reference (public on the host's profile; up true or false is optional): {reference_form(t)}"


def ask_host(t, s):
    host = parties(t, s)[1]
    if not host:
        return [post(t, f"No member's bound wallet is the host's publisher address {t.record('terms')['publisher']}, so the host cannot leave a reference on this stay.")]
    return [reply(host, f"Your {t.data['kind']} deal {t.id} settled. Leave the buyer a one-line reference (the amin reads it when matching them later; "
                        f"up true or false is optional): {reference_form(t)}")]


def reference(e, s):
    d = json.loads(e.text)
    t = s.thread(str(d["deal"]))
    if not t or t.data["kind"] not in ("lease", "fetch", "couch") or not served(t):
        return [reply(e.sender, f"Deal {d['deal']} is not a settled lease, fetch job or stay: references come after settlement, and not on a released hold.")]
    buyer, host = parties(t, s)
    if e.sender.person not in (buyer, host):
        unbound = f" No member's bound wallet is this stay's publisher address {t.record('terms')['publisher']}: the host binds that wallet first." if host is None else ""
        return [reply(e.sender, f"Only the buyer and the host of deal {t.id} leave references on it." + unbound)]
    if any(r["deal"] == t.id and r["author"] == e.sender.person for r in references(s)):
        return [reply(e.sender, f"You already left your reference on deal {t.id}; there is one per side.")]
    text, up = str(d["text"]).strip(), d.get("up")
    if not text or len(text) > REFERENCE_CHARS or "\n" in text or IPV4.search(text) or not (up is None or isinstance(up, bool)):
        raise ValueError(f"a reference is one line of 1 to {REFERENCE_CHARS} characters with no IP address, and up is true, false or absent")
    about = "host" if e.sender.person == buyer else "guest"
    x = dict(deal=t.id, kind=t.data["kind"], about=about, subject=host_subject(t) if about == "host" else buyer, author=e.sender.person, text=text, up=up, at=e.at)
    if about == "host":
        stored = store(dict(sender=dict(person=e.sender.person), text="reference " + json.dumps(x), reference=x), resident=True)
    else:
        # Sealed: the amin sees only the buyer's tally.
        mine = [r for r in references(s) if r["about"] == "guest" and r["subject"] == buyer] + [x]
        tally = f"Host references about buyer {buyer}: {len(mine)}, {sum(r['up'] is True for r in mine)} up, {sum(r['up'] is False for r in mine)} down."
        stored = store(dict(sender=dict(person=e.sender.person), text=tally, reference=x), resident=True, sealed=("reference",))
    return [stored, reply(e.sender, f"Recorded your reference on deal {t.id}."), *(publish(x, p) for p in subscribers(s) if about == "host")]


def publish(x, member):
    return reply(member, "reference " + json.dumps({k: x[k] for k in ("deal", "kind", "subject", "up", "text", "at")}))


def subscribe(e, s):
    mark = [] if e.sender.person in subscribers(s) else [store(dict(sender=dict(person=e.sender.person), text=json.dumps(dict(kind="subscriber")), subscriber=e.sender.person), resident=True)]
    return mark + [reply(e.sender, "references subscribed"), *(publish(x, e.sender.person) for x in references(s) if x["about"] == "host")]


def carded(q, s, t, subject):
    rs = [r for r in references(s) if r["about"] == "host" and r["subject"] == subject]
    thumbs = lambda r: " (up)" if r["up"] is True else " (down)" if r["up"] is False else ""
    card = (f"References for {subject}: {len(rs)}, {sum(r['up'] is True for r in rs)} up, {sum(r['up'] is False for r in rs)} down. Latest: "
            + "; ".join(json.dumps(r["text"]) + thumbs(r) for r in rs[-3:][::-1]) + "." if rs else f"References for {subject}: none yet.")
    x = t.record("terms")
    card += "\n\n" + escrow_card(x["escrow"]) if x and "escrow" in x else ""
    return q if card in q else q + "\n\n" + card



# Delegated standing terms: no prose or agent-generated financial authority.
def allocate(e, t, s):
    if e.at >= t.created_at + 120:
        return [t.set_flag("closed"), allocation_failed(t, "read deadline exceeded", "expired")]
    if isinstance(e, Message):
        if t.flag("alloc_started"):
            return []
        return [t.set_flag("alloc_started"), set_timer(t.created_at + 120, "allocation_read_expired", thread=t.id), *alloc_read(t, MARKET_URL)]
    if isinstance(e, ToolDone) and e.tool == "record" and e.state == "done":
        if conflict(t, s):
            return [t.set_flag("closed"), post(t, conflict(t, s))]
        return [t.set_flag("agreed"), set_timer(t.created_at + ACCEPT_SECONDS, "allocation_expired", thread=t.id), allocation_contract(t, "requires_acceptance")]
    if not isinstance(e, ToolDone) or e.tool != "runtime.web_fetch":
        return []
    d = doc(e.result) if e.state == "done" else None
    req = t.data["request"]
    if e.args["url"] == MARKET_URL:
        if not d or "hosts" not in d:
            return [t.set_flag("closed"), allocation_failed(t, "market unavailable")]
        # A mismatched market version can rule out a candidate; eligibility still requires its verified appraisal.
        live = live_agents(d) - {x["agent_id"] for x in d["lines"] if (x.get("appraisal") or {}).get("guest_version", APPRAISAL_PIN[:8]) != APPRAISAL_PIN[:8]}
        return [t.set_flag("fresh:market"), *(t.set_flag("fresh:live:" + a) for a in live), *alloc_next(t, s, live)]
    line = next((v for v in lines(s).values() if verified_url(v["appraisal_id"]) == e.args["url"]), None)
    per_gb = line and max(1, line["policy"]["floor_shared_per_gb"])
    if line and d and d.get("id") == line["appraisal_id"] and d.get("agent_id") == line["agent_id"] and fresh(d, e.at) and not busy(s, line["agent_id"], req["domains"], t.id, False):
        terms = dict(finding="terms", state="proposed", reason="standing offer", line=line["line"], domains=req["domains"], category=req["category"], minutes=5, price=req["max_price"], price_per_gb=per_gb, exclusive=False, seller=line["owner"], agent_id=line["agent_id"], basis="shared", escrow=escrow_terms(t, line, "shared", per_gb, req["max_price"], 5))
        return [t.set_flag("fresh:" + line["appraisal_id"]), call("record", thread=t.id, **terms)]
    return [t.set_flag("tried:" + e.args["url"]), *alloc_next(t, s, {f[11:] for f in t.snapshot["flags"] if f.startswith("fresh:live:")}, e.args["url"])]


def alloc_next(t, s, live, failed=""):
    req = t.data["request"]
    candidates = sorted((v for v in lines(s).values() if v["agent_id"] in live and v["policy"].get("quick_lease") is True and v["policy"].get("operator") and req["category"] in v["policy"]["categories"] and v["policy"]["max_minutes"] >= 5 and not busy(s, v["agent_id"], req["domains"], t.id, False) and verified_url(v["appraisal_id"]) != failed and not t.flag("tried:" + verified_url(v["appraisal_id"]))), key=lambda v: (v["policy"]["floor_shared_per_gb"], v["line"]))
    return alloc_read(t, verified_url(candidates[0]["appraisal_id"])) if candidates else [t.set_flag("closed"), allocation_failed(t, "no eligible standing offer")]


def allocation_contract(t, status, **extra):
    return post(t, json.dumps(dict(kind="layover-allocation/1", operation_id=t.data["allocate"], status=status, expires=t.created_at + ACCEPT_SECONDS, thread=t.id, base=RESIP, terms=t.record("terms"), charge="pending_signed_settlement", **extra)))


def alloc_read(t, url):
    return [*clear(t, "alloc_read:"), t.set_flag("alloc_read:" + url), store(dict(text="Allocation read: " + url)), run("prompts/allocation.md", see=["thread"], tools=["runtime.web_fetch"])]


def allocation_failed(t, reason, status="unavailable"):
    return post(t, json.dumps(dict(kind="layover-allocation/1", operation_id=t.data["allocate"], status=status, thread=t.id, reason=reason, charge="none")))

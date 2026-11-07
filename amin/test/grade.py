#!/usr/bin/env python3
"""Grade the IP souk journeys (notes/journeys.html, "Pass criteria") from records.

  grade.py snapshot > before.json        before the journeys: balances and holds of seller and buyer
  grade.py SELLER_THREAD BUYER_THREAD --start T [--decline THREAD] [--before before.json]

T is epoch seconds or ISO 8601. Each party reads only its own view through the host API
(souk_read, souk_inbox under its own credential). That view has no tool arguments, tool results
or ledger deltas, so terms, settlement and enrollment are read from the program's own posts
(hold notice, "Settled lease", "Enrolled line"), fetched records are re-fetched from the public
resip site, and credit movements are balance differences against the --before snapshot.
Checks 9-12 also read the site's probe records, recompute the probe schedule from drand (web/probe-schedule.ts),
and read holder statements with `resip status DIR LEASE_ID` from the lease files in --lease-dirs. A workload or
datacenter log is probe3.sh output (local-data/baseline-target-site-2026-11-05): one PROBE row per fetch.
Exit status is 1 if any check fails.
"""

import argparse
import functools
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

SOUK = "31f5c141-fb2d-4572-939a-68543a2d0649"
RESIP = "https://pod.dstack.soc1024.com/resip-staging"
ANDREW = "8730c015-dd49-401c-919c-7f96d552f271"
SELLER = "79064a39-8b6b-43cc-a964-c4e3c6702a5a"
BUYER = "e1752b78-9037-4643-8e39-fb81120b1a60"
GUEST = re.search(r'^APPRAISAL_PIN = "([0-9a-f]{8})', open(Path(__file__).parent.parent / "build.py").read(), re.M).group(1)
PERIOD_MINUTES = 5
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
ENROLLED = re.compile(r"Enrolled line (\S+) \((\S+)\); exclusive leases: ([\w-]+)\.")
ESCROW = re.compile(r"Escrow: (\d+) credits are held.*?resip lease DIR (\S+) (\w+) (exclusive|shared) (\d+) (\d+) (\d+)", re.S)
SETTLED = re.compile(rf"Settled lease ({UUID}): (\d+) credits to the seller, (\d+) back to the buyer\.")
LEASE_ID = re.compile(rf"^\s*lease\s+({UUID})\s*$", re.I)
PROGRAM_POST = re.compile(
    r"^(Escrow: |Settled lease |Enrolled line |Lease \S+ is \w+; the amin checks again|The amin stopped before finishing"
    r"|The hold of |The terms were declined|The IP souk could not read|A (line|lease) message needs|Only an arbiter)"
)
IPV4 = re.compile(r"(?<!\d)(?<!\d\.)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\.?\d)")
IPV6 = re.compile(r"(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?![\w:])", re.I)
CLAIMS = [
    ("credits", re.compile(r"(\d+(?:\.\d+)?)\s*(?:dev\s+)?credits?", re.I)),
    ("bandwidth", re.compile(r"(\d+(?:\.\d+)?)\s*(?:mbps|mbit/s|mb/s)", re.I)),
    ("periods", re.compile(r"(\d+)(?:\s*(?:of|/)\s*(\d+))?\s*(?:covered\s+)?(?:five-minute\s+|5-minute\s+)?periods?", re.I)),
    ("minutes", re.compile(r"(\d+)\s*(?:-\s*)?min(?:ute)?s?\b", re.I)),
    ("asn", re.compile(r"\bAS\s?(\d{3,})", re.I)),
]
DELISTED = re.compile(r"^Line (\S+) is delisted by QA: the newest probe failed \((.*)\)\. Buyers", re.S)
RELISTED = re.compile(r"^Line (\S+) is listed again: probe (\S+) passed at (\S+)\.")
WORD_CLAIMS = re.compile(r"\b(region|isp[_ ]class)\b\W{0,4}[`\"']([^`\"'\n]+)[`\"']", re.I)


def open_holds(cr):
    return {k: v for k, v in cr["holds"].items() if v["amount"]}


class Missing(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def http(method, url, body=None, token=None):
    headers = {"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})}
    request = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        raise Missing(f"{method} {url}: HTTP {e.code} {e.read()[:300].decode(errors='replace')}")
    except urllib.error.URLError as e:
        raise Missing(f"{method} {url}: {e.reason}")


@functools.cache
def resip_text(path):
    return http("GET", RESIP + path)


def resip(path):
    text = resip_text(path)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise Missing(f"GET {RESIP}{path} is not JSON: {text[:200]!r}")


class Member:
    def __init__(self, home):
        c = json.loads((Path(home).expanduser() / "credential.json").read_text())
        self.home, self.url, self.token = home, c["url"].rstrip("/"), c["token"]

    def call(self, tool, **args):
        return json.loads(http("POST", f"{self.url}/api/{tool}", {"souk_id": SOUK, **args}, self.token))

    @functools.cache
    def inbox(self):
        return self.call("souk_inbox")

    @functools.cache
    def read(self, thread):
        try:
            return self.call("souk_read", thread_id=thread)
        except Missing as e:
            raise Missing(f"{self.home} reading {thread}: {e}")

    def credits(self):
        rows = [r["payload"] for r in self.inbox() if r["kind"] == "Credits"]
        if len(rows) != 1:
            raise Missing(f"{self.home}: {len(rows)} Credits rows in souk_inbox")
        return rows[0]


def messages(rows, kind=None):
    return [r for r in rows if r["kind"] == "Message" and (kind is None or r["payload"]["kind"] == kind)]


def outputs(rows):
    return [r for r in rows if r["kind"] == "Output"]


def receipts(rows, tool):
    return [r["payload"] for r in rows if r["kind"] == "Receipt" and r["payload"]["tool"] == tool]


def one(items, what):
    if len(items) != 1:
        raise Missing(f"expected one {what}, found {len(items)}")
    return items[0]


def post_match(rows, pattern, what):
    return one([m for r in outputs(rows) if (m := pattern.search(r["payload"]["text"]))], what)


def probe_rows(path):
    rows = [line[line.index("PROBE\t"):].rstrip("\n").split("\t") for line in open(path) if "PROBE\t" in line]
    bad = [r for r in rows if len(r) != 12]
    if bad or not rows:
        raise Missing(f"{path}: {len(rows)} PROBE rows, {len(bad)} not in probe3.sh's 12-field format")
    return [dict(zip(("tag", "at", "url", "code", "cls", "wire", "ce", "body", "secs", "end", "marker", "title"), r)) for r in rows]


def served(r):
    return r["code"] == "200" and r["end"] == "html" and r["marker"] == "-" and r["title"] != ""


def run(cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if p.returncode:
        raise Missing(f"{' '.join(cmd)} exited {p.returncode}: {p.stdout.strip()[-400:]} {p.stderr.strip()[-200:]}")
    return p.stdout


def instant(v):
    try:
        return float(v)
    except ValueError:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()


class Check:
    def __init__(self):
        self.lines, self.failed = [], False

    def info(self, msg):
        self.lines.append("     " + msg)

    def expect(self, ok, msg):
        self.lines.append(("ok   " if ok else "BAD  ") + msg)
        self.failed |= not ok


class Journey:
    def __init__(self, a):
        self.a = a
        self.seller, self.buyer, self.andrew = Member(a.seller_home), Member(a.buyer_home), Member(a.creator_home)

    @functools.cached_property
    def start(self):
        return instant(self.a.start)

    def s_rows(self):
        return self.seller.read(self.a.seller_thread)

    def b_rows(self):
        return self.buyer.read(self.a.buyer_thread)

    def line(self):
        return json.loads(one(messages(self.s_rows(), "line"), f"line message in seller thread {self.a.seller_thread}")["payload"]["text"])

    def enrolled(self):
        m = post_match(self.s_rows(), ENROLLED, f"'Enrolled line' post in seller thread {self.a.seller_thread}")
        return dict(line=m[1], agent_id=m[2], basis=m[3])

    def request(self, rows=None):
        rows = self.b_rows() if rows is None else rows
        return json.loads(one(messages(rows, "lease"), "lease message in buyer thread")["payload"]["text"])

    def terms(self, rows=None):
        m = post_match(self.b_rows() if rows is None else rows, ESCROW, "hold notice ('Escrow: ...') in buyer thread")
        return dict(price=int(m[1]), domains=m[2].split(","), category=m[3], exclusive=m[4] == "exclusive", minutes=int(m[5]), price_per_gb=int(m[6]), notice_price=int(m[7]))

    def lease_id(self, rows=None):
        ids = [m[1] for r in messages(self.b_rows() if rows is None else rows) if (m := LEASE_ID.match(r["payload"]["text"]))]
        return one(sorted(set(ids)), "'lease <id>' message in buyer thread")

    def verified(self):
        return resip(f"/api/appraisals/{self.line()['appraisal_id']}/verified")

    def statement(self, rows=None):
        return resip(f"/api/leases/{self.lease_id(rows)}/statement")

    def seller_share(self):
        t, st = self.terms(), self.statement()
        if st["status"] != "ended" or st["attestation_pass"] is not True or (self.request()["exclusive"] and st["statement_exclusive"] is not True):
            return 0
        if st["bytes_by_period"] is None:
            return 0
        return min(t["price"], (st["bytes_up"] + st["bytes_down"]) * t["price_per_gb"] // 10**9)

    @functools.cache
    def holder(self, lid):
        """The holder's signed statement, verified by `resip status` against the receipts and the attestation."""
        d = one([d for d in self.a.lease_dirs.split(",") if (Path(d).expanduser() / f"lease-{lid}.json").exists()], f"lease-{lid}.json in {self.a.lease_dirs}")
        out = run(["deno", "run", "-A", "--no-check", str(Path(self.a.web).expanduser() / "web/buyer/resip.ts"), "status", str(Path(d).expanduser()), lid])
        return json.loads(one([x for x in out.splitlines() if x.startswith("statement: ")], f"'statement:' line in resip status of {lid}")[len("statement: "):])

    def party_threads(self):
        return [("seller", self.seller, SELLER, self.a.seller_thread), ("buyer", self.buyer, BUYER, self.a.buyer_thread)] + (
            [("decline", self.buyer, BUYER, self.a.decline)] if self.a.decline else []
        )

    # 1
    def hands_off(self, c):
        for label, member, person, thread in self.party_threads():
            rows = member.read(thread)
            c.expect(one([r for r in rows if r["kind"] == "Thread"], f"Thread row for {thread}")["payload"]["members"] == [person], f"{label} {thread} members are only {person}")
            for r in messages(rows):
                sender, at = r["payload"]["sender"]["person"], r["at"]
                if at >= self.start:
                    c.expect(sender != ANDREW, f"{label} {thread} seq {r['seq']} at {at:.0f} sender {sender}")
            c.info(f"{label} {thread}: {len(messages(rows))} member messages, {len(outputs(rows))} posts; receipts carry no time")
        human = [r for r in messages(self.andrew.inbox()) if r["at"] >= self.start]
        c.info(f"human-sender (Andrew {ANDREW}) events since {self.start:.0f}: {len(human)}")
        for r in human:
            c.info(f"  seq {r['seq']} thread {r['thread']} kind {r['payload']['kind']}: {r['payload']['text'][:100]!r}")
        c.info("the agents' own sessions are not visible here; grade them from their transcripts")

    # 2
    def enrollment(self, c):
        line, en, v = self.line(), self.enrolled(), self.verified()
        c.info(f"line message appraisal_id {line['appraisal_id']}; Enrolled post: line {en['line']} agent {en['agent_id']} basis {en['basis']}")
        c.expect(en["line"] == self.a.seller_thread, f"enrolled line id {en['line']} is the seller thread")
        c.expect(v["pass"] is True, f"/verified pass {v['pass']}; failing checks {[x['name'] for x in v['checks'] if not x['pass']]}")
        c.expect(str(v["guest_version"]).startswith(GUEST), f"/verified guest_version {v['guest_version']}")
        c.expect(v["agent_id"] == en["agent_id"], f"/verified agent_id {v['agent_id']}")
        req = resip(f"/api/appraisal-requests/{v['request_id']}")
        c.expect(req["requested_by"] == SELLER, f"appraisal request {v['request_id']} requested_by {req['requested_by']}")
        c.expect(req.get("appraisal_id") == line["appraisal_id"], f"appraisal request appraisal_id {req.get('appraisal_id')}")
        c.expect(any(r["state"] == "done" for r in receipts(self.s_rows(), "record")), "a done 'record' receipt in the seller thread")
        for who, member in (("seller", self.seller), ("andrew", self.andrew)):
            for r in messages(member.inbox(), "line"):
                if r["thread"] and r["thread"] != self.a.seller_thread:
                    posts = [o["payload"]["text"] for o in outputs(member.read(r["thread"]))]
                    state = "enrolled" if any(ENROLLED.search(p) for p in posts) else "not enrolled"
                    c.info(f"other line thread ({who}) {r['thread']}: appraisal {json.loads(r['payload']['text'])['appraisal_id']}, {state}; last post: {(posts or [''])[-1][:120]!r}")
        refused = [x["id"] for x in resip(f"/api/agents/{en['agent_id']}/appraisals") if x["pass"] is not True]
        c.info(f"appraisals of {en['agent_id']} on the site with pass not true: {refused}")

    # 3
    def deal(self, c):
        req, pol, t, en = self.request(), self.line()["policy"], self.terms(), self.enrolled()
        c.info(f"request {req}; policy {pol}; terms (hold notice) {t}")
        c.expect(sorted(t["domains"]) == sorted(d.lower() for d in req["domains"]), "domains equal the request")
        c.expect(t["category"] == req["category"], "category equals the request")
        c.expect(t["category"] in pol["categories"], "category allowed by the owner")
        c.expect(PERIOD_MINUTES <= t["minutes"] <= req["minutes"], f"minutes {t['minutes']} within the request's {req['minutes']}")
        c.expect(t["minutes"] <= pol["max_minutes"], f"minutes within the owner's max {pol['max_minutes']}")
        floor = pol["floor_exclusive_per_gb" if t["exclusive"] else "floor_shared_per_gb"]
        c.expect(floor <= t["price_per_gb"], f"floor {floor} <= price_per_gb {t['price_per_gb']}")
        c.expect(1 <= t["price"] <= req["max_price"], f"1 <= price {t['price']} <= max_price {req['max_price']}")
        c.expect(t["price"] == t["notice_price"], "escrow amount equals the resip lease command's total")
        c.expect(t["exclusive"] == req["exclusive"], f"resip lease command mode exclusive={t['exclusive']} vs request {req['exclusive']}")
        if req["exclusive"]:
            c.expect(pol["exclusive"] is True and en["basis"] in ("attested", "owner-reported"), f"exclusive: owner offers {pol['exclusive']}, basis {en['basis']}")
        c.info("the proposal card is gone from the inbox once answered; terms are read from the program's hold notice")

    # 4
    def delivery(self, c):
        lid, st, en, req = self.lease_id(), self.statement(), self.enrolled(), self.request()
        covered = sum(1 for p in st["periods"] if p["covered"])
        c.expect(st["lease_id"] == lid, f"statement lease_id {st['lease_id']}")
        c.expect(st["agent_id"] == en["agent_id"], f"statement agent_id {st['agent_id']}")
        c.expect(st["status"] in ("ended", "active"), f"status {st['status']}, end_reason {st['end_reason']!r}")
        c.expect(st["attestation_pass"] is True, f"attestation_pass {st['attestation_pass']}")
        c.expect(st["exclusive"] == req["exclusive"], f"lease created exclusive={st['exclusive']} vs request {req['exclusive']}")
        c.expect(st["statement_exclusive"] in (None, req["exclusive"]), f"statement_exclusive {st['statement_exclusive']} vs request {req['exclusive']}; shared_with {st['shared_with']}")
        c.expect(covered > 0, f"periods covered {covered} of {len(st['periods'])}")
        c.info(f"window {st['window']}; ip_commitments {st['ip_commitments']}; measurement_current {st['measurement_current']}")
        refusals = [r["payload"]["text"][:160] for r in self.b_rows() if r["kind"] in ("Message", "Output") and re.search(r"refus|second buyer", r["payload"]["text"], re.I)]
        c.info(f"second-buyer refusal mentions in the buyer thread (not graded): {refusals}")
        c.info("per-domain success/refusal is in the holder's statement only, not the public one")

    # 5
    def settlement(self, c):
        t, lid, s = self.terms(), self.lease_id(), self.seller_share()
        m = post_match(self.b_rows(), SETTLED, "'Settled lease' post in buyer thread")
        c.info(f"price {t['price']}, minutes {t['minutes']}; expected seller {s}, buyer {t['price'] - s}; posted {m[0]!r}")
        c.expect(m[1] == lid, f"settled lease {m[1]}")
        c.expect((int(m[2]), int(m[3])) == (s, t["price"] - s), f"split posted ({m[2]}, {m[3]}) vs expected ({s}, {t['price'] - s})")
        for tool in ("credits.hold", "credits.pay_hold"):
            r = receipts(self.b_rows(), tool)
            c.expect([(x["state"], x["origin"]) for x in r] == [("done", "program")], f"{tool} receipts {r}")
        c.expect(not receipts(self.b_rows(), "credits.release_hold"), "no credits.release_hold receipt")
        if not self.a.before:
            raise Missing("no --before snapshot: the host API gives balances, not ledger deltas, so the settlement cannot be read from the ledger")
        before = json.loads(Path(self.a.before).read_text())
        grants = {p: 0 for p in (SELLER, BUYER)}
        for r in messages(self.andrew.inbox(), "grant"):
            g = json.loads(r["payload"]["text"])
            if r["at"] > before["at"] and g["member"] in grants:
                grants[g["member"]] += g["amount"]
                c.info(f"grant in window: seq {r['seq']} {g}")
        after = {SELLER: self.seller.credits(), BUYER: self.buyer.credits()}
        delta = {p: after[p]["balance"] - before["credits"][p]["balance"] - grants[p] for p in grants}
        c.expect(delta[SELLER] == s, f"seller balance {before['credits'][SELLER]['balance']} -> {after[SELLER]['balance']}, delta less grants {delta[SELLER]}")
        c.expect(delta[BUYER] == -s, f"buyer balance {before['credits'][BUYER]['balance']} -> {after[BUYER]['balance']}, delta less grants {delta[BUYER]}")
        c.expect(sum(delta.values()) == 0, f"deltas sum to {sum(delta.values())}")
        c.expect(not open_holds(after[BUYER]) and not open_holds(after[SELLER]), f"no outstanding holds: buyer {after[BUYER]['holds']}, seller {after[SELLER]['holds']}")

    # 6
    def decline(self, c):
        rows = self.buyer.read(self.a.decline)
        t, st = self.terms(rows), self.statement(rows)
        c.info(f"decline thread {self.a.decline}: request {self.request(rows)}; terms {t}")
        c.expect(st["status"] == "declined", f"statement {st['lease_id']} status {st['status']}, end_reason {st['end_reason']!r}")
        for tool in ("credits.hold", "credits.release_hold"):
            r = receipts(rows, tool)
            c.expect([(x["state"], x["origin"]) for x in r] == [("done", "program")], f"{tool} receipts {r}")
        c.expect(not receipts(rows, "credits.pay_hold"), "no credits.pay_hold receipt (release_hold returns the whole hold)")
        c.expect(not any(SETTLED.search(o["payload"]["text"]) for o in outputs(rows)), "no 'Settled lease' post")
        c.expect(not open_holds(self.buyer.credits()), f"buyer holds now {self.buyer.credits()['holds']}")

    # 7
    def claims(self, c):
        st = self.statement()
        req_id = self.verified()["request_id"]
        sources = [self.request(), self.line(), self.verified(), resip(f"/api/appraisal-requests/{req_id}"), st, self.terms(), self.enrolled()]
        covered = sum(1 for p in st["periods"] if p["covered"])
        t, pol, s = self.terms(), self.line()["policy"], self.seller_share()
        derived = [PERIOD_MINUTES, covered, len(st["periods"]), covered * PERIOD_MINUTES, pol["floor_exclusive_per_gb" if t["exclusive"] else "floor_shared_per_gb"], t["price_per_gb"], *(x for x in (st["bytes_up"], st["bytes_down"]) if x is not None), s, t["price"] - s]
        nums, words = set(map(float, derived)), set()

        def walk(x):
            if isinstance(x, dict):
                [walk(v) for v in x.values()]
            elif isinstance(x, list):
                [walk(v) for v in x]
            elif isinstance(x, (int, float)) and not isinstance(x, bool):
                nums.add(float(x))
            elif isinstance(x, str):
                words.add(x.lower())

        walk(sources)
        rows = [(label, r) for label, member, _, thread in self.party_threads() for r in outputs(member.read(thread))]
        posts = [(label, r) for label, r in rows if not PROGRAM_POST.match(r["payload"]["text"])]
        c.info(f"amin posts checked: {len(posts)} (program posts excluded: {len(rows) - len(posts)})")
        for label, r in posts:
            text = re.sub(rf"{UUID}|https?://\S+|\d{{4}}-\d\d-\d\dT[\d:.]+Z?", " ", r["payload"]["text"])
            for kind, pattern in CLAIMS:
                for m in pattern.finditer(text):
                    for v in filter(None, m.groups()):
                        c.expect(float(v) in nums, f"{label} seq {r['seq']} {kind} {v!r} in {m[0]!r}")
            for m in WORD_CLAIMS.finditer(text):
                c.expect(m[2].strip().lower() in words, f"{label} seq {r['seq']} {m[1]} {m[2]!r}")
        c.info("extraction is pattern-based (numbers next to credits/Mbps/periods/minutes/AS, quoted region/isp_class)")

    # 8
    def leaks(self, c):
        threads = [r["thread"] for r in self.buyer.inbox() if r["kind"] == "Thread"]
        texts = {"buyer inbox": json.dumps(self.buyer.inbox())} | {f"buyer thread {t}": json.dumps(self.buyer.read(t)) for t in threads}
        for where, text in texts.items():
            hits = IPV4.findall(text) + IPV6.findall(text)
            c.expect(not hits, f"{where}: IP-like strings {hits}")
        seller_hits = IPV4.findall(json.dumps(self.s_rows())) + IPV6.findall(json.dumps(self.s_rows()))
        c.info(f"seller thread {self.a.seller_thread} (not buyer-readable) IP-like strings: {seller_hits}")
        rows = [self.b_rows()] + ([self.buyer.read(self.a.decline)] if self.a.decline else [])
        domains = sorted({d.lower() for r in rows for d in self.request(r)["domains"]})
        agent, aid, lid = self.enrolled()["agent_id"], self.line()["appraisal_id"], self.lease_id()
        paths = [
            "/api/agents",
            f"/api/agents/{agent}/appraisals",
            f"/api/leases?agent_id={agent}",
            f"/api/leases/{lid}",
            f"/api/leases/{lid}/statement",
            f"/api/appraisals/{aid}",
            f"/api/appraisals/{aid}/verified",
            f"/api/appraisal-requests/{self.verified()['request_id']}",
        ]
        for p in paths:
            text = resip_text(p).lower()
            c.expect(not [d for d in domains if d in text], f"GET {p}: buyer domains {[d for d in domains if d in text]}")
            c.expect(not IPV4.findall(text) + IPV6.findall(text), f"GET {p}: IP-like strings {IPV4.findall(text) + IPV6.findall(text)}")

    # 9
    def qa_history(self, c):
        agent = self.enrolled()["agent_id"]
        out = run(["deno", "run", "-A", "web/probe-schedule.ts", RESIP, agent], cwd=Path(self.a.web).expanduser()).strip().splitlines()
        c.expect(out[-1].startswith("all "), f"probe-schedule.ts {agent} recomputes every filed probe from drand: {out[-1]}")
        sched = resip("/api/probe-scheduler")
        anchor, longest = instant(sched["anchors"][agent]), sched["probe"]["max"]
        before = [p for p in resip(f"/api/agents/{agent}/probes") if instant(p["scheduled_at"]) < self.start]
        c.expect(self.start - anchor >= 86400, f"drawn probes start at the anchor {sched['anchors'][agent]}, {(self.start - anchor) / 3600:.1f} h before the run start")
        times = [anchor] + sorted(instant(p["scheduled_at"]) for p in before) + [self.start]
        gap = max(b - a for a, b in zip(times, times[1:]))
        c.expect(gap <= longest, f"longest gap between drawn probes up to the start {gap / 3600:.1f} h (the schedule forces one within {longest / 3600:.0f} h)")
        day = [p for p in before if instant(p["scheduled_at"]) >= self.start - 86400]
        passed = [p for p in day if p["status"] == "done" and p["pass"] is True]
        c.expect(len(day) > 0 and len(passed) >= 0.95 * len(day), f"{len(passed)} of {len(day)} probes in the 24 h before the start passed")
        for p in day:
            if p not in passed:
                c.info(f"  not passed: {p['request_id']} scheduled {p['scheduled_at']} status {p['status']} pass {p['pass']} error {p['error']!r}")

    # 10
    def delisting(self, c):
        rows = [(t, r) for t in [r["thread"] for r in self.seller.inbox() if r["kind"] == "Thread"] for r in outputs(self.seller.read(t))]
        down = [(r, m) for t, r in rows if (m := DELISTED.match(r["payload"]["text"])) and m[1] == t]
        up = [(r, m) for t, r in rows if (m := RELISTED.match(r["payload"]["text"])) and m[1] == t]
        probes = {p["probe_id"] or p["request_id"]: p for p in resip(f"/api/agents/{self.enrolled()['agent_id']}/probes")}
        for r, m in down:
            cited = re.findall(r"(?:^|; )probe (\S+) ", m[2])
            failed = [probes[x] for x in cited if x in probes and (probes[x]["pass"] is not True or probes[x]["same_ip_as_last"] is False)]
            c.expect(len(cited) == 1 and len(failed) == 1, f"delisted {m[1]} seq {r['seq']}: cites probes {cited}; site shows failed {[p['request_id'] for p in failed]}")
        for r, m in up:
            c.expect(m[2] in probes and probes[m[2]]["pass"] is True, f"relisted {m[1]} seq {r['seq']}: probe {m[2]} pass {probes.get(m[2], {}).get('pass')} at {m[3]}")
        pairs = [(d[1][1], d[0]["seq"], u[0]["seq"]) for d in down for u in up if d[1][1] == u[1][1] and d[0]["seq"] < u[0]["seq"]]
        c.expect(bool(pairs), f"delisted-then-relisted pairs (line, delist seq, relist seq): {pairs}")
        c.info("line_status records are resident (amin-side) and not in the seller's view; graded from the program's posts and the site's probe records")

    # 11
    def exclusive_refusal(self, c):
        st = self.holder(self.a.exclusive_lease)
        lo, hi, mine = instant(st["start"]), instant(st["end"]), {d.lower() for d in st["domains"]}
        c.expect(st["exclusive"] is True, f"lease {st['lease_id']} statement exclusive {st['exclusive']}: {st['claim']}")
        c.info(f"window {st['start']} .. {st['end']}; domains {sorted(mine)}; requests_to_domains {st['requests_to_domains']}, by this lease {st['requests_by_lease']}, refused_to_others {st['refused_to_others']}")
        attempts = 0
        member = Member(self.a.second_home)
        for t in self.a.second_thread:
            rows = member.read(t)
            r = one(messages(rows, "lease"), f"lease message in second thread {t}")
            want = {d.lower() for d in json.loads(r["payload"]["text"])["domains"]}
            c.expect(lo <= r["at"] <= hi and want & mine, f"second thread {t} seq {r['seq']} at {r['at']:.0f} asks for {sorted(want)}")
            escrow = [o["payload"]["text"][:120] for o in outputs(rows) if ESCROW.search(o["payload"]["text"])]
            c.expect(not escrow, f"second thread {t} got no terms (Escrow posts: {escrow})")
            attempts += 1
        for lid in self.a.second_lease:
            pub, d = resip(f"/api/leases/{lid}"), one([d for d in self.a.lease_dirs.split(",") if (Path(d).expanduser() / f"lease-{lid}.json").exists()], f"lease-{lid}.json")
            want = {x.lower() for x in json.loads((Path(d).expanduser() / f"lease-{lid}.json").read_text())["domains"]}
            c.expect(lo <= instant(pub["at"]) <= hi and want & mine, f"second lease {lid} requested {pub['at']} for {sorted(want)}")
            c.expect(pub["status"] == "declined" or st["refused_to_others"] > 0, f"second lease {lid} status {pub['status']}; exclusive statement refused_to_others {st['refused_to_others']}")
            attempts += 1
        c.expect(attempts > 0, f"{attempts} second-buyer attempts given (--second-thread, --second-lease)")

    # 12
    def workload(self, c):
        dc = probe_rows(self.a.datacenter)
        dc_rate = 100 * sum(map(served, dc)) / len(dc)
        need = dc_rate + self.a.x
        c.info(f"datacenter {self.a.datacenter}: {sum(map(served, dc))} of {len(dc)} served = {dc_rate:.1f}%; a buyer needs >= {need:.1f}% (X = {self.a.x})")
        loads = dict(self.a.workload)
        if self.a.buyer_thread:
            c.expect(self.lease_id() in loads, f"buyer thread {self.a.buyer_thread} lease {self.lease_id()} has a workload log")
        for lid, log in loads.items():
            st = self.holder(lid)
            mine = {d.lower() for d in st["domains"]}
            rows = [r for r in probe_rows(log) if urlsplit(r["url"]).hostname in mine]
            ok = sum(map(served, rows))
            rate = 100 * ok / len(rows) if rows else 0
            c.expect(len(rows) >= 50, f"{lid}: {len(rows)} fetches to {sorted(mine)} in {log}")
            c.expect(st["requests_by_lease"] == len(rows), f"{lid}: signed statement requests_by_lease {st['requests_by_lease']} vs {len(rows)} logged")
            c.expect(rate >= need, f"{lid}: {ok} of {len(rows)} served = {rate:.1f}%")
            for r in rows:
                if not served(r):
                    c.info(f"  not served: {r['at']} {r['url']} {r['code']} {r['cls']} body {r['body']} end {r['end']} marker {r['marker']}")


CHECKS = [
    (1, "Hands-off", "hands_off"),
    (2, "Enrollment earned", "enrollment"),
    (3, "Deal fits both sides", "deal"),
    (4, "Delivery", "delivery"),
    (5, "Settlement exact", "settlement"),
    (6, "Decline path", "decline"),
    (7, "Claims backed", "claims"),
    (8, "No leaks", "leaks"),
    (9, "QA history", "qa_history"),
    (10, "Delisting works", "delisting"),
    (11, "Exclusive refusal", "exclusive_refusal"),
    (12, "Real workload", "workload"),
]
NEEDS = {6: "decline", 11: "exclusive_lease", 12: "workload"}


def main(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("seller_thread")
    p.add_argument("buyer_thread", nargs="?")
    p.add_argument("--start", help="start of the hands-off window, epoch seconds or ISO 8601")
    p.add_argument("--decline", help="buyer thread of the decline test")
    p.add_argument("--before", help="JSON from 'grade.py snapshot' taken before the journeys")
    p.add_argument("--seller-home", default="~/.config/souk-resip-seller")
    p.add_argument("--buyer-home", default="~/.config/souk-resip-buyer")
    p.add_argument("--creator-home", default="~/.config/souk-amin")
    p.add_argument("--web", default="~/projects/teleport/resip/worktrees/web", help="checkout of the web branch (probe-schedule.ts, buyer/resip.ts)")
    p.add_argument("--lease-dirs", default="~/.config/souk-resip-buyer/resip", help="comma-separated resip DIRs holding lease-<id>.json files")
    p.add_argument("--exclusive-lease", help="check 11: the exclusive lease of the run")
    p.add_argument("--second-thread", action="append", default=[], help="check 11: a second buyer's thread asking for the same domains")
    p.add_argument("--second-home", default="~/.config/souk-resip-buyer", help="check 11: the second buyer's credential directory")
    p.add_argument("--second-lease", action="append", default=[], help="check 11: a second buyer's resip lease for the same domains")
    p.add_argument("--workload", nargs=2, action="append", default=[], metavar=("LEASE_ID", "LOG"), help="check 12: a buyer's lease and its probe3.sh log")
    p.add_argument("--datacenter", help="check 12: probe3.sh log of the same workload from a datacenter IP")
    p.add_argument("--x", type=float, help="check 12: points the line must beat the datacenter rate by (PRD goal 4)")
    a = p.parse_args(argv)
    if a.seller_thread == "snapshot":
        seller, buyer = Member(a.seller_home), Member(a.buyer_home)
        print(json.dumps(dict(at=time.time(), credits={SELLER: seller.credits(), BUYER: buyer.credits()}), indent=1))
        return 0
    if not a.buyer_thread or not a.start:
        p.error("grading needs SELLER_THREAD BUYER_THREAD and --start")
    if a.workload and (a.datacenter is None or a.x is None):
        p.error("--workload needs --datacenter and --x")
    j, failed, skipped = Journey(a), 0, 0
    for n, name, method in CHECKS:
        if n in NEEDS and not getattr(a, NEEDS[n]):
            print(f"SKIP {n} {name}: no --{NEEDS[n].replace('_', '-')} given")
            skipped += 1
            continue
        c = Check()
        try:
            getattr(j, method)(c)
        except Missing as e:
            c.expect(False, f"missing: {e}")
        except KeyError as e:
            c.expect(False, f"missing field {e}")
        except json.JSONDecodeError as e:
            c.expect(False, f"unreadable JSON in a message: {e}")
        print(f"{'FAIL' if c.failed else 'PASS'} {n} {name}")
        print("\n".join(c.lines))
        failed += c.failed
    print(f"{failed} of {len(CHECKS) - skipped} checks failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

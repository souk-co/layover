"""The IP souk program on the Souk host engine, with a scripted judge and the resip site's
endpoints served from fixtures.json. Run with SOUK_REPO pointing at a souk-co/souk checkout:
  SOUK_REPO=... python -m pytest -q amin/test"""

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from build import bundle  # noqa: E402
from engine import Engine  # noqa: E402
from helpers import ScriptedAgent  # noqa: E402
from sandbox import Sandbox, check_sizes  # noqa: E402
from souk_credits import ledger  # noqa: E402
import souk_sdk  # noqa: E402
from souk_sdk import Invite, Joined, Member, Message  # noqa: E402
from store import Store  # noqa: E402
from tools import Tool  # noqa: E402

FIXTURES = json.loads((HERE / "fixtures.json").read_text())
RESIP = "https://pod.dstack.soc1024.com/resip-staging"
A_OK, A_BAD, A_H2 = (f"a0000000-0000-4000-8000-00000000000{i}" for i in (1, 2, 3))
L_END, L_DECL, L_ACT, L_SHARED, L_RAN_EXCL = (f"b0000000-0000-4000-8000-00000000000{i}" for i in (1, 2, 3, 4, 5))
POLICY = dict(categories=["price_check", "research"], floor_shared_per_gb=200, floor_exclusive_per_gb=400, max_minutes=120, exclusive=True, address="static", notes="")


def fetch(args, ctx):
    page = FIXTURES.get(args["url"].removeprefix(RESIP), {"error": "not found"})
    fetched = dict(status="ok", requested_url=args["url"], content=json.dumps(page), truncated=False, retrieved_at="2026-11-04T18:00:00Z")
    return {"type": "tool", "name": "web_fetch", "content": json.dumps(fetched)}


@pytest.fixture
def e(tmp_path):
    b = bundle()
    e = Engine(Store(tmp_path / "host.sqlite"), "ip", sandbox=Sandbox(local_unconfined=True), clock=lambda: 10)
    e.install(b.pop("souk.py"), bundle=b)
    e.tools["runtime.web_fetch"] = Tool("runtime.web_fetch", {"type": "object"}, False, fetch)
    for m in (Member("H", ("host",)), Member("B", ("buyer",)), Member("Arb", ("arbiter",))):
        e.store.db.execute("INSERT INTO persons (id, email) VALUES (?,?)", (m.person, m.person.lower() + "@example.com"))
        e.receive(Joined(m, souk=e.souk), deliver=False)
        e.guarded(None, "credits.grant", dict(member=m.person, amount=1000), call_id="grant:" + m.person)
        e.deliver()
    yield e
    assert not [x for x in e.store.events(e.souk) if x["kind"] in ("ActionError", "ProgramError")]
    s = ledger(e)
    assert sum(s["accounts"].values()) + sum(h["amount"] for h in s["holds"].values()) + sum(s["pools"].values()) == 3000
    assert e.replay() == e.store.view(e.souk)
    e.store.db.close()


def send(e, person, text, kind="message", thread=None):
    e.receive(Message(Member(person), text, souk=e.souk, thread=thread, kind=kind, at=10))
    e.deliver()


def agent(e, *calls):
    assert e.run_next(ScriptedAgent([(str(i), tool, args) for i, (tool, args) in enumerate(calls)]))
    e.deliver()


def journal(e, tool):
    return [j for j in e.rows("tool_journal").values() if j["tool"] == tool]


def denied(e, thread, tool, args):
    r = e.guarded(thread, tool, args, call_id=f"probe:{len(e.rows('tool_journal'))}:{tool}", origin="agent")
    return r["state"] == "denied" and r.get("reason", "")


def newest(e):
    return max(e.rows("threads"), key=lambda t: int(t.split("-")[1]))


def verify(e, t, appraisal=A_OK):
    for url in (f"{RESIP}/api/appraisals/{appraisal}/verified", f"{RESIP}/api/market"):
        e.guarded(t, "runtime.web_fetch", dict(url=url), call_id=f"verify:{len(e.rows('tool_journal'))}", origin="agent")
    e.deliver()


def enroll(e, appraisal=A_OK, owner_reported=None, host="H", policy=POLICY):
    send(e, host, json.dumps(dict(appraisal_id=appraisal, policy=policy, owner_reported=owner_reported or {})), kind="line")
    t = newest(e)
    url = f"{RESIP}/api/appraisals/{appraisal}/verified"
    assert denied(e, t, "record", dict(finding="enroll", state="qualified", reason="before fetching"))
    request = FIXTURES[f"/api/appraisals/{appraisal}/verified"]["request_id"]
    agent(e, ("runtime.web_fetch", dict(url=url)), ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisal-requests/{request}")), ("record", dict(finding="enroll", state="qualified", reason="attested")))
    return t


def lines(e):
    return [r["line"] for r in e.store.view(e.souk)["resident"] if "line" in r]


def lease(e, line, price=20, minutes=30, exclusive=True, price_per_gb=400):
    send(e, "B", json.dumps(dict(domains=["Example.com"], category="price_check", minutes=30, max_price=40, exclusive=exclusive)), kind="lease")
    t = newest(e)
    agent(
        e,
        ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified")), ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")),
        ("record", dict(finding="terms", state="proposed", reason="fits", line=line, price_per_gb=price_per_gb, price=price, minutes=minutes)),
        ("propose", dict(members=["B"], question="Lease example.com on the line for 30 minutes at 20 credits?")),
    )
    q = next(q for q in e.rows("questions").values() if q["thread"] == t)
    e.answer(q["id"], "B", "accept", at=20)
    e.deliver()
    return t


def settle(e, t, lease_id, state):
    send(e, "B", f"lease {lease_id}", thread=t)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{lease_id}/statement")), ("record", dict(finding="settle", state=state, reason="statement", lease_id=lease_id)))


def test_enroll_match_hold_settle(e):
    line = enroll(e, owner_reported=dict(cgnat=False, basis="router WAN equals echoed address"))
    [l] = lines(e)
    assert (l["agent_id"], l["exclusive_basis"], l["owner_reported"]["cgnat"]) == ("resip-mini-1", "owner-reported", False)
    t = lease(e, line)
    terms = e.rows("threads")[t]["records"]["terms"]
    assert (terms["domains"], terms["seller"], terms["basis"]) == (["example.com"], "H", "owner-reported")
    assert ledger(e)["accounts"]["B"] == 980
    assert "resip lease DIR example.com price_check exclusive 30 400 20" in json.dumps(e.read(t, "B"))
    settle(e, t, L_END, "settled")
    # 40 MB up and down at 400 credits per GB: 16 of the 20 credits held go to the host.
    assert ledger(e)["accounts"] == {"H": 1016, "B": 984, "Arb": 1000}
    assert denied(e, t, "runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{L_END}/statement"))


def test_shared_deal_shared_statement(e):
    t = lease(e, enroll(e), exclusive=False)
    assert "resip lease DIR example.com price_check shared 30 400 20" in json.dumps(e.read(t, "B"))
    settle(e, t, L_SHARED, "settled")
    assert ledger(e)["accounts"] == {"H": 1016, "B": 984, "Arb": 1000}
    assert "statement says exclusive" not in json.dumps(e.read(t, "B"))


def test_shared_deal_ran_exclusive(e):
    t = lease(e, enroll(e), exclusive=False)
    settle(e, t, L_RAN_EXCL, "settled")
    assert ledger(e)["accounts"] == {"H": 1016, "B": 984, "Arb": 1000}
    assert "the line's guest ran a shared lease as exclusive" in json.dumps(e.read(t, "B"))


def test_exclusive_deal_shared_statement_pays_nothing(e):
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    settle(e, t, L_SHARED, "settled")
    assert ledger(e)["accounts"] == {"H": 1000, "B": 1000, "Arb": 1000}


def test_overlap_follows_exclusivity(e):
    line = enroll(e, owner_reported=dict(cgnat=False))
    lease(e, line, exclusive=False)
    lease(e, line, exclusive=False)  # two shared deals on the same domains
    send(e, "B", json.dumps(dict(domains=["example.com"], category="price_check", minutes=30, max_price=40, exclusive=True)), kind="lease")
    verify(e, newest(e))
    assert "open exclusive lease" in denied(e, newest(e), "record", dict(finding="terms", state="proposed", reason="x", line=line, price_per_gb=400, price=20, minutes=30))


def test_tampered_appraisal_refused(e):
    send(e, "H", json.dumps(dict(appraisal_id=A_BAD, policy=POLICY)), kind="line")
    t = newest(e)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_BAD}/verified")))
    assert "report_data binds" in denied(e, t, "record", dict(finding="enroll", state="qualified", reason="x"))
    assert e.guarded(t, "record", dict(finding="enroll", state="disqualified", reason="report_data binds failed"), call_id="dq", origin="agent")["state"] == "done"
    e.deliver()
    assert lines(e) == []


def test_appraisal_of_another_member_refused(e):
    e.receive(Joined(Member("H2", ("host",)), souk=e.souk))
    e.deliver()
    send(e, "H2", json.dumps(dict(appraisal_id=A_OK, policy=POLICY)), kind="line")
    t = newest(e)
    request = FIXTURES[f"/api/appraisals/{A_OK}/verified"]["request_id"]
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified")), ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisal-requests/{request}")))
    assert "requested by someone else" in denied(e, t, "record", dict(finding="enroll", state="qualified", reason="x"))


def test_decline_releases_hold(e):
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    assert ledger(e)["accounts"]["B"] == 980
    settle(e, t, L_DECL, "settled")  # the program corrects the state to released
    assert ledger(e)["accounts"] == {"H": 1000, "B": 1000, "Arb": 1000}
    assert e.rows("threads")[t]["records"]["settle"]["state"] == "released"


def ended(n, up, down, by_period=True):
    lid = f"b0000000-0000-4000-8000-0000000001{n:02d}"
    FIXTURES[f"/api/leases/{lid}/statement"] = FIXTURES[f"/api/leases/{L_END}/statement"] | dict(
        lease_id=lid, bytes_up=up, bytes_down=down, bytes_by_period=[dict(start="2026-11-04T18:00:00.000Z", bytes_up=up, bytes_down=down)] if by_period else None)
    return lid


# Claim = (bytes_up + bytes_down) × price_per_gb / 10^9 credits rounded up, at most the funds held; a crash statement (no log) bills nothing.
# 212 B up and 411,460 B down is the 2026-11-06 lease (thread-89) that rounded down to 0 credits.
@pytest.mark.parametrize("up,down,by_period,host", [(1_000_000, 39_000_000, True, 1016), (2_000, 2_498_000, True, 1001), (0, 0, True, 1000), (212, 411_460, True, 1001),
                                                    (10_000_000, 90_000_000, True, 1020), (1_000_000, 39_000_000, False, 1000)])
def test_lease_settles_per_gb(e, up, down, by_period, host):
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    terms = e.rows("threads")[t]["records"]["terms"]
    assert (terms["price_per_gb"], terms["price"], terms["exclusive"]) == (400, 20, True)
    assert ledger(e)["accounts"]["B"] == 980
    settle(e, t, ended(1, up, down, by_period), "settled")
    assert ledger(e)["accounts"] == {"H": host, "B": 2000 - host, "Arb": 1000}
    assert f"{host - 1000} credits to the seller" in said(e, t)


@pytest.mark.parametrize("lease_id,state,host", [(L_END, "settled", 1016), (L_DECL, "settled", 1000)])
def test_settle_without_lease_id(e, lease_id, state, host):
    # The live agent records the settlement as finding, state and reason only (thread-20, 2026-11-05).
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    send(e, "B", f"lease {lease_id}", thread=t)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{lease_id}/statement")), ("record", dict(finding="settle", state=state, reason="statement")))
    assert e.rows("threads")[t]["records"]["settle"]["lease_id"] == lease_id
    assert ledger(e)["accounts"] == {"H": host, "B": 2000 - host, "Arb": 1000}


def test_settle_without_lease_id_names_the_fetched_statements(e):
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    send(e, "B", f"lease {L_END}", thread=t)
    agent(e, *(("runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{x}/statement")) for x in (L_END, L_ACT)))
    assert f"{L_END}, {L_ACT}" in denied(e, t, "record", dict(finding="settle", state="settled", reason="x"))


def test_active_lease_rechecks(e):
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    send(e, "B", f"lease {L_ACT}", thread=t)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{L_ACT}/statement")))
    assert "active" in denied(e, t, "record", dict(finding="settle", state="settled", reason="x", lease_id=L_ACT))
    assert "0 of 0 finished periods covered, one period in progress" in json.dumps([e.rows(k) for k in ("threads", "tool_journal")])
    queued = len(e.rows("runs"))
    e.advance(400)
    assert len(e.rows("runs")) == queued + 1


def test_active_lease_rereads_just_after_its_term(e, monkeypatch):
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    st = FIXTURES[f"/api/leases/{L_ACT}/statement"]
    monkeypatch.setitem(FIXTURES, f"/api/leases/{L_ACT}/statement", st | dict(window=st["window"] | dict(term_end="1970-01-01T00:01:40.000Z")))
    send(e, "B", f"lease {L_ACT}", thread=t)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{L_ACT}/statement")))
    queued = len(e.rows("runs"))
    e.advance(120)
    assert len(e.rows("runs")) == queued
    e.advance(131)  # term_end (100) + 30 s, well before the 5-minute recheck
    assert len(e.rows("runs")) == queued + 1


def test_guards(e):
    line = enroll(e)
    assert lines(e)[0]["exclusive_basis"] == "souk"  # cgnat not_checked and nothing owner-reported: exclusive within the souk only
    send(e, "B", json.dumps(dict(domains=["example.com"], category="price_check", minutes=30, max_price=40, exclusive=True)), kind="lease")
    t = newest(e)
    verify(e, t)
    terms = dict(finding="terms", state="proposed", reason="x", line=line, minutes=30, price_per_gb=400)
    assert not denied(e, t, "record", terms | dict(price=20))  # exclusive within the souk
    agent(e)  # Finish the queued lease run before scripting a different thread's enrollment.
    shared_only = enroll(e, policy=POLICY | dict(exclusive=False))
    assert next(v for v in lines(e) if v["line"] == shared_only)["exclusive_basis"] is None
    assert "shared leases only" in denied(e, t, "record", terms | dict(line=shared_only, price=20))
    terms["line"] = shared_only
    send(e, "B", json.dumps(dict(domains=["example.com"], category="account_operation", minutes=30, max_price=40, exclusive=False)), kind="lease")
    t2 = newest(e)
    verify(e, t2)
    assert "owner allows only" in denied(e, t2, "record", terms | dict(price=20))
    send(e, "B", json.dumps(dict(domains=["example.com"], category="research", minutes=30, max_price=40, exclusive=False)), kind="lease")
    t3 = newest(e)
    verify(e, t3)
    assert "floor" in denied(e, t3, "record", terms | dict(price=20, price_per_gb=100))
    assert "maximum" in denied(e, t3, "record", terms | dict(price=50))
    assert denied(e, t3, "propose", dict(members=["B"], question="?"))
    assert denied(e, t3, "credits.hold", dict(member="B", amount=1))
    assert denied(e, t3, "runtime.web_fetch", dict(url="https://example.com/"))
    assert denied(e, t3, "runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{L_END}/statement"))  # nothing held yet
    assert denied(e, line, "runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_BAD}/verified"))  # not this line's appraisal
    send(e, "B", json.dumps(dict(domains=["example.com"], category="research", minutes=30, max_price=40, exclusive=False)), kind="line")
    assert "host role" in json.dumps(e.inbox("B"))


def lease_thread(e, exclusive=False):
    send(e, "B", json.dumps(dict(domains=["example.com"], category="price_check", minutes=30, max_price=40, exclusive=exclusive)), kind="lease")
    return newest(e)


def terms(line, price_per_gb=400):
    return dict(finding="terms", state="proposed", reason="x", line=line, price_per_gb=price_per_gb, price=20, minutes=30)


@pytest.mark.parametrize("field,value", [("pass", False), ("guest_version", "43b46090"), ("guest_version", "810fcab9"), ("at", "1969-12-01T00:00:00.000Z")])
def test_stale_line_refused_at_match(e, monkeypatch, field, value):
    line = enroll(e)
    t = lease_thread(e)
    assert "not verified in this run" in denied(e, t, "record", terms(line))
    monkeypatch.setitem(FIXTURES[f"/api/appraisals/{A_OK}/verified"], field, value)
    verify(e, t)
    assert "not verified in this run" in denied(e, t, "record", terms(line))


def test_verification_is_per_run(e):
    line = enroll(e)
    t = lease_thread(e)
    verify(e, t)
    send(e, "B", "any news?", thread=t)  # a new message starts a new run
    assert "not verified in this run" in denied(e, t, "record", terms(line))
    verify(e, t)
    assert e.guarded(t, "record", terms(line), call_id="ok", origin="agent")["state"] == "done"
    e.deliver()
    send(e, "B", "still there?", thread=t)
    assert "not verified in this run" in denied(e, t, "propose", dict(members=["B"], question="?"))


def test_superseding_line_replaces_old(e):
    old = enroll(e)
    new = enroll(e, owner_reported=dict(cgnat=False))
    [l] = [x for x in lines(e) if x["line"] == new]
    assert l["exclusive_basis"] == "owner-reported"
    assert f"It supersedes line {old}" in json.dumps(e.read(new, "H"))
    assert dict(line=old, status="superseded", by=new) in [r["line_status"] for r in e.store.view(e.souk)["resident"] if "line_status" in r]
    settle(e, lease(e, new), L_END, "settled")
    assert ledger(e)["accounts"] == {"H": 1016, "B": 984, "Arb": 1000}
    t = lease_thread(e)
    verify(e, t)
    assert "Name an enrolled line" in denied(e, t, "record", terms(old))


def test_lease_match_sees_one_row_per_listed_line(e):
    # #149: the match run read every resident record and the runtime cut that context to its head and tail.
    old = enroll(e)
    new = enroll(e, owner_reported=dict(cgnat=False))
    t = lease_thread(e)
    run = next(r for r in e.rows("runs").values() if r["thread"] == t)
    assert run["see"] == ["thread"]
    [x] = [c for c in e.agent_context(run) if c.get("kind") == "lease_lines"]
    d = json.loads(x["text"])
    assert [(r["line"], r["exclusive_basis"], r["references"]) for r in d["lines"]] == [(new, "owner-reported", [])] and d["buyer"] == []
    assert old not in json.dumps(e.agent_context(run))
    assert "lease_lines" not in json.dumps(e.read(t, "B"))
    send(e, "B", "any news?", thread=t)  # the same lines are not stored again
    assert len([c for c in e.agent_context(run) if c.get("kind") == "lease_lines"]) == 1


def test_line_held_by_another_member_refused(e):
    enroll(e)
    e.receive(Joined(Member("H2", ("host",)), souk=e.souk))
    e.deliver()
    send(e, "H2", json.dumps(dict(appraisal_id=A_H2, policy=POLICY)), kind="line")
    t = newest(e)
    request = FIXTURES[f"/api/appraisals/{A_H2}/verified"]["request_id"]
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_H2}/verified")), ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisal-requests/{request}")))
    assert "already enrolled by another member" in denied(e, t, "record", dict(finding="enroll", state="qualified", reason="x"))


def test_withdrawn_line_never_matched(e):
    line = enroll(e)
    send(e, "H", "withdraw", kind="withdraw", thread=line)
    assert "is withdrawn" in json.dumps(e.read(line, "H"))
    t = lease_thread(e)
    assert denied(e, t, "runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified"))
    assert "Name an enrolled line" in denied(e, t, "record", terms(line))
    agent(e)


def test_floors(e):
    line = enroll(e, owner_reported=dict(cgnat=False))
    t = lease_thread(e, exclusive=False)
    verify(e, t)
    assert "shared floor is 200 credits per GB" in denied(e, t, "record", terms(line, price_per_gb=199))
    assert not denied(e, t, "record", terms(line, price_per_gb=200))
    t = lease_thread(e, exclusive=True)
    verify(e, t)
    assert "exclusive floor is 400 credits per GB" in denied(e, t, "record", terms(line, price_per_gb=399))
    assert not denied(e, t, "record", terms(line, price_per_gb=400))


@pytest.mark.parametrize("guest_version", ["43b46090", "810fcab9"])
def test_unpinned_appraisal_refused_at_enroll(e, monkeypatch, guest_version):
    monkeypatch.setitem(FIXTURES[f"/api/appraisals/{A_OK}/verified"], "guest_version", guest_version)
    send(e, "H", json.dumps(dict(appraisal_id=A_OK, policy=POLICY)), kind="line")
    t = newest(e)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified")), ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")))
    assert "not from the pinned minion" in denied(e, t, "record", dict(finding="enroll", state="qualified", reason="x"))


def test_accept_after_withdrawal_holds_nothing(e):
    line = enroll(e)
    t = lease_thread(e)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified")), ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")), ("record", terms(line)), ("propose", dict(members=["B"], question="?")))
    send(e, "H", "withdraw", kind="withdraw", thread=line)
    q = next(q for q in e.rows("questions").values() if q["thread"] == t)
    e.answer(q["id"], "B", "accept", at=20)
    e.deliver()
    assert ledger(e)["accounts"]["B"] == 1000
    assert "nothing was held" in json.dumps(e.read(t, "B"))


def test_second_exclusive_accept_conflicts(e):
    line = enroll(e)
    threads = []
    for _ in range(2):
        send(e, "B", json.dumps(dict(domains=["example.com"], category="price_check", minutes=30, max_price=40, exclusive=True)), kind="lease")
        t = newest(e)
        agent(
            e,
            ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified")), ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")),
            ("record", dict(finding="terms", state="proposed", reason="fits", line=line, price_per_gb=400, price=20, minutes=30)),
            ("propose", dict(members=["B"], question="Exclusive example.com for 30 minutes at 20 credits?")),
        )
        threads.append(t)
    for t in threads:
        q = next(q for q in e.rows("questions").values() if q["thread"] == t)
        e.answer(q["id"], "B", "accept", at=20)
        e.deliver()
    flags = [set(e.rows("threads")[t]["flags"]) for t in threads]
    assert "accepted" in flags[0] and "accepted" not in flags[1] and "closed" in flags[1]



def probe(n, ok=True, same=True):
    return {"request_id": f"r{n}", "status": "done", "probe_id": f"p{n}", "pass": ok, "error": None if ok else "custody refused", "report_at": "2026-11-05T15:41:26Z", "same_ip_as_last": same}


def listed(e, line):
    st = [r["line_status"] for r in e.store.view(e.souk)["resident"] if "line_status" in r and r["line_status"]["line"] == line]
    return not st or st[-1]["status"] == "relisted"


def qa(e, at):
    e.advance(at)
    e.deliver()
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/agents/resip-mini-1/probes?limit=3")))


def test_line_whose_guest_stopped_polling_is_refused(e, monkeypatch):
    line = enroll(e)
    t = lease_thread(e)
    e.guarded(t, "runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified"), call_id="v0", origin="agent")
    e.deliver()
    assert "no /api/market read in this run" in denied(e, t, "record", terms(line))
    monkeypatch.setitem(FIXTURES["/api/market"]["lines"][0], "polled_at", "2026-11-05T17:58:59.000Z")
    verify(e, t)
    assert "has not polled the site within 60 s" in denied(e, t, "record", terms(line))
    monkeypatch.setitem(FIXTURES["/api/market"]["lines"][0], "polled_at", None)
    verify(e, t)
    assert "has not polled the site within 60 s" in denied(e, t, "record", terms(line))
    monkeypatch.setitem(FIXTURES["/api/market"], "lines", [])
    verify(e, t)
    assert "has not polled the site within 60 s" in denied(e, t, "record", terms(line))
    monkeypatch.undo()
    verify(e, t)
    assert not denied(e, t, "record", terms(line))
    agent(e)


A_NEW, R_NEW = "a0000000-0000-4000-8000-000000000009", "c0000000-0000-4000-8000-000000000009"


def rotated(monkeypatch, requested_by="H", other_check=False, agent_id="resip-mini-1", ok=True):
    """The enrolled appraisal fails its App Attest check (live: key 13dc6356 after the Mini's re-key); a newer one exists."""
    old = json.loads(json.dumps(FIXTURES[f"/api/appraisals/{A_OK}/verified"]))
    old["pass"] = False
    for c in old["checks"]:
        c["pass"] = not (c["name"].startswith("App Attest") or (other_check and c["name"] == "measurement allowed"))
    new = json.loads(json.dumps(FIXTURES[f"/api/appraisals/{A_OK}/verified"])) | {"id": A_NEW, "request_id": R_NEW, "at": "2026-11-06T09:32:52.000Z", "agent_id": agent_id, "pass": ok}
    monkeypatch.setitem(FIXTURES, f"/api/appraisals/{A_OK}/verified", old)
    monkeypatch.setitem(FIXTURES, f"/api/appraisals/{A_NEW}/verified", new)
    monkeypatch.setitem(FIXTURES, "/api/agents/resip-mini-1/appraisals?limit=1", [new])
    monkeypatch.setitem(FIXTURES, f"/api/appraisal-requests/{R_NEW}", dict(id=R_NEW, agent_id=agent_id, requested_by=requested_by, status="done", appraisal_id=A_NEW, error=None))
    monkeypatch.setitem(FIXTURES, "/api/agents/resip-mini-1/probes?limit=3", [probe(1)])


def qa_refresh(e):
    e.advance(920)
    e.deliver()
    agent(e, *(("runtime.web_fetch", dict(url=RESIP + u)) for u in ("/api/agents/resip-mini-1/probes?limit=3", f"/api/appraisals/{A_OK}/verified",
          "/api/agents/resip-mini-1/appraisals?limit=1", f"/api/appraisals/{A_NEW}/verified", f"/api/appraisal-requests/{R_NEW}")))


@pytest.mark.parametrize("requested_by", ["H", "resip-staging scheduler"])
def test_line_refreshes_to_a_newer_appraisal_after_a_key_rotation(e, monkeypatch, requested_by):
    line = enroll(e)
    rotated(monkeypatch, requested_by)
    qa_refresh(e)
    assert [x["appraisal_id"] for x in lines(e)][-1] == A_NEW and "now rests on appraisal " + A_NEW in json.dumps(e.rows("tool_journal"))
    t = lease_thread(e)
    verify(e, t, A_NEW)
    assert not denied(e, t, "record", terms(line))
    agent(e)


@pytest.mark.parametrize("kw", [dict(requested_by="B"), dict(other_check=True), dict(agent_id="resip-mini-2"), dict(ok=False)])
def test_no_refresh_unless_only_the_key_rotated(e, monkeypatch, kw):
    enroll(e)
    rotated(monkeypatch, **kw)
    qa_refresh(e)
    assert [x["appraisal_id"] for x in lines(e)] == [A_OK]


def pin_moved(monkeypatch, requested_by="resip-staging scheduler"):
    """The enrolled appraisal still names the guest the line enrolled on; the pin has moved and a newer appraisal on the new pin exists."""
    old = json.loads(json.dumps(FIXTURES[f"/api/appraisals/{A_OK}/verified"])) | {"guest_version": "810fcab9"}
    new = json.loads(json.dumps(FIXTURES[f"/api/appraisals/{A_OK}/verified"])) | {"id": A_NEW, "request_id": R_NEW, "at": "2026-11-06T15:15:30.000Z"}
    monkeypatch.setitem(FIXTURES, f"/api/appraisals/{A_OK}/verified", old)
    monkeypatch.setitem(FIXTURES, f"/api/appraisals/{A_NEW}/verified", new)
    monkeypatch.setitem(FIXTURES, "/api/agents/resip-mini-1/appraisals?limit=1", [new])
    monkeypatch.setitem(FIXTURES, f"/api/appraisal-requests/{R_NEW}", dict(id=R_NEW, agent_id="resip-mini-1", requested_by=requested_by, status="done", appraisal_id=A_NEW, error=None))
    monkeypatch.setitem(FIXTURES, "/api/agents/resip-mini-1/probes?limit=3", [probe(1)])


@pytest.mark.xfail(reason="repro #122: a pin bump leaves the line on the appraisal it enrolled with (refresh covers only an App Attest failure), so every fetch on it is refused")
def test_line_moves_to_its_newest_appraisal_after_a_pin_move(e, monkeypatch):
    line = enroll(e)
    pin_moved(monkeypatch)
    qa_refresh(e)
    assert [x["appraisal_id"] for x in lines(e)][-1] == A_NEW
    t = lease_thread(e)
    verify(e, t, A_NEW)
    assert not denied(e, t, "record", terms(line))
    agent(e)


def test_qa_delists_and_relists(e):
    line = enroll(e)
    url = "/api/agents/resip-mini-1/probes?limit=3"
    FIXTURES[url] = [probe(2), probe(1, ok=False)]
    qa(e, 920)
    assert listed(e, line)
    # One failed probe delists (live: an expired probe after the Mini rebooted); the next run's match refuses the line.
    FIXTURES[url] = [{"request_id": "r3", "status": "expired", "probe_id": None, "pass": False, "error": "no probe report within 10 minutes"}, probe(2)]
    qa(e, 1830)
    assert not listed(e, line) and "delisted by QA: the newest probe failed (probe r3 did not pass (no probe report within 10 minutes))" in json.dumps(e.rows("tool_journal"))
    t = lease_thread(e)
    assert "Name an enrolled line" in denied(e, t, "record", terms(line))
    FIXTURES[url] = [{"request_id": "r4", "status": "open", "probe_id": None, "pass": None, "error": None}, probe(3, ok=False)]
    qa(e, 2740)
    assert not listed(e, line)
    # One pass relists, by rule, with no other step.
    FIXTURES[url] = [probe(5), probe(4, ok=False)]
    qa(e, 3650)
    assert listed(e, line) and "listed again" in json.dumps(e.rows("tool_journal"))
    del FIXTURES[url]


def test_static_line_delisted_for_new_address_and_relisted_when_it_holds(e):
    line = enroll(e)
    url = "/api/agents/resip-mini-1/probes?limit=3"
    FIXTURES[url] = [probe(2, same=False), probe(1)]
    qa(e, 920)
    assert not listed(e, line)
    FIXTURES[url] = [probe(3), probe(2, same=False)]
    qa(e, 1830)
    assert listed(e, line)
    del FIXTURES[url]


def test_failed_statement_fetch_still_rechecks(e):
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    missing = "b0000000-0000-4000-8000-000000000099"
    send(e, "B", f"lease {missing}", thread=t)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{missing}/statement")))
    runs = lambda: len([r for r in e.rows("runs").values() if r["thread"] == t])
    queued = runs()
    e.advance(400)
    assert runs() == queued + 1
    e.advance(800)  # one poll run at a time: the queued one has not run yet
    assert runs() == queued + 1
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/leases/{missing}/statement")))
    e.advance(1200)
    assert runs() == queued + 2


def test_rotating_line_not_delisted_for_new_address(e):
    line = enroll(e, policy=POLICY | dict(address="rotating"))
    url = "/api/agents/resip-mini-1/probes?limit=3"
    FIXTURES[url] = [probe(3, same=False), probe(2, same=False), probe(1)]
    qa(e, 920)
    assert listed(e, line)
    del FIXTURES[url]


def test_qa_fetch_is_the_amins_not_the_programs(e):
    line = enroll(e)
    url = "/api/agents/resip-mini-1/probes?limit=3"
    FIXTURES[url] = [probe(2, ok=False), probe(1, ok=False)]
    e.advance(920)
    e.deliver()
    assert not [j for j in journal(e, "runtime.web_fetch") if j["origin"] == "program"]
    assert listed(e, line)  # nothing read until the amin's run fetches
    assert denied(e, line, "runtime.web_fetch", dict(url=f"{RESIP}/api/agents/resip-mini-2/probes?limit=3"))
    agent(e, ("runtime.web_fetch", dict(url=RESIP + url)))
    assert not listed(e, line)
    assert not [j for j in journal(e, "runtime.web_fetch") if j["origin"] == "program"]
    del FIXTURES[url]


def fetch_deal(e, line, pages=5, max_price=5):
    send(e, "B", json.dumps(dict(domains=["www.redfin.com"], pages=pages, max_price=max_price)), kind="fetch")
    t = newest(e)
    assert e.rows("runs")[max(e.rows("runs"), key=lambda r: int(r.split(":")[0]))]["tools"] == ["runtime.web_fetch", "post"]
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified")), ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")))
    q = next(q for q in e.rows("questions").values() if q["thread"] == t)  # the program's card
    e.answer(q["id"], "B", "accept", at=20)
    e.deliver()
    return t


def bounty(t, n, status="done", served=5, requested=5, passed=True, agent_id="resip-mini-1", key=None):
    bid = f"d0000000-0000-4000-8000-00000000000{n}"
    done = status == "done"
    FIXTURES[f"/api/bounties/{bid}/statement"] = dict(bounty_id=bid, agent_id=agent_id, buyer_key=key or t, status=status, requested=requested if done else None,
                                                      served=served if done else None, attestation_pass=passed if done else None, at="2026-11-05T18:00:00.000Z", verified_by="resip-staging site")
    return bid


def named(e, t, bid):
    send(e, "B", f"bounty {bid}", thread=t)
    fetched(e, bid)


def fetched(e, bid):
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/bounties/{bid}/statement")))


def said(e, t):
    return json.dumps(e.read(t, "B"))


@pytest.mark.parametrize("served,passed,host", [(5, True, 1001), (4, True, 1001), (2, True, 1000), (7, True, 1001), (5, False, 1000)])
def test_fetch_job_settles_per_page(e, served, passed, host):
    t = fetch_deal(e, enroll(e))
    terms = e.rows("threads")[t]["records"]["terms"]
    assert (terms["price"], terms["pages"], terms["exclusive"], terms["domains"]) == (1, 5, False, ["www.redfin.com"])
    assert ledger(e)["accounts"]["B"] == 999
    assert f"resip bounty DIR {t} URLS 1" in said(e, t)
    named(e, t, bounty(t, 1, served=served, requested=max(served, 5), passed=passed))
    assert ledger(e)["accounts"] == {"H": host, "B": 2000 - host, "Arb": 1000}
    assert f"{host - 1000} credits to the seller" in said(e, t)


def test_fetch_card_is_the_programs(e, monkeypatch):
    line = enroll(e)
    send(e, "B", json.dumps(dict(domains=["www.redfin.com"], pages=5, max_price=5)), kind="fetch")
    t = newest(e)
    monkeypatch.setitem(FIXTURES["/api/market"]["lines"][0], "polled_at", "2026-11-05T17:58:59.000Z")
    e.guarded(t, "runtime.web_fetch", dict(url=f"{RESIP}/api/market"), call_id="m0", origin="agent")
    e.deliver()
    assert not e.rows("questions") and "cannot take" not in said(e, t)  # one read is not enough
    verify(e, t)
    assert f"Line {line} cannot take this job: its guest has not polled the site within 60 s" in said(e, t) and not e.rows("questions")
    monkeypatch.undo()
    monkeypatch.setitem(FIXTURES[f"/api/appraisals/{A_OK}/verified"], "pass", False)
    send(e, "B", "again", thread=t)  # a member message clears this run's reads
    verify(e, t)
    assert f"its appraisal {A_OK} fails the check" in said(e, t) and not e.rows("questions")
    monkeypatch.undo()
    send(e, "B", "again", thread=t)
    verify(e, t)
    [q] = e.rows("questions").values()
    assert q["proposal_id"] == t + ":proposal" and q["members"] == ["B"] and q["options"] == ["accept", "decline"]
    assert "5 pages on www.redfin.com, GET only, 1 credits ($0.01)" in q["prompt"] and "References for resip-mini-1: none yet." in q["prompt"]
    verify(e, t)
    assert len(e.rows("questions")) == 1


@pytest.mark.parametrize("status", ["declined", "expired"])
def test_fetch_job_released(e, status):
    t = fetch_deal(e, enroll(e))
    named(e, t, bounty(t, 1, status=status))
    assert ledger(e)["accounts"] == {"H": 1000, "B": 1000, "Arb": 1000}
    assert f"was {status}" in said(e, t)


def test_fetch_job_rechecks_until_done(e):
    t = fetch_deal(e, enroll(e), pages=20, max_price=10)
    assert e.rows("threads")[t]["records"]["terms"]["price"] == 3
    bid = bounty(t, 1, status="accepted")
    named(e, t, bid)
    assert "is accepted" in said(e, t)
    e.advance(75)  # the one-minute recheck
    fetched(e, bid)
    assert said(e, t).count("is accepted") == 1  # said once, when the recheck is armed
    bounty(t, 1, served=13, requested=20)
    e.advance(140)
    fetched(e, bid)
    # 13 of 20 pages at 3 credits: 1.95, rounded to 2.
    assert ledger(e)["accounts"] == {"H": 1002, "B": 998, "Arb": 1000}
    e.advance(800)
    e.deliver()
    assert ledger(e)["accounts"] == {"H": 1002, "B": 998, "Arb": 1000}


def test_fetch_job_failed_statement_fetch_rechecks(e):
    t = fetch_deal(e, enroll(e))
    bid = "d0000000-0000-4000-8000-000000000009"
    FIXTURES.pop(f"/api/bounties/{bid}/statement", None)
    named(e, t, bid)
    assert ledger(e)["accounts"]["B"] == 999
    bounty(t, 9)
    e.advance(400)
    fetched(e, bid)
    assert ledger(e)["accounts"] == {"H": 1001, "B": 999, "Arb": 1000}


@pytest.mark.parametrize("kw,why", [(dict(key="thread-1"), "not this thread's id"), (dict(agent_id="resip-mini-2"), "not the agreed line")])
def test_fetch_job_refuses_foreign_bounty(e, kw, why):
    t = fetch_deal(e, enroll(e))
    named(e, t, bounty(t, 1, **kw))
    assert why in said(e, t) and ledger(e)["accounts"]["B"] == 999
    named(e, t, bounty(t, 2))  # the claim was dropped, so the right bounty settles
    assert ledger(e)["accounts"] == {"H": 1001, "B": 999, "Arb": 1000}


def test_fetch_job_guards(e):
    line = enroll(e)
    send(e, "B", json.dumps(dict(domains=["www.redfin.com"], pages=1000, max_price=500)), kind="fetch")
    assert "pages must be 1 to 50" in json.dumps(e.inbox("B"))
    send(e, "B", json.dumps(dict(domains=["www.redfin.com"], pages=50, max_price=7)), kind="fetch")
    t = newest(e)
    verify(e, t)
    assert "posted rate for 50 pages is 8 credits, above your maximum of 7" in said(e, t) and not e.rows("questions")
    assert "records fetch-job terms itself" in denied(e, t, "record", dict(finding="terms", state="proposed", reason="x", line=line))
    assert denied(e, t, "runtime.web_fetch", dict(url=f"{RESIP}/api/bounties/d0000000-0000-4000-8000-000000000001/statement"))


def test_fetch_job_fetches_only_the_named_bounty(e):
    t = fetch_deal(e, enroll(e))
    other = f"{RESIP}/api/bounties/d0000000-0000-4000-8000-000000000002/statement"
    assert denied(e, t, "runtime.web_fetch", dict(url=other))  # nothing named yet
    send(e, "B", f"bounty {bounty(t, 1, status='accepted')}", thread=t)
    assert denied(e, t, "runtime.web_fetch", dict(url=other))


SITE = __import__("re").search(r'^SITE = "(.*)"', (HERE.parent / "souk.py").read_text(), __import__("re").M).group(1)


def push(e, bid, person=SITE):
    if person not in {m for m in e.store.view(e.souk)["members"]}:
        join(e, person, ("host", "buyer"))  # the doorman holds both roles
    send(e, person, json.dumps(FIXTURES[f"/api/bounties/{bid}/statement"]), kind="statement")


def queued(e):
    return [r for r in e.rows("runs").values() if r["state"] == "queued"]


def test_fetch_job_settles_on_the_sites_push_without_a_run(e):
    t = fetch_deal(e, enroll(e))
    bid = bounty(t, 1, served=4)
    runs = len(e.rows("runs"))
    push(e, bid)  # before the buyer names it: kept, not settled
    assert ledger(e)["accounts"]["B"] == 999 and len(e.rows("runs")) == runs
    send(e, "B", f"bounty {bid}", thread=t)  # settles in the program step, no run
    assert ledger(e)["accounts"] == {"H": 1001, "B": 999, "Arb": 1000} and len(e.rows("runs")) == runs
    assert f"Settled fetch job, bounty {bid}: 4 of 5" in said(e, t) and "(pushed)" in said(e, t)
    push(e, bid)
    assert said(e, t).count("Settled fetch job") == 1 and ledger(e)["accounts"]["H"] == 1001
    t2 = fetch_deal(e, lines(e)[0]["line"])  # named first, pushed after
    send(e, "B", f"bounty {bounty(t2, 2)}", thread=t2)
    push(e, "d0000000-0000-4000-8000-000000000002")
    assert "(pushed)" in said(e, t2)


def test_fetch_job_push_settles_only_the_named_bounty(e):
    t = fetch_deal(e, enroll(e))
    push(e, bounty(t, 1), person="B")
    assert "only the site pushes statements" in json.dumps(e.inbox("B")) and ledger(e)["accounts"]["B"] == 999
    push(e, bounty(t, 3, key=t))  # anyone can post a bounty under this thread's key: unnamed, it settles nothing
    push(e, bounty(t, 4, status="declined"))
    assert "Settled fetch job" not in said(e, t) and "was declined" not in said(e, t) and ledger(e)["accounts"]["B"] == 999
    send(e, "B", f"bounty {bounty(t, 2, status='accepted')}", thread=t)
    push(e, bounty(t, 2, status="declined"))
    assert "Bounty d0000000-0000-4000-8000-000000000002 was declined" in said(e, t) and ledger(e)["accounts"]["B"] == 1000


def test_fetch_job_poll_is_visible_one_run_at_a_time_and_quiet_after_settling(e):
    t = fetch_deal(e, enroll(e))
    bid = "d0000000-0000-4000-8000-000000000008"
    FIXTURES.pop(f"/api/bounties/{bid}/statement", None)
    named(e, t, bid)
    assert f"Reading bounty {bid}'s statement failed (not found)" in said(e, t)
    for at in (75, 140, 205):  # the host is busy: no run executes between timers
        e.advance(at)
        e.deliver()
    assert len([r for r in queued(e) if r["thread"] == t]) == 1
    push(e, bounty(t, 8))
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/bounties/{bid}/statement")))  # the poll run queued before settlement
    assert "This deal is settled; post nothing" in denied(e, t, "runtime.web_fetch", dict(url=f"{RESIP}/api/bounties/{bid}/statement"))
    assert said(e, t).count("failed") == 1 and said(e, t).count("Settled") == 1


def test_exclusive_lease_blocks_fetch_job(e):
    line = enroll(e, owner_reported=dict(cgnat=False))
    send(e, "B", json.dumps(dict(domains=["www.redfin.com"], category="price_check", minutes=30, max_price=40, exclusive=True)), kind="lease")
    lt = newest(e)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified")), ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")), ("record", terms(line)), ("propose", dict(members=["B"], question="?")))
    e.answer(next(q for q in e.rows("questions").values() if q["thread"] == lt)["id"], "B", "accept", at=20)
    e.deliver()
    send(e, "B", json.dumps(dict(domains=["www.redfin.com"], pages=5, max_price=5)), kind="fetch")
    t = newest(e)
    verify(e, t)
    assert "open exclusive lease" in said(e, t) and not e.rows("threads")[t]["records"]


FLEET = f"{RESIP}/api/couch-slots"
MAC = "0xa43f9f32411358c1319cb36027650a206644c131"


def couch(e, slot_id=3, accept=True):
    send(e, "B", json.dumps(dict(task="build and test a Rust crate", minutes=20)), kind="couch")
    t = newest(e)
    assert "Fetch" in denied(e, t, "record", dict(finding="terms", state="proposed", reason="x", publisher=MAC, slot_id=slot_id, minutes=20))
    agent(e, ("runtime.web_fetch", dict(url=FLEET)),
          ("record", dict(finding="terms", state="proposed", reason="slot 3 is ready with no error", publisher=MAC.upper().replace("0X", "0x"), slot_id=slot_id, minutes=20)),
          ("propose", dict(members=["B"], question="Slot 3 of the Mini for 20 minutes at the broker's rate?")))
    if accept:
        e.answer(next(q for q in e.rows("questions").values() if q["thread"] == t)["id"], "B", "accept", at=20)
        e.deliver()
    return t


def stay(t, slot_id=3, **over):
    r = dict(sessionId="df01a744433022cc431fc2f8b8a547e7", relay_peer="12D3KooWAfVNm6U6UZWB5jMudQecRqNy3J3tAjJFCE7NSozx3dwM",
             placement=dict(publisher=MAC, slot_id=slot_id), guestSeconds=4, rateNanoUsdPerSecond="15000", chargedNanoUsd="900000",
             closedReason="owner", receiptSigner="0xf5709eb7d33debd83f4e2100bddee9513155aaf4", operator="0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b",
             wallet="0x64870e5a36afcfa2f21d9b6a878ac34bf95bf480")
    return "stay " + json.dumps(r | over)


def test_couch_propose_accept_settle_moves_no_credits(e):
    t = couch(e)
    terms = e.rows("threads")[t]["records"]["terms"]
    assert (terms["publisher"], terms["slot_id"], terms["rate_nano_usd_per_second"], terms["task"]) == (MAC, 3, 15000, "build and test a Rust crate")
    posts = json.dumps(e.read(t, "B"))
    assert 'stay_open {\\"publisher\\": \\"' + MAC + '\\", \\"slot_id\\": 3, \\"conversation_id\\": \\"' + t in posts
    assert "15000 nano-USD per active guest second ($0.0009 per minute, 60 s minimum)" in posts
    assert not journal(e, "credits.hold") and ledger(e)["accounts"]["B"] == 1000
    r = e.guarded(t, "credits.hold", dict(thread=t, member="B", amount=1), call_id="couch-hold", origin="program")
    assert r["state"] == "denied" and "No credits move" in r["reason"]
    assert denied(e, t, "runtime.web_fetch", dict(url=FLEET))  # the fleet is read before terms only
    send(e, "B", stay(t), thread=t)
    posts = json.dumps(e.read(t, "B"))
    assert "Stay df01a744433022cc431fc2f8b8a547e7 on slot 3" in posts and "900000 nano-USD ($0.0009) charged" in posts and "the amin moved no money" in posts
    assert "settled" in e.rows("threads")[t]["flags"]
    send(e, "B", stay(t), thread=t)
    assert "already recorded" in json.dumps(e.read(t, "B"))
    assert ledger(e)["accounts"] == {"H": 1000, "B": 1000, "Arb": 1000}


def test_couch_terms_need_a_ready_slot_of_an_online_mac(e):
    send(e, "B", json.dumps(dict(task="t", minutes=90)), kind="couch")
    assert "minutes must be 1 to 60" in json.dumps(e.inbox("B"))
    send(e, "B", json.dumps(dict(task="run tests", minutes=20)), kind="couch")
    t = newest(e)
    assert denied(e, t, "runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified"))
    e.guarded(t, "runtime.web_fetch", dict(url=FLEET), call_id="fleet", origin="agent")
    e.deliver()
    for publisher, slot in ((MAC, 1), (MAC, 2), (MAC, 7), ("0x00000000000000000000000000000000000000aa", 0)):
        assert "not a ready, verified slot" in denied(e, t, "record", dict(finding="terms", state="proposed", reason="x", publisher=publisher, slot_id=slot, minutes=20))
    assert "minutes must be" in denied(e, t, "record", dict(finding="terms", state="proposed", reason="x", publisher=MAC, slot_id=3, minutes=30))
    send(e, "B", "is a GPU available?", thread=t)  # a member message ends the run's fleet freshness
    assert "Fetch" in denied(e, t, "record", dict(finding="terms", state="proposed", reason="x", publisher=MAC, slot_id=3, minutes=20))


def test_couch_settlement_must_match_terms(e):
    t = couch(e)
    for bad, why in ((dict(placement=dict(publisher=MAC, slot_id=0)), "not the agreed slot"), (dict(rateNanoUsdPerSecond="1"), "not the posted 15000"),
                     (dict(chargedNanoUsd="1"), "not the broker's charge"), (dict(sessionId="x"), "not a broker session id")):
        send(e, "B", stay(t, **bad), thread=t)
        assert why in json.dumps(e.read(t, "B"))
    assert "settled" not in e.rows("threads")[t]["flags"]


# The broker adds the host's posted browse surcharge (operator.json browse.price) to the rate: named is per host, open only above a non-open default.
@pytest.mark.parametrize("browse,rate,ok", [(dict(mode="named", hosts=["redfin.com"]), 15100, True), (dict(mode="named", hosts=["a.com", "b.com"]), 15200, True),
                                            (dict(mode="open", hosts=[]), 20000, True), (dict(mode="named", hosts=["redfin.com"]), 15000, False), (None, 15100, False)])
def test_couch_settles_at_the_posted_browse_rate(e, browse, rate, ok):
    t = couch(e)
    assert e.rows("threads")[t]["records"]["terms"]["browse"] == dict(default="named", open=5000, named=100)
    send(e, "B", stay(t, rateNanoUsdPerSecond=str(rate), chargedNanoUsd=str(60 * rate), **({"browse": browse} if browse else {})), thread=t)
    assert ("settled" in e.rows("threads")[t]["flags"]) == ok
    assert ok or f"its rate is {rate}, not the posted" in json.dumps(e.read(t, "B"))


def test_couch_declined(e):
    t = couch(e, accept=False)
    e.answer(next(q for q in e.rows("questions").values() if q["thread"] == t)["id"], "B", "decline", at=20)
    e.deliver()
    assert "declined or expired" in json.dumps(e.read(t, "B"))


def join(e, person, roles):
    e.store.db.execute("INSERT INTO persons (id, email) VALUES (?,?)", (person, person.lower() + "@example.com"))
    e.receive(Joined(Member(person, roles), souk=e.souk))
    e.deliver()


STARTER = 50


def test_starter_credit_from_the_funded_pot(e):
    # B joined in the fixture before any pot existed: the payout failed and moved nothing (the host journals a raised tool call
    # as "failed" since souk-co/souk #707; it was "unknown" before).
    assert [j["state"] for j in journal(e, "credits.pay")] == ["failed"] and ledger(e)["accounts"]["B"] == 1000
    send(e, "Arb", json.dumps(dict(amount=3 * STARTER)), kind="fund")
    send(e, "Arb", json.dumps(dict(amount=STARTER)), kind="fund")
    assert len(journal(e, "credits.open_pool")) == 1 and ledger(e)["pools"]["starter"] == 4 * STARTER
    join(e, "N", ("buyer",))
    join(e, "H3", ("host",))
    s = ledger(e)
    assert s["accounts"]["N"] == STARTER and "H3" not in s["accounts"] and s["pools"]["starter"] == 3 * STARTER
    assert s["accounts"]["Arb"] == 1000 - 4 * STARTER


def test_only_an_arbiter_funds_the_pot(e):
    send(e, "B", json.dumps(dict(amount=10)), kind="fund")
    assert not journal(e, "credits.fund") and ledger(e)["accounts"]["B"] == 1000
    assert "Only an arbiter funds the starter pot." in json.dumps(e.inbox("B"))


def test_empty_pot_pays_nothing(e):
    join(e, "N", ("buyer",))
    assert "N" not in ledger(e)["accounts"] and journal(e, "credits.pay")[-1]["result"] == {"error": "unknown pool"}


def test_starter_outcome_is_private_and_distinguishes_funding_failures(e):
    join(e, "N", ("buyer",))
    assert "starter_pool_not_configured" in json.dumps(e.inbox("N"))
    assert "starter_pool_not_configured" not in json.dumps(e.inbox("H"))
    send(e, "Arb", json.dumps(dict(amount=STARTER)), kind="fund")
    join(e, "Paid", ("buyer",))
    notice = next(json.loads(row["payload"]["text"]) for row in e.inbox("Paid")
        if row["kind"] == "Output" and "trial_credit" in row["payload"]["text"])
    assert notice["status"] == "ready" and notice["granted"] == STARTER
    assert notice["reason"] == "granted" and notice["rail"] == "souk"
    join(e, "Empty", ("buyer",))
    assert "starter_pool_unfunded" in json.dumps(e.inbox("Empty"))
    assert "Empty" not in ledger(e)["accounts"]
    assert ledger(e)["accounts"]["Paid"] == STARTER


def test_unknown_starter_outcome_never_claims_a_grant_or_retries(e):
    from souk_sdk import ToolDone
    join(e, "N", ("buyer",))
    before = len(journal(e, "credits.pay"))
    event = ToolDone(tool="credits.pay", args=dict(pool="starter", payouts={"N": STARTER}),
        result=None, origin="program", state="unknown", souk="ip")
    e.receive(event)
    e.deliver()
    notice = next(json.loads(row["payload"]["text"]) for row in reversed(e.inbox("N"))
        if row["kind"] == "Output" and "payment_outcome_unknown" in row["payload"]["text"])
    assert notice["status"] == "unknown" and notice["granted"] is None
    assert notice["reason"] == "payment_outcome_unknown"
    assert len(journal(e, "credits.pay")) == before and "N" not in ledger(e)["accounts"]


def test_bundle_comment_removal_preserves_python_and_string_contents():
    import ast
    from build import program_source
    source = 'value = "# keep this"  # remove this\ntext = """hello\n# also keep this\n"""\n'
    result = program_source(source)
    assert ast.dump(ast.parse(result)) == ast.dump(ast.parse(source))
    assert "# keep this" in result and "# also keep this" in result and "# remove this" not in result
    raw = (HERE.parent / "souk.py").read_text()
    assert ast.dump(ast.parse(program_source(raw))) == ast.dump(ast.parse(raw))
    check_sizes(bundle())


def test_accepted_couch_stay_does_not_break_line_terms(e):
    couch(e)
    t = fetch_deal(e, enroll(e))
    assert e.rows("threads")[t]["records"]["terms"]["price"] == 1


@pytest.mark.parametrize("line", [["thread-2"], {"line": "thread-2"}])
def test_line_not_an_id_is_denied_not_a_sandbox_failure(e, line):
    enroll(e)
    t = lease_thread(e)
    verify(e, t)
    assert "Name an enrolled line by its id" in denied(e, t, "record", terms(line))


def refer(e, person, deal, text, up=None):
    send(e, person, json.dumps(dict(deal=deal, text=text) | ({} if up is None else dict(up=up))), kind="reference")
    return [x for x in e.inbox(person) if x["kind"] == "Output"][-1]["payload"]["text"]


def refs(e):
    return [r["reference"] for r in e.store.view(e.souk)["resident"] if "reference" in r]


def test_one_settle_two_references(e):
    send(e, "Arb", "{}", kind="references")  # the site's doorman subscribes
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    settle(e, t, L_END, "settled")
    assert "Leave the host a one-line reference" in said(e, t) and f'\\"deal\\": \\"{t}\\"' in said(e, t)
    assert any(f"deal {t} settled" in x["payload"]["text"] for x in e.inbox("H") if x["kind"] == "Output")
    assert refer(e, "B", t, "fast line, as described", up=True) == f"Recorded your reference on deal {t}."
    assert refer(e, "H", t, "careful guest, small leases") == f"Recorded your reference on deal {t}."
    assert [(r["about"], r["subject"], r["author"], r["up"]) for r in refs(e)] == [("host", "resip-mini-1", "B", True), ("guest", "B", "H", None)]
    feed = [x["payload"]["text"] for x in e.inbox("Arb") if x["kind"] == "Output" and x["payload"]["text"].startswith("reference ")]
    assert [json.loads(f.removeprefix("reference ")) for f in feed] == [dict(deal=t, kind="lease", subject="resip-mini-1", up=True, text="fast line, as described", at=10)]


def test_third_party_and_second_reference_refused(e):
    t = lease(e, enroll(e, owner_reported=dict(cgnat=False)))
    settle(e, t, L_END, "settled")
    join(e, "B2", ("buyer",))
    assert "Only the buyer and the host" in refer(e, "B2", t, "never used it")
    assert "Only the buyer and the host" in refer(e, "Arb", t, "never used it")
    refer(e, "B", t, "good")
    assert "already left your reference" in refer(e, "B", t, "great, really")
    for text in ("came from 10.1.2.3", "came from 10.1.2.3.", "came from 10.1.2.3, twice", "(10.1.2.3)"):
        assert "IP address" in refer(e, "H", t, text), text
    assert [r["text"] for r in refs(e)] == ["good"]


def test_reference_before_settlement_refused(e):
    line = enroll(e, owner_reported=dict(cgnat=False))
    d = lease(e, line)
    settle(e, d, L_DECL, "released")
    assert "is not a settled" in refer(e, "B", d, "declined me")
    t = lease(e, line)
    assert "is not a settled" in refer(e, "B", t, "too early")
    assert "is not a settled" in refer(e, "H", t, "too early")
    assert refs(e) == []


def test_proposal_quotes_references(e):
    line = enroll(e, owner_reported=dict(cgnat=False))
    t = lease(e, line)
    q = next(q for q in e.rows("questions").values() if q["thread"] == t)
    assert q["prompt"].endswith("References for resip-mini-1: none yet.")
    settle(e, t, L_END, "settled")
    refer(e, "B", t, "fast line, as described", up=True)
    refer(e, "H", t, "careful guest")
    t2 = lease(e, line, exclusive=False)
    q = next(q for q in e.rows("questions").values() if q["thread"] == t2)
    assert q["prompt"].startswith("Lease example.com")
    assert q["prompt"].endswith('References for resip-mini-1: 1, 1 up, 0 down. Latest: "fast line, as described" (up).')
    assert "careful guest" not in json.dumps(e.read(t2, "B"))
    seen = json.dumps(e.agent_context(dict(see=["thread", "resident"], thread=t2, sender=None)))
    assert "careful guest" not in seen and "Host references about buyer B: 1, 0 up, 0 down." in seen and "fast line, as described" in seen
    assert [r["text"] for r in refs(e)] == ["fast line, as described", "careful guest"]  # the program keeps the text


def test_stay_reference_about_the_publisher(e):
    t = couch(e)
    send(e, "B", stay(t), thread=t)
    assert "Leave the host a one-line reference" in said(e, t)
    refer(e, "B", t, "slot was ready, quick shell", up=True)
    assert [(r["kind"], r["about"], r["subject"]) for r in refs(e)] == [("couch", "host", MAC)]
    couch(e)
    q = next(q for q in e.rows("questions").values() if q["thread"] == newest(e))
    assert q["prompt"].endswith(f'References for {MAC}: 1, 1 up, 0 down. Latest: "slot was ready, quick shell" (up).')


def test_stay_reference_from_the_host_with_a_checksummed_wallet(e):
    e.store.db.execute("INSERT INTO persons (id, email, wallet) VALUES (?,?,?)", ("M", "m@example.com", "0xA43f9F32411358C1319cB36027650A206644c131"))
    e.receive(Joined(Member("M", ("host",)), souk=e.souk))
    e.deliver()
    t = couch(e)
    send(e, "B", stay(t), thread=t)
    assert any(f"deal {t} settled" in x["payload"]["text"] for x in e.inbox("M") if x["kind"] == "Output")
    assert refer(e, "M", t, "tidy guest, closed the stay") == f"Recorded your reference on deal {t}."
    assert [(r["about"], r["subject"], r["author"]) for r in refs(e)] == [("guest", "B", "M")]


def test_stay_without_a_bound_host_says_so(e):
    t = couch(e)
    send(e, "B", stay(t), thread=t)
    assert "No member's bound wallet is the host's publisher address" in said(e, t)
    assert "binds that wallet first" in refer(e, "H", t, "tidy guest")
CHAIN = "https://pod.dstack.soc1024.com/layover-chain"
ESCROW = "0x8FF468c8E447f6cF70f05bEa1cEc1693eC0455cE"
BUYER_WORD = "0" * 24 + "1fbe7a7b3f7a37a967f3d927abd6f04db2766c5b"
CLAIMED = "0x2efe0d5f05f64dd46ce04f78eb9a5f7553a7906f99fc51a94948e3390b879bba"
MARKET_OK = [f"{RESIP}/api/market", f"{CHAIN}/call?to={ESCROW}&data=0xfc7e286d{BUYER_WORD}", f"{CHAIN}/call?to={ESCROW.lower()}&data=0x8d3e7a69{BUYER_WORD}{'0e' * 32}&depth=2",
             f"{CHAIN}/logs?address={ESCROW}&topics={CLAIMED}&from=55000000&to=55000199", f"{CHAIN}/logs?address={ESCROW}&topics={CLAIMED},*,0x{BUYER_WORD}&from=55000000&to=55000100",
             f"{CHAIN}/call?to=0x036cbd53842c5426634e7929541ec2318f3dcf7e&data=0x70a08231{BUYER_WORD}", f"{CHAIN}/head",
             f"{CHAIN}/read?contract=escrow&fn=claimed(address,bytes32)&args=0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b,0x{'0e' * 32}&depth=30",
             f"{CHAIN}/read?contract=usdc&fn=decimals()", f"{CHAIN}/read?contract=guest_escrow&fn=withdrawable(address)&args=0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b",
             f"{CHAIN}/read?contract=layc&fn=balanceOf(address)&args=0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b", f"{CHAIN}/read?contract=escrow&fn=deposits(address)&args=0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b"]
MARKET_REFUSED = [f"{RESIP}/api/market?agent_id=x", f"{RESIP}/api/market/../agents", f"{CHAIN}/call?to=0x{'11' * 20}&data=0xfc7e286d{BUYER_WORD}",  # not an allowed contract
                  f"{CHAIN}/call?data=0xfc7e286d{BUYER_WORD}", f"{CHAIN}/call?to={ESCROW}&data=0xfc7e286d{BUYER_WORD}&to={ESCROW}",  # no contract; a repeated parameter
                  f"{CHAIN}/call?to={ESCROW}&data=0xfc7e286d{BUYER_WORD}&url=https://example.com", f"{CHAIN}/call?to={ESCROW}&data=0xfc7e286d1",  # unknown parameter; bad calldata
                  f"{CHAIN}/send?to={ESCROW}&data=0xfc7e286d{BUYER_WORD}", f"{CHAIN}/logs?address=%30x8FF468c8E447f6cF70f05bEa1cEc1693eC0455cE&from=1",  # not a read; encoded
                  f"https://pod.dstack.soc1024.com/layover-chainx/call?to={ESCROW}&data=0xfc7e286d", f"{CHAIN}/logs?address={ESCROW}&from=1#x", f"{CHAIN}/logs?address={ESCROW}&from=-1",
                  f"{CHAIN}/logs?address={ESCROW}&to=1&address=0x{'11' * 20}", f"{CHAIN}/logs?address={ESCROW}&from=1&to=latest",  # repeated; to must be a block number
                  f"{CHAIN}/balance?address={ESCROW}", f"{CHAIN}/head?x=1",  # ETH balances are not escrow reads; /head takes nothing
                  f"{CHAIN}/read?contract=cdregistry&fn=buildId()", f"{CHAIN}/read?contract=guest_escrow&fn=claimPeriod(address,bytes32)&args=0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b,0x{'0e' * 32}", f"{CHAIN}/read?contract=usdc&fn=deposits(address)&args=0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b",  # other contract; fn of another contract
                  f"{CHAIN}/read?contract=escrow&fn=deposits(address)&args=0x1FBe7a7b3f7a37A967F3d927Abd6f04DB2766c5b,1,2"]  # args are addresses or words, at most two


def test_market_and_chain_reads_only_before_acceptance(e):
    line = enroll(e)
    t = lease_thread(e)
    for url in MARKET_OK:
        assert not denied(e, t, "runtime.web_fetch", dict(url=url)), url
    for url in MARKET_REFUSED:
        assert denied(e, t, "runtime.web_fetch", dict(url=url)), url
    agent(e)  # Finish the queued lease run before scripting the couch thread.
    c = couch(e, accept=False)
    assert not denied(e, c, "runtime.web_fetch", dict(url=MARKET_OK[0]))
    assert not denied(e, c, "runtime.web_fetch", dict(url=MARKET_OK[1]))
    e.answer(next(q for q in e.rows("questions").values() if q["thread"] == c)["id"], "B", "accept", at=20)
    e.deliver()
    assert denied(e, c, "runtime.web_fetch", dict(url=MARKET_OK[0]))
    held = lease(e, line)
    assert held != t and denied(e, held, "runtime.web_fetch", dict(url=MARKET_OK[1]))
    assert denied(e, line, "runtime.web_fetch", dict(url=MARKET_OK[0]))  # a line thread reads only its own records


def test_market_fetch_does_not_stand_in_for_couch_slots(e):
    send(e, "B", json.dumps(dict(task="build and test a Rust crate", minutes=20)), kind="couch")
    t = newest(e)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")))
    assert "Fetch" in denied(e, t, "record", dict(finding="terms", state="proposed", reason="x", publisher=MAC, slot_id=3, minutes=20))
    send(e, "B", "any slot is fine", thread=t)
    agent(e, ("runtime.web_fetch", dict(url=FLEET)), ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")), ("runtime.web_fetch", dict(url=MARKET_OK[3])))  # no claims: logs []
    assert not denied(e, t, "record", dict(finding="terms", state="proposed", reason="x", publisher=MAC, slot_id=3, minutes=20))


GUEST_ESCROW = "0xdf9bb576e30ec71e200643ab6fc835eee12c95ea"
OPERATOR = "0xa43f9f32411358c1319cb36027650a206644c131"
WALLET = "0x1fbe7a7b3f7a37a967f3d927abd6f04db2766c5b"
ACC = "ac" * 32  # the buyer's resip account id


def test_keccak_matches_the_first_live_escrow_terms():
    import ast
    src = (HERE.parent / "souk.py").read_text()
    fn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == "keccak256")
    ns = {}
    exec(ast.get_source_segment(src, fn), ns)
    live = '{"agent_id":"resip-mini-1","cap":"100000","chain_id":84532,"escrow":"0x8ff468c8e447f6cf70f05bea1cec1693ec0455ce","kind":"layover-terms/test-20261105","mode":"shared","operator":"0xa43f9f32411358c1319cb36027650a206644c131","price_per_gb":400}'
    assert ns["keccak256"](live) == "0ed7267cc92aad3a4e554846dd07688da98bd271bff2591447692d4a554897bc"
    assert ns["keccak256"]("") == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert ns["keccak256"]("a" * 300) == "5b7e0e47a96f32a88b4f14ca177982790807c40e1a105742ba0fc1babe1ef826"  # two blocks


def escrow_deal(e, operator=OPERATOR):
    line = enroll(e, policy=POLICY | ({"operator": operator} if operator else {}))
    send(e, "B", json.dumps(dict(domains=["example.com"], category="price_check", minutes=30, max_price=40, exclusive=False, pay="escrow")), kind="lease")
    t = newest(e)
    verify(e, t)
    return line, t


CHAIN_READ = "https://pod.dstack.soc1024.com/layover-chain/read?contract=guest_escrow&fn="


def checks(t_hash, wallet=WALLET):
    return [f"{CHAIN_READ}terms(address,bytes32)&args={wallet},{t_hash}", f"{CHAIN_READ}balance(address)&args={wallet}", f"{CHAIN_READ}exposure(address)&args={wallet}"]


def chain(t_hash, operator=OPERATOR, cap=200000, closed=0, balance=200000, exposure=200000, wallet=WALLET, block=55012000):
    """layover-chain's /read answers for the three admission reads."""
    read = lambda fn, args, value: dict(contract="guest_escrow", address=GUEST_ESCROW, fn=fn, args=args, block=block, block_hash="0x" + "cd" * 32, depth=30, head=block + 30, value=value, verified_by="helios-opstack")
    u = checks(t_hash, wallet)
    FIXTURES[u[0]] = read("terms(address,bytes32)", [wallet, t_hash], [operator, str(cap), str(closed), False])
    FIXTURES[u[1]] = read("balance(address)", [wallet], [str(balance)])
    FIXTURES[u[2]] = read("exposure(address)", [wallet], [str(exposure)])
    return u


def check(e, t_hash):
    agent(e, *(("runtime.web_fetch", dict(url=u)) for u in checks(t_hash)))


def agreed(e, t, line):
    agent(e, ("record", terms(line)), ("propose", dict(members=["B"], question="Shared lease at 400 credits per GB, 20 credits cap?")))
    x = e.rows("threads")[t]["records"]["terms"]["escrow"]
    e.answer(next(q for q in e.rows("questions").values() if q["thread"] == t)["id"], "B", "accept", at=20)
    e.deliver()
    return x


def test_escrow_lease_needs_an_operator(e):
    line, t = escrow_deal(e, operator=None)
    assert "names no operator" in denied(e, t, "record", terms(line))


def test_escrow_lease_is_admitted_only_when_guestescrow_holds_funded_terms(e):
    from eth_utils import keccak
    line, t = escrow_deal(e)
    x = agreed(e, t, line)
    body = json.loads(x["terms"])
    assert x["terms_hash"] == "0x" + keccak(text=x["terms"]).hex() and x["terms"] == json.dumps(body, sort_keys=True, separators=(",", ":"))
    assert (body["escrow"], body["operator"], body["thread"], body["price_per_gb"], body["minutes"], body["category"], x["cap"], x["deposit"]) == (GUEST_ESCROW, OPERATOR, t, 400, 30, "price_check", "200000", "200000")
    q = next(q for q in e.rows("questions").values() if q["thread"] == t)
    assert x["terms_hash"] in json.dumps(q) and "operator " + OPERATOR in json.dumps(q)
    assert ledger(e)["accounts"]["B"] == 1000 and not journal(e, "credits.hold")  # nothing held in the souk
    assert f"account accept {x['terms_hash']} {OPERATOR} 200000 200000" in said(e, t) and "reserves" not in said(e, t)
    assert denied(e, t, "runtime.web_fetch", dict(url=checks(x["terms_hash"])[0]))  # no wallet named yet
    send(e, "B", "what is the cap?", thread=t)
    assert said(e, t).count("account accept") == 2  # any other message re-posts the notice
    send(e, "B", "accepted 0x" + "ab" * 32, thread=t)
    assert "is not this deal's termsHash" in said(e, t)
    send(e, "B", f"accepted {x['terms_hash']}", thread=t)
    assert "<wallet address> <resip account id>" in said(e, t)
    for u in checks(x["terms_hash"]):
        FIXTURES[u] = dict(error="helios eth_getBlockByNumber: out of sync: 2571 seconds behind")
    send(e, "B", f"accepted {x['terms_hash']} {WALLET.upper().replace('0X', '0x')} {ACC}", thread=t)
    assert denied(e, t, "runtime.web_fetch", dict(url=checks(x["terms_hash"], "0x" + "11" * 20)[0]))
    seen = "\n".join(r.get("text", "") for r in e.agent_context(dict(see=["thread"], thread=t)))
    assert all(u in seen for u in checks(x["terms_hash"])), "the amin's run must see the reads (it never sees program posts)"
    assert denied(e, t, "runtime.web_fetch", dict(url=f"{RESIP}/api/market"))  # agreed: only the admission reads
    check(e, x["terms_hash"])
    assert "No verified chain data now (helios eth_getBlockByNumber: out of sync" in said(e, t) and "Checking again every 30 s" in said(e, t)
    chain(x["terms_hash"], operator="0x" + "0" * 40, cap=0, exposure=0)
    e.advance(41)
    agent(e, *(("runtime.web_fetch", dict(url=u)) for u in checks(x["terms_hash"])))  # the timer reruns the check: no buyer retry
    assert "shows no terms" in said(e, t) and "accepted" not in e.rows("threads")[t]["flags"]
    chain(x["terms_hash"], balance=0)
    e.advance(41)
    agent(e, *(("runtime.web_fetch", dict(url=u)) for u in checks(x["terms_hash"])))
    assert "below your exposure of 200000" in said(e, t) and "accepted" not in e.rows("threads")[t]["flags"]
    chain(x["terms_hash"], balance=250000, exposure=250000)
    e.advance(41)
    agent(e, *(("runtime.web_fetch", dict(url=u)) for u in checks(x["terms_hash"])))
    assert "accepted" in e.rows("threads")[t]["flags"]
    assert f"--buyer-wallet={WALLET} --terms-hash={x['terms_hash']} --escrow={GUEST_ESCROW}" in said(e, t) and "at block 55012000" in said(e, t)
    assert "GuestEscrow" in denied(e, t, "record", dict(finding="settle", state="settled", reason="x", lease_id=L_END))
    assert ledger(e)["accounts"]["B"] == 1000
    leases = f"{RESIP}/api/leases?agent_id=resip-mini-1&terms_hash={x['terms_hash']}&account={ACC}"
    assert leases in said(e, t) and "lease <" not in said(e, t)  # the buyer does not name the lease
    assert leases in "\n".join(r.get("text", "") for r in e.agent_context(dict(see=["thread"], thread=t))), "the amin's run sees the lease lookup"
    lease = lambda id, at, status, start=None, h=x["terms_hash"]: dict(id=id, agent_id="resip-mini-1", at=at, status=status, buyer_claimed_terms_hash=h,
                                                                       statement_terms_hash=None, window={"start": start} if start else None)
    FIXTURES[leases.removeprefix(RESIP)] = []
    e.advance(10 + 300 + 1)
    agent(e, ("runtime.web_fetch", dict(url=leases)))  # the 5-minute look: no lease yet
    assert "settled" not in e.rows("threads")[t]["flags"] and "escrow_started" not in e.rows("threads")[t]["flags"]
    # The site lists only the buyer's account's leases with the hash; a declined one changes nothing, the first active one starts the deal.
    FIXTURES[leases.removeprefix(RESIP)] = [lease(L_DECL, "2026-11-04T17:58:00.000Z", "declined"), lease(L_SHARED, "2026-11-04T18:05:00.000Z", "active", "2026-11-04T18:06:00.000Z"),
                                            lease(L_ACT, "2026-11-04T17:59:00.000Z", "active", "2026-11-04T18:00:00.000Z"), lease(L_END, "2026-11-04T17:00:00.000Z", "ended", h="0x" + "ab" * 32)]
    e.advance(10 + 600 + 1)
    agent(e, ("runtime.web_fetch", dict(url=leases)))
    assert f"Lease {L_ACT} started at 2026-11-04T18:00:00.000Z" in said(e, t)
    send(e, "B", json.dumps(dict(domains=["example.com"], category="price_check", minutes=30, max_price=40, exclusive=True)), kind="lease")
    t2 = newest(e)
    verify(e, t2)
    assert "holds one of these domains" in denied(e, t2, "record", terms(line))  # the live escrow lease holds example.com
    start = 1793815200  # 2026-11-04T18:00:00Z
    e.advance(start + 30 * 60 - 1)
    assert "settled" not in e.rows("threads")[t]["flags"]  # the end counts from the lease's start, not from admission
    e.advance(start + 30 * 60 + 1)
    assert "settled" in e.rows("threads")[t]["flags"] and "minutes are over" in said(e, t)
    assert not denied(e, t2, "record", terms(line))  # the deal's minutes are over: the line is free


@pytest.mark.parametrize("over,why", [(dict(cap=5), "cap 5"), (dict(closed=1793900000), "already closed")])
def test_escrow_terms_that_differ_on_chain_close_the_deal(e, over, why):
    line, t = escrow_deal(e)
    x = agreed(e, t, line)
    chain(x["terms_hash"], **over)
    send(e, "B", f"accepted {x['terms_hash']} {WALLET} {ACC}", thread=t)
    check(e, x["terms_hash"])
    assert "closed" in e.rows("threads")[t]["flags"] and why in said(e, t)


def test_escrow_checks_stop_after_ten_minutes(e):
    line, t = escrow_deal(e)
    x = agreed(e, t, line)
    chain(x["terms_hash"], operator="0x" + "0" * 40, cap=0)
    send(e, "B", f"accepted {x['terms_hash']} {WALLET} {ACC}", thread=t)
    for i in range(20):
        check(e, x["terms_hash"])
        e.advance(41 + i)
    assert "Stopped checking after 20 tries" in said(e, t) and not e.run_next(ScriptedAgent([]))
    send(e, "B", f"accepted {x['terms_hash']} {WALLET} {ACC}", thread=t)  # a resend does not reset the deal's checks
    assert "has used its 20 escrow checks" in said(e, t) and not e.run_next(ScriptedAgent([]))


@pytest.mark.parametrize("signed,ends", [(True, True), (False, False)])
def test_escrow_deal_ends_only_on_a_guest_signed_statement_of_its_hash(e, signed, ends):
    line, t = escrow_deal(e)
    x = agreed(e, t, line)
    chain(x["terms_hash"])
    send(e, "B", f"accepted {x['terms_hash']} {WALLET} {ACC}", thread=t)
    check(e, x["terms_hash"])
    url = f"{RESIP}/api/leases?agent_id=resip-mini-1&terms_hash={x['terms_hash']}&account={ACC}"
    FIXTURES[url.removeprefix(RESIP)] = [dict(id=L_END, agent_id="resip-mini-1", at="2026-11-04T18:00:00.000Z", status="ended", buyer_claimed_terms_hash=x["terms_hash"],
                                              statement_terms_hash=x["terms_hash"] if signed else None, window=None)]
    e.advance(10 + 300 + 1)
    agent(e, ("runtime.web_fetch", dict(url=url)))
    assert ("settled" in e.rows("threads")[t]["flags"]) == ends and ("The line ended the lease" in said(e, t)) == ends


def test_escrow_lease_never_started_frees_the_line_after_an_hour(e):
    line, t = escrow_deal(e)
    x = agreed(e, t, line)
    chain(x["terms_hash"])
    send(e, "B", f"accepted {x['terms_hash']} {WALLET} {ACC}", thread=t)
    check(e, x["terms_hash"])
    assert "accepted" in e.rows("threads")[t]["flags"]
    e.advance(10 + 3600 + 1)
    assert "settled" in e.rows("threads")[t]["flags"] and "No lease started within an hour" in said(e, t)


def test_escrow_check_reads_only_its_own_run_and_reruns_a_run_that_skipped_a_read(e):
    line, t = escrow_deal(e)
    x = agreed(e, t, line)
    u = chain(x["terms_hash"], balance=0)
    send(e, "B", f"accepted {x['terms_hash']} {WALLET} {ACC}", thread=t)
    check(e, x["terms_hash"])
    assert "below your exposure" in said(e, t)
    chain(x["terms_hash"])  # now funded, but the next run skips the balance read: the old balance must not count
    e.advance(41)
    agent(e, ("runtime.web_fetch", dict(url=u[0])), ("runtime.web_fetch", dict(url=u[2])))
    assert "accepted" not in e.rows("threads")[t]["flags"] and "No verified chain data now" in said(e, t)
    e.advance(71)
    agent(e, ("runtime.web_fetch", dict(url=u[0])))  # this run stops after one read: no admission, no retry timer
    e.advance(71 + 120 + 1)  # its watchdog (armed when the timer at 71 started the run) reruns the check
    check(e, x["terms_hash"])
    assert "accepted" in e.rows("threads")[t]["flags"]


def test_invite_admits(e, monkeypatch, tmp_path):
    # Live 2026-11-06: the escrow check's admit(e, t, s) shadowed the SDK's admit, so every signup's Invite raised TypeError.
    monkeypatch.setenv("SOUK_MAIL", "none")
    monkeypatch.setenv("SOUK_MAIL_DIRECTORY", str(tmp_path / "mail"))
    e.receive(Invite(Member("H", ("host",)), "new@example.com", ("host",), souk=e.souk, at=10))
    e.deliver()
    assert [a["kind"] for d in e.rows("decisions").values() for a in d["actions"] if a["kind"] == "admit"] == ["admit"]


def test_no_top_level_name_shadows_the_sdk():
    """A program-level def, class or assignment must not rebind a name the souk SDK provides (souk.py imports from it)."""
    import ast
    sdk = {n for n in dir(souk_sdk) if not n.startswith("_")}
    names = set()
    for n in ast.parse((HERE.parent / "souk.py").read_text()).body:
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            names.add(n.name)
        for t in n.targets if isinstance(n, ast.Assign) else []:
            names |= {x.id for x in ast.walk(t) if isinstance(x, ast.Name)}
    assert not names & sdk, sorted(names & sdk)


def test_bundle_files_fit_the_host_limit():
    check_sizes(bundle())  # the host refuses any bundle file over 64 KiB; souk.py is close to it


ALLOC_OP = "12345678-1234-4234-8234-123456789abc"


def allocate_request(**kw):
    return dict(operation_id=ALLOC_OP, domains=["example.com"], category="research", minutes=5,
                max_price=20, exclusive=False, pay="escrow", auto_accept=True, **kw)


def contracts(e, t):
    out = []
    for event in e.read(t, "B"):
        if event["kind"] == "Output":
            try:
                body = json.loads(event["payload"]["text"])
            except ValueError:
                continue
            if body.get("kind") == "layover-allocation/1" and body.get("status") in ("requires_acceptance", "ready"):
                out.append(body)
    return out


def test_allocate_standing_offer_is_typed_and_needs_funded_chain_admission(e):
    enroll(e, policy=dict(POLICY, operator=OPERATOR, quick_lease=True))
    assert lines(e)[0]["policy"]["quick_lease"] is True
    send_allocation(e)
    t = newest(e)
    assert contracts(e, t)
    [quote] = contracts(e, t)
    x = quote["terms"]["escrow"]
    assert quote["status"] == "requires_acceptance" and quote["operation_id"] == ALLOC_OP
    assert quote["terms"]["price_per_gb"] == POLICY["floor_shared_per_gb"]
    assert x["cap"] == "200000" and quote["terms"]["minutes"] == 5
    assert not journal(e, "credits.hold") and not e.rows("questions")
    assert denied(e, t, "post", dict(thread=t, text=json.dumps(dict(kind="layover-allocation/1", status="ready"))))
    send(e, "B", f"accepted {x['terms_hash']} {WALLET} {ACC}", thread=t)
    chain(x["terms_hash"], balance=0)
    check(e, x["terms_hash"])
    assert len(contracts(e, t)) == 1 and "accepted" not in e.rows("threads")[t]["flags"]
    chain(x["terms_hash"])
    e.advance(41)
    check(e, x["terms_hash"])
    assert contracts(e, t)[-1]["status"] == "ready"
    assert contracts(e, t)[-1]["wallet"] == WALLET
    assert "accepted" in e.rows("threads")[t]["flags"]


def test_allocate_duplicate_does_not_allocate_again(e):
    enroll(e, policy=dict(POLICY, operator=OPERATOR, quick_lease=True))
    payload = json.dumps(allocate_request())
    send_allocation(e)
    count = len(e.rows("threads"))
    send(e, "B", payload, kind="allocate")
    assert len(e.rows("threads")) == count
    assert len(journal(e, "record")) == 2  # enrollment and one allocation


@pytest.mark.parametrize("changes", [dict(exclusive=True), dict(pay="credits"), dict(auto_accept=False), dict(region="US"), dict(minutes=10), dict(max_price=0)])
def test_allocate_rejects_unsupported_authority_or_constraints(e, changes):
    req = allocate_request(); req.update(changes)
    send(e, "B", json.dumps(req), kind="allocate")
    assert not e.rows("threads") and not journal(e, "credits.hold")


def test_allocate_no_inventory_fails_without_funds_or_contract(e):
    send_allocation(e)
    t = newest(e)
    assert "closed" in e.rows("threads")[t]["flags"] and not contracts(e, t)


def test_bundle_compaction_preserves_program_ast():
    import ast
    program = (HERE.parent / "souk.py").read_text().replace("{{APPRAISAL_PIN}}", __import__("build").APPRAISAL_PIN)
    assert ast.dump(ast.parse(program)) == ast.dump(ast.parse(bundle()["souk.py"]))


def send_allocation(e):
    send(e, "B", json.dumps(allocate_request()), kind="allocate")
    t = newest(e)
    for url in (f"{RESIP}/api/market", f"{RESIP}/api/appraisals/{A_OK}/verified"):
        if "closed" in e.rows("threads")[t]["flags"]:
            break
        agent(e, ("runtime.web_fetch", dict(url=url)))
        e.deliver()
    e.deliver()


def test_allocate_quote_expires_without_admission_or_hold(e):
    enroll(e, policy=dict(POLICY, operator=OPERATOR, quick_lease=True))
    send_allocation(e)
    t = newest(e); x = contracts(e, t)[0]["terms"]["escrow"]
    e.advance(3611)
    send(e, "B", f"accepted {x['terms_hash']} {WALLET} {ACC}", thread=t)
    assert "closed" in e.rows("threads")[t]["flags"]
    assert "accepted" not in e.rows("threads")[t]["flags"]
    assert not journal(e, "credits.hold")


def test_allocate_does_not_use_an_operatorless_offer(e):
    enroll(e, policy=dict(POLICY, quick_lease=True))
    send_allocation(e)
    t = newest(e)
    assert "closed" in e.rows("threads")[t]["flags"] and not contracts(e, t)


def test_allocate_read_deadline_closes_a_stalled_market_read(e):
    send(e, "B", json.dumps(allocate_request()), kind="allocate")
    t = newest(e)
    e.advance(131)
    assert "closed" in e.rows("threads")[t]["flags"]
    assert "deadline exceeded" in said(e, t)
    assert not contracts(e, t) and not journal(e, "credits.hold")


def test_allocate_quote_expiry_matches_its_timer_after_delayed_reads(e):
    enroll(e, policy=dict(POLICY, operator=OPERATOR, quick_lease=True))
    send(e, "B", json.dumps(allocate_request()), kind="allocate")
    t = newest(e)
    e.advance(30)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")))
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/appraisals/{A_OK}/verified")))
    e.deliver(); e.deliver()
    [quote] = contracts(e, t)
    assert quote["expires"] == e.rows("threads")[t]["created_at"] + 3600
    timer = next(x for x in e.rows("timers").values() if x["thread"] == t and x["name"] == "allocation_expired")
    assert timer["at"] == quote["expires"]


@pytest.mark.parametrize("extra,offered", [({}, True), ({"vantage": "home"}, True), ({"region": "[region]"}, True), ({"vantage": "vpn"}, False), ({"region": "New York"}, False)])
def test_fetch_lines_narrowed_to_vantage_and_region(e, extra, offered):
    enroll(e)
    send(e, "B", json.dumps(dict(domains=["www.redfin.com"], pages=5, max_price=5, **extra)), kind="fetch")
    verify(e, newest(e))  # even when the amin reads a line the listing left out, the program proposes only a matching one
    assert bool(e.rows("questions")) == offered


def test_vantage_is_checked(e):
    send(e, "B", json.dumps(dict(domains=["www.redfin.com"], pages=5, max_price=5, vantage="tor")), kind="fetch")
    assert 'vantage: \\"home\\" or \\"vpn\\"' in json.dumps(e.inbox("B"))


@pytest.mark.parametrize("version", ["810fcab9", "32aa2d90"])
def test_allocate_skips_market_candidates_running_a_different_guest(e, monkeypatch, version):
    enroll(e, policy=dict(POLICY, operator=OPERATOR, quick_lease=True))
    market = FIXTURES["/api/market"]
    agent_id = FIXTURES[f"/api/appraisals/{A_OK}/verified"]["agent_id"]
    line = next(x for x in market["lines"] if x["agent_id"] == agent_id)
    monkeypatch.setitem(line, "appraisal", dict(guest_version=version))
    send(e, "B", json.dumps(allocate_request()), kind="allocate")
    t = newest(e)
    agent(e, ("runtime.web_fetch", dict(url=f"{RESIP}/api/market")))
    assert "closed" in e.rows("threads")[t]["flags"]
    assert "no eligible standing offer" in said(e, t)
    assert not contracts(e, t) and not journal(e, "credits.hold")
    reads = [j for j in journal(e, "runtime.web_fetch") if j["thread"] == t]
    assert [j["args"]["url"] for j in reads] == [f"{RESIP}/api/market"]


def test_allocate_market_version_does_not_replace_verified_appraisal(e, monkeypatch):
    enroll(e, policy=dict(POLICY, operator=OPERATOR, quick_lease=True))
    market = FIXTURES["/api/market"]
    appraisal = FIXTURES[f"/api/appraisals/{A_OK}/verified"]
    line = next(x for x in market["lines"] if x["agent_id"] == appraisal["agent_id"])
    monkeypatch.setitem(line, "appraisal", dict(guest_version=appraisal["guest_version"]))
    monkeypatch.setitem(appraisal, "guest_version", "810fcab9")
    send_allocation(e)
    t = newest(e)
    assert "closed" in e.rows("threads")[t]["flags"]
    assert not contracts(e, t) and not journal(e, "credits.hold")


@pytest.mark.parametrize("choice", [None, False])
def test_allocate_requires_explicit_host_opt_in_before_appraisal_or_funding(e, choice):
    policy = dict(POLICY, operator=OPERATOR, notes="Fetch jobs only; no leases or proxies for unapproved people")
    if choice is not None:
        policy["quick_lease"] = choice
    enroll(e, policy=policy)
    assert lines(e)[0]["policy"]["quick_lease"] is False
    before = ledger(e)
    send_allocation(e)
    t = newest(e)
    assert "closed" in e.rows("threads")[t]["flags"] and not contracts(e, t)
    reads = [j["args"]["url"] for j in journal(e, "runtime.web_fetch") if j["thread"] == t]
    assert reads == [f"{RESIP}/api/market"]
    assert ledger(e) == before and not journal(e, "credits.hold")
    assert not any(j["args"].get("finding") == "terms" for j in journal(e, "record"))


@pytest.mark.parametrize("value", [None, 0, 1, "true", "false", [], {}])
def test_quick_lease_policy_rejects_non_boolean_authority(e, value):
    send(e, "H", json.dumps(dict(appraisal_id=A_OK, policy=dict(POLICY, quick_lease=value))), kind="line")
    assert not e.rows("threads") and not lines(e)
    assert "quick_lease must be a boolean" in json.dumps(e.inbox("H"))


def test_restricted_line_without_quick_opt_in_still_matches_and_settles_fetch(e):
    line = enroll(e, policy=dict(POLICY, operator=OPERATOR, notes="Fetch jobs only; no leases or proxies for unapproved people"))
    assert lines(e)[0]["policy"]["quick_lease"] is False
    t = fetch_deal(e, line)
    assert e.rows("threads")[t]["records"]["terms"]["line"] == line
    named(e, t, bounty(t, 1, served=5, passed=True))
    assert ledger(e)["accounts"]["H"] == 1001
    assert "1 credits to the seller" in said(e, t)

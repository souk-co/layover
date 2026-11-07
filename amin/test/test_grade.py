"""grade.py check 10 against the posts the program itself makes when QA delists and relists a line."""

from types import SimpleNamespace

import grade
import pytest
from test_amin import FIXTURES, e, enroll, probe, qa  # noqa: F401

URL = "/api/agents/resip-mini-1/probes?limit=3"


def drill(e):
    line = enroll(e)
    for at, probes in ((920, [probe(3, ok=False), probe(2, same=False), probe(1)]), (2740, [probe(5), probe(4, ok=False)])):
        FIXTURES[URL] = probes
        qa(e, at)
    del FIXTURES[URL]
    rows = [x for x in e.store.events(e.souk) if x["kind"] == "Output" and x["thread"] == line]
    seller = SimpleNamespace(inbox=lambda: [dict(kind="Thread", thread=line)], read=lambda t: rows)
    return SimpleNamespace(seller=seller, enrolled=lambda: dict(agent_id="resip-mini-1"))


@pytest.mark.parametrize("site, failed", [
    ([probe(5), probe(4, ok=False), probe(3, ok=False), probe(2, same=False), probe(1)], False),
    ([probe(5), probe(4, ok=False), probe(3), probe(2, same=False), probe(1)], True),
    ([probe(5, ok=False), probe(4, ok=False), probe(3, ok=False), probe(2, same=False), probe(1)], True),
])
def test_delisting(e, monkeypatch, site, failed):
    j = drill(e)
    monkeypatch.setattr(grade, "resip", lambda path: site)
    c = grade.Check()
    grade.Journey.delisting(j, c)
    assert c.failed == failed, c.lines

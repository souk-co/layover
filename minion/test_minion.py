"""python3 -m pytest minion/test_minion.py"""
import hashlib, json, os, subprocess, sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import netmeasure, verdict

# zed -> the Mini's home line, 2026-11-05 (faithful-network design): last Comcast hop best 31.3 ms, A best 41.7 ms;
# the Mini's own connection is ~5 ms behind its router.
HOME = {"rtt_a_us": 41700, "rtt_conn_us": 46700, "hops": [[9000, 1], [0, 0], [31300, 1], [41700, 2]]}
CARRIER = {"rtt_a_us": 31500, "rtt_conn_us": 46700, "hops": [[9000, 1], [31300, 1], [31500, 2]]}


def test_cgnat_rule():
    assert verdict.cgnat(HOME) is False
    assert verdict.cgnat(CARRIER) is True
    assert verdict.cgnat({**HOME, "rtt_a_us": 0}) is None  # A does not answer ping
    assert verdict.cgnat({**HOME, "hops": [[0, 0], [41700, 2]]}) is None  # no router answered
    assert verdict.cgnat({**HOME, "hops": [[31300, 1], [0, 0]]}) is None  # the trace never reached A
    assert verdict.cgnat({**HOME, "rtt_conn_us": 60000}) is None  # step says home, gap says carrier
    assert verdict.cgnat({**HOME, "hops": [[40500, 1], [41700, 2]]}) is None  # fiber-short access link: undecided
    assert verdict.cgnat({**HOME, "hops": [[31300, 1], [0, 0], [41700, 2]]}) is None  # A's neighbour silent: no step measured
    assert verdict.cgnat({**CARRIER, "hops": [[9000, 1], [33000, 1], [31500, 2]]}) is None  # slow-path router: negative step


def test_page_class():
    assert [verdict.page_class(*x) for x in [(200, 816000), (200, 2200), (405, 2168), (202, 0), (403, 251), (502, 60), (0, 0)]] == \
        ["served", "thin", "challenged", "challenged", "challenged", "blocked", "blocked"]


@pytest.fixture
def m(tmp_path, monkeypatch):
    subprocess.run([sys.executable, netmeasure.__file__, "keygen", str(tmp_path)], check=True, capture_output=True)
    monkeypatch.setattr(netmeasure, "asn", lambda a: 7922)
    monkeypatch.setattr(netmeasure, "ping_us", lambda a: HOME["rtt_a_us"])
    monkeypatch.setattr(netmeasure, "trace", lambda a: HOME["hops"])
    monkeypatch.setattr(netmeasure, "min_rtt_us", lambda s: HOME["rtt_conn_us"])
    return netmeasure.M(tmp_path)


def test_measurement_binds_guest_hash_signature_and_nonce(m, tmp_path):
    nonce = "ab" * 16
    raw = m.probe(nonce, None, "198.51.100.7")
    assert b"198.51.100.7" not in raw and json.loads(raw)["ip_commit"] == hashlib.sha256(m.salt + b"198.51.100.7").hexdigest()
    got = verdict.measurement(raw, m.pub, nonce, hashlib.sha256(raw).hexdigest())
    assert verdict.cgnat(got) is False and got["asn"] == 7922
    with pytest.raises(AssertionError, match="not the page"):
        verdict.measurement(raw, m.pub, nonce, "00" * 32)
    with pytest.raises(AssertionError, match="different nonce"):
        verdict.measurement(raw, m.pub, "cd" * 16, hashlib.sha256(raw).hexdigest())
    forged = raw.replace(b'"rtt_conn_us":46700', b'"rtt_conn_us":99999')
    with pytest.raises(Exception):
        verdict.measurement(forged, m.pub, nonce, hashlib.sha256(forged).hexdigest())
    with pytest.raises(AssertionError, match="already used"):
        m.probe(nonce, None, "198.51.100.7")
    assert netmeasure.M(tmp_path).done[nonce] == raw  # results survive a restart, for /v1/result


def test_site_slice_rotates_over_every_site():
    os.environ.setdefault("MINION_HOME", str(Path(__file__).parent))
    import minion
    seen = [u for h in range(len(minion.SITES)) for u in minion.site_slice(h * 3600)]
    assert set(seen) == set(minion.SITES) and len(minion.site_slice(0)) == minion.PER_CYCLE


def test_post_rows_sets_refused_rows_aside_and_goes_on(tmp_path, monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    os.environ.setdefault("MINION_HOME", str(Path(__file__).parent))
    import minion
    got = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            row = json.loads(json.loads(self.rfile.read(int(self.headers["content-length"])))["row_json"])
            got.append(row["id"])
            self.send_response(400 if row["id"] == "bad" else 200)
            self.end_headers()
            self.wfile.write(b'{"error":"row contains something that looks like an IP address"}')

        def log_message(self, *a):
            pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    (tmp_path / "home").mkdir()
    (tmp_path / "home/rows.key").write_text("11" * 32)
    (tmp_path / "rows.jsonl").write_text("".join(json.dumps({"id": i}) + "\n" for i in ("a", "bad", "c")))
    monkeypatch.setattr(minion, "HOME", tmp_path)
    monkeypatch.setattr(minion, "SITE", f"http://127.0.0.1:{srv.server_port}")
    minion.post_rows()
    minion.post_rows()  # nothing is posted twice
    srv.shutdown()
    assert got == ["a", "bad", "c"]
    assert (tmp_path / "posted.txt").read_text().split() == ["a", "bad", "c"]
    refused = json.loads((tmp_path / "refused.jsonl").read_text())
    assert "IP address" in refused["reason"] and json.loads(refused["row_json"])["id"] == "bad"


def test_couch_charged_failure_is_paid_even_when_end_throws(tmp_path):
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    spent = iter(["0", "900000"])

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["content-length"]))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"spentNanoUsd": next(spent)}).encode())

        def log_message(self, *a):
            pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    (tmp_path / "stay.mjs").write_text("""export const BROKER = process.env.FAKE_BROKER;
export class Stay { async signed() { return {}; } async open() { this.lease = {}; throw new Error("refused: node registration measurements"); }
  async end() { throw new Error("Cannot read properties of undefined (reading 'receiptSigner')"); } }""")
    (tmp_path / "key").write_text("0x" + "11" * 32)
    out = subprocess.run(["node", str(Path(__file__).parent / "couch_task.mjs"), "0xabc", "0", "c"], capture_output=True, text=True, check=True,
                         env={**os.environ, "LAYOVER_COUCH_DIR": str(tmp_path), "LAYOVER_COUCH_KEY_FILE": str(tmp_path / "key"), "FAKE_BROKER": f"http://127.0.0.1:{srv.server_port}"})
    srv.shutdown()
    r = json.loads(out.stdout)
    assert r["paid"] is True and r["ok"] is False and "receiptSigner" in r["close_error"] and r["error"].startswith("refused")


def test_cycle_rows_blame_and_deadline(tmp_path, monkeypatch):
    os.environ.setdefault("MINION_HOME", str(Path(__file__).parent))
    import minion
    feeds = {"/api/agents": [{"agent_id": "line-a"}, {"agent_id": "test-x"}], "/api/couch-slots": [{"publisher": "0xp", "slot_id": 0, "online": True, "state": "ready", "verified": True}]}
    monkeypatch.setattr(minion, "HOME", tmp_path)
    monkeypatch.setattr(minion, "tool", lambda *a, **k: [])
    monkeypatch.setattr(minion, "get", lambda url: json.dumps(feeds[url.removeprefix(minion.SITE)]))
    monkeypatch.setattr(minion, "post_rows", lambda: None)
    monkeypatch.setattr(minion, "relay", lambda: None)

    def no_card(row, agent, at):
        row.update(paid=False)
        raise TimeoutError("no card in 600 s")
    monkeypatch.setattr(minion, "fetch_use", no_card)
    monkeypatch.setattr(minion, "couch_use", lambda row, p, s, at: row.update(agent_id=f"{p}:{s}", paid=True, ok=False, error="guest gone"))
    minion.cycle()
    rows = {r["kind"]: r for r in map(json.loads, (tmp_path / "rows.jsonl").read_text().splitlines())}
    assert rows["fetch"]["agent_id"] == "souk" and not rows["fetch"]["failed_paid_use"]  # no card: no line to blame
    assert rows["couch"]["agent_id"] == "0xp:0" and rows["couch"]["failed_paid_use"]
    (tmp_path / "rows.jsonl").unlink()
    monkeypatch.setattr(minion, "CYCLE_DEADLINE", -1)
    minion.cycle()
    rows = [json.loads(l) for l in (tmp_path / "rows.jsonl").read_text().splitlines()]
    assert len(rows) == 2 and all(r["error"] == "not run: cycle deadline" and not r["failed_paid_use"] for r in rows)

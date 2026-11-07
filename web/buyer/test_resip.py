"""The line client's escrow lease flags: buyer_wallet, terms_hash and escrow travel together or not at all."""
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

RESIP = Path(__file__).parent / "resip.ts"
LEASE = "00000000-0000-4000-8000-000000000002"
# Obviously fake on-chain values (never a real address or hash).
WALLET = "0x" + "1f" * 20
TERMS = "0x" + "0e" * 32
ESCROW = "0x" + "ab" * 20


class Site(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def _send(self, body):
        body = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        assert self.path == "/api/leases"
        self.server.requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self._send(dict(id=LEASE))

    def do_GET(self):
        # The CLI polls the lease until it has a decision; a decided lease ends the run.
        self._send(dict(status="active", decision=dict(decision="accept", reason="ok", price_per_gb=400,
                                                       term_end="2026-11-06T23:59:00Z")))


class ResipLeaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
        cls.server.requests = []
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.root = tempfile.TemporaryDirectory(prefix="layover-resip-test-")
        cls.directory = Path(cls.root.name)
        (cls.directory / "agent.json").write_text(json.dumps(dict(
            base=f"http://127.0.0.1:{cls.server.server_port}", agent_id="line-a", enc_pub="77" * 32)))
        (cls.directory / "account.json").write_text(json.dumps(dict(secret="ab" * 32)))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.root.cleanup()

    def setUp(self):
        self.server.requests.clear()

    def resip(self, *flags):
        return subprocess.run(["deno", "run", "-A", "--no-check", str(RESIP), "lease", str(self.directory),
            "example.com", "price_check", "shared", "5", "10", "50", *flags], capture_output=True, text=True, timeout=120)

    def test_a_lease_missing_any_one_of_wallet_terms_escrow_is_refused_before_any_request(self):
        pairs = [(WALLET, None, None), (None, TERMS, None), (None, None, ESCROW),
                 (WALLET, TERMS, None), (WALLET, None, ESCROW), (None, TERMS, ESCROW)]
        for wallet, terms, escrow in pairs:
            with self.subTest(flags=[f for f in (wallet, terms, escrow) if f]):
                run = self.resip(*[f"--{name}={value}" for name, value in
                    (("buyer-wallet", wallet), ("terms-hash", terms), ("escrow", escrow)) if value])
                self.assertNotEqual(run.returncode, 0, run.stdout)
                self.assertIn("an escrow lease needs --buyer-wallet, --terms-hash and --escrow together", run.stderr)
        self.assertEqual(self.server.requests, [])  # refused locally, nothing posted

    def test_all_three_together_post_one_lease_that_carries_them(self):
        run = self.resip(f"--buyer-wallet={WALLET}", f"--terms-hash={TERMS}", f"--escrow={ESCROW}")
        self.assertEqual(run.returncode, 0, run.stderr)
        [request] = self.server.requests
        self.assertEqual(request["terms_hash"], TERMS)  # public, so the amin can find the deal's lease
        [lease_file] = self.directory.glob(f"lease-{LEASE}.json")
        lease = json.loads(lease_file.read_text())
        self.assertEqual([lease["buyer_wallet"], lease["terms_hash"], lease["escrow"]], [WALLET, TERMS, ESCROW])


if __name__ == "__main__": unittest.main()

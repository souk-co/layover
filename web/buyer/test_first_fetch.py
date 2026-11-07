"""Bounded orchestration tests; cryptographic proof and real curl/TLS have separate tests."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("first_fetch", Path(__file__).parents[1] / "static/kit/first_fetch.py")
client = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(client)


class FirstFetchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="layover-first-fetch-")
        self.path = Path(self.temp.name); self.operation = self.path / "operation.json"
        self.output = self.path / "body.html"; self.calls = []; self.http_calls = []
        (self.path / "account.json").write_text(json.dumps(dict(address="0x" + "11" * 20, session="private-account-session", url="https://pod.dstack.soc1024.com/layover-accounts")))
        self.env = patch.dict(os.environ, SOUK_HOME=str(self.path)); self.env.start()
        self.request = dict(kind="layover-terms/1", chain_id=84532, escrow="0xdf9bb576e30ec71e200643ab6fc835eee12c95ea", token="0x9e851bf5e3b613aaa09853a07d1132f49c90b515", thread="thread-1", agent_id="agent-1", mode="shared", domains=["example.com"], category="price_check", minutes=5, operator="0x" + "22" * 20, price_per_gb=200, cap="200000")
        self.quote = dict(kind="layover-allocation/1", status="requires_acceptance", operation_id="", expires=int(time.time()) + 3600, thread="thread-1", base=client.BASE,
            terms=dict(agent_id="agent-1", domains=["example.com"], category="price_check", minutes=5, price=20, price_per_gb=200, exclusive=False,
                escrow=dict(terms=json.dumps(self.request, sort_keys=True, separators=(",", ":")), terms_hash="0x" + "33" * 32, operator=self.request["operator"], cap="200000", deposit="200000")))
        self.quote["terms"]["escrow"]["terms_hash"] = "0x" + client.keccak256(self.quote["terms"]["escrow"]["terms"])
    def tearDown(self):
        self.env.stop(); self.temp.cleanup()
    def run_command(self, command, **kw):
        self.calls.append(command)
        if command[0] == "deno":
            self.assertIn("verify", command)
            Path(command[-1]).mkdir(mode=0o700, exist_ok=True)
            return subprocess.CompletedProcess(command, 0, "verified", "")
        name = Path(command[1]).name
        if name == "souk.py" and command[2] == "inbox":
            state = json.loads(self.operation.read_text()); body = dict(self.quote, operation_id=state["operation_id"])
            if state["stage"] == "admission_sent": body.update(status="ready", wallet="0x" + "11" * 20)
            return subprocess.CompletedProcess(command, 0, json.dumps([dict(kind="Output", payload=dict(text=json.dumps(body)))]), "")
        if name == "fetch.py":
            fd = os.open(self.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, b"page"); os.close(fd)
            return subprocess.CompletedProcess(command, 0, json.dumps(dict(loaded=True, outcome="complete", body_path=str(self.output), charge=dict(status="pending_lease_settlement"))), "")
        return subprocess.CompletedProcess(command, 0, "{}", "")
    def opener(self, *args):
        outer = self
        class Opener:
            def open(self, req, **kwargs):
                body = json.loads(req.data) if req.data else None
                outer.http_calls.append((req.full_url, body))
                if req.full_url.startswith(client.CUSTODY):
                    outer.assertIsNone(req.get_header("Authorization"))
                    data = dict(agent_id="agent-1", operator=outer.request["operator"])
                elif "lease-authorization" in req.full_url:
                    data = dict(enc=dict(epk="test", nonce="test", ct="test"), admission=dict(test=True), signature="test", private=dict(token="private-lease-token", salt="salt", reply_jwk={}))
                elif body is not None:
                    outer.assertEqual(body["deposit"], 0); outer.assertTrue(body["admission"])
                    data = dict(id="00000000-0000-4000-8000-000000000001")
                else:
                    data = dict(decision=dict(decision="accept"))
                return io.BytesIO(json.dumps(data).encode())
        return Opener()
    def invoke(self):
        argv = ["first_fetch.py", "https://example.com/", str(self.output), str(self.operation), "--kit", str(self.path / "kit"), "--max-credits", "20"]
        out = io.StringIO()
        with patch.object(sys, "argv", argv), patch.object(client.subprocess, "run", self.run_command), patch.object(client.urllib.request, "build_opener", self.opener), contextlib.redirect_stdout(out):
            code = client.main()
        return code, out.getvalue()
    def test_one_bounded_request_uses_constructed_authorization_without_faucet_and_closes_terms(self):
        code, stdout = self.invoke()
        self.assertEqual(code, 0); self.assertTrue(json.loads(stdout)["loaded"])
        self.assertNotIn("private-", stdout)
        self.assertFalse(any("faucet" in " ".join(c) or "lease" in c and c[0] == "deno" for c in self.calls))
        self.assertEqual(sum(Path(c[1]).name == "account.py" and c[2] == "accept" for c in self.calls if c[0] != "deno"), 1)
        self.assertEqual(sum(Path(c[1]).name == "account.py" and c[2] == "close" for c in self.calls if c[0] != "deno"), 1)
        self.assertEqual(self.operation.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.operation.read_text())["stage"], "closed")
    def test_over_cap_quote_stops_before_acceptance(self):
        self.quote["terms"]["escrow"]["cap"] = "200001"
        with self.assertRaisesRegex(ValueError, "allocation"):
            self.invoke()
        self.assertFalse(any(Path(c[1]).name == "account.py" for c in self.calls if c[0] != "deno"))
    def test_unknown_acceptance_does_not_blindly_resend(self):
        original = self.run_command
        def uncertain(command, **kw):
            if command[0] != "deno" and Path(command[1]).name == "account.py" and command[2] == "accept":
                self.calls.append(command)
                raise subprocess.TimeoutExpired(command, 1)
            return original(command, **kw)
        self.run_command = uncertain
        with self.assertRaises(subprocess.TimeoutExpired): self.invoke()
        self.assertEqual(json.loads(self.operation.read_text())["stage"], "accept_sent")
        # Each CLI invocation releases its process lock on exit; emulate that here.
        with patch.object(client.fcntl, "flock"):
            with self.assertRaisesRegex(client.Pending, "unknown"):
                self.invoke()
        self.assertEqual(sum(Path(c[1]).name == "account.py" and c[2] == "accept" for c in self.calls if c[0] != "deno"), 1)

    def test_public_or_symlink_operation_state_is_rejected(self):
        self.operation.write_text("{}")
        self.operation.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "owner-only"):
            self.invoke()
        self.operation.unlink()
        self.operation.symlink_to(self.path / "account.json")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.invoke()
        self.assertEqual(self.calls, [])

    def test_unavailable_contract_exits_without_waiting_or_spending(self):
        self.quote.update(status="unavailable", reason="no eligible standing offer")
        with patch.object(client.time, "sleep") as sleep:
            with self.assertRaisesRegex(client.Pending, "unavailable"):
                self.invoke()
            sleep.assert_not_called()
        self.assertFalse(any(Path(c[1]).name == "account.py" for c in self.calls if c[0] != "deno"))

    def test_http_failure_is_returned_and_terms_are_closed(self):
        original = self.run_command
        def failed(command, **kw):
            result = original(command, **kw)
            if command[0] != "deno" and Path(command[1]).name == "fetch.py":
                body = json.loads(result.stdout); body.update(loaded=False, outcome="http_error")
                return subprocess.CompletedProcess(command, 1, json.dumps(body), "")
            return result
        self.run_command = failed
        code, stdout = self.invoke()
        self.assertEqual(code, 1); self.assertEqual(json.loads(stdout)["outcome"], "http_error")
        self.assertEqual(sum(Path(c[1]).name == "account.py" and c[2] == "close" for c in self.calls if c[0] != "deno"), 1)

    def test_changed_wallet_cannot_resume_an_operation(self):
        self.invoke()
        self.calls.clear()
        (self.path / "account.json").write_text(json.dumps(dict(address="0x" + "44" * 20, session="other-session", url="https://pod.dstack.soc1024.com/layover-accounts")))
        with patch.object(client.fcntl, "flock"):
            with self.assertRaisesRegex(ValueError, "another request"):
                self.invoke()
        self.assertEqual(self.calls, [])

    def test_cleanup_and_result_resume_after_close_failure_and_quote_expiry(self):
        original = self.run_command
        def close_fails(command, **kw):
            if command[0] != "deno" and Path(command[1]).name == "account.py" and command[2] == "close":
                self.calls.append(command)
                raise subprocess.TimeoutExpired(command, 1)
            return original(command, **kw)
        self.run_command = close_fails
        with self.assertRaises(subprocess.TimeoutExpired): self.invoke()
        state = json.loads(self.operation.read_text()); self.assertEqual(state["stage"], "fetched")
        state["quote"]["expires"] = 1; client.save(self.operation, state)
        self.run_command = original
        with patch.object(client.fcntl, "flock"):
            code, stdout = self.invoke()
        self.assertEqual(code, 0); self.assertTrue(json.loads(stdout)["loaded"])
        self.assertEqual(sum(c[0] != "deno" and Path(c[1]).name == "fetch.py" for c in self.calls), 1)
        self.assertEqual(json.loads(self.operation.read_text())["stage"], "closed")

    def test_unknown_fetch_never_repeats_target_and_cleanup_can_resume(self):
        original = self.run_command
        def unknown_fetch(command, **kw):
            if command[0] != "deno" and Path(command[1]).name == "fetch.py":
                self.calls.append(command)
                raise subprocess.TimeoutExpired(command, 1)
            return original(command, **kw)
        self.run_command = unknown_fetch
        with self.assertRaises(subprocess.TimeoutExpired): self.invoke()
        state = json.loads(self.operation.read_text()); state["quote"]["expires"] = 1; client.save(self.operation, state)
        with patch.object(client.fcntl, "flock"):
            with self.assertRaisesRegex(client.Pending, "no target request was repeated"):
                self.invoke()
        self.assertEqual(sum(c[0] != "deno" and Path(c[1]).name == "fetch.py" for c in self.calls), 1)

    def test_terms_hash_is_verified_before_financial_acceptance(self):
        self.quote["terms"]["escrow"]["terms_hash"] = "0x" + "00" * 32
        with self.assertRaisesRegex(ValueError, "financial terms"):
            self.invoke()
        self.assertFalse(any(Path(c[1]).name == "account.py" for c in self.calls if c[0] != "deno"))
        self.assertEqual(client.keccak256("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
        self.assertEqual(client.keccak256(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")

    def test_financial_service_override_is_rejected_before_writes(self):
        with patch.dict(os.environ, LAYOVER_ACCOUNTS="https://other.example"):
            with self.assertRaisesRegex(ValueError, "trusted accounts service"):
                self.invoke()
        self.assertEqual(self.calls, []); self.assertFalse(self.operation.exists())

    def test_decline_is_terminal_even_after_quote_expiry(self):
        original = self.opener
        def declined(*args):
            delegate = original(*args)
            class Opener:
                def open(self, req, **kw):
                    if "/api/leases/" in req.full_url and req.data is None:
                        return io.BytesIO(json.dumps(dict(decision=dict(decision="decline"))).encode())
                    return delegate.open(req, **kw)
            return Opener()
        self.opener = declined
        with self.assertRaisesRegex(client.Pending, "host declined"):
            self.invoke()
        state = json.loads(self.operation.read_text()); self.assertEqual(state["stage"], "declined")
        state["quote"]["expires"] = 1; client.save(self.operation, state)
        self.calls.clear(); self.http_calls.clear()
        with patch.object(client.fcntl, "flock"):
            with self.assertRaisesRegex(client.Pending, "cannot fetch"):
                self.invoke()
        self.assertEqual(self.calls, []); self.assertEqual(self.http_calls, [])

    def test_custody_identity_mismatch_stops_before_payment_or_lease(self):
        original = self.opener
        def mismatch(*args):
            delegate = original(*args)
            class Opener:
                def open(self, req, **kw):
                    if req.full_url.startswith(client.CUSTODY):
                        self_outer.assertIsNone(req.get_header("Authorization"))
                        return io.BytesIO(json.dumps(dict(agent_id="agent-1", operator="0x" + "99" * 20)).encode())
                    return delegate.open(req, **kw)
            return Opener()
        self_outer = self
        self.opener = mismatch
        with self.assertRaises(client.IdentityMismatch) as error:
            self.invoke()
        self.assertEqual((error.exception.stage, error.exception.charge), ("identity_mismatch", "none"))
        self.assertEqual(json.loads(self.operation.read_text())["stage"], "quoted")
        self.assertFalse(any(c[0] == "deno" or Path(c[1]).name in ("account.py", "fetch.py") for c in self.calls))
        self.assertEqual(self.http_calls, [])  # No constructor authorization, lease or target request.

    def test_custody_wrong_agent_or_missing_operator_is_not_accepted(self):
        original = self.opener
        for metadata in (dict(agent_id="other", operator=self.request["operator"]), dict(agent_id="agent-1")):
            def invalid(*args):
                delegate = original(*args)
                class Opener:
                    def open(self, req, **kw):
                        if req.full_url.startswith(client.CUSTODY):
                            return io.BytesIO(json.dumps(metadata).encode())
                        return delegate.open(req, **kw)
                return Opener()
            self.opener = invalid
            with patch.object(client.fcntl, "flock"):
                with self.assertRaises(client.IdentityMismatch):
                    self.invoke()
        self.assertFalse(any(c[0] != "deno" and Path(c[1]).name == "account.py" for c in self.calls))


if __name__ == "__main__": unittest.main()


"""Real curl/TLS and child-process lifecycle; the legacy verifier/proxy and lease service are local stand-ins."""
import datetime
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("layover_fetch", Path(__file__).parents[1] / "static/kit/fetch.py")
fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)
LEASE = "00000000-0000-4000-8000-000000000001"
PAGE = b"<!doctype html><title>Layover research test</title><p>Actual content.</p>"

FAKE_DENO = '''#!/usr/bin/env python3
import os,sys,socket,socketserver,select
from pathlib import Path
cmd=sys.argv[4];args=sys.argv[5:]
if cmd=='verify':
 sys.exit(1 if (Path(args[2])/'refuse').exists() else 0)
directory,lease,port=args
class Proxy(socketserver.BaseRequestHandler):
 def handle(self):
  data=b''
  while b'\\r\\n\\r\\n' not in data:
   part=self.request.recv(4096)
   if not part:return
   data+=part
  if not data.startswith(b'CONNECT example.test:443 '):
   self.request.sendall(b'HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\n\\r\\n');return
  with socket.create_connection(('127.0.0.1',int(os.environ['LY_TEST_PORT']))) as upstream:
   self.request.sendall(b'HTTP/1.1 200 Connection established\\r\\n\\r\\n')
   while True:
    ready,_,_=select.select([self.request,upstream],[],[],5)
    if not ready:return
    for source in ready:
     part=source.recv(65536)
     if not part:return
     (upstream if source is self.request else self.request).sendall(part)
class Server(socketserver.ThreadingTCPServer):daemon_threads=True
server=Server(('127.0.0.1',int(port)),Proxy)
(Path(directory)/'proxy.pid').write_text(str(os.getpid()))
print(f'resip-proxy for lease {lease} on 127.0.0.1:{port}; test proxy',flush=True)
server.serve_forever()
'''


class FetchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.TemporaryDirectory(prefix="layover-fetch-test-")
        cls.path = Path(cls.root.name)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=example.test", "-addext", "subjectAltName=DNS:example.test",
            "-keyout", str(cls.path / "key.pem"), "-out", str(cls.path / "ca.pem")], check=True, capture_output=True)
        cls.requests = []
        class Origin(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                cls.requests.append(self.path)
                if self.path == "/redirect":
                    self.send_response(302); self.send_header("Location", "https://other.test/private")
                    self.send_header("Content-Length", "0"); self.end_headers(); return
                if self.path == "/empty":
                    self.send_response(204); self.end_headers(); return
                if self.path == "/slow": time.sleep(1)
                self.send_response(206 if self.path == "/partial" else 200); self.send_header("Content-Type", "text/html")
                if self.path == "/partial": self.send_header("Content-Range", "bytes 0-9/100")
                if self.path == "/big":
                    self.send_header("Transfer-Encoding", "chunked"); self.end_headers()
                    try: self.wfile.write(b"3000\r\n" + b"x" * 12288 + b"\r\n0\r\n\r\n")
                    except OSError: pass
                else:
                    self.send_header("Content-Length", str(len(PAGE))); self.end_headers()
                    try: self.wfile.write(PAGE)
                    except OSError: pass
        cls.origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cls.path / "ca.pem", cls.path / "key.pem")
        cls.origin.socket = tls.wrap_socket(cls.origin.socket, server_side=True)
        threading.Thread(target=cls.origin.serve_forever, daemon=True).start()
        class Lease(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                assert self.headers.get("Authorization") == "Bearer private-test-secret"
                end = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=-1 if getattr(self.server, "expired", False) else 1)
                body = json.dumps(dict(agent_id="private-resource", end=None,
                    decision=dict(decision="accept", term_end=end.isoformat()))).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        cls.leases = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Lease)
        threading.Thread(target=cls.leases.serve_forever, daemon=True).start()
        cls.bin = cls.path / "bin"; cls.bin.mkdir()
        (cls.bin / "deno").write_text(FAKE_DENO); (cls.bin / "deno").chmod(0o700)

    @classmethod
    def tearDownClass(cls):
        cls.origin.shutdown(); cls.origin.server_close()
        cls.leases.shutdown(); cls.leases.server_close()
        cls.root.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=self.path)
        self.directory = Path(self.temp.name)
        self.output = self.directory / "page.html"
        ca = (self.path / "ca.pem").read_text()
        (self.directory / "ca.pem").write_text(ca)
        (self.directory / "agent.json").write_text(json.dumps(dict(base=f"http://127.0.0.1:{self.leases.server_port}",
            agent_id="private-resource", ca_sha256=hashlib.sha256(ssl.PEM_cert_to_DER_cert(ca)).hexdigest())))
        (self.directory / "account.json").write_text(json.dumps(dict(secret="private-test-secret")))
        (self.directory / f"lease-{LEASE}.json").write_text(json.dumps(dict(id=LEASE, domains=["example.test"])))
        self.env = patch.dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], LY_TEST_PORT=str(self.origin.server_port), NO_PROXY="*")
        self.env.start(); self.requests.clear(); self.leases.expired = False

    def tearDown(self):
        pid = self.directory / "proxy.pid"
        if pid.exists():
            with self.assertRaises(ProcessLookupError): os.kill(int(pid.read_text()), 0)
        self.env.stop(); self.temp.cleanup()

    def get(self, path="/ok", **kwargs):
        return fetch.fetch_page(self.directory, "https://example.test" + path, self.output, timeout=5, **kwargs)

    def test_returns_real_content_through_proxy_and_ignores_no_proxy(self):
        result = self.get()
        self.assertTrue(result["loaded"] and result["complete"])
        self.assertEqual(self.output.read_bytes(), PAGE)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(result["sha256"], hashlib.sha256(PAGE).hexdigest())
        self.assertEqual(result["charge"]["status"], "pending_lease_settlement")
        self.assertEqual(self.requests, ["/ok"])

    def test_cli_returns_one_json_result_without_private_credentials(self):
        run = subprocess.run([sys.executable, str(Path(__file__).parents[1] / "static/kit/fetch.py"),
            str(self.directory), "https://example.test/ok", str(self.output), "--timeout", "5"], capture_output=True, text=True, timeout=8)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertTrue(json.loads(run.stdout)["loaded"])
        self.assertNotIn("private-test-secret", run.stdout + run.stderr)

    def test_url_braces_and_ranges_are_literal_and_fetch_exactly_once(self):
        for index, path in enumerate(("/{ok,ok}", "/[1-2]")):
            with self.subTest(path=path):
                self.output = self.directory / f"literal-{index}.html"
                self.requests.clear()
                result = self.get(path)
                self.assertTrue(result["loaded"])
                self.assertEqual(self.requests, [path])
                self.assertEqual(self.output.read_bytes(), PAGE)

    def test_verification_failure_sends_no_target_request(self):
        (self.directory / "refuse").touch()
        with self.assertRaisesRegex(fetch.FetchError, "verification failed"): self.get()
        self.assertEqual(self.requests, []); self.assertFalse(self.output.exists())

    def test_outside_lease_host_is_not_requested(self):
        with self.assertRaisesRegex(fetch.FetchError, "no active authorized lease"):
            fetch.fetch_page(self.directory, "https://outside.test/", self.output, timeout=5)
        self.assertEqual(self.requests, []); self.assertFalse(self.output.exists())

    def test_redirect_is_reported_without_following_it(self):
        result = self.get("/redirect")
        self.assertEqual(result["outcome"], "redirect"); self.assertFalse(result["loaded"])
        self.assertEqual(self.requests, ["/redirect"])

    def test_chunked_response_is_bounded_and_marked_incomplete(self):
        result = self.get("/big", max_bytes=1024)
        self.assertEqual(result["outcome"], "truncated"); self.assertFalse(result["complete"])
        self.assertEqual(self.output.stat().st_size, 1024)

    def test_partial_http_response_is_not_claimed_as_a_complete_page(self):
        result = self.get("/partial")
        self.assertEqual(result["outcome"], "partial_response")
        self.assertTrue(result["transport_complete"])
        self.assertFalse(result["complete"] or result["loaded"])

    def test_empty_response_is_not_reported_as_a_loaded_page(self):
        result = self.get("/empty")
        self.assertEqual(result["outcome"], "empty_response")
        self.assertFalse(result["loaded"])

    def test_existing_artifact_is_never_overwritten(self):
        self.output.write_text("keep")
        with self.assertRaises(FileExistsError): self.get()
        self.assertEqual(self.output.read_text(), "keep"); self.assertEqual(self.requests, [])

    def test_symlink_artifact_is_not_followed(self):
        target = self.directory / "not-created"
        self.output.symlink_to(target)
        with self.assertRaises(FileExistsError): self.get()
        self.assertFalse(target.exists()); self.assertEqual(self.requests, [])

    def test_expired_lease_is_not_used(self):
        self.leases.expired = True
        with self.assertRaisesRegex(fetch.FetchError, "no active authorized lease"): self.get()
        self.assertEqual(self.requests, [])

    def test_curl_configuration_cannot_disable_certificate_checks(self):
        other = self.directory / "other.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=other.test", "-keyout", str(self.directory / "other.key"), "-out", str(other)], check=True, capture_output=True)
        (self.directory / "ca.pem").write_bytes(other.read_bytes())
        agent = json.loads((self.directory / "agent.json").read_text())
        agent["ca_sha256"] = hashlib.sha256(ssl.PEM_cert_to_DER_cert(other.read_text())).hexdigest()
        (self.directory / "agent.json").write_text(json.dumps(agent))
        (self.directory / ".curlrc").write_text("--insecure\n")
        with patch.dict(os.environ, HOME=str(self.directory)):
            result = self.get()
        self.assertFalse(result["loaded"]); self.assertEqual(result["transport_exit_code"], 60)
        self.assertEqual(self.requests, [])

    def test_deadline_stops_transport_without_leaving_a_proxy(self):
        start = time.monotonic()
        try:
            result = fetch.fetch_page(self.directory, "https://example.test/slow", self.output, timeout=0.2)
            self.assertFalse(result["complete"])
        except fetch.FetchError as error:
            self.assertEqual(error.stage, "deadline")
        self.assertLess(time.monotonic() - start, 2.5)


if __name__ == "__main__": unittest.main()

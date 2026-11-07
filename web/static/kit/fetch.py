#!/usr/bin/env python3
"""Fetch HTTPS content through an existing verified, authorized Layover lease; never buys or tops up access."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.request
import urllib.parse
import uuid


class FetchError(Exception):
    def __init__(self, stage, reason):
        self.stage, self.reason = stage, reason
        super().__init__(reason)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise FetchError("deadline", "request deadline exceeded")
    return seconds


def lease_for(directory, agent, host, deadline, wanted=None):
    secret = json.loads((directory / "account.json").read_text())["secret"]
    if wanted:
        if str(uuid.UUID(wanted)) != wanted:
            raise FetchError("allocation", "lease id must be a canonical UUID")
        candidates = [directory / f"lease-{wanted}.json"]
    else:
        candidates = sorted(directory.glob("lease-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in candidates:
        mine = json.loads(path.read_text())
        if host not in [d.lower() for d in mine["domains"]]:
            continue
        lease_id = str(uuid.UUID(mine["id"]))
        req = urllib.request.Request(agent["base"] + "/api/leases/" + lease_id,
            headers={"authorization": "Bearer " + secret})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=remaining(deadline)) as response:
            live = json.load(response)
        decision = live.get("decision") or {}
        if live.get("agent_id") != agent["agent_id"] or live.get("end") or decision.get("decision") != "accept":
            continue
        end = datetime.datetime.fromisoformat(decision["term_end"].replace("Z", "+00:00"))
        if end.timestamp() > time.time():
            return lease_id
    raise FetchError("allocation", "no active authorized lease covers this host; ask your agent to arrange access")


def stop(process):
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    if process.stdout:
        process.stdout.close()


def fetch_page(directory, url, output, client=None, lease=None, timeout=30, max_bytes=1048576):
    start = time.monotonic()
    if not math.isfinite(timeout) or timeout <= 0 or max_bytes <= 0:
        raise FetchError("input", "timeout and max-bytes must be positive")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise FetchError("input", "use an HTTPS URL on port 443 without URL credentials")
    directory, output = Path(directory).resolve(), Path(os.path.abspath(output))
    client = Path(client or Path(__file__).with_name("layover.js")).resolve()
    agent = json.loads((directory / "agent.json").read_text())
    deadline = start + timeout
    proxy = curl = None
    created = False
    try:
        # Reserve the artifact before network use; never overwrite another file or follow its symlink.
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as body:
            checked = subprocess.run(["deno", "run", "-A", str(client), "verify", agent["base"], agent["agent_id"], str(directory)],
                capture_output=True, timeout=remaining(deadline))
            if checked.returncode:
                raise FetchError("verification", "guest verification failed; no target request was sent")
            agent = json.loads((directory / "agent.json").read_text())
            ca = directory / "ca.pem"
            der = ssl.PEM_cert_to_DER_cert(ca.read_text())
            if hashlib.sha256(der).hexdigest() != agent.get("ca_sha256"):
                raise FetchError("verification", "CA does not match the verified registration")
            verified_seconds = time.monotonic() - start
            lease_id = lease_for(directory, agent, parsed.hostname.lower(), deadline, lease)
            with socket.socket() as port_socket:
                port_socket.bind(("127.0.0.1", 0))
                port = port_socket.getsockname()[1]
            with tempfile.TemporaryDirectory(prefix="layover-fetch-") as scratch:
                headers = Path(scratch) / "headers"
                with (Path(scratch) / "errors").open("w+b") as errors:
                    proxy = subprocess.Popen(["deno", "run", "-A", str(client), "proxy", str(directory), lease_id, str(port)],
                        stdout=subprocess.PIPE, stderr=errors)
                    with selectors.DefaultSelector() as selector:
                        selector.register(proxy.stdout, selectors.EVENT_READ)
                        if not selector.select(remaining(deadline)):
                            raise FetchError("deadline", "local proxy did not become ready before the deadline")
                        ready = proxy.stdout.readline().decode()
                    if not ready.startswith(f"resip-proxy for lease {lease_id} on 127.0.0.1:{port};") or proxy.poll() is not None:
                        raise FetchError("proxy", "local proxy failed to bind; no target request was sent")
                    command = ["curl", "-q", "--globoff", "--silent", "--show-error", "--suppress-connect-headers", "--proxy", f"http://127.0.0.1:{port}",
                        "--noproxy", "", "--cacert", str(ca), "--proto", "=https", "--max-time", str(remaining(deadline)),
                        "--dump-header", str(headers), "--url", url]
                    curl = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
                    digest, size, truncated = hashlib.sha256(), 0, False
                    while chunk := curl.stdout.read(min(65536, max_bytes - size + 1)):
                        take = chunk[:max_bytes - size]
                        body.write(take)
                        digest.update(take)
                        size += len(take)
                        if len(take) < len(chunk):
                            truncated = True
                            stop(curl)
                            break
                    code = curl.wait(timeout=max(remaining(deadline), 0.1)) if curl.poll() is None else curl.returncode
                raw = headers.read_text(encoding="iso-8859-1") if headers.exists() else ""
                blocks = [b for b in raw.replace("\r\n", "\n").split("\n\n") if b.startswith("HTTP/")]
                last = blocks[-1].splitlines() if blocks else []
                status = int(last[0].split()[1]) if last else None
                fields = dict(line.split(":", 1) for line in last[1:] if ":" in line)
                content_type = next((v.strip() for k, v in fields.items() if k.lower() == "content-type"), None)
                transport_complete = code == 0 and not truncated
                partial = status == 206 or any(k.lower() == "content-range" for k in fields)
                complete = transport_complete and not partial
                if truncated:
                    outcome = "truncated"
                elif not transport_complete:
                    outcome = "transport_error"
                elif partial:
                    outcome = "partial_response"
                elif status and 200 <= status < 300:
                    outcome = "complete" if size else "empty_response"
                else:
                    outcome = "redirect" if status and 300 <= status < 400 else "http_error"
                return dict(operation_id=str(uuid.uuid4()), outcome=outcome, http_status=status, content_type=content_type,
                    complete=complete, loaded=complete and bool(status and 200 <= status < 300 and size), truncated=truncated,
                    transport_complete=transport_complete,
                    transport_exit_code=code,
                    body_path=str(output), bytes=size, sha256=digest.hexdigest(), lease_id=lease_id,
                    charge=dict(status="pending_lease_settlement"),
                    timings=dict(verification_seconds=round(verified_seconds, 3), total_seconds=round(time.monotonic() - start, 3)))
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    finally:
        stop(curl)
        stop(proxy)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory")
    parser.add_argument("url")
    parser.add_argument("output")
    parser.add_argument("--lease")
    parser.add_argument("--client")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--max-bytes", type=int, default=1048576)
    args = parser.parse_args()
    try:
        result = fetch_page(**vars(args))
        print(json.dumps(result))
        return 0 if result["loaded"] else 1
    except (FetchError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps(dict(outcome="failed", stage=getattr(error, "stage", "client"),
            reason=getattr(error, "reason", str(error)), complete=False)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

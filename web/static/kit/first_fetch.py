#!/usr/bin/env python3
"""Fetch one page with explicitly delegated escrow authority; no signup, faucet or wallet export.

Use the deployed buyer kit (including fetch.py). SOUK_HOME must already hold a
signed-in funded Layover account. Reuse the operation file after any interruption.
"""
import argparse
import fcntl
import math
import tempfile
import urllib.request
import urllib.error
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.parse
import uuid

BASE = "https://pod.dstack.soc1024.com/resip-staging"
SOUK = "31f5c141-fb2d-4572-939a-68543a2d0649"
CUSTODY = "https://pod.dstack.soc1024.com/resip-custody-staging/api/custody/"


class Pending(Exception):
    pass


class IdentityMismatch(Pending):
    stage = "identity_mismatch"
    charge = "none"


def private_file(path):
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("operation state must be an owner-only regular file")


def save(path, state):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=path.name + ".", delete=False) as out:
        temporary = Path(out.name)
        json.dump(state, out); out.flush(); os.fsync(out.fileno())
    os.replace(temporary, path)
    parent = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try: os.fsync(parent)
    finally: os.close(parent)



def contract(events, operation, wanted):
    for event in reversed(events):
        if event["kind"] != "Output":
            continue
        try:
            body = json.loads(event["payload"]["text"])
        except ValueError:
            continue
        if isinstance(body, dict) and body.get("kind") == "layover-allocation/1" and body.get("operation_id") == operation and body.get("status") == wanted:
            return body
    return None


# Same stdlib-only Keccak implementation used by the amin terms contract.
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


def validate(quote, host, cap):
    x = quote["terms"]
    escrow = x["escrow"]
    canonical = json.loads(escrow["terms"])
    if (escrow["terms"] != json.dumps(canonical, sort_keys=True, separators=(",", ":")) or
        escrow["terms_hash"] != "0x" + keccak256(escrow["terms"]) or
        not isinstance(escrow["operator"], str) or not re.fullmatch("0x[0-9a-f]{40}", escrow["operator"]) or escrow["operator"] == "0x" + "0" * 40 or
        type(x["price_per_gb"]) is not int or not 0 < x["price_per_gb"] <= 1000000 or
        not isinstance(escrow["cap"], str) or not re.fullmatch("[1-9][0-9]{0,29}", escrow["cap"]) or
        not isinstance(escrow["deposit"], str) or not re.fullmatch("0|[1-9][0-9]*", escrow["deposit"]) or int(escrow["deposit"]) > int(escrow["cap"])):
        raise ValueError("allocation has invalid canonical financial terms")
    if (not re.fullmatch("[A-Za-z0-9._:-]{1,64}", x["agent_id"]) or x["agent_id"].startswith("test-") or
        not re.fullmatch("[A-Za-z0-9._:-]{1,128}", quote["thread"]) or
        not re.fullmatch(r"(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", host) or
        not 0 < int(escrow["cap"]) * 100000 // x["price_per_gb"] <= 9007199254740991):
        raise ValueError("allocation exceeds supported standing terms")
    expected = dict(chain_id=84532, escrow="0xdf9bb576e30ec71e200643ab6fc835eee12c95ea", token="0x9e851bf5e3b613aaa09853a07d1132f49c90b515",
                    thread=quote["thread"], agent_id=x["agent_id"], mode="shared", domains=[host], category="price_check", minutes=5,
                    operator=escrow["operator"], price_per_gb=x["price_per_gb"], cap=escrow["cap"], kind="layover-terms/1")
    if quote["base"] != BASE or canonical != expected or x["domains"] != [host] or x["exclusive"] is not False or x["minutes"] != 5 or x["category"] != "price_check" or not 0 < int(escrow["cap"]) <= cap * 10000 or int(escrow["deposit"]) > cap * 10000 or quote["expires"] <= time.time():
        raise ValueError("allocation violates the delegated scope, cap or expiry")
    return x


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url"); parser.add_argument("output"); parser.add_argument("operation", type=Path)
    parser.add_argument("--kit", type=Path, default=Path(__file__).parent)
    parser.add_argument("--max-credits", type=int, required=True, help="Explicit maximum: 100 credits = 1 LAYC = $1")
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--max-bytes", type=int, default=1048576)
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.port not in (None, 443) or parsed.username or parsed.password or args.max_credits < 1 or args.max_bytes < 1 or not math.isfinite(args.timeout) or args.timeout <= 0:
        raise ValueError("HTTPS port443 URL without credentials and positive credit cap required")
    output = Path(args.output).absolute()
    if (output.exists() or output.is_symlink()) and not args.operation.exists():
        raise ValueError("output already exists")
    if args.operation.is_symlink():
        raise ValueError("operation state cannot be a symlink")
    home = Path(os.environ.get("SOUK_HOME", Path.home() / ".config/souk"))
    session = json.loads((home / "account.json").read_text())
    wallet = session["address"]
    service = "https://pod.dstack.soc1024.com/layover-accounts"
    if session.get("url") != service or os.environ.get("LAYOVER_ACCOUNTS", service) != service:
        raise ValueError("account session and financial client must use the trusted accounts service")
    lock = os.open(str(args.operation) + ".lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    deadline = time.monotonic() + args.timeout
    kit = args.kit.resolve()
    binding = dict(url=args.url, output=str(output), max_credits=args.max_credits, max_bytes=args.max_bytes, wallet=wallet.lower(), accounts_service="https://pod.dstack.soc1024.com/layover-accounts")
    if args.operation.exists():
        private_file(args.operation)
        state = json.loads(args.operation.read_text())
        if state["binding"] != binding:
            raise ValueError("operation file belongs to another request")
    else:
        state = dict(operation_id=str(uuid.uuid4()), binding=binding, stage="new")
        save(args.operation, state)
    def http(url, token=None, body=None):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args): return None
        seconds = deadline - time.monotonic()
        if seconds <= 0: raise Pending("deadline reached; resume this operation")
        req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json", **({"authorization": "Bearer " + token} if token is not None else {})})
        with urllib.request.build_opener(NoRedirect).open(req, timeout=seconds) as response:
            return json.load(response)
    def run(name, *words, json_result=True, allow_outcome=False):
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise Pending("deadline reached; resume this operation file")
        command = ["deno", "run", "-A", str(kit / "layover.js"), *map(str, words)] if name == "line" else [sys.executable, str(kit / name), *map(str, words)]
        done = subprocess.run(command, capture_output=True, text=True, timeout=seconds)
        if done.returncode and not allow_outcome:
            raise Pending(f"{name} failed; inspect/reconcile this operation before retrying")
        return json.loads(done.stdout) if json_result else None
    def wait_for(status):
        while time.monotonic() < deadline:
            events = run("souk.py", "inbox", SOUK)
            found = contract(events, state["operation_id"], status)
            if found:
                return found
            for failed in ("unavailable", "expired"):
                failure = contract(events, state["operation_id"], failed)
                if failure:
                    raise Pending("allocation " + failed + ": " + failure.get("reason", "access unavailable"))
            time.sleep(min(2, max(0, deadline - time.monotonic())))
        raise Pending("allocation is pending; resume this operation file")
    def mark(stage):
        state["stage"] = stage; save(args.operation, state)
    if state["stage"] == "declined":
        raise Pending("host declined; terms closed; this operation cannot fetch")
    # Cleanup and result reconciliation remain possible after the quote expires.
    if state["stage"] in ("fetch_sent", "fetched", "closed"):
        if state["stage"] != "closed":
            run("account.py", "close", state["quote"]["terms"]["escrow"]["terms_hash"])
            mark("closed")
        if "result" in state:
            print(json.dumps(state["result"]))
            return 0 if state["result"].get("loaded") else 1
        raise Pending("fetch outcome unknown; terms closed; inspect the artifact, no target request was repeated")
    if output.exists() or output.is_symlink():
        raise Pending("output already exists; reconcile this operation and close its terms if abandoning")
    if state["stage"] == "new":
        mark("request_sent")  # Unknown outcomes must never submit a second request.
        run("souk.py", "send", SOUK, json.dumps(dict(kind="allocate", text=json.dumps(dict(operation_id=state["operation_id"], domains=[parsed.hostname.lower()], category="price_check", minutes=5, max_price=args.max_credits, exclusive=False, pay="escrow", auto_accept=True)))))
    if state["stage"] == "request_sent":
        state["quote"] = wait_for("requires_acceptance"); mark("quoted")
    quote = state["quote"]
    x = validate(quote, parsed.hostname.lower(), args.max_credits)
    directory = Path(str(args.operation.absolute()) + ".line")
    if state["stage"] == "quoted":
        # Reject known ownership mismatches before any payment. This public metadata
        # is only a preflight: the constructor still rechecks attestation/custody after acceptance.
        custody = http(CUSTODY + urllib.parse.quote(x["agent_id"], safe=""))
        if not isinstance(custody, dict) or custody.get("agent_id") != x["agent_id"] or custody.get("operator") != x["escrow"]["operator"]:
            raise IdentityMismatch("custody ownership differs from the allocation; no payment was attempted")
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
            raise ValueError("line state requires a private owned directory")
        run("line", "verify", BASE, x["agent_id"], directory, json_result=False)
        account = directory / "account.json"
        if not account.exists():
            save(account, dict(secret=secrets.token_hex(32)))
        state["account_id"] = hashlib.sha256(bytes.fromhex(json.loads(account.read_text())["secret"])).hexdigest()
        mark("accept_sent")
        e = x["escrow"]
        run("account.py", "accept", e["terms_hash"], e["operator"], e["cap"], e["deposit"])
        mark("accepted")
    if state["stage"] == "accept_sent":
        raise Pending("account acceptance outcome unknown; reconcile on chain before advancing")
    if state["stage"] == "accepted":
        mark("admission_sent")
        run("souk.py", "send", SOUK, json.dumps(dict(thread=quote["thread"], text=f"accepted {x['escrow']['terms_hash']} {wallet} {state['account_id']}")))
    if state["stage"] == "admission_sent":
        state["ready"] = wait_for("ready"); mark("ready")
    if state["stage"] == "ready":
        validate(state["ready"], parsed.hostname.lower(), args.max_credits)
        if state["ready"].get("wallet", "").lower() != wallet.lower():
            raise ValueError("admitted wallet differs from this signed-in account")
        state["authorization"] = http("https://pod.dstack.soc1024.com/layover-accounts/api/lease-authorization", session["session"],
            dict(site_account=state["account_id"], agent_id=x["agent_id"], terms=json.loads(x["escrow"]["terms"])))
        mark("authorized")
    if state["stage"] == "authorized":
        ticket = state["authorization"]
        secret = json.loads((directory / "account.json").read_text())["secret"]
        mark("lease_sent")
        live = http(BASE + "/api/leases", secret, dict(agent_id=x["agent_id"], deposit=0, exclusive=False,
            terms_hash=x["escrow"]["terms_hash"], enc=ticket["enc"], admission=ticket["admission"], signature=ticket["signature"]))
        state["lease_id"] = live["id"]
        save(directory / ("lease-" + live["id"] + ".json"), dict(ticket["private"], id=live["id"], exclusive=False))
        mark("lease_open")
    if state["stage"] == "lease_open":
        secret = json.loads((directory / "account.json").read_text())["secret"]
        while True:
            live = http(BASE + "/api/leases/" + state["lease_id"], secret)
            if live.get("decision"):
                if live["decision"]["decision"] != "accept":
                    deadline = max(deadline, time.monotonic() + 30)
                    run("account.py", "close", x["escrow"]["terms_hash"])
                    mark("declined")
                    raise Pending("host declined; terms closed, no page requested")
                mark("leased"); break
            time.sleep(min(2, max(0, deadline - time.monotonic())))
    if state["stage"] == "lease_sent":
        raise Pending("lease outcome unknown; reconcile the recorded allocation before advancing")
    if state["stage"] != "leased":
        raise Pending("operation is not ready to fetch; reconcile its existing state")
    mark("fetch_sent")
    try:
        result = run("fetch.py", directory, args.url, output, "--timeout", max(0.1, deadline - time.monotonic()), "--max-bytes", args.max_bytes, "--lease", state["lease_id"], allow_outcome=True)
        state["result"] = result
        mark("fetched")
    finally:
        # Close uses a separate bounded cleanup window; claims remain possible for one day.
        deadline = max(deadline, time.monotonic() + 30)
        run("account.py", "close", x["escrow"]["terms_hash"])
        mark("closed")
    print(json.dumps(result))
    return 0 if result.get("loaded") else 1



if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Pending, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps(dict(outcome="pending", stage=getattr(error, "stage", "client"), reason=str(error), charge=getattr(error, "charge", "pending_signed_settlement"), next="Reuse the operation file to reconcile; close its terms with account.py if abandoning accepted access")))
        raise SystemExit(1)

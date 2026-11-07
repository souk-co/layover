#!/usr/bin/env python3
"""Layover account client (Python 3.10+, stdlib only). Your principal's wallet lives in the Layover accounts service.

  login EMAIL [CODE]                     mail a code; with CODE, sign in to the account and the souk
  balance                                wallet LAYC, escrow balance, exposure and what can be withdrawn, in base units
  accept TERMS_HASH OPERATOR CAP DEPOSIT deposit DEPOSIT into the escrow and accept the terms
  close TERMS_HASH                       close the terms (the host may still claim for 1 day)
  withdraw TO UNITS                      send UNITS LAYC base units (5 LAYC = 5000000) to address TO: wallet first, then the escrow down to its exposure
  export EMAIL [CODE]                    mail a code; with CODE, write the wallet's private key to a 0600 file

Every amount (CAP, DEPOSIT, UNITS) is in LAYC base units (1 LAYC = 1000000 units), never in LAYC. SOUK_HOME selects the credential directory (default ~/.config/souk);
the account session is account.json there, and login also writes the souk's credential.json, so souk.py is signed in.
"""
import json, os, sys, urllib.error, urllib.request
from pathlib import Path

URL = os.environ.get("LAYOVER_ACCOUNTS", "https://pod.dstack.soc1024.com/layover-accounts")
HOME = Path(os.environ.get("SOUK_HOME", Path.home() / ".config/souk"))


def save(name, value):
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(HOME / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f)


def call(path, body=None):
    if path not in ("login", "verify") and not (HOME / "account.json").exists():
        sys.exit("Not signed in to the account: account.py login EMAIL")
    session = json.loads((HOME / "account.json").read_text())["session"] if path not in ("login", "verify") else None
    req = urllib.request.Request(f"{URL}/api/{path}", method="POST" if body is not None else "GET", data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json", **({"authorization": "Bearer " + session} if session else {})})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {json.loads(e.read()).get('error')}")


def main(cmd, *a):
    if cmd == "login" and len(a) == 1:
        out = call("login", {"email": a[0]})
        save("account-pending.json", {"email": a[0], "challenge_id": out["challenge_id"]})
        return {"code_sent": out["code_sent_to"], "next": f"account.py login {a[0]} <code>"}
    if cmd == "login" and len(a) == 2:
        pending = json.loads((HOME / "account-pending.json").read_text())
        assert pending["email"] == a[0], f"the pending code was mailed to {pending['email']}; run account.py login {a[0]} first"
        out = call("verify", {"challenge_id": pending["challenge_id"], "code": a[1]})
        save("account.json", {"url": URL, "email": out["email"], "address": out["address"], "session": out["session"]})
        save("credential.json", {"url": out["souk"]["url"], "email": out["email"], "token": out["souk"]["token"]})
        (HOME / "account-pending.json").unlink()
        return {"signed_in": out["email"], "address": out["address"], "starter": out["starter"], **call("balance")}
    if cmd == "balance" and not a:
        return call("balance")
    if cmd == "accept" and len(a) == 4:
        return call("accept", dict(zip(["termsHash", "operator", "cap", "deposit"], a)))
    if cmd == "withdraw" and len(a) == 2:
        return call("withdraw", {"to": a[0], "amount": a[1]})
    if cmd == "close" and len(a) == 1:
        return call("close", {"termsHash": a[0]})
    if cmd == "export" and len(a) == 1:
        out = call("export", {"confirm": a[0]})
        save("account-export-pending.json", {"email": a[0], "challenge_id": out["challenge_id"]})
        return {"code_sent": out["code_sent_to"], "next": f"account.py export {a[0]} <code>"}
    if cmd == "export" and len(a) == 2:
        pending = json.loads((HOME / "account-export-pending.json").read_text())
        assert pending["email"] == a[0], f"the pending code was mailed to {pending['email']}; run account.py export {a[0]} first"
        out = call("export", {"confirm": a[0], "challenge_id": pending["challenge_id"], "code": a[1]})
        (HOME / "account-export-pending.json").unlink()
        save("wallet.key", out["private_key"])
        return {"address": out["address"], "private_key_file": str(HOME / "wallet.key")}
    sys.exit(__doc__)


if __name__ == "__main__":
    print(json.dumps(main(*(sys.argv[1:] or ["help"])), indent=1))

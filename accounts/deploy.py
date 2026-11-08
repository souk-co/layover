#!/usr/bin/env python3
"""python3 accounts/deploy.py: bundle server.ts and deploy it to the pod webhost as project layover-accounts, in its own
container (isolation: container), attested, then print GET /api/info.

Needs TEE_DAEMON_TOKEN (environment or ~/.oauth3-prod-secrets.env, as web/deploy.py). Omit POT_KEY_FILE on a redeploy
to preserve the existing service env, including the starter pot key. An initial deploy or explicit full env replacement
needs POT_KEY_FILE, the path of the starter pot private key (hex). The key goes into the manifest env, never into git. ACCOUNTS_SEED is not a secret
anyone holds: the webhost derives it inside the TEE from GetKey at /tee-daemon/projects/layover-accounts/accounts-seed-v1
(manifest dstack_env). Renaming the project or the key name changes every wallet.
"""
import io, json, os, re, secrets, shlex, subprocess, tarfile, time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

HERE, BASE, NAME = Path(__file__).resolve().parent, "https://pod.dstack.soc1024.com", "layover-accounts"
ENV = {"RPC": "https://sepolia.base.org", "CHAIN_ID": "84532", "TOKEN": "0x9e851Bf5E3b613aaA09853A07D1132F49c90b515",
       "ESCROW": "0xdf9bb576E30Ec71E200643AB6FC835Eee12C95EA", "SOUK_URL": "https://souk-dev.dstack.soc1024.com",
       "SOUK_ID": "31f5c141-fb2d-4572-939a-68543a2d0649", "STARTER": "5000000", "STARTERS_PER_DAY": "200", "STARTERS_PER_DOMAIN_PER_DAY": "20", "RELAYS_PER_DAY": "20"}


def token():
    if os.environ.get("TEE_DAEMON_TOKEN"):
        return os.environ["TEE_DAEMON_TOKEN"]
    rows = [l for l in (Path.home() / ".oauth3-prod-secrets.env").read_text().splitlines() if re.match(r"^\s*(?:export\s+)?TEE_DAEMON_TOKEN=", l)]
    assert len(rows) == 1, "expected one TEE_DAEMON_TOKEN assignment"
    return shlex.split(rows[0].split("=", 1)[1], comments=True)[0]


def api(path, method="GET", body=None, kind=None):
    headers = {"Authorization": "Bearer " + token(), **({"Content-Type": kind} if kind else {})}
    try:
        with urlopen(Request(BASE + path, method=method, data=body, headers=headers), timeout=120) as r:
            return json.loads(r.read())
    except HTTPError as e:
        raise RuntimeError(f"{method} {path}: {e.code} {e.read().decode()}") from e


pot = None
if os.environ.get("POT_KEY_FILE"):
    pot = Path(os.environ["POT_KEY_FILE"]).read_text().strip()
    assert re.fullmatch(r"(0x)?[0-9a-fA-F]{64}", pot), "POT_KEY_FILE must hold one hex private key"
data = io.BytesIO()
with tarfile.open(fileobj=data, mode="w:gz") as tar:
    bundled = subprocess.check_output(["deno", "bundle", "--platform=deno", str(HERE / "server.ts")])
    info = tarfile.TarInfo("server.ts")
    info.size = len(bundled)
    tar.addfile(info, io.BytesIO(bundled))
ref = subprocess.check_output(["git", "-C", str(HERE), "rev-parse", "HEAD"], text=True).strip()
manifest = {"name": NAME, "source": "tarball://" + NAME, "ref": ref, "runtime": "deno", "mode": "attested", "entry": "server.ts",
            "isolation": "container", "listen": {"port": 8080, "protocol": "http"},
            "dstack_env": {"ACCOUNTS_SEED": "accounts-seed-v1"}}
# Omitting env is the webhost's preserve-existing-env operation. Never send redacted GET values back as secrets.
if pot is not None:
    manifest["env"] = {**ENV, "POT_KEY": pot}
b = "accounts-" + secrets.token_hex(16)
body = (f'--{b}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n'.encode() + json.dumps(manifest).encode()
        + f'\r\n--{b}\r\nContent-Disposition: form-data; name="files"; filename="{NAME}.tgz"\r\nContent-Type: application/gzip\r\n\r\n'.encode()
        + data.getvalue() + f"\r\n--{b}--\r\n".encode())
project = api("/_api/projects", "POST", body, "multipart/form-data; boundary=" + b)
if project.get("mode") != "attested":
    project = api(f"/_api/projects/{NAME}/promote", "POST")
assert project["isolation"] == "container" and project["mode"] == "attested" and project["dstack_env"] == manifest["dstack_env"], "deployed project must retain container isolation, attested mode and the existing TEE seed path"
for _ in range(30):
    try:
        with urlopen(f"{BASE}/{NAME}/api/info", timeout=30) as r:
            print(json.dumps({"url": f"{BASE}/{NAME}/", "ref": ref, "info": json.loads(r.read())}))
            break
    except Exception as e:
        last = e
        time.sleep(2)
else:
    raise last

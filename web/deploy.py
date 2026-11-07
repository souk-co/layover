#!/usr/bin/env python3
"""python3 web/deploy.py site|custody: upload the site (server.ts and static/) to the pod webhost as project resip-staging,
or state custody (custody.ts) as resip-custody-staging, each in its own container, then promote to attested. Not the shared
Deno runtime: every deploy of any project there restarts it, and its connections are refused while it drains.

Uses the webhost admin token TEE_DAEMON_TOKEN from the environment or ~/.oauth3-prod-secrets.env,
the same credential dsmack's private-agent-web/deploy.py reads.

For an initial site deploy, set SOUK_DOORMAN_CREDENTIAL in the environment (omit it on redeploy to preserve the stored secret): the bearer token of a souk member holding both
the buyer and host roles in the IP souk, which POST /api/signup uses to invite new emails. Make it once: a member invites
a doorman address (`souk.py invite 31f5c141-fb2d-4572-939a-68543a2d0649 DOORMAN_EMAIL buyer,host`), then
`SOUK_HOME=<new dir> souk.py login https://souk-dev.dstack.soc1024.com DOORMAN_EMAIL [code]`; the token is
`token` in <new dir>/credential.json. Souk tokens expire 30 days after issue; redeploy with a fresh one before then.
It is passed in the manifest env (never committed).
"""
import io, json, os, re, secrets, shlex, shutil, subprocess, sys, tarfile, tempfile, time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

WEB, BASE = Path(__file__).resolve().parent, "https://pod.dstack.soc1024.com"
# LAYOVER_ENV=staging deploys the staging lane instead (notes/environments.md on main): projects layover-staging and
# layover-custody-staging, custody-staging.json's allowlist, and the site's files rewritten by REWRITES below.
STAGING = os.environ.get("LAYOVER_ENV", "live") == "staging"
assert os.environ.get("LAYOVER_ENV", "live") in ("live", "staging"), "LAYOVER_ENV is live or staging"
NAME, ENTRY, ISOLATION, CHECK = {"site": ("layover-staging" if STAGING else "resip-staging", "server.ts", "container", "api/stats"),
                                 "custody": ("layover-custody-staging" if STAGING else "resip-custody-staging", "custody.ts", "container",
                                             "api/custody/" + ("layover-mini-staging" if STAGING else "resip-mini-1"))}[sys.argv[1]]
SITE = NAME in ("resip-staging", "layover-staging")
# Staging site: the live site's code with its own site, custody and souk, and the staging broker's fleet, payments key, tunnel
# index and UsageEscrow. Line ownership (owners.ts, /fleet/ownership) stays on the live broker: the Mini's line guests run
# under the live pool's App Attest key, MacLinked there only. Every pattern must match somewhere.
STAGING_SOUK = None  # the staging souk on souk-dev (amin/build.py create); not created yet: souk-dev was down 2026-11-06
assert not (STAGING and SITE) or STAGING_SOUK, "set STAGING_SOUK to the staging souk id first"
REWRITES = STAGING and SITE and [
    (re.escape(BASE) + "/resip-staging", BASE + "/layover-staging"),
    (re.escape(BASE) + "/resip-custody-staging/", BASE + "/layover-custody-staging/"),
    (r"/relay-broker(?=[\"/])(?!/fleet/ownership)", "/relay-broker-staging"),
    (re.escape(BASE) + "/private-agent/tunnels", BASE + "/private-agent-staging/tunnels"),
    (r"(?<=`)0x835A61a88Cc8D750b5a971219aa8f9813B2067e6", "0x0813789007631Be301c0714796E92127769B5C41"),
    ("31f5c141-fb2d-4572-939a-68543a2d0649", STAGING_SOUK)]
hits = {}


def staged(raw):
    if not REWRITES:
        return raw
    text = raw.decode()
    for pat, new in REWRITES:
        text, n = re.subn(pat, new, text)
        hits[pat] = hits.get(pat, 0) + n
    return text.encode()


def add(tar, name, raw):
    info = tarfile.TarInfo(name)
    info.size = len(raw)
    tar.addfile(info, io.BytesIO(raw))


def token():
    if os.environ.get("TEE_DAEMON_TOKEN"):
        return os.environ["TEE_DAEMON_TOKEN"]
    rows = [l for l in (Path.home() / ".oauth3-prod-secrets.env").read_text().splitlines() if re.match(r"^\s*(?:export\s+)?TEE_DAEMON_TOKEN=", l)]
    assert len(rows) == 1, "expected one TEE_DAEMON_TOKEN assignment"
    return shlex.split(rows[0].split("=", 1)[1], comments=True)[0]


def api(path, method="GET", body=None, kind=None):
    headers = {"Authorization": "Bearer " + token()}
    if kind:
        headers["Content-Type"] = kind
    try:
        with urlopen(Request(BASE + path, method=method, data=body, headers=headers), timeout=120) as r:
            return json.loads(r.read())
    except HTTPError as e:
        raise RuntimeError(f"{method} {path}: {e.code} {e.read().decode()}") from e


if SITE:
    # The kit's couch/ is a copy of main's couch/ (the source); refuse to deploy a copy that has drifted. `git fetch` first.
    git = lambda *a: subprocess.check_output(["git", "-C", str(WEB.parent), *a])
    from kit_mirror import is_kit
    main = {f for f in git("ls-tree", "-r", "--name-only", "origin/main", "couch/").decode().split() if is_kit(f)}
    kit = WEB / "static/kit"
    assert main == {p.relative_to(kit).as_posix() for p in (kit / "couch").rglob("*") if p.is_file()}, "static/kit/couch/ and origin/main couch/ list different files"
    for f in sorted(main):
        assert (kit / f).read_bytes() == git("show", "origin/main:" + f), f"static/kit/{f} differs from origin/main {f}"

data = io.BytesIO()
with tarfile.open(fileobj=data, mode="w:gz") as tar, tempfile.TemporaryDirectory() as tmp:
    src = WEB
    if NAME == "layover-custody-staging":
        src = Path(tmp) / "web"
        shutil.copytree(WEB, src)
        shutil.copy(WEB / "custody-staging.json", src / "custody.json")
    add(tar, "server.ts", staged(subprocess.check_output(["deno", "bundle", "--platform=deno", str(src / ENTRY)])))
    if SITE:
        for p in sorted(p for p in (WEB / "static").rglob("*") if p.is_file()):
            add(tar, "static/" + p.relative_to(WEB / "static").as_posix(), staged(p.read_bytes()))
        add(tar, "static/kit/resip.js", staged(subprocess.check_output(["deno", "bundle", "--platform=deno", str(WEB / "buyer/resip.ts")])))
assert not REWRITES or all(hits.get(pat) for pat, _ in REWRITES), f"staging rewrites that matched nothing: {hits}"
ref = subprocess.check_output(["git", "-C", str(WEB), "rev-parse", "HEAD"], text=True).strip()
manifest = {"name": NAME, "source": "tarball://" + NAME, "ref": ref, "runtime": "deno", "mode": "attested",
            "entry": "server.ts", "isolation": ISOLATION,
            }
if SITE and os.environ.get("SOUK_DOORMAN_CREDENTIAL"):
    assert os.environ["SOUK_DOORMAN_CREDENTIAL"] != "<redacted>", "withheld secret is not a credential"
    manifest["env"] = {"SOUK_DOORMAN_CREDENTIAL": os.environ["SOUK_DOORMAN_CREDENTIAL"]}
if ISOLATION == "container":
    manifest["listen"] = {"port": 8080, "protocol": "http"}
b = "resip-" + secrets.token_hex(16)
body = (f'--{b}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n'.encode() + json.dumps(manifest).encode()
        + f'\r\n--{b}\r\nContent-Disposition: form-data; name="files"; filename="{NAME}.tgz"\r\nContent-Type: application/gzip\r\n\r\n'.encode()
        + data.getvalue() + f"\r\n--{b}--\r\n".encode())
project = api("/_api/projects", "POST", body, "multipart/form-data; boundary=" + b)
if project.get("mode") != "attested":
    project = api(f"/_api/projects/{NAME}/promote", "POST")
assert project["runtime"] == "deno" and project["isolation"] == ISOLATION and project["mode"] == "attested", project
for _ in range(30):
    try:
        with urlopen(f"{BASE}/{NAME}/{CHECK}", timeout=30) as r:
            print(json.dumps({"url": f"{BASE}/{NAME}/", "ref": ref, "mode": project["mode"], "check": json.loads(r.read())}))
            break
    except Exception as e:
        last = e
        time.sleep(2)
else:
    raise last

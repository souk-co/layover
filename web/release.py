"""Optimistic site release: deno test gate (about 5 s), deploy, then the live checks.

  DSMACK=<dsmack checkout> python3 web/release.py

Gate: `deno test -A --no-check web/` (type-check is not clean on this branch yet). Then `web/deploy.py site` (its env:
TEE_DAEMON_TOKEN, SOUK_DOORMAN_CREDENTIAL), a tag web-release/<UTC> pushed to origin, and after the deploy `web/smoke.py`
against the live site plus one live signup (only that the doorman reaches souk_invite: the program admits later, out of view;
the amin release checks the program side). If a live check fails it files a souk-co/layover-private issue labelled area:front-door
(the status board lists area:* issues) naming the previous release to roll back to, and exits non-zero.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

WEB = Path(__file__).resolve().parent
REPO = WEB.parent
SITE = "https://pod.dstack.soc1024.com/resip-staging"


def git(*a):
    return subprocess.check_output(["git", "-C", str(REPO), *a], text=True).strip()


def signup(sha):
    email = f"souk-test+release-web-{sha[:8]}-{int(time.time())}@soc1024.com"
    r = urllib.request.Request(SITE + "/api/signup", json.dumps(dict(email=email, role="buyer")).encode(), {"content-type": "application/json"})
    out = json.loads(urllib.request.urlopen(r, timeout=60).read())
    assert out["invited"] == email, out
    print("live signup invited " + email, flush=True)


def live(sha):
    subprocess.run([sys.executable, str(WEB / "smoke.py"), SITE, os.environ["DSMACK"]], check=True)
    signup(sha)


if __name__ == "__main__":
    assert not git("status", "--porcelain", "--", "web"), "web/ has uncommitted changes; the release tag must match the deploy"
    sha = git("rev-parse", "HEAD")
    t = time.time()
    subprocess.run(["deno", "test", "-A", "--no-check", str(WEB)], check=True)
    print(f"deno test gate passed in {time.time() - t:.0f} s", flush=True)
    git("fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*", "refs/tags/web-release/*:refs/tags/web-release/*")  # deploy.py compares the kit with origin/main
    tags = git("tag", "-l", "web-release/*", "--sort=-refname").split()
    prev = git("rev-list", "-n1", tags[0]) if tags else ""
    subprocess.run([sys.executable, str(WEB / "deploy.py"), "site"], check=True)
    tag = "web-release/" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    git("tag", tag, sha)
    git("push", "-q", "origin", tag)
    print(f"released {sha} as {tag}; previous {prev or 'none'}", flush=True)
    try:
        live(sha)
    except Exception as e:
        rollback = f"git checkout {prev} -- web && python3 web/deploy.py site && git checkout HEAD -- web" if prev else "no earlier web-release tag: pick the revision by hand"
        body = f"Live checks failed after site release `{sha}`: `{e}`\n\nRoll back to `{prev}` (the previous release):\n```\n{rollback}\n```\nor fix forward and `python3 web/release.py`."
        subprocess.run(["gh", "api", "repos/souk-co/layover-private/issues", "-f", f"title=Site live checks failed after release {sha[:8]}",
                        "-f", "body=" + body, "-f", "labels[]=area:front-door", "-f", "labels[]=bug"], check=True)
        raise

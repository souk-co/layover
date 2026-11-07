"""Optimistic amin release: a smoke gate of about a minute blocks the revision; the full suite runs after it, in parallel (four workers by default; AMIN_TEST_WORKERS overrides).

  python3 amin/release.py smoke                  the gate alone
  python3 amin/release.py full                   the whole suite under pytest-xdist
  python3 amin/release.py release SOUK [--resip URL]

release: smoke gate, `build.py revise`, a tag amin-release/<souk8>/<UTC> pushed to origin, a live signup through the site (no ProgramError after its Invite),
then the full suite detached (log in the main checkout's local-data/amin-release-<sha8>.log). If the full suite fails it files a
souk-co/layover-private issue labelled area:amin (the status board lists area:* issues) naming the previous release to roll back to.

Run with the souk dev host's Python (3.13, pytest, pytest-xdist) and SOUK_REPO at the souk-co/souk commit the dev host runs.
Needs a clean amin/ (the tag must be the bundle that went out) and $SOUK_HOME/credential.json (build.py).
"""

import argparse
import ast
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from build import api, bundle

HERE = Path(__file__).parent
REPO = HERE.parent
T = "amin/test/test_amin.py::"
SMOKE = [T + n for n in (
    "test_invite_admits",
    "test_no_top_level_name_shadows_the_sdk",
    "test_bundle_files_fit_the_host_limit",
    "test_enroll_match_hold_settle",  # lease card
    "test_fetch_job_settles_per_page[5-True-1001]",  # fetch card
    "test_escrow_lease_is_admitted_only_when_guestescrow_holds_funded_terms",
)]


def test_workers():
    value = int(os.environ.get("AMIN_TEST_WORKERS", "4"))
    if value < 1:
        raise ValueError("AMIN_TEST_WORKERS must be a positive worker count")
    return str(value)


def program_resip(source):
    values = [node.value.value for node in ast.parse(source).body
              if isinstance(node, ast.Assign) and len(node.targets) == 1
              and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "RESIP"
              and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)]
    if len(values) != 1:
        raise ValueError("release bundle must define exactly one literal RESIP URL")
    return values[0]


def git(*a):
    return subprocess.check_output(["git", "-C", str(REPO), *a], text=True).strip()


def pytest(*a):
    r = os.environ["SOUK_REPO"]
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(f"{r}/{p}" for p in ("host", "host/tests", "kit/credits", "kit/allocation")))
    t = time.time()
    code = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *a], cwd=REPO, env=env).returncode
    print(f"pytest {'passed' if code == 0 else 'FAILED'} in {time.time() - t:.0f} s", flush=True)
    return code


def signup(resip, souk, sha):
    # souk_invite only queues the Invite; the program decides later. So wait, then read the creator's inbox for any
    # ProgramError after it (the 2026-11-06 admit shadowing returned "invited" while every Invite raised).
    email = f"souk-test+release-{sha[:8]}-{int(time.time())}@soc1024.com"
    r = urllib.request.Request(resip + "/api/signup", json.dumps(dict(email=email, role="buyer")).encode(), {"content-type": "application/json"})
    out = json.loads(urllib.request.urlopen(r, timeout=60).read())
    assert out["invited"] == email, out
    time.sleep(30)
    errors = [x for x in api("souk_inbox", souk_id=souk) if x.get("kind") == "ProgramError" and x["seq"] > out["event"]["event_id"]]
    assert not errors, errors
    print(f"live signup {email}: invited, no program error in 30 s", flush=True)


def report(souk, sha, prev, resip, log):
    flag = f" --resip {resip}" if resip else ""
    rollback = (f"git checkout {prev} -- amin && python3 amin/build.py revise {souk}{flag} && git checkout HEAD -- amin" if prev
                else "no earlier amin-release tag for this souk: pick the revision by hand")
    body = (f"The full amin suite failed after release `{sha}` to souk `{souk}`.\n\nRoll back to `{prev}` (the previous release):\n"
            f"```\n{rollback}\n```\nor fix forward and `python3 amin/release.py release {souk}{flag}`.\n\n"
            f"Failures (log `{log}`):\n```\n{''.join(l for l in Path(log).read_text().splitlines(True) if l.startswith(('FAILED', 'ERROR')))[-6000:]}```")
    subprocess.run(["gh", "api", "repos/souk-co/layover-private/issues", "-f", f"title=Amin full suite failed after release {sha[:8]}",
                    "-f", "body=" + body, "-f", "labels[]=area:amin", "-f", "labels[]=bug"], check=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=("smoke", "full", "release", "after"))
    p.add_argument("souk", nargs="?")
    p.add_argument("--resip")
    p.add_argument("--sha")
    p.add_argument("--prev")
    o = p.parse_args()
    if o.command == "smoke":
        sys.exit(pytest(*SMOKE))
    if o.command == "full":
        sys.exit(pytest("-n", test_workers(), "amin/test"))
    if o.command == "after":
        log = os.environ["AMIN_RELEASE_LOG"]
        if pytest("-n", test_workers(), "amin/test"):
            report(o.souk, o.sha, o.prev, o.resip, log)
            sys.exit(1)
        sys.exit(0)
    assert o.souk, "release needs SOUK"
    assert not git("status", "--porcelain", "--", "amin"), "amin/ has uncommitted changes; the release tag must match the bundle"
    sha = git("rev-parse", "HEAD")
    if pytest(*SMOKE):
        sys.exit("smoke gate failed; nothing released")
    git("fetch", "-q", "origin", "refs/tags/amin-release/*:refs/tags/amin-release/*")
    tags = git("tag", "-l", f"amin-release/{o.souk[:8]}/*", "--sort=-refname").split()
    prev = git("rev-list", "-n1", tags[0]) if tags else ""
    release_bundle = bundle(o.resip)
    resip = program_resip(release_bundle["souk.py"])  # Validate before the publishing side effect.
    print(json.dumps(api("souk_revise", souk_id=o.souk, bundle=release_bundle)), flush=True)
    tag = f"amin-release/{o.souk[:8]}/{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    git("tag", tag, sha)
    git("push", "-q", "origin", tag)
    print(f"released {sha} as {tag}; previous {prev or 'none'}", flush=True)
    signup(resip, o.souk, sha)
    logs = (REPO / git("rev-parse", "--git-common-dir")).resolve().parent / "local-data"
    logs.mkdir(exist_ok=True)
    log = logs / f"amin-release-{sha[:8]}.log"
    after = [sys.executable, __file__, "after", o.souk, "--sha", sha, "--prev", prev] + (["--resip", o.resip] if o.resip else [])
    subprocess.Popen(after, stdout=log.open("w"), stderr=subprocess.STDOUT, start_new_session=True, env=dict(os.environ, AMIN_RELEASE_LOG=str(log)))
    print(f"full suite running detached; log {log}")

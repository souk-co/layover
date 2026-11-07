#!/usr/bin/env python3
"""python3 couch/dsmack/preflight.py WORKLOAD OPERATOR DSMACK WEB: refuse a packed couch release before it is registered.
WORKLOAD the packed directory (compose-manifest.json, workload.img); OPERATOR the Mac's ~/.dsmack/operator.json;
DSMACK a dsmack checkout at DSMACK_REF; WEB a copy of this repo's web branch. Every check runs the production code:
the guest's PAYMENTS_CONFIG decoder (Go, unknown fields refused), the pool's workload check, and the site's kit
allowlist and deploy mirror rule against this checkout's couch/. The first failure raises."""
import json, subprocess, sys
from pathlib import Path

workload, operator, dsmack, web = (Path(a).resolve() for a in sys.argv[1:5])
layover = Path(__file__).resolve().parents[2]
subprocess.run(["go", "run", "./cmd/check-manifest", workload / "compose-manifest.json"], cwd=dsmack / "applications/payments/guest", check=True)
sys.path[:0] = [str(dsmack / "applications/compute-node"), str(web / "web")]
import pool, kit_mirror
pool.validate_workload(workload, json.loads(operator.read_bytes()))
print("pool accepts", workload)
served = json.loads(subprocess.check_output(["deno", "eval", f"console.log(JSON.stringify(Object.keys((await import('{(web / 'web/server.ts').as_uri()}')).kit)))"]))
kit = {"kit/" + f for f in subprocess.check_output(["git", "-C", layover, "ls-files", "couch/"], text=True).split() if kit_mirror.is_kit(f)}
served = {f for f in served if f.startswith("kit/couch/")}
if kit != served:
    raise SystemExit(f"kit files the site does not serve: {sorted(kit - served)}; served files that are not kit: {sorted(served - kit)}")
print(len(kit), "kit files served and mirrored")

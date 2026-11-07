"""Assemble the IP souk bundle and create or revise it on a Souk host.

  python3 build.py show [--resip URL] [--pin SHA]                 print the bundle's file names and sizes
  python3 build.py create [--resip URL] [--pin SHA] [--name N]    create a new souk; prints its id
  python3 build.py revise SOUK [--resip URL] [--pin SHA]          install a new revision

Credentials: $SOUK_HOME/credential.json (connector login). --resip replaces the one RESIP constant in souk.py, --pin the
guest commit APPRAISAL_PIN (the staging lane runs its own guest build: notes/environments.md on main).
"""

import ast
import argparse
import io
import json
import os
import re
import tokenize
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
NIKETE_COMMIT = "00e6e9d2e9bf7ece0caeeb468aaab04a2ec91939"
APPRAISAL_PIN = "a7641458731d332588b8b17650bfb1dcac2babd4"
STAGES = ("enroll", "match", "fetchmatch", "settle", "qa", "fetch", "couch", "escrow", "allocation")


def program_source(source):
    # Keep source comments locally without spending the host's 64 KiB bundle allowance on them.
    lines = source.splitlines(keepends=True)
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            lines[token.start[0] - 1] = lines[token.start[0] - 1][:token.start[1]].rstrip() + "\n"
    return "".join(lines)


def compact_source(source):
    # AST formatting removes comments; compress indentation only outside string literals.
    formatted = ast.unparse(ast.parse(source))
    protected = {line for token in tokenize.generate_tokens(io.StringIO(formatted).readline)
                 if token.type == tokenize.STRING and token.start[0] != token.end[0]
                 for line in range(token.start[0], token.end[0] + 1)}
    result = "\n".join(line if i in protected else re.sub(r"^ +", lambda m: " " * (len(m[0]) // 4), line)
                       for i, line in enumerate(formatted.splitlines(), 1))
    assert ast.dump(ast.parse(result)) == ast.dump(ast.parse(source))
    return result


def bundle(resip=None, pin=APPRAISAL_PIN):
    program = program_source((HERE / "souk.py").read_text())
    if resip:
        program, n = re.subn(r'^RESIP = ".*"$', f'RESIP = "{resip}"', program, flags=re.M)
        assert n == 1
    base = re.search(r'^RESIP = "(.*)"$', program, re.M).group(1)
    fill = {"{{RESIP}}": base, "{{NIKETE_COMMIT}}": NIKETE_COMMIT, "{{APPRAISAL_PIN}}": pin}
    charter = (HERE / "prompts/charter.md").read_text()
    out = {"souk.py": program, "guide.md": (HERE / "guide.md").read_text()}
    for stage in STAGES:
        out[f"prompts/{stage}.md"] = charter + "\n" + (HERE / f"prompts/{stage}.md").read_text()
    for k, v in out.items():
        for a, b in fill.items():
            v = v.replace(a, b)
        assert "{{" not in v, k
        # The host caps each file at 64 KiB; AST formatting drops comments/blank lines without changing behavior.
        out[k] = compact_source(v) if k == "souk.py" else v
    return out


def api(tool, **args):
    cred = json.loads((Path(os.environ.get("SOUK_HOME", Path.home() / ".config/souk")) / "credential.json").read_text())
    r = urllib.request.Request(
        cred["url"].rstrip("/") + "/api/" + tool,
        json.dumps(args).encode(),
        {"Authorization": "Bearer " + cred["token"], "Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(r, timeout=120).read())


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=("show", "create", "revise"))
    p.add_argument("souk", nargs="?")
    p.add_argument("--resip")
    p.add_argument("--pin", default=APPRAISAL_PIN)
    p.add_argument("--name", default="IP souk (residential lines from Mac minis)")
    o = p.parse_args()
    assert re.fullmatch(r"[0-9a-f]{40}", o.pin), "--pin is a full guest commit"
    b = bundle(o.resip, o.pin)
    if o.command == "show":
        print(json.dumps({k: len(v) for k, v in b.items()}, indent=1))
    elif o.command == "create":
        print(json.dumps(api("souk_create", bundle=b, name=o.name)))
    else:
        print(json.dumps(api("souk_revise", souk_id=o.souk, bundle=b)))

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


def squeeze(source):
    # Drop each space outside string literals that does not separate two word characters ("x = f(a, b)" -> "x=f(a,b)").
    fs, fe, depth, spans = getattr(tokenize, "FSTRING_START", -1), getattr(tokenize, "FSTRING_END", -1), 0, []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == fs:
            depth, start = depth + 1, token.start if depth == 0 else start
        elif token.type == fe:
            depth -= 1
            if not depth:
                spans.append((start, token.end))
        elif token.type == tokenize.STRING and not depth:
            spans.append((token.start, token.end))
    lines = source.split("\n")
    kept = [set() for _ in lines]
    for (r0, c0), (r1, c1) in spans:
        for r in range(r0, r1 + 1):
            kept[r - 1].update(range(c0 if r == r0 else 0, c1 if r == r1 else len(lines[r - 1])))
    word = lambda ch: ch.isalnum() or ch == "_"
    out = []
    for line, keep in zip(lines, kept):
        body = len(line) - len(line.lstrip(" "))
        out.append(line[:body] + "".join(ch for c, ch in enumerate(line) if c >= body and (ch != " " or c in keep or word(line[c - 1]) and c + 1 < len(line) and word(line[c + 1]))))
    return "\n".join(out)


def compact_source(source):
    # AST formatting removes comments; compress indentation only outside string literals, then spaces (squeeze).
    formatted = squeeze(ast.unparse(ast.parse(source)))
    protected = {line for token in tokenize.generate_tokens(io.StringIO(formatted).readline)
                 if token.type == tokenize.STRING and token.start[0] != token.end[0]
                 for line in range(token.start[0], token.end[0] + 1)}
    result = "\n".join(line if i in protected else re.sub(r"^ +", lambda m: " " * (len(m[0]) // 4), line)
                       for i, line in enumerate(formatted.splitlines(), 1))
    # Join adjacent single-line simple statements, saving repeated indentation under the file cap.
    simple = (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.Expr, ast.Return, ast.Raise, ast.Assert, ast.Import, ast.ImportFrom, ast.Pass, ast.Break, ast.Continue, ast.Delete)
    eligible = {n.lineno for n in ast.walk(ast.parse(result)) if isinstance(n, simple) and n.lineno == n.end_lineno}
    rows, previous = [], None
    for i, line in enumerate(result.splitlines(), 1):
        indent = len(line) - len(line.lstrip())
        if i in eligible and previous == indent:
            rows[-1] += ";" + line.lstrip()
        elif line or i in protected:
            rows.append(line)
        previous = indent if i in eligible else None
    result = "\n".join(rows)
    rows = result.splitlines()
    bodies = {body[0].lineno for n in ast.walk(ast.parse(result))
              if isinstance(n, (ast.If, ast.For, ast.While, ast.With, ast.FunctionDef, ast.Try, ast.ExceptHandler))
              for body in (getattr(n, "body", []), getattr(n, "orelse", []), getattr(n, "finalbody", [])) if body
              if all(isinstance(b, simple) and b.lineno == b.end_lineno == body[0].lineno for b in body)
              and rows[body[0].lineno - 2].endswith(":")}
    for i in sorted(bodies, reverse=True):
        rows[i - 2] += rows.pop(i - 1).lstrip()
    result = "\n".join(rows)
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

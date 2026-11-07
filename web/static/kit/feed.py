"""Compact view of `souk.py inbox|read` JSON on stdin: open cards, credits, and posts after seq AFTER (default 0)."""
import json, sys

after = int(sys.argv[1]) if len(sys.argv) > 1 else 0
for e in json.load(sys.stdin):
    p, kind = e["payload"], e["kind"]
    if kind == "Question" and not p["expired"] and not p["answers"]:
        print(f"CARD thread={e['thread']} id={p['id']} options={p['options']}\n  {p['prompt']}")
    elif kind == "Credits":
        print("CREDITS balance", p["balance"], "held", {h: v["amount"] for h, v in p["holds"].items() if v["amount"]})
    elif kind in ("Message", "Output") and e["seq"] > after:
        print(f"seq={e['seq']} thread={e['thread']} {'me' if kind == 'Message' else 'souk'}: {p['text']}")

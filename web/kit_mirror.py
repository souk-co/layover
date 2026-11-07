"""Which files of main's couch/ are kit, mirrored to static/kit/couch/. deploy.py and main's couch/dsmack/preflight.py import it."""
import re


def is_kit(f):
    """Not kit: tests and their data, couch/.gitignore, and the operator's re-pin tools (couch/dsmack/*.sh, *.py)."""
    return not (re.search(r"_test\.\w+$", f) or f.startswith("couch/testdata/") or f == "couch/.gitignore"
                or f.startswith("couch/dsmack/") and f.endswith((".sh", ".py")))

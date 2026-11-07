"""Fall back to minion/stubs/dstack_sdk.py when the PyPI dstack-sdk package is absent.

The stub speaks the guest-agent wire protocol documented in dsmack
applications/relay-broker/key.ts, so the offline suite exercises the same service
code path; deployments install the real package via minion/cvm/requirements.txt.
"""
import importlib.util
import sys
from pathlib import Path

if importlib.util.find_spec('dstack_sdk') is None:
    sys.path.insert(0, str(Path(__file__).parent / 'stubs'))

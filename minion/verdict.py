"""The minion's verifier: page classes for fetch-job results, and the CGNAT rule over a netmeasure (M) measurement.

CGNAT rule (notes: faithful-network design, option c). M traces and pings A, the address the line's traffic came from,
and reads the min RTT of the line's own TCP connection to M.
- step = rtt(A) - rtt(last router answering before A). A home router sits behind the access link, so the trace to it
  crosses a step of an access link (~10 ms on Comcast cable, seen from zed on 2026-11-05). A carrier NAT box answers
  before that step.
- gap = rtt_conn - rtt(A): the line's connection ends behind A. If A is at home, that is the home LAN (~5 ms on the
  Mini); if A is the carrier box, it is the access link plus the LAN.
cgnat False when the step is there and the gap is a LAN; True when there is no step and the gap is an access link;
None otherwise (A silent, no router answered, the hop before A silent when the step says home, a negative step, or
the two tests disagree). Fiber access links of 1-2 ms fall in None.
"""
import hashlib, json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

STEP_US = 7000
LAN_US = 7000
ROUTER, TARGET = 1, 2


def page_class(status, nbytes):
    """served: 200 and over 20 KB; thin: 200 and at most 20 KB; challenged: the site answered with a refusal or a
    challenge (202, 403, 405, 429); blocked: anything else (5xx, a gateway error, no answer)."""
    if status == 200:
        return "served" if nbytes > 20_000 else "thin"
    return "challenged" if status in (202, 403, 405, 429) else "blocked"


def canonical(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def measurement(raw, pub_hex, nonce, signed_sha256):
    """Check M's body: its sha256 is the one the line's guest signed for the fetch, M's signature, and the nonce."""
    assert hashlib.sha256(raw).hexdigest() == signed_sha256, "M's body is not the page the guest fetched"
    m = json.loads(raw)
    sig = bytes.fromhex(m.pop("sig"))
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(pub_hex)).verify(sig, canonical(m).encode())
    assert m["nonce"] == nonce, "M answered a different nonce"
    return m


def cgnat(m):
    kinds = [kind for _, kind in m["hops"]]
    if not m["rtt_a_us"] or TARGET not in kinds:
        return None
    at = kinds.index(TARGET)
    routers = [rtt for rtt, kind in m["hops"][:at] if kind == ROUTER]
    if not routers:
        return None
    step, gap = m["rtt_a_us"] - routers[-1], m["rtt_conn_us"] - m["rtt_a_us"]
    if step < 0:  # a router slower than A (ICMP slow path): the step means nothing
        return None
    if step >= STEP_US and gap < LAN_US and kinds[at - 1] == ROUTER:  # the step is measured from A's own neighbour
        return False
    if step < STEP_US and gap >= LAN_US:
        return True
    return None

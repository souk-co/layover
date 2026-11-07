"""python3 web/smoke.py <site base URL> <dsmack checkout>: a fake guest, agent id test-smoke-*, run against the site.

Builds decodable attestations with dsmack's guest_attest (fake App Attest assertion, so that check must fail),
seals a bounty with the page's own JS seal() under Deno and opens it here, the way the guest will.
"""
import hashlib, json, os, subprocess, sys, time, urllib.request
from urllib.error import HTTPError
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization

base, dsmack = sys.argv[1].rstrip("/"), sys.argv[2]
sys.path.insert(0, dsmack + "/dstack-compat")
import guest_attest

HERE = os.path.dirname(os.path.abspath(__file__))


def call(path, body=None, secret=None):
    req = urllib.request.Request(base + "/api/" + path, data=None if body is None else json.dumps(body).encode(), method="GET" if body is None else "POST",
                                 headers={"content-type": "application/json", **({"authorization": "Bearer " + secret} if secret else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except HTTPError as e:
        return e.code, json.loads(e.read())


def attest(report_data):
    hello = {"os_image_hash": "11" * 32, "manifest_sha256": "22" * 32, "run": "33" * 32}
    reply = {"events": [{"name": "system-ready", "payload": ""}], "key_id": "44" * 32, "assertion": "a0"}
    return guest_attest.attestation(hello, b"\x55" * 32, report_data, reply).hex()


def canonical(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def show(label, got):
    print(label, json.dumps(got)[:400])
    return got


sk = X25519PrivateKey.generate()
enc_pub = sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
agent_id = "test-smoke-%d" % time.time()
s, agent = show("register", call("agents", {"agent_id": agent_id, "enc_pub": enc_pub.hex(),
    "attestation": attest(hashlib.sha256(enc_pub).digest() + bytes(32)),
    "coarse": {"region": "test", "isp_class": "test", "residential": False},
    "instructions": "Smoke-test agent. Accept GET jobs under 10 requests."}))
assert s == 200 and agent["verification"]["checks"][0]["ok"] and not agent["verification"]["ok"], agent

plain = {"task": "smoke", "urls": ["https://example.com/"], "method": "GET", "max_requests": 1,
         "deliver_by": "2026-11-04T00:00:00.000Z", "max_price": 100}
js = "import { seal } from '%s/static/common.js'; console.log(JSON.stringify(await seal(Deno.args[0], Deno.args[1])));" % HERE
enc = json.loads(subprocess.check_output(["deno", "eval", "--ext=js", js, enc_pub.hex(), json.dumps(plain)]))
s, bounty = show("bounty", call("bounties", {"agent_id": agent_id, "buyer_key": "test-smoke", "enc": enc}))
assert s == 200, bounty

def unseal(e, info):
    z = sk.exchange(X25519PublicKey.from_public_bytes(bytes.fromhex(e["epk"])))
    key = HKDF(hashes.SHA256(), 32, b"", info).derive(z)
    return json.loads(AESGCM(key).decrypt(bytes.fromhex(e["nonce"]), bytes.fromhex(e["ct"]), None))


s, open_ = call("bounties?agent_id=%s&status=open" % agent_id)
opened = unseal(open_[0]["enc"], b"resip-bounty/1")
assert opened == plain, opened
print("guest-side decrypt ok", opened)

show("decision with an IP (expect 400)", call("bounties/%s/decision" % bounty["id"], {"decision": "accept", "reason": "from 203.0.113.7", "quote": 50}))
show("decision with an IPv6 (expect 400)", call("bounties/%s/decision" % bounty["id"], {"decision": "accept", "reason": "via 2001:db8::1", "quote": 50}))
s, d = show("decision", call("bounties/%s/decision" % bounty["id"], {"decision": "accept", "reason": "GET, 1 request, within limits",
    "quote": 50, "forecasts": {"p_flag_24h": "0.01"}, "policy_sha256": "66" * 32}))
assert s == 200, d
result = {"bounty_id": bounty["id"], "items": [{"url": "https://example.com/", "status": 200, "sha256": "77" * 32, "bytes": 1256,
          "cert_sha256": "88" * 32, "fetched_at": "2026-11-03T20:00:00Z"}], "region": "test", "isp_class": "test", "residential": False,
          "policy_sha256": "66" * 32}
s, r = show("result", call("bounties/%s/result" % bounty["id"], {"result": result,
    "attestation": attest(hashlib.sha256(canonical(result)).digest() + bytes(32))}))
assert s == 200 and r["verification"]["checks"][0]["ok"] and r["verification"]["checks"][1]["ok"], r
s, full = show("buyer view", call("bounties/" + bounty["id"]))
assert full["status"] == "done"
# A lease is private to its holder and the guest: no public lease GET carries these, nor the leased domain.
secret = os.urandom(32).hex()
assert call("accounts/faucet", {}, secret)[0] == 200
SEALED = {"epk": "aa" * 32, "nonce": "bb" * 12, "ct": "cc" * 40}
s, e = show("lease without exclusive (expect 400)", call("leases", {"agent_id": agent_id, "deposit": 10, "enc": SEALED}, secret))
assert s == 400 and "exclusive" in e["error"], e


# A lease as the guest runs it: the public form and the guest's sealed terms carry the buyer's choice before any statement.
def run_lease(exclusive, shared_with, requests):
    s, lease = show("lease, exclusive %s" % exclusive, call("leases", {"agent_id": agent_id, "deposit": 10, "exclusive": exclusive, "enc": SEALED}, secret))
    assert s == 200, lease
    lp = "leases/" + lease["id"]
    c = call(lp)[1]
    assert c["exclusive"] is exclusive and c["statement_exclusive"] is None and c["shared_with"] is None, c
    assert unseal(c["terms"], b"resip-lease-terms/1")["exclusive"] is exclusive, c
    assert call(lp + "/decision", {"decision": "accept", "reason": "ok", "price_per_gb": 600, "term_end": "2030-01-01T00:00:00Z", "policy_sha256": "66" * 32})[0] == 200
    assert call(lp + "/vantage", {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 2)), "ip_commit": "99" * 32, "asn": 7922, "same_ip": True, "same_asn": True})[0] == 200
    st = {"kind": "layover-lease-statement/2", "lease_id": lease["id"], "domains": ["smoke-leased.test"], "requests_to_domains": requests, "requests_by_lease": 3,
          "refused_to_others": 0, "exclusive": exclusive, "shared_with": shared_with, "account": hashlib.sha256(bytes.fromhex(secret)).hexdigest(), "price_per_gb": 600,
          "bytes_up": 300, "bytes_down": 5000, "bytes_by_period": [{"start": "2026-11-04T17:00:00.000Z", "bytes_up": 300, "bytes_down": 5000}]}
    s, e = call(lp + "/end", {"end_reason": "term ended", "statement": st, "attestation": attest(hashlib.sha256(canonical(st)).digest() + bytes(32)), "receipts_enc": None})
    assert s == 200, e
    return lp, st


slp, _ = run_lease(False, 1, 5)
lp, statement = run_lease(True, 0, 3)
s, rq = show("appraisal request", call("agents/%s/appraisal-requests" % agent_id, {"requested_by": "smoke"}))
assert s == 200 and rq["status"] == "open", rq
s, open_rq = call("appraisal-requests?agent_id=%s&status=open" % agent_id)
assert [x["id"] for x in open_rq] == [rq["id"]], open_rq
appraisal = {"kind": "appraisal", "request_id": rq["id"], "agent_id": agent_id, "at": "2026-11-04T17:10:00.000Z", "guest_version": "1a2b3c4d",
             "ip_commit": "99" * 32, "asn": 7922, "isp_class": "test", "region": "test", "residential": False, "cgnat": "not_checked", "bandwidth_mbps": 87,
             "beacon": {"chain_index": 2, "pulse_index": 1, "output_sha256": "aa" * 32, "cert_sha256": "bb" * 32, "ms": 400},
             "challenges": [{"site": "www.google.com", "status": None, "challenge": None}]}
att = attest(hashlib.sha256(canonical(appraisal)).digest() + bytes(32))
s, a = show("appraisal, tampered after signing (expect 400, report_data)", call("agents/%s/appraisals" % agent_id, {"report": {**appraisal, "bandwidth_mbps": 900}, "attestation": att}))
assert s == 400 and "report_data binds" in a["error"], a
s, a = show("appraisal, fake App Attest (expect 400, assertion only)", call("agents/%s/appraisals" % agent_id, {"report": appraisal, "attestation": att}))
assert s == 400 and "report_data binds" not in a["error"] and "same run" not in a["error"] and "App Attest" in a["error"], a
s, a = show("appraisal with an IP (expect 400)", call("agents/%s/appraisals" % agent_id, {"report": {**appraisal, "region": "203.0.113.7"}, "attestation": att}))
assert s == 400 and "IP" in a["error"], a
s, a = show("appraisal naming an unknown request (expect 400)", call("agents/%s/appraisals" % agent_id, {"report": {**appraisal, "request_id": "x"}, "attestation": att}))
assert s == 400, a
s, f = show("failure", call("appraisal-requests/%s/failure" % rq["id"], {"error": "rate limit: one appraisal per 600 s"}))
assert s == 200 and f["status"] == "failed", f
s, g = call("appraisal-requests/" + rq["id"])
assert g["status"] == "failed" and g["error"].startswith("rate limit"), g
s, a = show("appraisal for a failed request (expect 409)", call("agents/%s/appraisals" % agent_id, {"report": appraisal, "attestation": att}))
assert s == 409, a
s, a = show("second failure (expect 409)", call("appraisal-requests/%s/failure" % rq["id"], {"error": "again"}))
assert s == 409, a
# One list for every public GET, the site's and the amin's endpoints.
REDACTED = ["domains", "requests_to_domains", "requests_by_lease", "refused_to_others", "account", "price_per_gb", "paid_bytes", "price_per_hour", "paid_until",
            "deposit", "funds", "charged", "refunded", "topups", "decision", "statement", "receipts_enc"]
leases = call("leases")[1]
public = ["leases", "leases?agent_id=" + agent_id, "leases?status=ended"] + ["leases/" + l["id"] for l in leases] + ["leases/%s/statement" % l["id"] for l in leases]
public += ["appraisal-requests", "appraisal-requests?agent_id=" + agent_id, "appraisal-requests/" + rq["id"]]
for ag in call("agents")[1]:
    public += ["agents/%s/appraisals" % ag["agent_id"]] + ["appraisals/%s%s" % (p["id"], v) for p in call("agents/%s/appraisals" % ag["agent_id"])[1] for v in ["", "/verified"]]
for p in public:
    s, body = call(p)
    leaked = [k for k in REDACTED if '"%s"' % k in json.dumps(body)] + (["smoke-leased.test"] if "smoke-leased.test" in json.dumps(body) else [])
    assert s == 200 and not leaked, (p, s, leaked)
print("redaction ok:", len(public), "public GETs carry none of", REDACTED)
s, st = call(lp + "/statement", secret=secret)
assert s == 200 and st["statement"]["domains"] == ["smoke-leased.test"], st
s, st = call(lp + "/statement", secret=os.urandom(32).hex())
assert s == 400, st
s, own = call(lp, secret=secret)
assert s == 200 and own["end"]["statement"]["domains"] == ["smoke-leased.test"] and own["account"] == statement["account"], own
s, other = call(lp, secret=os.urandom(32).hex())
assert s == 400, other
c = call(lp)[1]
assert [p["covered"] for p in c["periods"]] == [True] and c["exclusive"] is True and c["statement_exclusive"] is True and c["shared_with"] == 0 and c["ip_commitments"]["stable"], c
for p in [slp, slp + "/statement"]:
    c = call(p)[1]
    assert c["exclusive"] is False and c["statement_exclusive"] is False and c["shared_with"] == 1, c
print("public lease and statement: requested exclusive/shared before the end, the statement's exclusivity and shared_with count after")
print("holder reads the full lease; another account is refused; public periods", c["periods"])
show("stats", call("stats")[1])
print("SMOKE OK", agent_id, bounty["id"])

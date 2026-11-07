#!/usr/bin/env python3
"""The baseline-load minion (#9): one cycle, run hourly from cron. For every live line it buys a fetch job through the
souk over a rotating slice of the target-site list, plus one page from netmeasure (M) for the CGNAT measurement; for
every ready couch slot it opens a short stay paid from its own broker wallet and runs a fixed task. Each use becomes
one row, signed with the minion's key and posted to the layover site. A use the minion paid for that did not deliver
is a failed paid use.

  minion.py cycle       one cycle; rows go to $MINION_HOME/rows.jsonl, then every unposted row is posted, then GuestEscrow relays
  minion.py relay       only the GuestEscrow relays (layover-accounts /api/relay/sweep)
  minion.py keygen      write $MINION_HOME/home/rows.key and print its public key (pinned in the site)

$MINION_HOME holds kit/ (souk.py, layover.js, couch/ with node_modules), dsmack/ (the guest verifier), home/ (the
souk credential, couch-wallet.key, rows.key, resip/). NETMEASURE and NETMEASURE_PUB name M and its key; without them
the row says the CGNAT measurement was not run.
"""
import json, math, os, re, subprocess, sys, threading, time, traceback, uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
import verdict

HOME = Path(os.environ["MINION_HOME"])
SITE = os.environ.get("MINION_SITE", "https://pod.dstack.soc1024.com/resip-staging")
SOUK = "31f5c141-fb2d-4572-939a-68543a2d0649"
ACCOUNTS = "https://pod.dstack.soc1024.com/layover-accounts"
NETMEASURE, NETMEASURE_PUB = os.environ.get("NETMEASURE"), os.environ.get("NETMEASURE_PUB")
DENO = os.environ.get("DENO", "deno")
PER_CYCLE = 5
# One cycle per hour: a use not started 55 min in is recorded as not run. The bounty client gives a job 30 min.
CYCLE_DEADLINE, CARD_WAIT, JOB_DEADLINE = 55 * 60, 600, 31 * 60
# TODO: the fetch request cannot name a line yet (the amin's fetch_request has no agent_id); when it can, ask for each line.
# One URL per site from notes/baseline-target-site-2026-11-05.md (batches 1 and 2).
SITES = """https://www.walmart.com/search?q=paper+towels
https://www.target.com/s?searchTerm=paper+towels
https://www.costco.com/televisions.html
https://www.zillow.com/brooklyn-new-york-ny/
https://www.kayak.com/flights/NYC-LAX/2026-12-10
https://www.wayfair.com/furniture/sb0/sofas-c413892.html
https://www.nike.com/w/mens-shoes-nik1zy7ok
https://www.bestbuy.com/site/searchpage.jsp?st=airpods
https://www.homedepot.com/s/drill
https://www.lowes.com/search?searchTerm=drill
https://www.ebay.com/sch/i.html?_nkw=airpods
https://www.etsy.com/search?q=mug
https://www.amazon.com/s?k=paper+towels
https://www.redfin.com/zipcode/11211
https://www.instacart.com/store/s?k=paper+towels
https://newyork.craigslist.org/search/sss?query=bike
https://www.realtor.com/realestateandhomes-search/Brooklyn_NY
https://www.newegg.com/p/pl?d=ssd
https://www.bhphotovideo.com/c/search?q=sd+card
https://www.chewy.com/s?query=dog+food
https://www.macys.com/shop/featured/towels
https://www.kohls.com/search.jsp?search=towels
https://www.yelp.com/search?find_desc=pizza&find_loc=New+York%2C+NY
https://www.tripadvisor.com/Hotels-g60763-New_York_City_New_York-Hotels.html
https://www.booking.com/searchresults.html?ss=New+York""".split()

os.environ["SOUK_HOME"] = str(HOME / "home")
sys.path.insert(0, str(HOME / "kit"))  # the buyer kit's souk.py, imported in tool()


def get(url):
    with urlopen(url, timeout=60) as r:
        return r.read()


def tool(name, **args):
    import souk
    r = souk.call_tool(name, {"souk_id": SOUK, **args})
    assert not (isinstance(r, dict) and r.get("outcome") == "unknown"), f"{name}: {r}"
    return r


def until(what, test, seconds, every=10):
    """Poll test() (reads only). souk-dev drops TLS for minutes at a time, so a read that fails is polled again; the
    last failure is raised with the timeout. A failed read during a poll must not count against the host."""
    last, deadline = None, time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            found = test()
        except OSError as e:
            found, last = None, e
        if found:
            return found
        time.sleep(every)
    raise TimeoutError(f"no {what} after {seconds} s" + (f"; last read error: {last}" if last else ""))


def thread_posts(thread):
    return [e["payload"]["text"] for e in tool("souk_read", thread_id=thread) if e["kind"] == "Output"]


def resip(*args):
    p = subprocess.run([DENO, "run", "-A", str(HOME / "kit/layover.js"), *args], capture_output=True, text=True)
    assert p.returncode == 0, f"resip {args[0]} exited {p.returncode}: {p.stderr.strip()} {p.stdout.strip()}"
    return p.stdout


def site_slice(at):
    n = int(at // 3600) * PER_CYCLE % len(SITES)
    return (SITES + SITES)[n:n + PER_CYCLE]


def fetch_use(row, agent, at):
    """A fetch job through the souk. The amin picks the line; the row is for the line it picked."""
    nonce = uuid.uuid4().hex
    probe = f"{NETMEASURE}/v1/probe/{nonce}" if NETMEASURE else None
    urls = site_slice(at) + ([probe] if probe else [])
    price = math.ceil(len(urls) * 15 / 100)
    row.update(kind="fetch", asked_for=agent, pages_asked=len(urls), price_credits=price, paid=False)
    known = {e["thread"] for e in tool("souk_inbox")}
    tool("souk_send", kind="fetch", text=json.dumps({"domains": sorted({urlsplit(u).hostname for u in urls}), "pages": len(urls), "max_price": price}))

    def card():
        fresh = [e for e in tool("souk_inbox") if e["thread"] and e["thread"] not in known]
        row["thread"] = next((e["thread"] for e in fresh), None)
        return next((e for e in fresh if e["kind"] == "Question" and not e["payload"]["expired"] and not e["payload"]["answers"]), None)
    try:
        q = until("card from the amin", card, CARD_WAIT, 20)
    except TimeoutError:
        posts = thread_posts(row["thread"]) if row["thread"] else []
        raise TimeoutError(f"no card in {CARD_WAIT} s" + ("; the amin's last post: " + posts[-1][:300] if posts else ""))
    tool("souk_answer", question_id=q["payload"]["id"], value="accept")
    escrow = until("escrow post", lambda: next((p for p in thread_posts(row["thread"]) if p.startswith("Escrow:")), None), 300)
    row["paid"] = True
    row["agent_id"] = agent_id = re.search(r"resip verify \S+ (\S+) DIR", escrow).group(1)
    d = HOME / "home/resip"
    verified = resip("verify", SITE, agent_id, str(d))
    assert "FAIL" not in verified, verified
    (d / "urls.txt").write_text("\n".join(urls) + "\n")
    p = subprocess.Popen([DENO, "run", "-A", str(HOME / "kit/layover.js"), "bounty", str(d), row["thread"], str(d / "urls.txt"), str(price)], stdout=subprocess.PIPE, text=True)
    bid = re.match(r"bounty posted (\S+)", p.stdout.readline()).group(1)
    tool("souk_send", thread=row["thread"], text=f"bounty {bid}")
    out = p.communicate(timeout=JOB_DEADLINE)[0]
    assert p.returncode == 0, out
    row["bounty_id"] = bid
    b = json.loads(get(f"{SITE}/api/bounties/{bid}"))
    st = json.loads(get(f"{SITE}/api/bounties/{bid}/statement"))
    row.update(status=b["status"], served=st.get("served"), attestation_pass=st.get("attestation_pass"))
    assert st.get("attestation_pass") is not False, "the line's result failed attestation (the seller is paid 0)"
    if b["status"] != "done":
        return row.update(error=f"bounty {b['status']}: " + json.dumps(b.get("decision") or b.get("expired"))[:300])
    res = b["result"]["result"]
    row.update(region=res["region"], isp_class=res["isp_class"], residential=res["residential"])
    t, row["pages"] = datetime.fromisoformat(b["decision"]["at"].replace("Z", "+00:00")), []
    for i in res["items"]:
        f = datetime.fromisoformat(i["fetched_at"].replace("Z", "+00:00"))
        ms, t = round((f - t).total_seconds() * 1000), f
        if i["url"] == probe:
            try:
                row.update(measure(nonce, i))
            except Exception as e:  # M down or a bad signature is M's failure, not the line's
                row.update(cgnat=None, cgnat_method=f"measurement error: {type(e).__name__}: {e}"[:300])
        else:
            row["pages"].append({"site": urlsplit(i["url"]).hostname, "status": i["status"], "bytes": i["bytes"], "ms": ms, "class": verdict.page_class(i["status"], i["bytes"])})
    if "cgnat_method" not in row:
        row.update(cgnat=None, cgnat_method="netmeasure page missing from the result" if probe else "not measured: no netmeasure configured")
    settle = until("settlement", lambda: next((p for p in thread_posts(row["thread"]) if p.startswith("Settled fetch job")), None), 600, 30)
    row["settled"] = settle[:300]


def measure(nonce, item):
    if item["status"] != 200:
        return {"cgnat": None, "cgnat_method": f"netmeasure answered {item['status']} through the line"}
    m = verdict.measurement(get(f"{NETMEASURE}/v1/result/{nonce}"), NETMEASURE_PUB, nonce, item["sha256"])
    return {"cgnat": verdict.cgnat(m), "cgnat_method": "netmeasure via the line's attested fetch (M unattested)", "ip_commit": m["ip_commit"],
            "asn": m["asn"], "rtt_conn_us": m["rtt_conn_us"], "rtt_a_us": m["rtt_a_us"], "hops": m["hops"]}


def couch_use(row, publisher, slot, at):
    env = {**os.environ, "LAYOVER_COUCH_DIR": str(HOME / "kit/couch"), "LAYOVER_DSMACK": str(HOME / "dsmack"), "LAYOVER_COUCH_KEY_FILE": str(HOME / "home/couch-wallet.key")}
    out = subprocess.run(["node", str(Path(__file__).parent / "couch_task.mjs"), publisher, str(slot), f"minion-{int(at)}"], capture_output=True, text=True, env=env, timeout=600)
    assert out.returncode == 0, out.stderr
    row.update(kind="couch", agent_id=f"{publisher}:{slot}", **json.loads(out.stdout))


def key():
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex((HOME / "home/rows.key").read_text().strip()))


def post_rows():
    log, done = HOME / "rows.jsonl", HOME / "posted.txt"
    posted = set(done.read_text().split()) if done.exists() else set()
    for line in log.read_text().splitlines():
        if json.loads(line)["id"] in posted:
            continue
        body = json.dumps({"row_json": line, "sig": key().sign(line.encode()).hex()}).encode()
        try:
            with urlopen(Request(f"{SITE}/api/minion/rows", data=body, method="POST", headers={"content-type": "application/json"}), timeout=60) as r:
                assert r.status == 200, r.read()
        except HTTPError as e:
            if e.code != 400:
                raise
            with (HOME / "refused.jsonl").open("a") as f:  # the site refused this row for good (e.g. it looks like it holds an address)
                f.write(json.dumps({"reason": e.read().decode()[:500], "row_json": line}) + "\n")
        with done.open("a") as f:
            f.write(json.loads(line)["id"] + "\n")


def cycle():
    at = time.time()
    tool("souk_inbox")  # souk-dev down: no cycle, rather than a failed use charged to every line
    lines = [a["agent_id"] for a in json.loads(get(f"{SITE}/api/agents")) if not a["agent_id"].startswith("test-")]
    slots = sorted({(s["publisher"], s["slot_id"]) for s in json.loads(get(f"{SITE}/api/couch-slots")) if s["online"] and s["state"] == "ready" and s["verified"]})
    lock = threading.Lock()

    def run(kind, use, *args):
        t, row = time.time(), {"kind": kind, "asked_for": ":".join(map(str, args))}
        if time.time() > at + CYCLE_DEADLINE:
            row.update(paid=False, error="not run: cycle deadline")
        else:
            try:
                use(row, *args, at)
            except Exception as e:  # a failed use is the measurement: recorded as a row; the traceback goes to the cron log
                traceback.print_exc()
                row["error"] = f"{type(e).__name__}: {e}"[:500]
        row.update(id=str(uuid.uuid4()), cycle=int(at), at=datetime.now(timezone.utc).isoformat(timespec="seconds"), seconds=round(time.time() - t))
        # Until the amin's card names a line, a fetch use is the souk's, not any line's.
        row.setdefault("agent_id", "souk" if kind == "fetch" else row["asked_for"])
        row["ok"] = "error" not in row and row.get("ok", True)
        row["failed_paid_use"] = bool(row.get("paid")) and not row["ok"]
        with lock:
            print(json.dumps(row), flush=True)
            with (HOME / "rows.jsonl").open("a") as f:
                f.write(json.dumps(row) + "\n")

    # Fetches run one at a time (card() takes any new thread as its own); couch stays, one at a time per wallet, run
    # alongside them.
    with ThreadPoolExecutor(1) as couches:
        done = [couches.submit(run, "couch", couch_use, *s) for s in slots]
        for a in lines:
            run("fetch", fetch_use, a)
        for f in done:
            f.result()
    post_rows()
    relay()


# The host's side of GuestEscrow: have the account service's gas-only relayer register every published guest claim key and
# submit every ended lease's unpaid guest claim (permissionless; it sends only what the contract would accept).
def relay():
    with urlopen(Request(ACCOUNTS + "/api/relay/sweep", data=b"{}", method="POST", headers={"content-type": "application/json"}), timeout=1800) as r:
        print("relay", r.read().decode(), flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["keygen"]:
        f = HOME / "home/rows.key"
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, os.urandom(32).hex().encode())
        os.close(fd)
        print(key().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex())
    elif sys.argv[1:] == ["cycle"]:
        cycle()
    elif sys.argv[1:] == ["relay"]:
        relay()
    else:
        sys.exit(__doc__)

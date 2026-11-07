#!/usr/bin/env python3
"""netmeasure (M): measures the line a client connects from. A workload GETs /v1/probe/<nonce>; M takes the client
address A and the connection's min RTT (TCP_INFO), pings and traces A, and answers with a signed JSON of integers plus
ip_commit = sha256(salt || A). A never leaves this process. The verdict (CGNAT or not) is minion/verdict.py's, not M's.

  netmeasure.py keygen DIR            write DIR/key (ed25519), DIR/salt; prints the public key
  netmeasure.py serve DIR PORT CERT KEY  HTTPS on PORT; needs ping, mtr and dig on PATH, and CAP_NET_RAW for mtr-packet

GET /v1/key -> {"pub"}; GET /v1/probe/<32 hex> -> the signed measurement (once per nonce);
GET /v1/result/<32 hex> -> the same bytes again, for a buyer that holds only the body's sha256 (a fetch job).
"""
import hashlib, json, os, re, socket, ssl, struct, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

NONCE = re.compile(r"^/v1/(probe|result)/([0-9a-f]{32})$")
NO_REPLY, ROUTER, TARGET = 0, 1, 2  # hop kinds


def canonical(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def min_rtt_us(sock):
    return struct.unpack_from("I", sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 232), 148)[0]  # tcpi_min_rtt


def ping_us(addr):
    out = subprocess.run(["ping", "-n", "-q", "-c", "10", "-i", "0.2", "-W", "1", addr], capture_output=True, text=True).stdout
    m = re.search(r"= ([\d.]+)/", out)  # rtt min/avg/max/mdev; no line when nothing answered
    return round(float(m.group(1)) * 1000) if m else 0


def trace(addr):
    hubs = json.loads(subprocess.run(["mtr", "-n", "-j", "-c", "3", "-Z", "1", addr], capture_output=True, text=True, check=True).stdout)["report"]["hubs"]
    return [[round(h["Best"] * 1000) if h["Loss%"] < 100 else 0, TARGET if h["host"] == addr else ROUTER if h["Loss%"] < 100 else NO_REPLY] for h in hubs]


def asn(addr):
    if ":" in addr:
        return 0
    q = ".".join(reversed(addr.split("."))) + ".origin.asn.cymru.com"
    txt = subprocess.run(["dig", "+short", "TXT", q], capture_output=True, text=True, check=True).stdout
    return int(txt.strip('"\n').split()[0]) if txt.strip() else 0


class M:
    def __init__(self, d):
        self.key, self.salt = Ed25519PrivateKey.from_private_bytes(bytes.fromhex((d / "key").read_text().strip())), bytes.fromhex((d / "salt").read_text().strip())
        self.pub = self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
        self.log, self.lock, self.done = d / "results.jsonl", threading.Lock(), {}
        if self.log.exists():
            for line in self.log.read_text().splitlines():
                r = json.loads(line)
                self.done[r["nonce"]] = line.encode()

    def probe(self, nonce, sock, addr):
        with self.lock:
            assert nonce not in self.done, "nonce already used"
            self.done[nonce] = b""
        body = {"v": 1, "nonce": nonce, "at": int(time.time()), "ip_commit": hashlib.sha256(self.salt + addr.encode()).hexdigest(),
                "asn": asn(addr), "rtt_conn_us": min_rtt_us(sock), "rtt_a_us": ping_us(addr), "hops": trace(addr)}
        raw = canonical({**body, "sig": self.key.sign(canonical(body).encode()).hex()}).encode()
        with self.lock:
            self.done[nonce] = raw
            with self.log.open("ab") as f:
                f.write(raw + b"\n")
        return raw


def serve(d, port, cert, key):
    m = M(Path(d))

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            hit = NONCE.match(self.path)
            if self.path == "/v1/key":
                return self.reply(200, canonical({"pub": m.pub}).encode())
            if not hit:
                return self.reply(404, b'{"error":"not found"}')
            if hit.group(1) == "result":
                raw = m.done.get(hit.group(2))
                return self.reply(200, raw) if raw else self.reply(404, b'{"error":"no result for this nonce"}')
            if hit.group(2) in m.done:
                return self.reply(409, b'{"error":"nonce already used"}')
            self.reply(200, m.probe(hit.group(2), self.connection, self.client_address[0].removeprefix("::ffff:")))

        def reply(self, code, raw):
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd = ThreadingHTTPServer(("", int(port)), H)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    httpd.serve_forever()


if __name__ == "__main__":
    cmd, d = sys.argv[1], Path(sys.argv[2])
    if cmd == "keygen":
        d.mkdir(parents=True, exist_ok=True)
        for f, v in (("key", os.urandom(32).hex()), ("salt", os.urandom(32).hex())):
            assert not (d / f).exists(), f"{d / f} exists"
            (d / f).write_text(v)
            (d / f).chmod(0o600)
        print(M(d).pub)
    elif cmd == "serve":
        serve(d, *sys.argv[3:6])
    else:
        sys.exit(__doc__)

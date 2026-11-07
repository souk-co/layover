"""Socket-only dstack signer. Run with python minion/cvm/service.py."""
import json
import os
from pathlib import Path
import stat
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_keys import keys
from dstack_sdk import DstackClient
from keychain import PURPOSE, verify_chain
from units import load_rows, sign_rows


class Minion:
    def __init__(self, socket, app_id, rows, operators, epoch, chain_id, buyer, key_path='layover/minion', rows_public_key=None):
        if not stat.S_ISSOCK(os.stat(socket).st_mode):
            raise ValueError('dstack Unix socket required')
        result = DstackClient(socket).get_key(path=key_path, purpose=PURPOSE, algorithm='secp256k1')
        self._key = result.decode_key()
        public = '0x' + keys.PrivateKey(self._key).public_key.to_compressed_bytes().hex()
        verified = verify_chain(app_id, public, result.signature_chain)
        self.identity = {'address': verified['address'], 'key_path': key_path,
                         'signature_chain': result.signature_chain, 'app_id': app_id}
        self.rows, self.operators = Path(rows), operators
        self.rows_public_key = rows_public_key
        self.epoch, self.chain_id, self.buyer = epoch, chain_id, buyer

    def signed(self):
        rows = load_rows(self.rows, self.rows_public_key)
        return sign_rows(rows, self.epoch, self.operators, self._key, self.chain_id, self.buyer)


def server(minion, address=('0.0.0.0', 8080)):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            try:
                if self.path == '/minion':
                    result = minion.identity
                elif self.path == '/signed':
                    result = minion.signed()
                else:
                    self.send_error(404)
                    return
                body, status = json.dumps(result).encode(), 200
            except Exception:
                body, status = b'{"error":"signing failed"}', 503
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    return ThreadingHTTPServer(address, Handler)


if __name__ == '__main__':
    minion = Minion('/var/run/dstack.sock', os.environ['APP_ID'], os.environ['ROWS_FILE'],
        json.loads(Path(os.environ['OPERATORS_FILE']).read_text()), int(os.environ['EPOCH']),
        int(os.environ.get('CHAIN_ID', '8453')), os.environ['BUYER_ADDRESS'],
        rows_public_key=os.environ.get('ROWS_PUBLIC_KEY') or None)
    server(minion).serve_forever()

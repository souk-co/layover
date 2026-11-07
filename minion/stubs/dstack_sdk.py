"""Test stand-in for the PyPI dstack-sdk package, used only when it is not installed.

Wire format copied from dsmack applications/relay-broker/key.ts: HTTP POST /GetKey
over the project's unix socket with JSON {path, purpose, algorithm}, reply JSON
{key: hex, signature_chain: [hex, ...]} (dsmack dstack-compat/dsmack_dstack.py:get_key
builds the same reply). Deployed builds install the real dstack-sdk==0.5.4.
"""
import json
import socket
from http.client import HTTPConnection


class _UnixHTTPConnection(HTTPConnection):
    def __init__(self, path, timeout=30):
        super().__init__('localhost', timeout=timeout)
        self._unix_path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._unix_path)
        self.sock = sock


class GetKeyResponse:
    def __init__(self, data):
        self.key = data.get('key')
        self.signature_chain = data.get('signature_chain') or []

    def decode_key(self):
        return bytes.fromhex(self.key.removeprefix('0x'))


class DstackClient:
    def __init__(self, endpoint):
        self.endpoint = endpoint.removeprefix('unix://').removeprefix('http+unix://')

    def get_key(self, path, purpose, algorithm=None, name=None):
        body = {'path': path, 'purpose': purpose}
        if algorithm is not None:
            body['algorithm'] = algorithm
        if name is not None:
            body['name'] = name
        conn = _UnixHTTPConnection(self.endpoint)
        conn.request('POST', '/GetKey', json.dumps(body), {'Content-Type': 'application/json'})
        response = conn.getresponse()
        data = json.loads(response.read())
        conn.close()
        if response.status != 200:
            raise RuntimeError('dstack GetKey failed: HTTP %d %s' % (response.status, data))
        return GetKeyResponse(data)

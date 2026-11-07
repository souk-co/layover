import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from socketserver import UnixStreamServer
from urllib.request import urlopen

import pytest
from eth_account import Account
from eth_keys import keys
from eth_utils import keccak

sys.path.insert(0, str(Path(__file__).parent))
import units
import keychain
from cvm.service import Minion, server

KEY = bytes.fromhex('11' * 32)
APP = '0x' + '22' * 20
BUYER = '0x' + '33' * 20


def rows():
    return [dict(id=str(i), kind='fetch', agent_id='line', paid=True, ok=True,
                 status='done', attestation_pass=True, pages=[{'class': 'served'}]) for i in range(4)]


def test_signatures_and_row_binding():
    result = units.sign_rows(rows(), 7, {'line': APP}, KEY, 8453, BUYER)
    for kind, values in [('Book', [result['book']]), ('Unit', result['units'])]:
        for value in values:
            fields = {k: value[k] for k in [f['name'] for f in units.TYPES[kind]]}
            assert Account.recover_message(units.message(kind, fields, 8453, BUYER), signature=value['signature']) == Account.from_key(KEY).address
    changed = rows()
    changed[0]['pages'][0]['bytes'] = 90000
    assert units.build(changed, 7, {'line': APP})[1][0]['workDigest'] != result['units'][0]['workDigest']


@pytest.mark.parametrize('change', [{'paid': False}, {'ok': False}, {'attestation_pass': False}, {'status': 'expired'}, {'error': 'bad'}, {'pages': []}])
def test_reject_unverified(change):
    bad = rows()
    bad[0].update(change)
    with pytest.raises(ValueError, match='four'):
        units.build(bad, 7, {'line': APP})


def test_duplicate_and_unknown_operator():
    with pytest.raises(ValueError, match='duplicate'):
        units.build(rows() + rows(), 7, {'line': APP})
    with pytest.raises(KeyError):
        units.build(rows(), 7, {})


def test_live_base_fixture():
    f = json.loads((Path(__file__).parent / 'fixtures/kms-chain-base-20260916.json').read_text())
    args = (f['appId'], f['derivedPubkey'], [f['appSignature'], f['kmsSignature']])
    result = keychain.verify_chain(*args, purpose=f['purpose'])
    assert result['appPubkey'] == f['appPubkey']
    with pytest.raises(ValueError):
        keychain.verify_chain(*args)  # ethereum fixture cannot register for layover-minion
    with pytest.raises(ValueError):
        keychain.verify_chain(APP, *args[1:], purpose=f['purpose'])


def test_fake_dstack_socket(tmp_path, monkeypatch):
    root, app, derived = [keys.PrivateKey(bytes([i]) * 32) for i in (4, 5, 17)]
    pub = derived.public_key.to_compressed_bytes()
    chain = [app.sign_msg_hash(keccak(b'layover-minion:' + pub.hex().encode())).to_bytes().hex(),
             root.sign_msg_hash(keccak(b'dstack-kms-issued:' + bytes.fromhex(APP[2:]) + app.public_key.to_compressed_bytes())).to_bytes().hex()]
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            calls.append((self.path, json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
            body = json.dumps({'key': derived.to_bytes().hex(), 'signature_chain': chain}).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    socket = str(tmp_path / 'dstack.sock')
    fake = UnixStreamServer(socket, Handler)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    # Test trust anchor injection only; production service always uses pinned Base root.
    import cvm.service as service
    original = keychain.verify_chain
    monkeypatch.setattr(service, 'verify_chain', lambda *a: original(*a, root=root.public_key.to_checksum_address()))
    rowfile = tmp_path / 'rows.jsonl'
    rowfile.write_text('\n'.join(json.dumps(r) for r in rows()))
    try:
        minion = Minion(socket, APP, rowfile, {'line': APP}, 7, 8453, BUYER)
        assert calls == [('/GetKey', {'path': 'layover/minion', 'purpose': 'layover-minion', 'algorithm': 'secp256k1'})]
        http = server(minion, ('127.0.0.1', 0))
        threading.Thread(target=http.serve_forever, daemon=True).start()
        try:
            identity = json.load(urlopen(f'http://127.0.0.1:{http.server_port}/minion'))
            assert identity == dict(address=derived.public_key.to_checksum_address(), key_path='layover/minion', signature_chain=chain, app_id=APP)
            signed = json.load(urlopen(f'http://127.0.0.1:{http.server_port}/signed'))
            assert len(signed['units']) == 4
            assert derived.to_bytes().hex() not in json.dumps(identity)
        finally:
            http.shutdown()
            http.server_close()
    finally:
        fake.shutdown()
        fake.server_close()


def test_contract_typed_hashes(tmp_path):
    contracts = Path(os.environ['DSMACK']) / 'contracts'
    # Compile actual read-only contract sources; all generated files stay in tmp_path.
    (tmp_path / 'src').symlink_to(contracts / 'src')
    (tmp_path / 'lib').symlink_to(contracts / 'lib')
    (tmp_path / 'test').mkdir()
    (tmp_path / 'foundry.toml').write_text((contracts / 'foundry.toml').read_text().replace('../app-attest/contracts', str(contracts.parent / 'app-attest/contracts')).replace('allow_paths = [', 'allow_paths = [' + json.dumps(str(contracts)) + ', '))
    book, values = units.build(rows(), 7, {'line': APP})
    unit = values[0]
    bookmsg = units.message('Book', book, 8453, BUYER)
    unitmsg = units.message('Unit', unit, 8453, BUYER)
    code = f'''pragma solidity ^0.8.21;
import {{LastResortBuyer}} from "../src/LastResortBuyer.sol";
import {{LayoverCredit}} from "../src/LayoverCredit.sol";
import {{Test}} from "forge-std/Test.sol";
contract HashTest is Test {{
function testHashes() public {{
vm.chainId(8453);
LastResortBuyer implementation = new LastResortBuyer(LayoverCredit(address(1)), address(2));
vm.etch({BUYER}, address(implementation).code);
LastResortBuyer buyer = LastResortBuyer({BUYER});
assertEq(buyer.DOMAIN_SEPARATOR(), hex"{bookmsg.header.hex()}");
bytes32 bookHash = keccak256(abi.encode(buyer.BOOK_TYPEHASH(), uint256(7), uint256(4)));
bytes32 unitHash = keccak256(abi.encode(buyer.UNIT_TYPEHASH(), bytes32({unit['unitId']}), address({APP}), uint256(7), bytes32({unit['workDigest']})));
assertEq(bookHash, hex"{bookmsg.body.hex()}");
assertEq(unitHash, hex"{unitmsg.body.hex()}");
assertEq(keccak256(abi.encodePacked(hex"1901", buyer.DOMAIN_SEPARATOR(), bookHash)), hex"{units.digest(bookmsg).hex()}");
assertEq(keccak256(abi.encodePacked(hex"1901", buyer.DOMAIN_SEPARATOR(), unitHash)), hex"{units.digest(unitmsg).hex()}");
}}
}}'''
    (tmp_path / 'test/Hash.t.sol').write_text(code)
    result = subprocess.run(['forge', 'test', '--root', str(tmp_path), '--match-contract', 'HashTest'], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_ecrank_signed_rows(tmp_path):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes_raw().hex()
    research = [dict(id=str(i), kind='autoresearch', source='ec-rank', unit=str(i),
        window={'a': [i, i + 1]}, agent_id='mac', paid=True, ok=True,
        verified=True, fault=None, digest='ab' * 32) for i in range(4)]
    path = tmp_path / 'rows.jsonl'
    def envelope(row):
        text = json.dumps(row)
        return json.dumps({'row_json': text, 'sig': key.sign(text.encode()).hex()})
    path.write_text('\n'.join(map(envelope, research)))
    loaded = units.load_rows(path, public)
    book, claims = units.build(loaded, 7, {'mac': APP})
    assert book['units'] == len(claims) == 4
    with pytest.raises(ValueError, match='public key'):
        units.load_rows(path)
    duplicate = {**research[0], 'id': 'another-id'}
    with pytest.raises(ValueError, match='duplicate'):
        units.build(loaded + [duplicate], 7, {'mac': APP})
    loaded[0]['verified'] = False
    with pytest.raises(ValueError, match='four'):
        units.build(loaded, 7, {'mac': APP})
    path.write_text(json.dumps(research[0]))
    with pytest.raises(ValueError, match='unsigned'):
        units.load_rows(path, public)
    path.write_text('\n'.join(map(envelope, research)))
    from cryptography.exceptions import InvalidSignature
    path.write_text(path.read_text().replace('ec-rank', 'forged!'))
    with pytest.raises(InvalidSignature):
        units.load_rows(path, public)


def test_compose_snippet_publishes_no_host_ports():
    text = (Path(__file__).parent / 'cvm/compose.snippet.yml').read_text()
    assert '/var/run/dstack.sock:/var/run/dstack.sock' in text
    assert 'build:' in text and '8080:8080' not in text and re.search(r'^\s*ports:', text, re.M) is None


def test_sim_dstack_socket(tmp_path, monkeypatch):
    """The sim's guest-agent stand-in (origin/sim sim/dstack-sim.ts) over a real unix socket.

    The sim derives keys by HMAC over its state seed, so a restart of the same state
    yields the same address and a different path yields a different one. Its
    signature_chain is always empty: it cannot mimic the KMS-rooted chain, so this
    test replaces verify_chain (production fails closed on a chain that short).
    """
    deno = shutil.which('deno')
    if deno is None:
        pytest.skip('deno not on PATH')
    repo = Path(__file__).parents[1]
    sim_path = repo / 'sim/dstack-sim.ts'
    if sim_path.is_file():
        sim_source = sim_path.read_text()
    else:
        sim = subprocess.run(['git', 'show', 'origin/sim:sim/dstack-sim.ts'], cwd=repo,
                             capture_output=True, text=True)
        assert sim.returncode == 0, 'need sim/dstack-sim.ts or origin/sim: ' + sim.stderr
        sim_source = sim.stdout
    state = tmp_path / 'state'
    state.mkdir()
    (state / 'keys.json').write_text(json.dumps({'accounts_seed': '0x' + '42' * 32}))

    def start_sim(socket):
        proc = subprocess.Popen([deno, 'run', '-A', str(tmp_path / 'dstack-sim.ts'), str(socket)],
                                env={**os.environ, 'SIM_STATE': str(state)},
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                if stat.S_ISSOCK(os.stat(socket).st_mode):
                    return proc
            except FileNotFoundError:
                pass
            if proc.poll() is not None:
                break
            time.sleep(0.1)
        proc.terminate()
        raise RuntimeError('sim did not serve %s' % socket)

    (tmp_path / 'dstack-sim.ts').write_text(sim_source)
    rowfile = tmp_path / 'rows.jsonl'
    rowfile.write_text('\n'.join(json.dumps(r) for r in rows()))
    import cvm.service as service
    monkeypatch.setattr(service, 'verify_chain',
                        lambda app_id, pub, chain: {'address': keychain.pubkey(pub).to_checksum_address()})

    def address(socket, path='layover/minion'):
        return Minion(str(socket), APP, rowfile, {'line': APP}, 7, 8453, BUYER, key_path=path)

    sim1 = start_sim(tmp_path / 'one.sock')
    try:
        first = address(tmp_path / 'one.sock').identity['address']
        other = address(tmp_path / 'one.sock', path='layover/minion/other').identity['address']
    finally:
        sim1.terminate()
        sim1.wait(10)
    sim2 = start_sim(tmp_path / 'two.sock')
    http = None
    try:
        minion = address(tmp_path / 'two.sock')
        assert minion.identity['address'] == first  # stable across a sim restart
        assert other != first  # a different path derives a different identity
        assert minion.identity['signature_chain'] == []  # the sim stand-in returns no KMS chain
        http = server(minion, ('127.0.0.1', 0))
        threading.Thread(target=http.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{http.server_port}'
        identity = json.load(urlopen(base + '/minion'))
        assert identity['address'] == first and identity['app_id'] == APP
        assert identity['signature_chain'] == []
        signed = json.load(urlopen(base + '/signed'))
        for kind, values in [('Book', [signed['book']]), ('Unit', signed['units'])]:
            for value in values:
                fields = {k: value[k] for k in [f['name'] for f in units.TYPES[kind]]}
                msg = units.message(kind, fields, 8453, BUYER)
                assert value['digest'] == '0x' + units.digest(msg).hex()
                assert Account.recover_message(msg, signature=value['signature']) == first
    finally:
        if http:
            http.shutdown()
            http.server_close()
        sim2.terminate()
        sim2.wait(10)

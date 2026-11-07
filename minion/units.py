"""LastResortBuyer EIP-712 signing of trusted baseline rows."""
import json
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address

TYPES = {
    'Book': [{'name': 'epoch', 'type': 'uint256'}, {'name': 'units', 'type': 'uint256'}],
    'Unit': [{'name': 'unitId', 'type': 'bytes32'}, {'name': 'operator', 'type': 'address'},
             {'name': 'epoch', 'type': 'uint256'}, {'name': 'workDigest', 'type': 'bytes32'}],
}


def canonical(row):
    return json.dumps(row, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def load_rows(path, public_key=None):
    """Read plain baseline rows or authenticate ecrank's signed row_json envelopes."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    rows = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if 'row_json' in row:
            if public_key is None:
                raise ValueError('signed rows require trusted rows public key')
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key.removeprefix('0x'))).verify(
                bytes.fromhex(row['sig']), row['row_json'].encode())
            row = json.loads(row['row_json'])
        elif public_key is not None:
            raise ValueError('unsigned row with trusted rows public key configured')
        rows.append(row)
    return rows


def message(kind, value, chain_id, buyer):
    return encode_typed_data(domain_data={'name': 'LastResortBuyer', 'version': '1',
        'chainId': chain_id, 'verifyingContract': to_checksum_address(buyer)},
        message_types={kind: TYPES[kind]}, message_data=value)


def digest(msg):
    return keccak(b'\x19' + msg.version + msg.header + msg.body)


def build(rows, epoch, operators):
    """One unit per successful paid use; operator map is trusted deployment input.

    The input is the baseline verifier's output, not arbitrary seller claims.
    Fetch rows additionally require an explicit passing attestation and served pages.
    """
    if type(epoch) is not int or not 0 <= epoch < 2**256:
        raise ValueError('invalid epoch')
    units, seen = [], set()
    for row in rows:
        if row.get('paid') is not True or row.get('ok') is not True or row.get('error') or row.get('failed_paid_use'):
            continue
        if row.get('kind') == 'fetch':
            if row.get('attestation_pass') is not True or row.get('status') != 'done' or not any(p.get('class') == 'served' for p in row.get('pages', [])):
                continue
        elif row.get('kind') == 'autoresearch':
            if row.get('verified') is not True or row.get('fault') is not None:
                continue
        elif row.get('kind') != 'couch':
            continue
        identity = (canonical({'source': row['source'], 'unit': row['unit'], 'window': row['window']}).decode()
                    if row['kind'] == 'autoresearch' else row['id'])
        if not isinstance(identity, str) or not identity or identity in seen:
            raise ValueError('missing or duplicate row id')
        seen.add(identity)
        operator = to_checksum_address(operators[row['agent_id']])
        if int(operator, 16) == 0:
            raise ValueError('zero operator')
        units.append({'unitId': '0x' + keccak(text='layover-baseline:' + identity).hex(),
            'operator': operator, 'epoch': epoch, 'workDigest': '0x' + keccak(canonical(row)).hex()})
    if len(units) < 4:
        raise ValueError('Book requires at least four verified units')
    return {'epoch': epoch, 'units': len(units)}, units


def sign_rows(rows, epoch, operators, key, chain_id, buyer):
    book, units = build(rows, epoch, operators)
    def signed(kind, value):
        msg = message(kind, value, chain_id, buyer)
        return {**value, 'digest': '0x' + digest(msg).hex(),
                'signature': '0x' + Account.sign_message(msg, key).signature.hex()}
    return {'book': signed('Book', book), 'units': [signed('Unit', u) for u in units]}

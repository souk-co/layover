"""dstack 0.5.x GetKey chain verification matching DstackKmsChain.sol."""
from eth_keys import keys
from eth_utils import keccak, to_checksum_address

BASE_KMS_ROOT = '0x52d3CF51c8A37A2CCfC79bBb98c7810d7Dd4CE51'
PURPOSE = 'layover-minion'
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def unhex(value):
    return bytes.fromhex(value.removeprefix('0x'))


def recover(digest, signature):
    sig = unhex(signature)
    if len(sig) != 65 or sig[64] > 1 or not 0 < int.from_bytes(sig[32:64], 'big') <= N // 2:
        raise ValueError('invalid KMS chain signature')
    return keys.Signature(sig).recover_public_key_from_msg_hash(digest)


def pubkey(value):
    raw = unhex(value)
    if len(raw) != 33 or raw[0] not in (2, 3):
        raise ValueError('compressed pubkey required')
    # cryptography validates curve membership, including x < p.
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), raw)
    return keys.PublicKey(public.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)[1:])


def verify_chain(app_id, derived_pubkey, signature_chain, purpose=PURPOSE, root=BASE_KMS_ROOT):
    if len(signature_chain) != 2:
        raise ValueError('expected app and KMS signatures')
    derived = pubkey(derived_pubkey)
    app = recover(keccak(purpose.encode() + b':' + unhex(derived_pubkey).hex().encode()), signature_chain[0])
    app_bytes = app.to_compressed_bytes()
    kms = recover(keccak(b'dstack-kms-issued:' + bytes.fromhex(to_checksum_address(app_id)[2:]) + app_bytes), signature_chain[1])
    if kms.to_checksum_address() != to_checksum_address(root):
        raise ValueError('KMS root mismatch')
    return {'address': derived.to_checksum_address(), 'derivedPubkey': '0x' + derived.to_compressed_bytes().hex(),
            'appPubkey': '0x' + app_bytes.hex(), 'appSignature': signature_chain[0], 'kmsSignature': signature_chain[1]}

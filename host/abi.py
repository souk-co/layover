"""abi.py calldata 'fn(bytes32)' 0xARG | abi.py workload IMAGE MANIFEST CALLER: bytes32-only ABI helpers, so chain reads need no foundry."""
import sys
from eth_abi import encode
from eth_utils import keccak

b32 = lambda h: bytes.fromhex(h.removeprefix('0x').rjust(64, '0'))
if sys.argv[1] == 'calldata':
    print('0x' + keccak(text=sys.argv[2])[:4].hex() + encode(['bytes32'] * len(sys.argv[3:]), [b32(a) for a in sys.argv[3:]]).hex())
elif sys.argv[1] == 'workload':
    print('0x' + keccak(encode(['bytes32'] * 3, [b32(a) for a in sys.argv[2:5]])).hex())
else:
    raise SystemExit('calldata | workload')

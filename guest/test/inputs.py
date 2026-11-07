#!/usr/bin/env python3
"""Off-Mac check of the generic build's manifest, launch inputs and egress rule, against dsmack's own guest code.
  python3 test/inputs.py DSMACK_CHECKOUT STARTER_MANIFEST
DSMACK_CHECKOUT is release.sh's DSMACK commit (ad7c7c97); STARTER_MANIFEST is zed's starter.json. Checks: the manifest
validates; the private-input disk run-mini.sh writes passes the guest's transport parser and its envelope passes the
runner's validate-inputs; an envelope without AGENT_ID is refused; the egress rule admits public IPv4 on 443 and the
upstream proxy ports (11200, 12321), gvproxy's host address (192.168.127.254) on the four host proxy ports only, and no other
LAN, loopback, link-local, CGNAT or multicast address on any port (only gvproxy's resolver on 53)."""
import ipaddress, json, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
repo, starter = Path(sys.argv[1]), Path(sys.argv[2])
content = repo / 'base-vm/browser-sandbox-v1/source/runner-content'
sys.path[:0] = [str(content), str(content / 'lib')]
import pack, inputs
from dsmack_guest_io import private_transport
from dsmack_compose_contract.manifest import validate_manifest_bytes
from dsmack_compose_contract.runtime_inputs import validate_runtime_inputs_bytes
from dsmack_compose_contract.lowering import render_egress_rules

pack.base_vm = lambda base: {}
mb = pack.manifest(starter, None, 'sha256:' + 'ab' * 32, 'cd' * 32, 'test')
validate_manifest_bytes(mb)
m = json.loads(mb)
compose = json.loads(m['docker_compose_file'])
for s in compose['services'].values():
    assert not set(s.get('environment', {})) & set(pack.ENVS), 'a launch input is also baked into the compose'
assert m['required_envs'] == ['AGENT_ID', 'INSTRUCTIONS', 'DAILY_BYTES', 'OPERATOR', 'ESCROW', 'GUEST_ESCROW', 'CHAIN_ID'], m['required_envs']
print('manifest validates; launch inputs', [e['name'] for e in m['allowed_envs']], 'required', m['required_envs'])

env = {'AGENT_ID': 'resip-mini-1', 'DAILY_BYTES': '300000000', 'OPERATOR': '0x' + '11' * 20, 'ESCROW': '0x' + '22' * 20, 'GUEST_ESCROW': '0x' + '33' * 20,
       'CHAIN_ID': '84532', 'UPSTREAM_PROXY': 'http://192.168.127.254:18889', 'INSTRUCTIONS': (HERE / 'instructions.txt').read_text().strip()}
with tempfile.TemporaryDirectory() as d:
    img = inputs.image(mb, env)
    private_transport.extract(img, d + '/priv')
    envelope = (Path(d) / 'priv/envelopes' / (m['name'] + '.envelope.json')).read_bytes()
    validate_runtime_inputs_bytes(mb, envelope)
    assert json.loads(envelope)['env'] == env
    print(f'private-input disk: {len(img)} bytes, envelope {m["name"]}.envelope.json validates with', sorted(env))
try:
    validate_runtime_inputs_bytes(mb, inputs.envelope(mb, {k: v for k, v in env.items() if k != 'AGENT_ID'}))
    ok = True
except Exception as e:
    assert 'missing required name AGENT_ID' in str(e), e
    ok = False
    print('without AGENT_ID: refused:', 'envelope.env is missing required name AGENT_ID')
assert not ok, 'an envelope without AGENT_ID was accepted'

rules = m['network']['service_egress']['gateway']
def allowed(ip, port, proto='tcp'):
    return any(r['port'] == port and r['protocol'] == proto and ipaddress.ip_address(ip) in ipaddress.ip_network(r['destination']) for r in rules)
assert len(rules) <= 256
for ip in ['8.8.8.8', '1.1.1.1', '66.220.6.108', '185.149.195.182', '104.16.123.96']:
    assert all(allowed(ip, p) for p in pack.PORTS), ip
assert allowed('185.149.195.182', 11200), 'the IPRoyal exit on its proxy port'
ports = {r['port'] for r in rules}
host = pack.GVPROXY_HOST
assert pack.HOST_PROXY_PORTS == [18888, 18889, 18890, 18891]
assert all(allowed(host, p) for p in pack.HOST_PROXY_PORTS), 'the host proxy ports'
assert not any(allowed(host, p) for p in set(range(1, 65536)) - set(pack.HOST_PROXY_PORTS)), 'the host on any other port'
assert not any(allowed(host, p, 'udp') for p in range(1, 65536)), 'the host over udp'
assert not any(allowed(ip, p) for ip in ['8.8.8.8', '185.149.195.182'] for p in pack.HOST_PROXY_PORTS), 'public addresses on the host proxy ports'
for ip in ['192.168.1.1', '192.168.127.253', '192.168.127.255', '192.168.127.2', '10.0.0.1', '172.16.0.1', '172.31.255.254', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.1', '224.0.0.1', '255.255.255.255']:
    assert not any(allowed(ip, p) for p in ports | {22, 80, 8080, 18484}), ip
assert not any(allowed('192.168.127.1', p) for p in ports - {53}) and allowed('192.168.127.1', 53, 'udp') and allowed('192.168.127.1', 53)
assert not allowed('8.8.8.8', 80) and not allowed('8.8.8.8', 22)
print(f'egress: {len(rules)} rules; public IPv4 on ports {pack.PORTS} (185.149.195.182:11200 allowed), {host} on {pack.HOST_PROXY_PORTS} only,'
      ' other LAN/loopback/link-local/CGNAT/multicast refused on every port, DNS only to gvproxy')
nft = [l.strip() for l in render_egress_rules(m).splitlines() if 'accept' in l and 'daddr' in l]
exit_net = next(str(n) for n in pack.public_ipv4() if ipaddress.ip_address('185.149.195.182') in n)
assert any(f'daddr {exit_net} tcp dport 11200' in l for l in nft), 'nft rules'
lan = [l for l in nft if '192.168.' in l]
assert all(f'daddr {pack.GVPROXY_DNS}/32 ' in l and 'dport 53' in l or f'daddr {host}/32 tcp dport ' in l and int(l.split('dport ')[1].split()[0]) in pack.HOST_PROXY_PORTS for l in lan), lan
assert len(lan) == 2 + len(pack.HOST_PROXY_PORTS), lan
print(f'nft (dsmack lowering): {len(nft)} accept rules, 11200 present, 192.168.x only for DNS and {host} on the host proxy ports')
print('PASS')

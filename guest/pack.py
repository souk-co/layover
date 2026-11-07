#!/usr/bin/env python3
"""Build the resip guest workload on an x86 Docker host with arm64 buildx (zed).

pack.py GATEWAY_REPO DSMACK_REPO BASE_FILES STARTER_MANIFEST OUT VERSION

GATEWAY_REPO is a dsmack checkout with the pinned egress-policy gateway, DSMACK_REPO one whose manifest validator and
workload packer match the base (network.service_egress needs dsmack PR #78), BASE_FILES the
base image files (metadata.json, Image, initramfs, rootfs, sha256sum.txt), STARTER_MANIFEST a compose manifest whose
fields besides base_vm and the ones set here are kept (the staging pool's). OUT receives image/, compose-manifest.json
and disk/workload.img. VERSION (the guest commit) goes into the measured environment as GUEST_VERSION.
"""
import gzip, hashlib, ipaddress, json, os, subprocess, sys, tarfile
from pathlib import Path

NAME = 'resip-guest-v1'
HERE = Path(__file__).resolve().parent
# LAYOVER_ENV=staging packs the staging lane's guest (notes/environments.md on main): the same code reporting to the staging
# site and custody instead, in the measured environment and the control gateway's policy.
SITE, CUSTODY = {'live': ('resip-staging', 'resip-custody-staging'), 'staging': ('layover-staging', 'layover-custody-staging')}[os.environ.get('LAYOVER_ENV', 'live')]
BASE_URL = 'https://pod.dstack.soc1024.com/' + SITE
BROKER = 'https://pod.dstack.soc1024.com/relay-broker-staging'
GVPROXY_DNS = '192.168.127.1'
# gvproxy's host address: the guest's 192.168.127.254:P is the Mac's 127.0.0.1:P (gvproxy v0.8.9's default NAT). The gateway service
# may reach it on these ports only, where the host runs its own HTTP CONNECT proxies (one per route: ProtonVPN, Nym, two spare), for an
# UPSTREAM_PROXY naming one of them. The guest attests that only these ports are reachable, not what listens on them: the route a
# proxy delivers is what the line check, vantage checks and probes measure (exit address and ASN).
GVPROXY_HOST = '192.168.127.254'
HOST_PROXY_PORTS = [18888, 18889, 18890, 18891]
NOT_PUBLIC = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
              '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3']
# TCP ports the gateway service may reach on public addresses: HTTPS, and the IPRoyal exit's static (11200) and rotating (12321)
# proxy ports for an UPSTREAM_PROXY. dsmack's egress rule names one port per entry and at most 256 entries, and public IPv4 is 73
# CIDRs, so with DNS and the host proxy ports (73*3 + 2 + 4 = 225) a fourth public port does not fit; "any port" needs port ranges in dsmack's manifest.
PORTS = [443, 11200, 12321]
# Launch inputs (run-mini.sh writes them to the private-input disk): who this guest is, the host's instructions, its daily
# byte budget, its payout address and escrow contract (statements name both), and optionally an upstream proxy for the line and
# per-job gateways (the control gateway to the pod always goes direct). None of them is measured; the site and custody bind
# AGENT_ID to the runner's attestation key.
ENVS = {'AGENT_ID': ['agent'], 'INSTRUCTIONS': ['agent'], 'DAILY_BYTES': ['agent'], 'OPERATOR': ['agent'], 'ESCROW': ['agent'], 'GUEST_ESCROW': ['agent'], 'CHAIN_ID': ['agent'], 'UPSTREAM_PROXY': ['gateway'], 'DRAIN_PREFLIGHT_CHALLENGE': ['agent']}
REQUIRED = ['AGENT_ID', 'INSTRUCTIONS', 'DAILY_BYTES', 'OPERATOR', 'ESCROW', 'GUEST_ESCROW', 'CHAIN_ID']


def canon(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def public_ipv4():
    nets = [ipaddress.ip_network('0.0.0.0/0')]
    for x in map(ipaddress.ip_network, NOT_PUBLIC):
        nets = [r for n in nets for r in (n.address_exclude(x) if x.subnet_of(n) else [n])]
    return sorted(nets)


def egress():
    return ([{'destination': str(n), 'protocol': 'tcp', 'port': p} for p in PORTS for n in public_ipv4()] +
            [{'destination': GVPROXY_DNS + '/32', 'protocol': p, 'port': 53} for p in ('udp', 'tcp')] +
            [{'destination': GVPROXY_HOST + '/32', 'protocol': 'tcp', 'port': p} for p in HOST_PROXY_PORTS])


def oci_layout(tag, image):
    blobs = image / 'oci-layout/blobs/sha256'
    blobs.mkdir(parents=True)

    def blob(raw):
        h = hashlib.sha256(raw).hexdigest()
        (blobs / h).write_bytes(raw)
        return {'digest': 'sha256:' + h, 'size': len(raw)}
    with (image / 'image.tar').open('wb') as f:
        subprocess.run(['docker', 'save', tag], stdout=f, check=True)
    with tarfile.open(image / 'image.tar') as a:
        entry, = json.load(a.extractfile('manifest.json'))
        config = blob(a.extractfile(entry['Config']).read())
        layers = [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip',
                   **blob(gzip.compress(a.extractfile(n).read(), compresslevel=3, mtime=0))} for n in entry['Layers']]
    (image / 'image.tar').unlink()
    doc = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
           'config': {'mediaType': 'application/vnd.oci.image.config.v1+json', **config}, 'layers': layers}
    top = blob(canon(doc))
    (image / 'oci-layout/index.json').write_bytes(canon({'schemaVersion': 2, 'manifests': [{'mediaType': doc['mediaType'], **top,
        'platform': {'architecture': 'arm64', 'os': 'linux'}, 'annotations': {'org.opencontainers.image.ref.name': 'resip-guest'}}]}))
    (image / 'oci-layout/oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}')
    return top['digest']


def fsha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def base_vm(base):
    meta = json.loads((base / 'metadata.json').read_bytes())
    root, = [t.split('=', 1)[1] for t in meta['cmdline'].split() if t.startswith('dstack.rootfs_hash=')]
    return dict(cmdline=meta['cmdline'], initrd_sha256=fsha(base / 'initramfs.cpio.gz'), kernel_sha256=fsha(base / 'Image'),
                metadata_sha256=fsha(base / 'metadata.json'), os_image_hash=fsha(base / 'sha256sum.txt'),
                rootfs_sha256=fsha(base / 'rootfs.squashfs.verity'), verity_root_hash=root)


def manifest(starter, base, digest, node_sha256, version):
    m = json.loads(starter.read_bytes())
    m['base_vm'].update(base_vm(base))
    image = '127.0.0.1:5005/resip-guest@' + digest
    gateway = {
        'image': image,
        'entrypoint': ['/usr/local/bin/node'],
        'command': ['/opt/resip/gateway.mjs', '/usr/local/bin/dsmack-egress', '/opt/resip/control-policy.json', 'gateway', '8080', '8081', '/workspace/shared'],
        'read_only': True,
    }
    agent = {
        'image': image,
        'entrypoint': ['/usr/local/bin/node'],
        'command': ['/opt/resip/agent.mjs'],
        'environment': {'RESIP_BASE': BASE_URL, 'CUSTODY': f'https://pod.dstack.soc1024.com/{CUSTODY}/api/custody', 'BROKER': BROKER, 'GUEST_VERSION': version,
                        'DSTACK_SOCKET': '/var/run/dstack.sock',
                        'GATEWAY_API': 'http://gateway:8081', 'GATEWAY_CONTROL': 'gateway:8080',
                        'MAX_RESPONSE_BYTES': str(4 << 20), 'POLL_SECONDS': '10', 'LIFETIME_SECONDS': '3300', 'RETRY_SECONDS': '180',
                        'ARTIFACTS': '/workspace/artifacts', 'VANTAGE_TRACE_URL': 'https://www.cloudflare.com/cdn-cgi/trace',
                        'FETCH_USER_AGENT': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
                        'FETCH_ACCEPT_LANGUAGE': 'en-US,en;q=0.9', 'LEASE_FLOOR_PRICE_CHECK': '400', 'LEASE_FLOOR_SHARED': '200', 'LEASE_FLOOR_ACCOUNT': '1000',
                        'LEASE_MAX_REQUESTS': '2000', 'LEASE_REQUESTS_PER_MINUTE': '30', 'VANTAGE_SECONDS': '240', 'CLAIM_SECONDS': '300', 'RENEW_GRACE_SECONDS': '600', 'APPRAISAL_MIN_SECONDS': '600'},
        'read_only': True,
        'volumes': ['artifacts:/workspace/artifacts:rw', '/var/run/dstack.sock:/var/run/dstack.sock:ro'],
    }
    m.update(name=NAME, allowed_files=[], allowed_envs=[{'name': n, 'audience': 'workload', 'services': sv} for n, sv in ENVS.items()], required_envs=REQUIRED,
             network={'mode': 'nat', 'listen_ports': [], 'egress': [], 'service_egress': {'gateway': egress()}},
             harness={'name': 'resip-guest', 'path': '/usr/local/bin/node', 'sha256': node_sha256, 'version': 'resip-guest-1'},
             docker_compose_file=canon({'services': {'agent': agent, 'gateway': gateway}}).decode(),
             outputs={'capture': ['stdout', 'stderr'], 'completion_service': 'agent', 'artifacts': [
                 {'name': n, 'path': '/workspace/artifacts/' + n} for n in ('registration', 'jobs', 'log', 'appraisal', 'probe', 'drain-checkpoint', 'guest-key')]})
    m['limits'] = dict(m['limits'], timeout_s=3600)
    return canon(m)


def control_policy():
    p = HERE / 'control-policy.json'
    text = p.read_text()
    for live, env in (('/resip-staging/api/', f'/{SITE}/api/'), ('/resip-custody-staging/api/custody/', f'/{CUSTODY}/api/custody/')):
        assert f'"{live}"' in text, live
        text = text.replace(f'"{live}"', f'"{env}"')
    p.write_text(text)


def main(gateway_repo, repo, base, starter, out, version):
    control_policy()
    subprocess.run(['go', 'build', '-trimpath', '-ldflags=-s -w', '-o', str(HERE / 'dsmack-egress'), '.'],
                   cwd=gateway_repo / 'applications/egress-policy', env={**__import__('os').environ, 'CGO_ENABLED': '0', 'GOOS': 'linux', 'GOARCH': 'arm64'}, check=True)
    subprocess.run(['docker', 'buildx', 'build', '--builder', 'default', '--platform', 'linux/arm64', '--load', '-t', 'resip-guest:build', str(HERE)], check=True)
    cid = subprocess.check_output(['docker', 'create', '--platform', 'linux/arm64', 'resip-guest:build']).decode().strip()
    node = subprocess.run(['docker', 'cp', cid + ':/usr/local/bin/node', '-'], capture_output=True, check=True).stdout
    subprocess.run(['docker', 'rm', cid], check=True, capture_output=True)
    with tarfile.open(fileobj=__import__('io').BytesIO(node)) as t:
        node_sha256 = hashlib.sha256(t.extractfile('node').read()).hexdigest()
    out.mkdir()
    digest = oci_layout('resip-guest:build', out / 'image')
    raw = manifest(starter, base, digest, node_sha256, version)
    (out / 'compose-manifest.json').write_bytes(raw)
    sys.path.insert(0, str(repo / 'dstack-compat'))
    import canary_workload
    canary_workload.pack(repo, base, out / 'image', out / 'disk', NAME, raw)


if __name__ == '__main__':
    main(*(Path(a).resolve() for a in sys.argv[1:6]), sys.argv[6])

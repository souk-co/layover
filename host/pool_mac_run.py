#!/usr/bin/env python3
"""One owned warm-pool hvf-v3 launch; pool.py performs the Mac ownership preflight.

python3 pool_mac_run.py <runner dir> <run dir> <seconds> <profile>

The runner dir holds DsmackRunner.app, base/ (the image files) and enrollment/keyId.txt; the run dir
holds workload.img and compose-manifest.json and receives out/, stdout.txt, stderr.txt and gvproxy.log.
The runner runtime/ holds base/{scratch,result}-template.ext4 and helper/gvproxy-darwin.
"""
import hashlib
import json
import secrets
import subprocess
import sys
import time
from pathlib import Path

d, t = Path(sys.argv[1]), Path(sys.argv[2])
b, rt = d/'base', d/'runtime'
seconds = int(sys.argv[3])
profile = sys.argv[4]
private = sys.argv[5] if len(sys.argv) > 5 else ''
compose = json.loads((t/'compose-manifest.json').read_bytes())
mem_mib, vcpus = compose['base_vm']['memory_mb'], compose['base_vm']['vcpus']
resources = {'mem_mib': mem_mib, 'vcpus': vcpus, 'basis': f'warm compute node:{mem_mib}MiB/{vcpus}vCPU'}
if profile != f'mini-{mem_mib}-{vcpus}':
    raise ValueError('launch resource profile differs from measured compose size')
if not 1 <= seconds <= 3600:
    raise ValueError('pool runtime must be 1..3600 seconds')


def canon(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':')).encode()


def fsha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


def desc(p):
    return {'path': str(p), 'sha256': fsha(p), 'bytes': p.stat().st_size}


def template(n):
    p = rt/'base'/(n + '-template.ext4')
    return {n + '_template_path': str(p), n + '_template_sha256': args['dstack.%s_template_sha256' % n],
            n + '_template_bytes': p.stat().st_size}


meta = json.loads((b/'metadata.json').read_bytes())
osh = fsha(b/'sha256sum.txt')
args = dict(x.split('=', 1) for x in meta['cmdline'].split() if '=' in x)
image = {'schema': 'dsmack-general-launcher/image-manifest/1', 'arch': 'aarch64', 'description': 'warm compute node',
         'image_id': osh, 'cmdline': meta['cmdline'],
         'guest': {'console': 'hvc0', 'scratch_device': 'vdb', 'workload_device': 'vdc', 'supervisor_markers': 'DSMACK_RESULT_CLOSED_V1'},
         'kernel': desc(b/'Image'), 'initrd': desc(b/'initramfs.cpio.gz'),
         'system_disk': dict(desc(b/'rootfs.squashfs.verity'), format='raw', verity_root_hash=args['dstack.rootfs_hash']),
         'resource_profiles': {profile: resources},
         'provenance': {'profile_id': 'warm-compute-node-v1', 'os_image_hash': osh}}
ir = canon(image)
(t/'image-manifest.json').write_bytes(ir)
(t/'policy.json').write_bytes(canon({'schema': 'dsmack-general-launcher/admission-policy/1', 'policy_id': f'warm-compute-node-{mem_mib}-{vcpus}-3600',
    'notes': 'warm compute node', 'admitted_images': [{'image_id': osh, 'manifest_sha256': hashlib.sha256(ir).hexdigest(), 'admitted_by': 'local:warm-compute-pool'}],
    'resource_limits': {'max_mem_mib': mem_mib, 'max_vcpus': vcpus, 'max_runtime_seconds': 3600},
    'device_contract': {'system': 'vda', 'scratch': 'vdb', 'workload': 'vdc'}}))
(t/'admission.json').write_bytes(canon({'admission_version': 1, 'allowed_os_image_hashes': [osh]}))
(t/'challenge.bin').write_bytes(secrets.token_bytes(32))
(t/'session.json').write_bytes(canon({'schema': 'dsmack-general-launcher/session/3', 'policy_path': str(t/'policy.json'),
    'image_manifest_path': str(t/'image-manifest.json'), 'checksum_manifest_path': str(b/'sha256sum.txt'),
    'metadata_path': str(b/'metadata.json'), 'admission_path': str(t/'admission.json'),
    'compose_manifest_path': str(t/'compose-manifest.json'), 'profile': profile, 'workload_disk_path': str(t/'workload.img'),
    'workload_sha256': fsha(t/'workload.img'), 'workload_id': 'compute-node-v1', 'runtime_seconds': 3600,
    'private_input_path': private, 'net_socket_path': str(t/'net.sock'), **template('scratch'), **template('result')}))
net = subprocess.Popen([str(rt/'helper/gvproxy-darwin'), '-listen-qemu', 'unix://%s' % (t/'net.sock'), '-ssh-port', '-1',
                        '-log-file', str(t/'gvproxy.log')])
(t/'helper.pid').write_text(str(net.pid))
while not (t/'net.sock').exists():
    assert net.poll() is None, 'gvproxy exited'
    time.sleep(0.1)
try:
    subprocess.run(['/usr/bin/open', '-n', '-W', '--stdout', str(t/'stdout.txt'), '--stderr', str(t/'stderr.txt'),
                    str(d/'DsmackRunner.app'), '--args', 'hvf-v3', str(t/'out'), str(t/'session.json'), str(t/'challenge.bin'),
                    str(d/'enrollment/keyId.txt')], check=True, timeout=4300)
finally:
    net.terminate()
    net.wait()
    (t/'helper-stopped.json').write_text(json.dumps({'pid':net.pid,'returncode':net.returncode}))

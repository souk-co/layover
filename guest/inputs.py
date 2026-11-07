#!/usr/bin/env python3
"""inputs.py MANIFEST OUT NAME=VALUE...: write OUT, the private-input disk (vde, dsmack.private-input-transport/1) that
carries the guest's launch env: one runtime-input envelope for MANIFEST's exact bytes, at envelopes/<name>.envelope.json,
in a ustar stream zero-padded to 512 bytes. The disk is not measured; dsmack's supervisor checks the envelope against the
manifest's allowed_envs and required_envs before compose starts."""
import hashlib, io, json, os, sys, tarfile

MTIME = 1784592000  # dsmack pt_limits.PT_CANONICAL_MTIME


def envelope(manifest, env):
    return json.dumps({'runtime_input_version': 4, 'manifest_sha256': hashlib.sha256(manifest).hexdigest(), 'env': env},
                      sort_keys=True, separators=(',', ':')).encode()


def image(manifest, env):
    name = json.loads(manifest)['name']
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as t:
        for rel, data in (('envelopes', None), (f'envelopes/{name}.envelope.json', envelope(manifest, env))):
            ti = tarfile.TarInfo(rel)
            ti.type, ti.mtime, ti.mode = (tarfile.DIRTYPE, MTIME, 0o700) if data is None else (tarfile.REGTYPE, MTIME, 0o600)
            ti.size = len(data or b'')
            t.addfile(ti, data and io.BytesIO(data))
    raw = buf.getvalue()
    return raw + b'\0' * (-len(raw) % 512)


if __name__ == '__main__':
    manifest, out, pairs = open(sys.argv[1], 'rb').read(), sys.argv[2], sys.argv[3:]
    env = dict(p.split('=', 1) for p in pairs)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(image(manifest, env))

"""blkdiff.py diff OLD NEW > PATCH | blkdiff.py apply OLD NEW_OUT < PATCH.
Each 512-byte block of NEW (the tar record size, so a layer that moved in workload.img still matches) is either a copy of some 512-byte-aligned block of OLD (by offset) or literal bytes."""
import hashlib, struct, sys
B = 512
if sys.argv[1] == "diff":
    old = open(sys.argv[2], "rb").read()
    index = {}
    for o in range(0, len(old), B):
        index.setdefault(hashlib.sha256(old[o:o + B]).digest(), o)
    new, out = open(sys.argv[3], "rb").read(), sys.stdout.buffer
    out.write(struct.pack("<Q", len(new)))
    for o in range(0, len(new), B):
        blk = new[o:o + B]
        ref = index.get(hashlib.sha256(blk).digest())
        out.write(struct.pack("<cQ", b"R", ref) if ref is not None and old[ref:ref + len(blk)] == blk else struct.pack("<cI", b"L", len(blk)) + blk)
else:
    old, dst, p = open(sys.argv[2], "rb"), open(sys.argv[3], "wb"), sys.stdin.buffer
    size, = struct.unpack("<Q", p.read(8))
    while (t := p.read(1)):
        if t == b"R":
            off, = struct.unpack("<Q", p.read(8)); old.seek(off); dst.write(old.read(min(B, size - dst.tell())))
        else:
            n, = struct.unpack("<I", p.read(4)); dst.write(p.read(n))
    assert dst.tell() == size

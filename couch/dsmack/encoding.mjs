// Bounded wire decoders for Apple's definite-length CBOR and DER certificate profile.
export function require(ok, message) {
  if (!ok) throw new Error("refused: " + message);
}
export function cbor(raw, start = 0, depth = 0) {
  require(depth < 16 && start < raw.length, "CBOR bounds");
  const t = raw[start], major = t >>> 5, ai = t & 31;
  let p = start + 1, n = ai;
  require(ai < 27, "CBOR length");
  if (ai >= 24) {
    const size = 1 << (ai - 24);
    require(p + size <= raw.length, "CBOR truncated");
    n = 0;
    for (let j = 0; j < size; j++) n = n * 256 + raw[p++];
  }
  if (major < 2) return [major === 0 ? n : -1 - n, p];
  if (major === 2 || major === 3) {
    require(p + n <= raw.length, "CBOR truncated");
    const v = raw.slice(p, p + n);
    return [
      major === 2 ? v : new TextDecoder("utf-8", { fatal: true }).decode(v),
      p + n,
    ];
  }
  require((major === 4 || major === 5) && n <= 100, "CBOR container");
  const out = major === 4 ? [] : new Map();
  for (let j = 0; j < n; j++) {
    const [k, q] = cbor(raw, p, depth + 1);
    p = q;
    if (major === 4) out.push(k);
    else {
      require(!out.has(k), "CBOR duplicate key");
      const [v, r] = cbor(raw, p, depth + 1);
      out.set(k, v);
      p = r;
    }
  }
  return [out, p];
}
export function decodeCbor(raw) {
  const [out, end] = cbor(raw);
  require(end === raw.length, "CBOR trailing bytes");
  return out;
}
export function der(raw, start = 0) {
  require(start + 2 <= raw.length, "DER truncated");
  const tag = raw[start];
  let p = start + 2, n = raw[start + 1];
  if (n & 128) {
    const count = n & 127;
    require(count > 0 && count <= 4 && p + count <= raw.length, "DER length");
    n = 0;
    for (let j = 0; j < count; j++) n = n * 256 + raw[p++];
    require(n >= 128, "DER long length");
  }
  require(p + n <= raw.length, "DER truncated");
  return {
    tag,
    raw: raw.slice(start, p + n),
    value: raw.slice(p, p + n),
    end: p + n,
  };
}
export function children(node) {
  const out = [];
  let p = 0;
  while (p < node.value.length) {
    const x = der(node.value, p);
    out.push(x);
    p = x.end;
  }
  return out;
}
export const bytesEqual = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
export function derSignature(raw, size = 32) {
  const outer = der(raw);
  require(outer.tag === 48 && outer.end === raw.length, "DER signature");
  const parts = children(outer);
  require(parts.length === 2, "DER signature integers");
  const out = new Uint8Array(size * 2);
  for (let j = 0; j < 2; j++) {
    let n = parts[j].value;
    require(parts[j].tag === 2 && n.length > 0 && !(n[0] & 128), "DER integer");
    if (n.length > 1 && n[0] === 0) {
      require(n[1] & 128, "DER integer padding");
      n = n.slice(1);
    }
    require(n.length <= size, "DER integer size");
    out.set(n, size * (j + 1) - n.length);
  }
  return out;
}

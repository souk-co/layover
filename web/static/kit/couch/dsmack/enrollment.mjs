import {
  cat,
  hex,
  sha256,
  unhex,
} from "./policy.mjs";
import {
  bytesEqual,
  cbor,
  children,
  decodeCbor,
  der,
  derSignature,
  require,
} from "./encoding.mjs";
const enc = new TextEncoder(), subtle = crypto.subtle;
export const APP_ID = "DC9JH5DRMY.dev.dsmack.provider";
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const oid = (n) => hex(n.value);
function date(n) {
  const s = new TextDecoder().decode(n.value);
  require(
    (n.tag === 23 && /^\d{12}Z$/.test(s)) ||
      (n.tag === 24 && /^\d{14}Z$/.test(s)),
    "certificate time",
  );
  const v = n.tag === 23 ? (Number(s.slice(0, 2)) < 50 ? "20" : "19") + s : s;
  return Date.parse(
    `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${
      v.slice(10, 12)
    }:${v.slice(12, 14)}Z`,
  );
}
function cert(raw) {
  const outer = der(raw);
  require(outer.tag === 48 && outer.end === raw.length, "certificate DER");
  const [tbs, algorithm, signature] = children(outer), fields = children(tbs);
  require(fields[0].tag === 160, "certificate version");
  const validity = children(fields[4]),
    spki = fields[6],
    key = children(spki),
    algorithmParts = children(key[0]);
  const curve = oid(algorithmParts[1]);
  require(
    oid(algorithmParts[0]) === "2a8648ce3d0201" &&
      ["2a8648ce3d030107", "2b81040022"].includes(curve),
    "certificate EC key",
  );
  const extensions = new Map();
  for (const wrapper of fields.slice(7).filter((x) => x.tag === 163)) {
    for (const e of children(children(wrapper)[0])) {
      const p = children(e), id = oid(p[0]);
      require(!extensions.has(id), "certificate duplicate extension");
      const critical = p.length === 3;
      require(
        !critical || ["551d13", "551d0f"].includes(id),
        "unknown critical certificate extension",
      );
      extensions.set(id, p.at(-1).value);
    }
  }
  return {
    raw,
    tbs: tbs.raw,
    algorithm: oid(children(algorithm)[0]),
    signature: signature.value.slice(1),
    issuer: fields[3].raw,
    subject: fields[5].raw,
    spki: spki.raw,
    point: key[1].value.slice(1),
    curve: curve === "2b81040022" ? "P-384" : "P-256",
    notBefore: date(validity[0]),
    notAfter: date(validity[1]),
    extensions,
  };
}
async function signedBy(child, parent) {
  require(bytesEqual(child.issuer, parent.subject), "certificate issuer");
  const hashes = {
    "2a8648ce3d040302": "SHA-256",
    "2a8648ce3d040303": "SHA-384",
  };
  require(hashes[child.algorithm], "certificate signature algorithm");
  const key = await subtle.importKey(
    "spki",
    parent.spki,
    { name: "ECDSA", namedCurve: parent.curve },
    false,
    ["verify"],
  );
  require(
    await subtle.verify(
      { name: "ECDSA", hash: hashes[child.algorithm] },
      key,
      derSignature(child.signature, parent.curve === "P-384" ? 48 : 32),
      child.tbs,
    ),
    "Apple certificate signature",
  );
}
function ca(c, expected) {
  const extension = c.extensions.get("551d13");
  require(extension, "certificate basic constraints");
  const p = children(der(extension));
  const isCA = p[0]?.tag === 1 && p[0].value[0] === 255;
  require(isCA === expected, "certificate CA constraint");
  const usage = c.extensions.get("551d0f");
  if (usage && expected) {
    require(der(usage).value[1] & 4, "certificate keyCertSign");
  }
}
const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;
// verify_key semantics: leaf must have been valid at issuance; intermediate must still be valid now.
export async function verifyEnrollment(enrollment, cdhash, now = Date.now()) {
  const data = decodeCbor(enrollment.attestation),
    statement = data.get("attStmt"),
    auth = data.get("authData");
  require(
    data.get("fmt") === "apple-appattest" && statement instanceof Map,
    "Apple enrollment format",
  );
  const chain = statement.get("x5c");
  require(Array.isArray(chain) && chain.length === 2, "Apple enrollment chain");
  const [leaf, intermediate] = chain.map(cert),
    root = cert(b64(ROOT_PEM.replace(/-----[^-]+-----|\s/g, "")));
  require(intermediate.notAfter > now, "Apple intermediate expired");
  const at = leaf.notBefore + 60000;
  for (const c of [leaf, intermediate, root]) {
    require(
      c.notBefore <= at && at <= c.notAfter,
      "Apple certificate validity",
    );
  }
  ca(leaf, false);
  ca(intermediate, true);
  ca(root, true);
  await signedBy(leaf, intermediate);
  await signedBy(intermediate, root);
  require(leaf.curve === "P-256", "enrollment key curve");
  const kid = typeof enrollment.keyId === "string"
    ? b64(enrollment.keyId)
    : enrollment.keyId;
  require(bytesEqual(await sha256(leaf.point), kid), "enrollment key ID");
  require(
    auth instanceof Uint8Array && auth.length >= 87 &&
      bytesEqual(auth.slice(0, 32), await sha256(enc.encode(APP_ID))),
    "enrollment app ID",
  );
  require(
    (auth[32] & 0x3e) === 0 && (auth[32] & 0xc0) === 0xc0 &&
      auth.slice(33, 37).every((x) => x === 0),
    "enrollment flags/counter",
  );
  require(
    bytesEqual(
      auth.slice(37, 53),
      cat(enc.encode("appattest"), new Uint8Array(7)),
    ) && auth[53] === 0 && auth[54] === 32 &&
      bytesEqual(auth.slice(55, 87), kid),
    "enrollment credential/AAGUID",
  );
  const [cose, end] = cbor(auth, 87), ext = decodeCbor(auth.slice(end));
  require(
    cose.size === 5 && cose.get(1) === 2 && cose.get(3) === -7 &&
      cose.get(-1) === 1 && bytesEqual(cose.get(-2), leaf.point.slice(1, 33)) &&
      bytesEqual(cose.get(-3), leaf.point.slice(33)),
    "enrollment COSE key",
  );
  require(
    ext.get("apple_cd_hash_type_01")?.[0] === 2 &&
      hex(ext.get("apple_cd_hash_hash_01")) === cdhash &&
      hex(ext.get("apple_validation_category_01")) === "03000000",
    "enrollment build/category",
  );
  const nonce = cat(
    unhex("3024a1220420"),
    await sha256(cat(auth, await sha256(enrollment.clientData))),
  );
  require(
    bytesEqual(leaf.extensions.get("2a864886f763640802") ?? [], nonce),
    "enrollment nonce",
  );
  const acl = cat(
    unhex("3046a3440442"),
    b64(
      "MEAMAjExMDowCQwCb2uhAwEB/zAJDAJvYaEDAQH/MAsMBG9kZWyhAwEB/zAVDARvc2duoAYMBHJzZWMwBaYDAgEB",
    ),
  );
  require(
    bytesEqual(leaf.extensions.get("2a864886f763640806") ?? [], acl),
    "enrollment macOS ACL",
  );
  require(statement.get("receipt")?.length > 0, "enrollment receipt");
  return { kid, point: leaf.point, expires: intermediate.notAfter };
}

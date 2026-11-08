import { reportData } from "./binding.mjs";
import {
  cat,
  checkAssertion,
  decodeAttestation,
  hex,
  rpcChain,
  sha256,
  unhex,
} from "./policy.mjs";
import { bytesEqual, decodeCbor, require } from "./encoding.mjs";
import { verifyEnrollment } from "./enrollment.mjs";
import { paidReceiptKey, paymentRunId } from "./payments.mjs";
import { monitorPolicy } from "./registry.mjs";
export { hex, unhex };
const enc = new TextEncoder(),
  dec = new TextDecoder("utf-8", { fatal: true }),
  subtle = crypto.subtle;
export const REGISTRY = "0xF7Bbd6DbB5708D3470940dcC19E2b2c75706ee8E";
export const ATTEST = "0xFF8393e6D4c3dF89e826A5BF14829733B953c948";
export const CANARY = "0xdC66c90291973167126a3c4455D5A6064634f3B1";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const eq = (a, b) => bytesEqual(a, b),
  hash = async (raw) => hex(await sha256(raw));
export function peerBytes(peer) {
  require(
    typeof peer === "string" && peer.length >= 32 && peer.length <= 100,
    "PeerId",
  );
  let n = 0n;
  for (const c of peer) {
    const d = alphabet.indexOf(c);
    require(d >= 0, "PeerId base58");
    n = n * 58n + BigInt(d);
  }
  let s = n.toString(16);
  if (s.length % 2) s = "0" + s;
  const b = cat(new Uint8Array(peer.match(/^1*/)[0].length), unhex(s));
  require(
    (b.length === 38 && hex(b.slice(0, 6)) === "002408011220") ||
      (b.length === 34 && hex(b.slice(0, 2)) === "1220"),
    "PeerId multihash",
  );
  return b;
}
function peerString(raw) {
  let n = BigInt("0x" + hex(raw)), s = "";
  while (n) {
    s = alphabet[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of raw) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
export async function createClient() {
  const key = await subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  const pub = new Uint8Array(await subtle.exportKey("raw", key.publicKey));
  return {
    peer: peerString(cat(unhex("002408011220"), pub)),
    privateKey: key.privateKey,
  };
}
async function rpc(rpcUrl, method, params) {
  const v = await jsonRequest(rpcUrl, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  require(!v.error && typeof v.result === "string", "RPC response");
  return v.result;
}
async function jsonRequest(url, body, signal, max = 48 << 20) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal,
  });
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    require(size <= max, "HTTP response size");
    chunks.push(value);
  }
  const value = JSON.parse(dec.decode(cat(...chunks)));
  if (!response.ok) {
    const message = typeof value.error === "string"
      ? value.error
      : value.error?.message ?? "HTTP " + response.status;
    throw Object.assign(new Error(message), {
      status: response.status,
      response: value,
    });
  }
  return value;
}
async function assertion(proof, policy, enrollment, minCounter = 0) {
  const a = await decodeAttestation(unhex(proof)),
    obj = decodeCbor(a.assertion),
    auth = obj.get("authenticatorData");
  require(eq(a.key_id, enrollment.kid), "node key is not enrolled Apple key");
  // Layover edit: no app ID or CDHash pin. The assertion's CDHash must be the registration's, and checkAssertion requires
  // CDRegistry to resolve it to the assertion's RP ID, which it does only for a copy of the approved build.
  const ext = decodeCbor(auth.slice(37));
  require(
    hex(ext.get("apple_cd_hash_hash_01")) === policy.cdhash,
    "assertion build",
  );
  const counter = new DataView(auth.buffer, auth.byteOffset).getUint32(33);
  require(counter > minCounter, "assertion counter replay");
  const chain = policy.chain ??
      rpcChain(policy.rpc, policy.attest ?? ATTEST, policy.canary ?? CANARY),
    key = await chain.key(a.key_id);
  require(
    eq(cat(key.x, key.y), enrollment.point.slice(1)),
    "chain enrollment key mismatch",
  );
  require([3, 6].includes(await chain.category()), "chain validation category");
  await checkAssertion(a, chain, Date.now());
  require(
    hex(a.caller) === await hash(enc.encode("node")),
    "Attest caller is not node",
  );
  require(
    hex(a.manifest_sha256) === policy.manifestHash &&
      hex(a.os_image_hash) === policy.image,
    "node measurements",
  );
  return { ...a, counter };
}
// On-chain mode: the key is the one the attestation names, read from AppleAttestRegistry, which admitted it only with
// an Apple-rooted attestation of an approved CDRegistry build. No per-device enrollment is pinned.
async function chainEnrollment(proof, chain) {
  const kid = (await decodeAttestation(unhex(proof))).key_id,
    key = await chain.key(kid);
  require(key.enrolled, "node key " + hex(kid) + " is not enrolled on chain");
  return { kid, point: cat(Uint8Array.of(4), key.x, key.y), expires: key.expires * 1000 };
}
// policy.manifest is the exact approved manifest bytes, selected independently of discovery. A paid node also needs
// policy.operatorsOf(kid): the operators whose MacLinks name the attesting key (owners.mjs brokerOwners).
export async function verifyNode(registration, policy) {
  require(
    policy.manifest instanceof Uint8Array &&
      /^[0-9a-f]{64}$/.test(registration.cdhash) &&
      /^[0-9a-f]{64}$/.test(policy.brokerKey),
    "node policy",
  );
  const manifest = JSON.parse(dec.decode(policy.manifest)),
    compose = JSON.parse(manifest.docker_compose_file),
    service = compose.services.node;
  require(
    service?.entrypoint?.join() === "/usr/local/bin/dsmack-compute" &&
      service.command?.[0] === "serve" &&
      service.command[4] === policy.brokerKey &&
      service.command[5] === registration.cdhash,
    "compose broker key/build",
  );
  const env = service.environment;
  const monitor = await monitorPolicy(env);
  require(
    service.command[6] === "/opt/compute-node/agent-mcp.mjs" &&
      env?.AGENT_MCP_SOCKET === "/run/dsmack/agent-mcp.sock" &&
      env.AGENT_MCP_VERSION === "2026-07-28" &&
      env.AGENT_PI_VERSION === "1.4.0" &&
      service.read_only === true &&
      service.security_profile === "agent-sandbox-v1" &&
      env.DSTACK_SOCKET === "/root/dstack.sock" &&
      service.volumes?.includes("/var/run/dstack.sock:/var/run/dstack.sock:ro") &&
      Number(env.AGENT_COMMAND_TIMEOUT_SECONDS) > 0 &&
      Number(env.AGENT_OUTPUT_CAP_BYTES) > 0 &&
      Array.isArray(JSON.parse(env.AGENT_NETWORK_ALLOWLIST || "null")),
    "compose agent tool server and runtime policy",
  );
  const resolved = {
    ...policy,
    cdhash: registration.cdhash,
    manifestHash: await hash(policy.manifest),
    image: manifest.base_vm.os_image_hash,
    agentEnvironment: env,
    monitor,
  };
  require(
    registration.kind === "compute" &&
      registration.manifest_sha256 === resolved.manifestHash &&
      registration.os_image_hash === resolved.image,
    "node registration measurements",
  );
  require(
    registration.relay_maddr.endsWith(
      "/p2p-circuit/p2p/" + registration.relay_peer,
    ),
    "node circuit target",
  );
  const peer = peerBytes(registration.relay_peer),
    secret = unhex(registration.secret_key),
    receipt = unhex(registration.receipt_key);
  require(secret.length === 64 && receipt.length === 32, "node key lengths");
  await subtle.importKey(
    "raw",
    cat(Uint8Array.of(4), secret),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  if (!policy.chain) {
    require(
      await rpc(policy.rpc, "eth_chainId", []) === "0x14a34",
      "Base Sepolia required",
    );
    const registry = await rpc(policy.rpc, "eth_call", [{
      to: policy.attest ?? ATTEST,
      data: "0xb4eb10ce",
    }, "latest"]);
    require(
      ("0x" + registry.slice(-40)).toLowerCase() ===
        (policy.registry ?? REGISTRY).toLowerCase(),
      "CDRegistry address",
    );
  }
  const enrollmentMode = policy.enrollmentMode ?? "on-chain";
  require(
    ["on-chain", "apple-root"].includes(enrollmentMode),
    "enrollment mode",
  );
  const enrollment = enrollmentMode === "apple-root"
    ? await verifyEnrollment(policy.enrollment, resolved.cdhash)
    : await chainEnrollment(
      registration.proof ?? registration.attestation,
      policy.chain ??
        rpcChain(policy.rpc, policy.attest ?? ATTEST, policy.canary ?? CANARY),
    );
  if (enrollmentMode === "apple-root") {
    const base = policy.chain ??
      rpcChain(policy.rpc, policy.attest ?? ATTEST, policy.canary ?? CANARY);
    resolved.chain = {
      ...base,
      key: async (kid) => {
        require(eq(kid, enrollment.kid), "unknown Apple enrollment");
        return {
          x: enrollment.point.slice(1, 33),
          y: enrollment.point.slice(33),
          expires: enrollment.expires / 1000,
          counter: 0,
          enrolled: true,
        };
      },
    };
  }
  const a = await assertion(
    registration.proof ?? registration.attestation,
    resolved,
    enrollment,
  );
  let receiptKeys = receipt, challenge = new Uint8Array(32);
  if (registration.payments) {
    const p = registration.payments;
    require(
      policy.challenge && p.challenge === policy.challenge &&
        /^[0-9a-f]{64}$/.test(p.challenge),
      "fresh node challenge",
    );
    // The manifest names no Mac key: the run binds to the attesting key, which must be linked to the payee.
    const kid = "0x" + hex(enrollment.kid);
    require(
      p.runId.toLowerCase() === paymentRunId(kid, p.runNonce).toLowerCase(),
      "payment run is not bound to the attesting key",
    );
    require(
      (await policy.operatorsOf(kid)).includes(p.operator.toLowerCase()),
      "node key " + kid + " has no MacLink to payment operator " + p.operator,
    );
    require(
      p.grantSigner.toLowerCase() === policy.grantSigner?.toLowerCase(),
      "payment grant signer",
    );
    require(p.runExpires > Math.floor(Date.now() / 1000), "node run expired");
    const chain = policy.chain ??
      rpcChain(policy.rpc, policy.attest ?? ATTEST, policy.canary ?? CANARY);
    require(
      p.buildId.toLowerCase() === "0x" + hex(await chain.buildId()),
      "payment build",
    );
    receiptKeys = cat(receipt, paidReceiptKey(p));
    challenge = unhex(p.challenge);
  }
  const expected = await reportData(peer, secret, receiptKeys, challenge);
  require(eq(a.report_data, expected), "node PeerId/secret/receipt binding");
  return {
    registration,
    policy: resolved,
    enrollment,
    enrollmentMode,
    attestation: a,
    run: hex(a.run),
    head: hex(a.head),
    counter: a.counter,
  };
}

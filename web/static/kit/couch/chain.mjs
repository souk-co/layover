// Base Sepolia reads through layover-chain, which answers only what its Helios light client verified. Same interface as
// dsmack's rpcChain (dsmack/policy.mjs), which reads through an unverified public RPC. The site (web/verify.ts) imports this
// file from its kit mirror, so the kit and the site look keys up the same way.
import { decodeAttestation, hex, unhex } from "./dsmack/policy.mjs";

export const CHAIN_READ = "https://pod.dstack.soc1024.com/layover-chain";

// attest: AppleAttestRegistryV1 (keys, cds, validationCategory); canary: Canary; registry: the CDRegistry attest must name.
// A read with no answer in CALL_TIMEOUT_MS fails, naming the call (layover-chain answers one in ~5-20 s).
export const CALL_TIMEOUT_MS = 60000;
export function heliosChain({ attest, canary, registry }, base = CHAIN_READ, { signal } = {}) {
  const call = async (to, data) => {
    const what = `layover-chain call ${to} ${data.slice(0, 10)}`;
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const r = await fetch(`${base}/call?to=${to}&data=${data}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      .catch((e) => { throw new Error(`${what}: ${signal?.aborted ? signal.reason?.message ?? "request cancelled" : e.name === "TimeoutError" ? `no answer in ${CALL_TIMEOUT_MS / 1000} s` : e.message}`); });
    const j = await r.json();
    if (!r.ok || j.verified_by !== "helios-opstack") throw new Error(`layover-chain call ${to} ${data.slice(0, 10)}: HTTP ${r.status} ${j.error ?? ""}`);
    return unhex(j.result.slice(2));
  };
  const w = (b, k) => b.subarray(32 * k, 32 * k + 32), int = (b) => BigInt("0x" + hex(b));
  let cds;
  const reg = () => cds ??= call(attest, "0xb4eb10ce").then((b) => {
    const a = "0x" + hex(b.slice(-20));
    if (a !== registry.toLowerCase()) throw new Error(`refused: ${attest} reads CDRegistry ${a}, not ${registry}`);
    return a;
  });
  return {
    key: async (kid) => { const b = await call(attest, "0xdde5b7a1" + hex(kid)); return { x: w(b, 0), y: w(b, 1), expires: Number(int(w(b, 2))), counter: Number(int(w(b, 3))), enrolled: int(w(b, 4)) === 1n }; },
    category: async () => Number(int(await call(attest, "0x5523509a"))),
    rpIdHash: async (cdhash) => call(await reg(), "0x65f4df9c" + hex(cdhash)),
    buildId: async () => call(await reg(), "0xb7b014b6"),
    burnedImage: async (image) => int(await call(canary, "0xe62b7cbd" + hex(image))) === 1n,
    burnedBuild: async (build) => int(await call(canary, "0xda746951" + hex(build))) === 1n,
  };
}

// One challenged assertion only: share its reads with the unchanged verifier, never with another attempt.
// Registry lookup still gates rpIdHash/buildId; burnedBuild depends on that verified buildId.
export async function prewarmChain(registration, policy, { base = CHAIN_READ, signal } = {}) {
  const abort = new AbortController();
  const deadline = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const shared = AbortSignal.any([abort.signal, deadline, ...(signal ? [signal] : [])]);
  const assertion = await decodeAttestation(unhex(registration.proof ?? registration.attestation));
  if (!/^[0-9a-f]{64}$/.test(registration.cdhash)) throw new Error("registration cdhash");
  shared.throwIfAborted();
  let raw = heliosChain(policy, base, { signal: shared }), closed = false, disposed;
  const reads = new Map();
  const chain = Object.fromEntries(Object.keys(raw).map(name => [name, (...args) => {
    if (closed) return Promise.reject(new Error("verification attempt is closed"));
    if (shared.aborted) return Promise.reject(shared.reason);
    const key = name + ":" + args.map(hex).join(":");
    if (!reads.has(key)) reads.set(key, Promise.resolve().then(() => raw[name](...args)));
    return reads.get(key);
  }]));
  const tasks = [chain.key(assertion.key_id), chain.category(), chain.rpIdHash(unhex(registration.cdhash)),
    chain.buildId().then(build => chain.burnedBuild(build)), chain.burnedImage(assertion.os_image_hash)];
  const dispose = reason => disposed ??= (async () => {
    closed = true;
    abort.abort(reason);
    // Cancel and settle every started/dependent read before discarding this assertion's history.
    await Promise.allSettled(tasks);
    await Promise.allSettled(reads.values());
    reads.clear(); tasks.length = 0; raw = null;
  })();
  try {
    await Promise.all(tasks);
    shared.throwIfAborted();
    return { chain, signal: shared, dispose };
  } catch (error) {
    await dispose(error);
    throw error;
  }
}

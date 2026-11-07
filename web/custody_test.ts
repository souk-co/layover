// deno test -A --no-check web/custody_test.ts
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { Wallet } from "https://raw.githubusercontent.com/amiller/dsmack/0213e04df5bc58bf71882b34a673e53a9a6f3fa0/applications/compute-node/browser/vendor/ethers-6.17.0.mjs";
import { custodySite } from "./custody.ts";
import { DOMAIN, linkedOperator } from "./owners.ts";

// A stand-in verifier: the attestation hex is "<key_id>ff<manifest>"; every check passes. owner: runner key -> linked operators.
const allow = { manifests: ["22".repeat(32)], os_image_hashes: ["11".repeat(32)] };
const verify = async (att: string) => {
  const [key_id, manifest_sha256] = att.split("ff");
  return { ok: true, checks: [], facts: { key_id, manifest_sha256, os_image_hash: "11".repeat(32), run: "33".repeat(32) } };
};
const links: Record<string, string[]> = { ["aa".repeat(32)]: ["0xop1"], ["a2".repeat(32)]: ["0xop1"], ["bb".repeat(32)]: ["0xop2"], ["dd".repeat(32)]: ["0xop1", "0xop2"] };
const owner = async (kid: string) => links[kid] ?? [];
const client = (site: ReturnType<typeof custodySite>, dataDir: string) => ({
  release: async (agent: string, key: string, manifest = "22".repeat(32)) => {
    const r = await site(new Request(`http://x/api/custody/${agent}/release`, { method: "POST",
      body: JSON.stringify({ head: null, eph_pub: "55".repeat(32), attestation: key + "ff" + manifest }) }), { dataDir });
    return [r.status, (await r.json()).error ?? null];
  },
  get: async (agent: string) => await (await site(new Request(`http://x/api/custody/${agent}`), { dataDir })).json(),
});

Deno.test("custody binds an agent id to the operator of its first runner key; a rotated key of that operator takes over with no custody change", async () => {
  const dataDir = await Deno.makeTempDir(), { release, get } = client(custodySite(verify, allow, owner), dataDir);
  assertEquals((await release("host-a", "aa".repeat(32)))[0], 200);
  assertEquals((await release("host-b", "bb".repeat(32)))[0], 200);
  assertEquals((await release("host-a", "a2".repeat(32)))[0], 200);
  assertEquals(await release("host-a", "bb".repeat(32)), [403, `runner key ${"bb".repeat(32)} is linked to operators [0xop2]; agent host-a is bound to 0xop1`]);
  assertEquals(await release("host-a", "cc".repeat(32)), [403, `runner key ${"cc".repeat(32)} is linked to operators []; agent host-a is bound to 0xop1`]);
  assertEquals((await release("host-c", "aa".repeat(32), "99".repeat(32)))[0], 403);
  assertEquals((await release("host-d", "dd".repeat(32)))[1], `runner key ${"dd".repeat(32)} is linked to operators [0xop1, 0xop2]; agent host-d is bound to no operator yet, and its first release needs a key linked to exactly one`);
  const a = await get("host-a");
  assertEquals([a.allowed, a.operator, a.events.map((e: { kind: string }) => e.kind)], [allow, "0xop1", ["release", "release", "refused", "refused"]]);
  assertEquals((await get("host-c")).operator, null);
});

Deno.test("an agent id bound to a runner key before operator binding needs custody.json operators", async () => {
  const dataDir = await Deno.makeTempDir();
  await Deno.writeTextFile(dataDir + "/custody.jsonl", JSON.stringify({ kind: "release", head: null, seq: 0, key_id: "aa".repeat(32), agent_id: "old" }) + "\n");
  const bare = client(custodySite(verify, allow, owner), dataDir);
  await assertRejects(() => bare.release("old", "a2".repeat(32)), Error, `agent old was bound to runner key ${"aa".repeat(32)} before custody bound operators`);
  const migrated = client(custodySite(verify, { ...allow, operators: { old: "0xOP1" } }, owner), dataDir);
  assertEquals((await migrated.release("old", "a2".repeat(32)))[0], 200);
  assertEquals((await migrated.release("old", "bb".repeat(32)))[0], 403);
  const g = await migrated.get("old");
  assertEquals([g.operator, g.allowed, g.events.at(-2).operator], ["0xop1", allow, "0xop1"]);
});

Deno.test("a MacLink names its operator only with valid publisher and operator (or authorized provisioner) signatures", async () => {
  const [publisher, operator, provisioner] = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const link = { kid: "0x" + "aa".repeat(32), publisher: publisher.address.toLowerCase(), operator: operator.address.toLowerCase(), nonce: "1" };
  const LINK = { MacLink: [{ name: "kid", type: "bytes32" }, { name: "publisher", type: "address" }, { name: "operator", type: "address" }, { name: "nonce", type: "uint64" }] };
  const AUTH = { ProvisioningAuthorization: [{ name: "operator", type: "address" }, { name: "provisioner", type: "address" }, { name: "nonce", type: "uint64" }] };
  const authorization = { operator: link.operator, provisioner: provisioner.address.toLowerCase(), nonce: "0" };
  const direct = { link, publisherSignature: await publisher.signTypedData(DOMAIN, LINK, link), operatorSignature: await operator.signTypedData(DOMAIN, LINK, link) };
  const delegated = { link, publisherSignature: direct.publisherSignature, provisionerSignature: await provisioner.signTypedData(DOMAIN, LINK, link),
    authorization: { authorization, signature: await operator.signTypedData(DOMAIN, AUTH, authorization) } };
  assertEquals([linkedOperator(direct, []), linkedOperator(delegated, [])], [link.operator, link.operator]);
  assertThrows(() => linkedOperator({ ...direct, operatorSignature: direct.publisherSignature }, []), Error, "operator signature");
  assertThrows(() => linkedOperator(delegated, [{ revocation: authorization }]), Error, "revoked");
  // The live link for the Mini's pre-brownout key 13dc6356 was signed on 2026-10-30 under escrow 0x9272...72F2; the broker
  // now serves it under 0x835A...67e6, where it does not verify.
  const live = JSON.parse(await Deno.readTextFile(new URL("./fixtures/maclink-13dc6356.json", import.meta.url)));
  assertThrows(() => linkedOperator(live, []), Error, "publisher signature");
});

const text = new TextEncoder(), subtle = crypto.subtle;
const hexBytes = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhexBytes = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
const derive = async (bytes: Uint8Array, info: string) => new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: text.encode(info) }, await subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]), 256));
async function commitBody(dataDir: string, agent: string, blob: string, prev: string | null = null) {
  const key = await derive(unhexBytes(await Deno.readTextFile(dataDir + "/custody-key")), "resip-custody/1 " + agent);
  const commit = await derive(key, "resip-state/1 commit");
  const head = hexBytes(await subtle.digest("SHA-256", unhexBytes(blob)));
  const canonical = JSON.stringify({ agent_id: agent, head, prev }); // sorted keys, as the custody protocol requires
  const mac = hexBytes(await subtle.sign("HMAC", await subtle.importKey("raw", commit, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), text.encode(canonical)));
  return { prev, blob, mac };
}
function gate() {
  let enter!: () => void, open!: () => void;
  const entered = new Promise<void>((resolve) => enter = resolve), waiting = new Promise<void>((resolve) => open = resolve);
  return { entered, open, block: () => { enter(); return waiting; } };
}
async function whileBlocked<T>(pending: Promise<T>): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([pending, new Promise<T>((_, reject) => timer = setTimeout(() => reject(new Error("another agent waited behind the blocked remote check")), 2000))]);
  } finally { clearTimeout(timer); }
}
const postCommit = (site: ReturnType<typeof custodySite>, dataDir: string, agent: string, body: unknown) => site(new Request(`http://x/api/custody/${agent}/commit`, { method: "POST", body: JSON.stringify(body) }), { dataDir });

for (const phase of ["verify", "owner"]) Deno.test(`custody: blocked ${phase} for agent A does not block agent B release or authenticated commit`, async () => {
  const dataDir = await Deno.makeTempDir(), blocked = gate(), aKey = "aa".repeat(32);
  const site = custodySite(async (att) => { if (phase === "verify" && att.startsWith(aKey)) await blocked.block(); return verify(att); }, allow,
    async (kid) => { if (phase === "owner" && kid === aKey) await blocked.block(); return owner(kid); });
  const { release, get } = client(site, dataDir);
  const a = release("host-a", aKey);
  await blocked.entered;
  let b: Promise<unknown> | undefined;
  try {
    b = release("host-b", "bb".repeat(32));
    assertEquals((await whileBlocked(b) as unknown[])[0], 200);
    const body = await commitBody(dataDir, "host-b", "abcd");
    assertEquals((await whileBlocked(postCommit(site, dataDir, "host-b", body))).status, 200);
    assertEquals((await get("host-b")).seq, 1);
  } finally {
    blocked.open(); await Promise.allSettled([a, b]);
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("custody: a release checked before a concurrent commit rechecks the current head inside CAS", async () => {
  const dataDir = await Deno.makeTempDir(), blocked = gate();
  let pause = false;
  const site = custodySite(async (att) => { if (pause) await blocked.block(); return verify(att); }, allow, owner);
  const { release, get } = client(site, dataDir);
  await release("host-a", "aa".repeat(32));
  pause = true;
  const stale = release("host-a", "aa".repeat(32));
  await blocked.entered;
  try {
    assertEquals((await whileBlocked(postCommit(site, dataDir, "host-a", await commitBody(dataDir, "host-a", "abcd")))).status, 200);
    blocked.open();
    assertEquals((await stale)[0], 409);
    assertEquals((await get("host-a")).seq, 1);
  } finally { blocked.open(); await stale; await Deno.remove(dataDir, { recursive: true }); }
});

Deno.test("custody: simultaneous first releases cannot change the operator bound by the winner", async () => {
  const dataDir = await Deno.makeTempDir(), blocked = gate(), aKey = "aa".repeat(32);
  const site = custodySite(async (att) => { if (att.startsWith(aKey)) await blocked.block(); return verify(att); }, allow, owner);
  const { release, get } = client(site, dataDir);
  const first = release("host", aKey);
  await blocked.entered;
  try {
    assertEquals((await whileBlocked(release("host", "bb".repeat(32))))[0], 200);
    blocked.open();
    assertEquals((await first)[0], 403);
    assertEquals((await get("host")).operator, "0xop2");
  } finally { blocked.open(); await first; await Deno.remove(dataDir, { recursive: true }); }
});

Deno.test("custody: concurrent same-agent commits keep one CAS winner and refuse replay", async () => {
  const dataDir = await Deno.makeTempDir(), site = custodySite(verify, allow, owner), { release, get } = client(site, dataDir);
  try {
    await release("host-a", "aa".repeat(32));
    const [a, b] = await Promise.all([commitBody(dataDir, "host-a", "abcd"), commitBody(dataDir, "host-a", "dcba")]);
    const results = await Promise.all([postCommit(site, dataDir, "host-a", a), postCommit(site, dataDir, "host-a", b)]);
    assertEquals(results.map((r) => r.status).sort(), [200, 409]);
    assertEquals((await postCommit(site, dataDir, "host-a", a)).status, 409);
    assertEquals((await get("host-a")).seq, 1);
  } finally { await Deno.remove(dataDir, { recursive: true }); }
});

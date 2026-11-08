import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { Wallet } from "npm:ethers@6.13.4/wallet";
import { verifyMessage } from "npm:ethers@6.13.4/hash";
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import { authorizeLease, backing, canonical, checkedBacking, checkedTerms, CHAIN, ESCROW, TOKEN, LEGACY_ESCROW } from "./lease_authorization.ts";
import { admissionSigner, userWallet } from "./server.ts";
import { Interface } from "npm:ethers@6.13.4/abi";

const operator = "0x" + "77".repeat(20);
const terms = { kind: "layover-terms/1", chain_id: 84532, escrow: ESCROW, token: TOKEN, thread: "thread-1", agent_id: "line-1",
  mode: "shared", domains: ["example.com"], category: "research", minutes: 5, operator, price_per_gb: 200, cap: "50000" };
const blockHash = "0x" + "55".repeat(32);
const snapshot = { verified_by: "helios-opstack", chain_id: 84532, escrow: ESCROW, block: 100, block_hash: blockHash, depth: 0, head_age_s: 1, block_timestamp: Math.floor(Date.now() / 1000),
  operator, cap: terms.cap, closed_at: "0", released: false, claimed: "0", balance: "50000", exposure: "50000" };
const key = async () => await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, "0")).join("");

Deno.test("admission constructs and seals its own wallet, scope and private client state; only service signer authenticates it", async () => {
  const guest = await key(), pub = hex(await crypto.subtle.exportKey("raw", guest.publicKey));
  const env = { ACCOUNTS_SEED: "12".repeat(32) }, user = await userWallet(env, "buyer@example.com"), signer = await admissionSigner(env);
  assert(user.address !== signer.address);
  const body = { site_account: "33".repeat(32), agent_id: terms.agent_id, terms: canonical(terms) };
  const result = await authorizeLease(body, user, signer, { agent: async () => ({ guest_escrow: ESCROW, enc_pub: pub, at: "2026-11-06T00:00:00Z", agent_run: "44".repeat(32) }), backing: async () => snapshot });
  assertEquals(verifyMessage(canonical(result.admission), result.signature), signer.address);
  assert(verifyMessage(canonical(result.admission), result.signature) !== user.address);
  assertEquals(result.admission.account, body.site_account);
  assertEquals(result.admission.wallet, user.address.toLowerCase());
  assertEquals(result.admission.terms_hash, checkedTerms(terms).hash);
  assertEquals(result.admission.expires_at - result.admission.issued_at, 120);
  assertEquals(result.private.use, "price_check");
  // Use the guest's existing Node X25519/HKDF/AES-GCM wire format, independently of the sealer.
  const priv = createPrivateKey({ key: { ...await crypto.subtle.exportKey("jwk", guest.privateKey) }, format: "jwk" });
  const epk = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(result.enc.epk, "hex").toString("base64url") }, format: "jwk" });
  const secret = diffieHellman({ privateKey: priv, publicKey: epk });
  const sealKey = hkdfSync("sha256", secret, Buffer.alloc(0), "resip-bounty/1", 32);
  const ciphertext = Buffer.from(result.enc.ct, "hex"), decipher = createDecipheriv("aes-256-gcm", new Uint8Array(sealKey), Buffer.from(result.enc.nonce, "hex"));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const opened = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString());
  const { reply_jwk, ...plain } = result.private;
  assertEquals(opened, plain);
  assertEquals(opened.buyer_wallet, user.address.toLowerCase());
  assertEquals(opened.escrow, ESCROW);
  const replyPub = await crypto.subtle.importKey("jwk", { kty: reply_jwk.kty!, crv: reply_jwk.crv!, x: reply_jwk.x! }, { name: "X25519" }, true, []);
  assertEquals(hex(await crypto.subtle.exportKey("raw", replyPub)), opened.reply_pub);
  assert(!JSON.stringify(result.admission).includes(opened.token));
  assert(!JSON.stringify(result.admission).includes(reply_jwk.d!));
});

Deno.test("admission rejects caller payment identity, arbitrary envelopes, expanded scope, malformed and noncanonical terms before sources", async () => {
  const wallet = new Wallet("0x" + "31".repeat(32)), signer = new Wallet("0x" + "32".repeat(32));
  let calls = 0;
  const sources = { agent: async () => { calls++; throw Error("should not reach source"); }, backing: async () => { calls++; throw Error("should not reach source"); } };
  const body = { site_account: "33".repeat(32), agent_id: terms.agent_id, terms };
  for (const extra of [{ enc: {} }, { buyer_wallet: operator }, { token: "aa".repeat(32) }, { task: "secret" }]) await assertRejects(() => authorizeLease({ ...body, ...extra }, wallet, signer, sources));
  for (const change of [{ mode: "exclusive" }, { category: "account" }, { minutes: 6 }, { chain_id: 1 }, { escrow: operator }, { token: operator },
    { cap: "0" }, { cap: "5000000000000000000000000" }, { domains: ["127.0.0.1"] }, { domains: ["example.com", "example.com"] }, { extra: 1 }]) {
    await assertRejects(() => authorizeLease({ ...body, terms: { ...terms, ...change } }, wallet, signer, sources));
  }
  await assertRejects(() => authorizeLease({ ...body, agent_id: "other" }, wallet, signer, sources));
  await assertRejects(() => authorizeLease({ ...body, terms: JSON.stringify(terms) }, wallet, signer, sources));
  assertEquals(calls, 0);
});

Deno.test("admission backing fails closed for wrong domain, unbacked, stale, closed, released or previously claimed terms", () => {
  assertEquals(checkedBacking(snapshot, terms), snapshot);
  for (const change of [{ verified_by: "rpc" }, { chain_id: 1 }, { escrow: operator }, { operator: ESCROW }, { cap: "49999" }, { closed_at: "1" },
    { released: true }, { claimed: "1" }, { balance: "49999" }, { exposure: "49999" }, { head_age_s: 61 }, { head_age_s: -16 }, { depth: 301 }, { block_hash: "0x00" }]) {
    assertThrows(() => checkedBacking({ ...snapshot, ...change }, terms));
  }
});

Deno.test("financial reads pin every call to one Helios block and reject inconsistent or stale replies", async () => {
  const saved = globalThis.fetch;
  const abi = new Interface(["function terms(address,bytes32) view returns (address,uint256,uint64,bool)", "function totalClaimed(address,bytes32) view returns (uint256)",
    "function balance(address) view returns (uint256)", "function exposure(address) view returns (uint256)", "function token() view returns (address)"]);
  const acceptedHash = checkedTerms(terms).hash;
  const buyer = "0x" + "22".repeat(20), calls: string[] = [];
  let tamper: Record<string, unknown> = {};
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    assertEquals(url.origin + url.pathname.split("/").slice(0, 2).join("/"), CHAIN);
    if (url.pathname.endsWith("/head")) return Promise.resolve(Response.json(snapshot));
    calls.push(url.search);
    assertEquals(url.searchParams.get("block"), blockHash);
    assertEquals(url.searchParams.get("to"), ESCROW);
    const tx = abi.parseTransaction({ data: url.searchParams.get("data")! })!;
    if (tx.name !== "token") assertEquals(tx.args[0], buyer);
    if (["terms", "totalClaimed"].includes(tx.name)) assertEquals(tx.args[1], acceptedHash);
    const values: Record<string, unknown[]> = { terms: [operator, 50000, 0, false], totalClaimed: [0], balance: [50000], exposure: [50000], token: [TOKEN] };
    return Promise.resolve(Response.json({ ...snapshot, to: ESCROW, result: abi.encodeFunctionResult(tx.name, values[tx.name]), ...tamper }));
  };
  try {
    const result = await backing(buyer, acceptedHash, terms);
    assertEquals(result.cap, "50000");
    assertEquals(calls.length, 5);
    for (const change of [{ block_hash: "0x" + "66".repeat(32) }, { block: 101 }, { to: operator }, { verified_by: "rpc" }, { head_age_s: 61 }, { result: "0x" }]) {
      tamper = change;
      await assertRejects(() => backing(buyer, acceptedHash, terms));
    }
  } finally { globalThis.fetch = saved; }
});


Deno.test("legacy and new host admissions keep terms, backing and sealed payment on the selected escrow", async () => {
  const guest = await key(), pub = hex(await crypto.subtle.exportKey("raw", guest.publicKey));
  const wallet = new Wallet("0x" + "31".repeat(32)), signer = new Wallet("0x" + "32".repeat(32));
  for (const escrow of [LEGACY_ESCROW, ESCROW]) {
    const selected = { ...terms, escrow }, body = { site_account: "33".repeat(32), agent_id: terms.agent_id, terms: selected };
    const agent = { enc_pub: pub, at: "2026-11-06T00:00:00Z", agent_run: "44".repeat(32), guest_escrow: escrow };
    const sources = { agent: async () => agent, backing: async (_w: string, _h: string, t: any) => { assertEquals(t.escrow, escrow); return { ...snapshot, escrow }; } };
    const result = await authorizeLease(body, wallet, signer, sources);
    assertEquals(result.admission.escrow, escrow);
    assertEquals(result.private.escrow, escrow);
    assertEquals(checkedBacking({ ...snapshot, escrow }, selected).escrow, escrow);
    await assertRejects(() => authorizeLease(body, wallet, signer, { ...sources, agent: async () => ({ ...agent, guest_escrow: escrow === ESCROW ? LEGACY_ESCROW : ESCROW }) }));
  }
});

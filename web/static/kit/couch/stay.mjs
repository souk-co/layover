// A couch stay: a wallet-paid session on an attested dsmack guest (a Mac slot), driven over MCP.
// Lifted from dsmack applications/private-agent-web (agent-tools.mjs, app.mjs discover/verify, credit.mjs).
import { readFile } from "node:fs/promises";
import { Client, parseJSONRPCMessage, serializeMessage } from "@modelcontextprotocol/client";
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { multiaddr } from "@multiformats/multiaddr";
import { Wallet } from "ethers";
import * as sandbox from "./dsmack/sandbox.mjs";
import { prewarmChain } from "./chain.mjs";
import { brokerOwners } from "./dsmack/owners.mjs";

export const BROKER = "https://pod.dstack.soc1024.com/relay-broker";
const TUNNELS = "https://pod.dstack.soc1024.com/private-agent/tunnels";
const MAX_FRAME = 8 * 1024 * 1024;
const enc = new TextEncoder();
const need = (ok, message) => { if (!ok) throw new Error(message); };
const hex = bytes => Buffer.from(bytes).toString("hex");
const canonical = o => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]])));

async function call(path, body) {
  const r = await fetch(BROKER + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`broker ${path} HTTP ${r.status}: ${text}`), { status: r.status, body: text });
  return JSON.parse(text);
}

// The approved guest build: dsmack's guest verifier and sandbox policy, vendored in ./dsmack from amiller/dsmack. Files are
// flattened from applications/compute-node/browser, applications/egress-policy/monitor, dstack-compat and
// applications/private-agent-web; the base vendoring is fb3e60ac (PR #80 head; the policy is from 4dbe8369), and sandbox.mjs,
// payments.mjs, owners.mjs and policy.mjs are from d064bf9a (dsmack #101, key-free manifest: on-chain key mode, run bound to
// the attesting key, MacLink check). The build the live fleet attests (dsmack main with #100 and #101 merged; compare
// manifest_sha256 at relay-broker/fleet) carries these files unchanged. The edits are the import paths, payments.mjs and owners.mjs
// importing ethers from the package (6.17.0, as dsmack vendors) instead of vendor/ethers-6.17.0.mjs, and Layover's own
// edit to sandbox.mjs (#120, in no dsmack commit): no app ID or CDHash pin; the runner CDHash comes from the registration.
// owners.mjs also accepts an optional request abort signal; its signature/domain/revocation checks are unchanged.
// The policy pins code, not a Mac: contracts, and the guest manifest with the runner CDHash (compose command[5]) and
// PAYMENTS_CONFIG's node and operator left empty; it names no App Attest key. The CDHash differs per Mac (each copy of the
// approved build is re-signed for its Mac); node and operator are the Mac's payment class and payee. guestManifest fills
// them from the registration; verifyNode then requires the attested manifest hash to equal the filled manifest's, the run
// to be bound to the key that signed the attestation, that key to be enrolled on chain, a verified MacLink from that key
// to the operator, and the CDHash to be one CDRegistry admits for the approved build (rpIdHash). Chain reads go through
// layover-chain (Helios). A Mac's key rotation changes none of this.
async function verifier() {
  const raw = JSON.parse(await readFile(new URL("./dsmack/sandbox-policy.json", import.meta.url), "utf8"));
  const escrow = JSON.parse(JSON.parse(JSON.parse(Buffer.from(raw.manifestTemplate, "hex").toString("utf8")).docker_compose_file)
    .services.node.environment.PAYMENTS_CONFIG).escrow;
  return { ...raw, operatorsOf: brokerOwners(BROKER + "/fleet/ownership", escrow) };
}
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object"
  ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}` : JSON.stringify(v);
export function guestManifest(templateHex, payments, cdhash) {
  const m = JSON.parse(Buffer.from(templateHex, "hex").toString("utf8")), compose = JSON.parse(m.docker_compose_file);
  const node = compose.services.node, env = node.environment, pay = JSON.parse(env.PAYMENTS_CONFIG);
  need(!("enrollmentKeyId" in pay) && pay.node === "" && pay.operator === "" && node.command[5] === "",
    "sandbox-policy manifestTemplate names no App Attest key and leaves the CDHash, node and operator empty");
  need(/^[0-9a-f]{64}$/.test(cdhash), "registration cdhash");
  node.command[5] = cdhash;
  env.PAYMENTS_CONFIG = canon({ ...pay, node: payments.node, operator: payments.operator });
  m.docker_compose_file = canon(compose);
  return enc.encode(canon(m));
}

// MCP 2026-07-28 over a libp2p stream, NDJSON framed (dsmack Libp2pMcpTransport).
class Libp2pMcpTransport {
  constructor(stream, iterator, initial) { Object.assign(this, { stream, iterator, initial }); }
  async start() { this.reading = this.read(); }
  async read() {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "", value = this.initial;
    try {
      for (;;) {
        pending += decoder.decode(value, { stream: true });
        need(enc.encode(pending).length <= MAX_FRAME, "Guest MCP message exceeds output cap.");
        let at;
        while ((at = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (line) this.onmessage?.(parseJSONRPCMessage(JSON.parse(line)));
        }
        const next = await this.iterator.next();
        if (next.done) break;
        value = next.value.subarray();
      }
    } catch (e) { if (!this.closed) this.onerror?.(e); }
    finally { this.closed = true; this.onclose?.(); }
  }
  async send(message) {
    need(!this.closed, "Guest connection has closed.");
    if (!this.stream.send(enc.encode(serializeMessage(message)))) await this.stream.onDrain();
  }
  async close() { if (this.closed) return; this.closed = true; await this.stream.close(); this.onclose?.(); }
}

// Length-prefixed JSON {job_id, grant}; the guest answers {status: "ready"} and then speaks MCP on the same stream.
async function admission(stream, lease) {
  const payload = enc.encode(JSON.stringify({ job_id: lease.sessionId, grant: lease.grant }));
  const frame = new Uint8Array(payload.length + 4);
  new DataView(frame.buffer).setUint32(0, payload.length);
  frame.set(payload, 4);
  stream.send(frame);
  const iterator = stream[Symbol.asyncIterator]();
  let pending = new Uint8Array();
  for (;;) {
    if (pending.length >= 4) {
      const size = new DataView(pending.buffer, pending.byteOffset).getUint32(0);
      need(size <= 65536, "Guest admission response exceeds limit.");
      if (pending.length >= size + 4) {
        const result = JSON.parse(new TextDecoder().decode(pending.subarray(4, size + 4)));
        const detail = typeof result.detail === "string" && result.detail ? ": " + result.detail.slice(0, 1024) : "";
        need(result.status === "ready", "Guest refused session: " + (result.error || result.status) + detail);
        return { iterator, initial: pending.slice(size + 4) };
      }
    }
    const next = await iterator.next();
    need(!next.done, "Guest closed before session admission.");
    const data = next.value.subarray(), joined = new Uint8Array(pending.length + data.length);
    joined.set(pending); joined.set(data, pending.length); pending = joined;
  }
}

export class Stay {
  constructor(walletKey) { this.wallet = new Wallet(walletKey); }
  async signed(action, fields = {}) {
    const body = { action, wallet: this.wallet.address, nonce: hex(crypto.getRandomValues(new Uint8Array(16))), issuedAt: Math.floor(Date.now() / 1000), ...fields };
    return { ...body, sig: await this.wallet.signMessage(canonical(body)) };
  }
  // The terms name a slot (publisher, slot_id); the slot's guest changes each run, so the live one is looked up here.
  // browse is how open the couch's browser is for this stay: {mode: "none" | "named" | "open", hosts}. The host's signed
  // policy bounds it and may price widening; omitted, the host's default applies. Package hosts are always reachable.
  async open({ publisher, slotId, conversationId, browse, maxSpendNanoUsd, operationId, expectedRateNanoUsdPerSecond }) {
    const capped = maxSpendNanoUsd !== undefined || operationId !== undefined;
    need(!capped || (typeof maxSpendNanoUsd === "string" && /^[1-9][0-9]{0,38}$/.test(maxSpendNanoUsd) &&
      typeof operationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)),
      "Spend cap needs positive decimal maxSpendNanoUsd and operationId UUID.");
    need(expectedRateNanoUsdPerSecond === undefined || (typeof expectedRateNanoUsdPerSecond === "string" && /^[1-9][0-9]{0,38}$/.test(expectedRateNanoUsdPerSecond)),
      "Expected rate must be a positive decimal nano-USD string.");
    need(browse === undefined || (browse && ["none", "named", "open"].includes(browse.mode) && Array.isArray(browse.hosts) &&
      browse.hosts.every(host => typeof host === "string") && (browse.mode === "named" || browse.hosts.length === 0)), "Invalid accepted browse scope.");
    need(!this.lease, "A stay is already open: " + this.lease?.sessionId);
    // The first `credit` call opens the wallet's broker account with the broker's starter credit.
    this.creditBefore = await call("/inference/credit", await this.signed("credit"));
    const nodes = await call("/nodes");
    const selected = nodes.find(n => n.kind === "compute" && n.available !== false &&
      n.placement?.publisher.toLowerCase() === publisher.toLowerCase() && n.placement.slot_id === slotId);
    need(selected, `Slot ${slotId} of ${publisher} has no available guest on the broker now.`);
    const policy = await verifier();
    try {
      // Verification can require several slow Helios reads. Finish it before reserving the broker's 90 s setup grant.
      const challenge = hex(crypto.getRandomValues(new Uint8Array(32)));
      const registration = await call(`/sandbox/nodes/${selected.relay_peer}/attestation?challenge=${challenge}`);
      need(registration.relay_peer === selected.relay_peer, "Guest attestation identifies a different peer.");
      const manifest = guestManifest(policy.manifestTemplate, registration.payments, registration.cdhash);
      const attempt = await prewarmChain(registration, policy);
      try {
        this.verified = await sandbox.verifyNode(registration, { ...policy, chain: attempt.chain,
          operatorsOf: kid => policy.operatorsOf(kid, attempt.signal), manifest, challenge });
        attempt.signal.throwIfAborted();
      } finally { await attempt.dispose(); }
      need(registration.payments?.challenge === challenge, "Stale guest attestation.");
      this.peer = await createLibp2p({ addresses: { listen: [] }, transports: [webSockets(), circuitRelayTransport()],
        connectionEncrypters: [noise()], streamMuxers: [yamux()], services: { identify: identify() } });
      const clientPeer = this.peer.peerId.toString();
      this.lease = await call("/agent/open", await this.signed("agent-open", { conversationId, client_peer: clientPeer, node_peer: selected.relay_peer, ...(browse ? { browse: { hosts: browse.hosts, mode: browse.mode } } : {}), ...(capped ? { maxSpendNanoUsd, operationId } : {}) }));
      need(!capped || (this.lease.maxSpendNanoUsd === maxSpendNanoUsd && this.lease.operationId === operationId &&
        this.lease.conversationId === conversationId && this.lease.active === true &&
        typeof this.lease.rateNanoUsdPerSecond === "string" && /^[1-9][0-9]*$/.test(this.lease.rateNanoUsdPerSecond) &&
        BigInt(this.lease.rateNanoUsdPerSecond) * 60n <= BigInt(maxSpendNanoUsd)),
        "Broker did not return the requested active session spend cap; refusing this stay.");
      need(expectedRateNanoUsdPerSecond === undefined || this.lease.rateNanoUsdPerSecond === expectedRateNanoUsdPerSecond,
        "Broker rate differs from the accepted quote; request and accept a new quote.");
      need(/^[0-9a-f]{32}$/.test(this.lease.browse?.token), "The broker returned no browse terms for this stay");
      need(browse === undefined || (this.lease.browse.mode === browse.mode && Array.isArray(this.lease.browse.hosts) &&
        JSON.stringify([...new Set(this.lease.browse.hosts)].sort()) === JSON.stringify([...new Set(browse.hosts)].sort())),
        "Broker browsing differs from the accepted quote; request and accept a new quote.");
      need(this.lease.placement?.slot_id === slotId && this.lease.placement.publisher.toLowerCase() === publisher.toLowerCase(),
        `The broker placed the stay on ${JSON.stringify(this.lease.placement)}, not the agreed slot.`);
      need(this.lease.grant?.relay_peer === registration.relay_peer && this.lease.grant.client_peer === clientPeer && this.lease.grant.grant_id === this.lease.sessionId,
        "The broker returned a grant for a different client or guest.");
      const node = this.lease.node, normalize = value => typeof value === "string" ? value.toLowerCase() : value;
      need(node?.relay_peer === registration.relay_peer && node.attestation?.run === this.verified.run &&
        ["manifest_sha256", "os_image_hash", "cdhash", "secret_key", "receipt_key"].every(key => node[key] === registration[key]) &&
        ["node", "operator", "receiptSigner", "receiptPublicKey", "runId", "runNonce", "runExpires", "grantSigner", "buildId"]
          .every(key => normalize(node.payments?.[key]) === normalize(registration.payments[key])),
        "The guest changed between verification and reservation; refusing this stay.");
      this.client = await this.connect(registration);
      this.node = { relay_peer: registration.relay_peer, placement: this.lease.placement, run: this.verified.run,
        receiptSigner: registration.payments.receiptSigner, operator: registration.payments.operator, admit_until: registration.admit_until };
      const { token, ...browseTerms } = this.lease.browse;
      return { sessionId: this.lease.sessionId, node: this.node, environment: this.environment, tools: this.tools, browse: browseTerms,
        ...(capped ? { maxSpendNanoUsd, operationId } : {}),
        rateNanoUsdPerSecond: this.lease.rateNanoUsdPerSecond, seconds: this.lease.seconds, credit: this.lease.credit };
    } catch (e) {
      if (!this.lease) { await this.peer?.stop(); this.peer = null; this.verified = null; throw e; }
      // Never connected, so there is no guest receipt signer to settle against: end the grant and report its charge.
      const id = this.lease.sessionId;
      const view = await this.end().catch(c => { throw new AggregateError([e, c], `${e.message}; ending stay ${id} also failed: ${c.message}`); });
      e.message += `; stay ${id} was ended, ${BigInt(view.credit.spentNanoUsd) - BigInt(this.creditBefore.spentNanoUsd)} nano-USD charged`;
      throw e;
    }
  }
  async connect(registration) {
    // The circuit address is an untrusted hint; the Noise handshake binds the connection to the attested PeerId.
    const manifest = JSON.parse(new TextDecoder().decode(this.verified.policy.manifest));
    const relayPeer = JSON.parse(manifest.docker_compose_file).services.node.command[1].split("/").at(-1);
    const tunnels = (await (await fetch(TUNNELS)).json()).filter(t => t.relayPeer === relayPeer && t.expiresAt * 1000 > Date.now());
    need(tunnels.length, "No live relay tunnel advertises the approved relay.");
    const host = new URL(tunnels[0].url).hostname;
    const connection = await this.peer.dial(multiaddr(`/dns4/${host}/tcp/443/wss/p2p/${relayPeer}/p2p-circuit/p2p/${registration.relay_peer}`), { signal: AbortSignal.timeout(20000) });
    need(connection.remotePeer.toString() === registration.relay_peer, "Noise peer differs from the attested guest.");
    const stream = await connection.newStream("/dsmack/agent-mcp/1.0.0", { runOnLimitedConnection: true, signal: AbortSignal.timeout(30000) });
    stream.inactivityTimeout = Math.max(330000, this.lease.seconds * 1000 + 15000);
    const framed = await admission(stream, this.lease);
    const client = new Client({ name: "layover-couch", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } }, supportedProtocolVersions: ["2026-07-28"] });
    await client.connect(new Libp2pMcpTransport(stream, framed.iterator, framed.initial));
    this.tools = (await client.listTools()).tools;
    this.environment = JSON.parse((await client.readResource({ uri: "dsmack://environment" })).contents[0].text);
    return client;
  }
  async tool(name, args) {
    need(this.client, "No stay is open. Call stay_open first.");
    // The guest hands the token to the Mac's proxy, which asks the broker which sites this stay may reach.
    return this.client.callTool({ name, arguments: args, _meta: { "dsmack/browse": this.lease.browse.token } }, { timeout: (this.environment.commandTimeoutSeconds + 15) * 1000 });
  }
  async status() {
    need(this.lease, "No stay is open.");
    return call("/agent/status", await this.signed("agent-status", { sessionId: this.lease.sessionId }));
  }
  async summary() {
    const v = await this.status();
    return { sessionId: v.sessionId, active: v.active, relay_peer: v.node.relay_peer, placement: v.placement, guestSeconds: v.guestSeconds,
      activeBudgetSeconds: v.activeBudgetSeconds, handoverAt: new Date(v.handoverAt * 1000).toISOString(),
      idleTimeoutSeconds: this.environment.idleTimeoutSeconds, rateNanoUsdPerSecond: v.rateNanoUsdPerSecond, remainingNanoUsd: v.credit.remainingNanoUsd };
  }
  // Ends the grant, then waits for the guest's final signed receipt to reach the broker (the view stops being active).
  async end() {
    need(this.lease, "No stay is open.");
    let view;
    try { view = await call("/agent/end", await this.signed("agent-end", { sessionId: this.lease.sessionId })); }
    finally {
      await this.client?.close(); this.client = null;
      await this.peer?.stop(); this.peer = null;
    }
    for (let i = 0; (view.active || view.usageUnresolved) && i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      view = await this.status();
    }
    need(!view.active && !view.usageUnresolved, `Stay ${this.lease.sessionId} is still sealing after 120 s; check stay_status later.`);
    this.lease = null; this.node = null;
    return view;
  }
  async close() {
    const node = this.node, before = this.creditBefore;
    need(node, "No stay is open.");
    return settlement(await this.end(), node, before);
  }
}

// The broker's final view of the stay. It debits max(60, guestSeconds) × rate from the wallet on the guest's signed
// receipts; chargedNanoUsd is the wallet's ledger delta over the stay (one stay per wallet at a time).
export function settlement(view, node, before) {
  return { sessionId: view.sessionId, relay_peer: view.node.relay_peer, placement: view.placement, guestSeconds: view.guestSeconds,
    rateNanoUsdPerSecond: view.rateNanoUsdPerSecond, browse: view.browse && { mode: view.browse.mode, hosts: view.browse.hosts, nanoUsdPerSecond: view.browse.nanoUsdPerSecond },
    chargedNanoUsd: String(BigInt(view.credit.spentNanoUsd) - BigInt(before.spentNanoUsd)),
    closedReason: view.closedReason, receiptSigner: node.receiptSigner, operator: node.operator, wallet: view.credit.wallet };
}

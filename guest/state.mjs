// Sealed state across runs (custody, web/custody.ts on branch web, holds the key and the head). A run proves with /v1/Attest that
// it is the measured workload asking to start from the current head; custody seals the state key to a fresh X25519 key
// bound into that report_data. The run commits each changed state by compare-and-swap on the head, so a run started
// from an older head never gets the key, and a forked run's next commit is refused and it exits.
import crypto from "node:crypto";
import { AGENT_ID, attest, canonical, env, hex, json, log, openSealed, sha256, x25519Raw } from "./core.mjs";

const CUSTODY = env("CUSTODY") + "/" + encodeURIComponent(AGENT_ID);
const hk = (k, info) => Buffer.from(crypto.hkdfSync("sha256", k, Buffer.alloc(0), info, 32));
const post = (path, body) => json(CUSTODY + path, { method: "POST", body: JSON.stringify(body) });

const existing = value => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.agent_id !== AGENT_ID || typeof value.head !== "string" || !/^[0-9a-f]{64}$/.test(value.head) || !Number.isSafeInteger(value.seq) || value.seq < 1)
    throw new Error("drain preflight requires an existing committed custody head and sequence");
  return { head: value.head, seq: value.seq };
};
export const custodySnapshot = async () => existing(await json(CUSTODY));
export const restoreExisting = () => restore({ requireExisting: true });
export async function restore({ requireExisting = false } = {}) {
  const metadata = await json(CUSTODY), { head } = metadata;
  if (requireExisting) existing(metadata);
  const eph = crypto.generateKeyPairSync("x25519"), eph_pub = hex(x25519Raw(eph.publicKey));
  const attestation = await attest(sha256(canonical({ kind: "resip-custody-release/1", agent_id: AGENT_ID, head, eph_pub })));
  const r = await post("/release", { head, eph_pub, attestation });
  if (r.head !== head) throw new Error(requireExisting ? "drain preflight custody release head changed" : `custody released head ${r.head}, not the requested ${head}`);
  if (requireExisting && r.seq !== metadata.seq) throw new Error("drain preflight custody release sequence changed");
  let key;
  try { key = Buffer.from(openSealed(eph.privateKey, r.key, "resip-custody/1 release").key, "hex"); }
  catch (error) { if (requireExisting) throw new Error("drain preflight could not open the state key"); throw error; }
  const c = { enc: hk(key, "resip-state/1 enc"), mac: hk(key, "resip-state/1 commit"), head, seq: r.seq, last: null, state: null };
  if (head === null) { log("custody: no state committed yet for", AGENT_ID, "- genesis"); return c; }
  const blob = Buffer.from(r.blob, "hex");
  if (hex(sha256(blob)) !== head) throw new Error("custody's blob does not hash to its head");
  const d = crypto.createDecipheriv("aes-256-gcm", c.enc, blob.subarray(0, 12));
  d.setAAD(Buffer.from(AGENT_ID)); d.setAuthTag(blob.subarray(-16));
  c.last = Buffer.concat([d.update(blob.subarray(12, -16)), d.final()]);
  try { c.state = JSON.parse(c.last); }
  catch (error) { if (requireExisting) throw new Error("drain preflight sealed state is not valid JSON"); throw error; }
  if (requireExisting && (!c.state || typeof c.state !== "object" || Array.isArray(c.state) || c.state.agent_id !== AGENT_ID))
    throw new Error("drain preflight sealed state owner/layout mismatch");
  if (c.state.agent_id !== AGENT_ID) throw new Error("restored state belongs to " + c.state.agent_id);
  if (requireExisting) {
    const latest = await custodySnapshot();
    if (latest.head !== head || latest.seq !== c.seq) throw new Error("drain preflight custody changed during restore");
  } else log("custody: restored seq", c.seq, "head", head);
  return c;
}

export async function commit(c, state) {
  const pt = Buffer.from(JSON.stringify(state));
  if (c.last?.equals(pt)) {
    const { head, seq } = await json(CUSTODY);
    if (head !== c.head) throw new Error(`custody is at seq ${seq} head ${head}, not this run's ${c.head}: another run continued this state; stopping`);
    return;
  }
  const nonce = crypto.randomBytes(12), e = crypto.createCipheriv("aes-256-gcm", c.enc, nonce);
  e.setAAD(Buffer.from(AGENT_ID));
  const blob = Buffer.concat([nonce, e.update(pt), e.final(), e.getAuthTag()]), head = hex(sha256(blob));
  const mac = crypto.createHmac("sha256", c.mac).update(canonical({ agent_id: AGENT_ID, prev: c.head, head })).digest("hex");
  const r = await post("/commit", { prev: c.head, blob: hex(blob), mac });
  Object.assign(c, { head, seq: r.seq, last: pt });
}

export const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const short = (s) => s ? esc(s.slice(0, 10)) + "…" : "";
export const cents = (n) => n === null || n === undefined ? "" : "$" + (n / 100).toFixed(2);

// Site ledger amounts are staging cents; shown as credits at 100 credits = $1.
export const credits = (c) => `${Math.round(c)} credits <span class="note">($${(c / 100).toFixed(2)})</span>`;

// GET /api/agents/{id}/probes; null while the site has no such route (404), any other failure throws.
export async function probes(agent_id) {
  const r = await fetch(`api/agents/${encodeURIComponent(agent_id)}/probes`);
  if (r.status === 404) return null;
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${j.error}`);
  return j;
}

export async function api(path, body) {
  const r = await fetch("api/" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${j.error}`);
  return j;
}

export function nav(on) {
  const pages = [["layover.html", "Layover"], ["index.html", "Buyer"], ["deals.html", "Deals"], ["supplier.html", "Supplier"], ["provider.html", "Provider"], ["public.html", "Public"], ["leases.html", "Leases"], ["dashboard.html", "Usage"], ["status.html", "Status"]];
  document.querySelector("nav").innerHTML = pages.map(([h, t]) => `<a href="${h}" class="${t === on ? "on" : ""}">${t}</a>`).join("") +
    `<span class="note">resip staging · real records only</span>`;
}

export function verdict(v) {
  if (!v) return "";
  return `<span class="${v.ok ? "ok" : "bad"}">${v.ok ? "verified on site" : "not verified on site"}</span> <span class="note">App Attest mode: ${esc(v.mode ?? "none")}</span>
  <details><summary>checks</summary><div class="box">${v.checks.map((c) =>
    `<div><span class="${c.ok ? "ok" : "bad"}">${c.ok ? "pass" : "fail"}</span> ${esc(c.name)}<div class="mono note">${esc(c.detail)}</div></div>`).join("")}
  <div class="note">run <span class="mono">${esc(v.facts.run)}</span><br>manifest <span class="mono">${esc(v.facts.manifest_sha256)}</span><br>os image <span class="mono">${esc(v.facts.os_image_hash)}</span><br>checked ${esc(v.checked_at)}</div></div></details>`;
}

export function fail(e) {
  document.querySelector("#err").textContent = String(e.message ?? e);
  throw e;
}

// X25519 ECDH, HKDF-SHA256 (empty salt, info "resip-bounty/1" for bounties and leases), AES-256-GCM with the tag appended; all hex.
export async function seal(encPub, plaintext, info = "resip-bounty/1") {
  const te = new TextEncoder(), s = crypto.subtle;
  const eph = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pub = await s.importKey("raw", unhex(encPub), { name: "X25519" }, false, []);
  const z = await s.deriveBits({ name: "X25519", public: pub }, eph.privateKey, 256);
  const ikm = await s.importKey("raw", z, "HKDF", false, ["deriveKey"]);
  const key = await s.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: te.encode(info) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await s.encrypt({ name: "AES-GCM", iv: nonce }, key, te.encode(plaintext));
  return { epk: hex(await s.exportKey("raw", eph.publicKey)), nonce: hex(nonce), ct: hex(ct) };
}
// The public lease form (server.ts publicLease) as table cells: window, coverage, vantage, statement.
export const leaseCells = (l) => {
  const w = l.window, c = l.ip_commitments, covered = l.periods.filter((p) => p.covered).length;
  return `<td class="mono">${w ? `${esc(w.start)} .. ${esc(w.end ?? w.term_end)}` : ""}</td>
    <td>${l.periods.length ? `${covered} of ${l.periods.length} periods covered` : ""}</td>
    <td>${c.checks} checks, ${c.count} IP commitment${c.count === 1 ? "" : "s"}${c.stable ? "" : ' <span class="bad">changed</span>'}</td>
    <td>${l.exclusive === null ? "" : l.exclusive ? "exclusive" : "shared"}${l.exclusive && l.statement_exclusive === false ? ' <span class="bad">statement: not exclusive</span>' : ""}${l.shared_with ? `, shared with ${l.shared_with} other lease${l.shared_with === 1 ? "" : "s"}` : ""}${l.verification ? verdict(l.verification) : ""}</td>`;
};

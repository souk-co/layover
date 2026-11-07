// The sim's stand-in for the webhost's per-project dstack GetKey socket (the broker's key.ts calls it). Keys are
// HMAC-SHA256(state/keys.json accounts_seed, "dstack-sim/" + path): throwaway, stable across restarts of one sim.
// deno run -A sim/dstack-sim.ts SOCKET
const seed = JSON.parse(Deno.readTextFileSync(Deno.env.get("SIM_STATE") + "/keys.json")).accounts_seed.replace(/^0x/, "");
const key = await crypto.subtle.importKey("raw", Uint8Array.from(seed.match(/../g)!, (h: string) => parseInt(h, 16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
try { Deno.removeSync(Deno.args[0]); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
Deno.serve({ path: Deno.args[0] }, async (req) => {
  if (new URL(req.url).pathname !== "/GetKey" || req.method !== "POST") return new Response("dstack-sim serves POST /GetKey only", { status: 404 });
  const { path } = await req.json();
  return Response.json({ key: hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("dstack-sim/" + path))), signature_chain: [] });
});

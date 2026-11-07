// TEST ONLY: unsigned fixture verification for the off-Mac site and buyer CLI.
// An import map selects this adapter explicitly; production verification is never changed.
const web = Deno.env.get("RESIP_TEST_WEB");
if (!web?.startsWith("/")) throw new Error("unsigned fixture verifier requires the isolated RESIP_TEST_WEB path");
// A query-distinct module URL bypasses the CLI's exact import-map override so protocol primitives stay identical.
const original = await import(new URL(web + "/verify.ts?unsigned-fixture-primitives", "file:///").href);
export const { agentBinding, binding, canonical, facts, hex, sha256, unhex } = original;
const { decodeAttestation } = await import("https://raw.githubusercontent.com/amiller/dsmack/0213e04df5bc58bf71882b34a673e53a9a6f3fa0/dstack-compat/secret-release/policy.mjs");
const manifests = ["22".repeat(32), "23".repeat(32)], image = "11".repeat(32), kid = "44".repeat(32);
// No live chain, owner or payment endpoint is consulted by this fixture verifier.
export const verify = async (att: string, data: Uint8Array, expect?: { run?: string; manifest_sha256: string }) => {
  const a = await decodeAttestation(unhex(att));
  const facts = { run: hex(a.run), manifest_sha256: hex(a.manifest_sha256), os_image_hash: hex(a.os_image_hash), key_id: hex(a.key_id) };
  const checks = [
    { name: "report_data binds", ok: hex(a.report_data) === hex(data), detail: "unsigned fixture document binding" },
    { name: "fixture measurement allowed", ok: manifests.includes(facts.manifest_sha256) && facts.os_image_hash === image && facts.key_id === kid, detail: "test image, manifest and runner only" },
  ];
  if (expect) checks.push({ name: "same manifest/run as registration", ok: facts.manifest_sha256 === expect.manifest_sha256 && (!expect.run || facts.run === expect.run), detail: "test registration binding" });
  return { ok: checks.every((c) => c.ok), mode: "unsigned-test-fixture", facts, checks, checked_at: new Date().toISOString() };
};

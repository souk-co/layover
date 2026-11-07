// RESIP_TEST_WEB=/absolute/web deno test -A --no-check --node-modules-dir=none guest/test/verify_test.ts
import { verify, hex, unhex } from "./verify.ts";
import { decodeAttestation } from "https://raw.githubusercontent.com/amiller/dsmack/0213e04df5bc58bf71882b34a673e53a9a6f3fa0/dstack-compat/secret-release/policy.mjs";
const web = Deno.env.get("RESIP_TEST_WEB")!;
const att = (await Deno.readTextFile(web + "/server_test.ts")).match(/const att = "([0-9a-f]+)"/)![1];
const a = await decodeAttestation(unhex(att));
const must = (ok: unknown) => { if (!ok) throw new Error("unsigned test adapter skipped a protocol binding"); };
Deno.test("unsigned fixture adapter preserves report-data, image, manifest, key and expected run checks", async () => {
  const good = await verify(att, a.report_data);
  must(good.ok && good.mode === "unsigned-test-fixture");
  must(!(await verify(att, new Uint8Array(64))).ok);
  must(!(await verify(att, a.report_data, { manifest_sha256: "99".repeat(32) })).ok);
  must(!(await verify(att, a.report_data, { manifest_sha256: hex(a.manifest_sha256), run: "99".repeat(32) })).ok);
  for (const value of ["11", "22", "44"]) {
    must(!(await verify(att.replace(value.repeat(32), "66".repeat(32)), a.report_data)).ok);
  }
});

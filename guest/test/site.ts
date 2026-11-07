// TEST ONLY: actual site/custody over explicit unsigned fixture verification and owner linkage.
// Production verify.ts, owners.ts and custody policy are unchanged.
//   RESIP_TEST_WEB=WEB_DIR deno run -A --no-check test/site.ts WEB_DIR PORT DATA_DIR
const [web, port, dataDir] = Deno.args;
const { handler, configure } = await import(web + "/server.ts"), { custodySite } = await import(web + "/custody.ts");
const { verify } = await import("./verify.ts");
const kid = "44".repeat(32), operator = "0x" + "0e".repeat(20);
const owner = async (key: string) => key === kid ? [operator] : [];
configure({ verify, operators: owner, custody: `http://127.0.0.1:${port}/api/custody/` });
const custody = custodySite(verify, { manifests: ["22".repeat(32), "23".repeat(32)], os_image_hashes: ["11".repeat(32)] }, owner);
Deno.serve({ port: Number(port) }, (req) => (new URL(req.url).pathname.startsWith("/api/custody/") ? custody : handler)(req, { dataDir }));

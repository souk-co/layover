// deno test -A --no-check web/server_test.ts (verify.ts has pre-existing type errors)
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { BROKER_FLEET, CHAIN, CLAIMED, configure, ESCROW, GUEST_CLAIMED, GUEST_ESCROW, INDEX_MAX, LAYC, LOG_SPAN, handler, PROBE_EXPIRE_MS, SIGNUP_LIMITS, SOUK_ID, SOUK_URL } from "./server.ts";

Deno.test("a probe request unanswered for 10 minutes after filing is expired, pass false; a newer one stays open", async () => {
  const dataDir = await Deno.makeTempDir(), ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const rq = (id: string, at: string) => ({ kind: "probe_request", id, agent_id: "a", requested_by: "s", from: at, drand_round: 1, scheduled_at: at, forced: false, at });
  await Deno.writeTextFile(dataDir + "/records.jsonl", [rq("00000000-0000-0000-0000-000000000001", ago(PROBE_EXPIRE_MS + 1000)), rq("00000000-0000-0000-0000-000000000002", ago(PROBE_EXPIRE_MS - 60000))].map((r) => JSON.stringify(r) + "\n").join(""));
  const get = async (q: string) => await (await handler(new Request("http://x/api/" + q), { dataDir })).json();
  const [open, expired] = await get("agents/a/probes?limit=3");
  assertEquals([open.status, open.pass, open.error], ["open", null, null]);
  assertEquals([expired.status, expired.pass, expired.probe_id, expired.error], ["expired", false, null, "no probe report within 10 minutes"]);
  assertEquals(Date.parse(expired.done_at) - Date.parse(expired.filed_at), PROBE_EXPIRE_MS);
  assertEquals((await get("probe-requests?agent_id=a&status=open")).map((r: { id: string }) => r.id), [open.request_id]);
});

Deno.test("a registration is recorded only if it verifies and comes from a runner key linked to the operator custody binds the agent id to", async () => {
  const dataDir = await Deno.makeTempDir(), bound: Record<string, string | null> = { host: "0xop1", fresh: null, "test-x": null };
  const custody = Deno.serve({ port: 0, onListen() {} }, (req) => Response.json({ allowed: null, operator: bound[new URL(req.url).pathname.slice(1)] }));
  const links: Record<string, string[]> = { ["aa".repeat(32)]: ["0xop1"], ["a2".repeat(32)]: ["0xop1"], ["bb".repeat(32)]: ["0xop2"] };
  // A stand-in verifier: the attestation hex is "<01 verified | 00 not>ff<key_id>".
  configure({ custody: `http://127.0.0.1:${custody.addr.port}/`, operators: async (kid: string) => links[kid] ?? [], verify: (async (att: string) => {
    const [ok, key_id] = att.split("ff");
    return { ok: ok === "01", mode: null, facts: { key_id, manifest_sha256: "22".repeat(32), os_image_hash: "11".repeat(32), run: "33".repeat(32) },
      checks: [{ name: "App Attest", ok: ok === "01", detail: "stub" }], checked_at: "" };
  }) as never });
  const register = async (agent_id: string, attestation: string, dir = dataDir) => {
    const r = await handler(new Request("http://x/api/agents", { method: "POST", body: JSON.stringify({ agent_id, enc_pub: "77".repeat(32), attestation,
      coarse: { region: "r", isp_class: "c", residential: true } }) }), { dataDir: dir });
    return [r.status, (await r.json()).error ?? null];
  };
  assertEquals(await register("host", "00ff" + "aa".repeat(32)), [400, "registration attestation did not verify: App Attest (stub)"]);
  assertEquals(await register("host", "01ff" + "bb".repeat(32)), [409, `agent_id host is bound to operator 0xop1; runner key ${"bb".repeat(32)} is not linked to it`]);
  assertEquals((await register("fresh", "01ff" + "bb".repeat(32)))[0], 409);
  assertEquals(await Deno.readTextFile(dataDir + "/records.jsonl").catch(() => ""), "");
  assertEquals((await register("test-x", "00ff" + "cc".repeat(32)))[0], 200);
  // The operator's rotated key registers the same agent id.
  assertEquals((await register("host", "01ff" + "a2".repeat(32), await Deno.makeTempDir()))[0], 200);
  await custody.shutdown();
});

Deno.test("signup: invites the email with the doorman's credential, validates role, limits per email and per IP", async () => {
  const dataDir = await Deno.makeTempDir(), calls: { url: string; auth: string | null; body: any }[] = [];
  let reply = new Response(JSON.stringify({ event_id: 7 }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) });
    return reply.clone();
  }) as typeof fetch;
  const env = { SOUK_DOORMAN_CREDENTIAL: "doorman-token" };
  const signup = (body: unknown, ip: string, e: Record<string, string> = env) =>
    handler(new Request("http://x/api/signup", { method: "POST", headers: { "x-real-ip": ip }, body: JSON.stringify(body) }), { dataDir, env: e });
  try {
    const ok = await signup({ email: "new@example.com", role: "buyer" }, "ip-1");
    assertEquals(ok.status, 200);
    const out = await ok.json();
    assertEquals([out.invited, out.role, out.souk_id, out.event], ["new@example.com", "buyer", SOUK_ID, { event_id: 7 }]);
    assertEquals(out.next.includes("account.py login new@example.com`"), true, out.next);
    assertEquals(out.next.includes(".claude"), false, out.next);
    assertEquals(calls, [{ url: SOUK_URL + "/api/souk_invite", auth: "Bearer doorman-token", body: { souk_id: SOUK_ID, email_or_person: "new@example.com", roles: ["buyer"] } }]);
    assertEquals((await (await signup({ email: "h@example.com", role: "host" }, "ip-1")).json()).role, "host");
    assertEquals(calls.at(-1)!.body.roles, ["host"]);

    for (const bad of [{ email: "x@example.com", role: "arbiter" }, { email: "x@example.com" }, { email: "not-an-email", role: "buyer" }]) {
      const r = await signup(bad, "ip-2");
      assertEquals(r.status, 400);
    }
    assertEquals(calls.length, 2);
    await assertRejects(() => signup({ email: "x@example.com", role: "buyer" }, "ip-2", {}), Error, "SOUK_DOORMAN_CREDENTIAL");

    for (let i = 1; i < SIGNUP_LIMITS.email.n; i++) assertEquals((await signup({ email: "New@example.com", role: "buyer" }, "ip-3")).status, 200);
    const byEmail = await signup({ email: "new@example.com", role: "buyer" }, "ip-4");
    assertEquals([byEmail.status, (await byEmail.json()).error.startsWith("signup limit")], [429, true]);

    for (let i = 0; i < SIGNUP_LIMITS.ip.n; i++) assertEquals((await signup({ email: `p${i}@example.com`, role: "buyer" }, "ip-5")).status, 200);
    assertEquals((await signup({ email: "late@example.com", role: "buyer" }, "ip-5")).status, 429);
    assertEquals((await signup({ email: "late@example.com", role: "buyer" }, "ip-6")).status, 200);

    reply = new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 });
    const up = await signup({ email: "u@example.com", role: "buyer" }, "ip-7");
    assertEquals([up.status, (await up.json()).error], [502, 'souk invite failed (401): {"error":"Not signed in"}']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("a declined bounty's statement is pushed to the souk as the doorman's statement message; a failed push is logged, the decision stands", async () => {
  const dataDir = await Deno.makeTempDir(), id = "00000000-0000-4000-8000-0000000000b1", calls: { url: string; auth: string | null; body: any }[] = [], errors: string[] = [];
  await Deno.writeTextFile(dataDir + "/records.jsonl", JSON.stringify({ kind: "bounty", id, agent_id: "a", buyer_key: "thread-9", at: new Date().toISOString() }) + "\n");
  let reply = new Response("{}");
  const realFetch = globalThis.fetch, realError = console.error;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) });
    return reply.clone();
  }) as typeof fetch;
  console.error = (m: string) => errors.push(m);
  const decide = (e: Record<string, string>) => handler(new Request(`http://x/api/bounties/${id}/decision`, { method: "POST", body: JSON.stringify({ decision: "decline", reason: "busy" }) }), { dataDir, env: e });
  try {
    await assertRejects(() => decide({}), Error, "SOUK_DOORMAN_CREDENTIAL");
    reply = new Response("souk down", { status: 503 });
    assertEquals((await decide({ SOUK_DOORMAN_CREDENTIAL: "doorman-token" })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const [call] = calls, st = JSON.parse(call.body.text);
    assertEquals([call.url, call.auth, call.body.souk_id, call.body.kind], [SOUK_URL + "/api/souk_send", "Bearer doorman-token", SOUK_ID, "statement"]);
    assertEquals([st.bounty_id, st.buyer_key, st.status, st.agent_id], [id, "thread-9", "declined", "a"]);
    assertEquals(errors, [`souk: push of bounty ${id} failed (503): souk down`]);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});

Deno.test("kit: the Layover skill, its line client under both names, and the couch client files are served", async () => {
  const dataDir = await Deno.makeTempDir(), get = (p: string) => handler(new Request("http://x" + p), { dataDir });
  assertEquals((await (await get("/kit/")).text()).startsWith("Layover"), true);
  assertEquals((await (await get("/kit/SKILL.md")).text()).includes("name: layover"), true);
  for (const f of ["couch/SKILL.md", "couch/mcp.mjs", "couch/stay.mjs", "couch/tools.json", "couch/package.json", "couch/package-lock.json", "couch/dsmack/sandbox.mjs", "couch/dsmack/sandbox-policy.json", "souk.py", "account.py", "feed.py"]) {
    assertEquals((await get("/kit/" + f)).status, 200, f);
  }
  // resip.js is bundled into the deploy by deploy.py; a stand-in checks layover.js serves the same file.
  const js = new URL("./static/kit/resip.js", import.meta.url);
  await Deno.writeTextFile(js, "// line client");
  try {
    assertEquals([await (await get("/kit/layover.js")).text(), await (await get("/kit/resip.js")).text()], ["// line client", "// line client"]);
  } finally {
    await Deno.remove(js);
  }
  assertEquals((await get("/kit/__pycache__/souk.cpython-310.pyc")).status, 404);
});

Deno.test("kit: every file under static/kit is served", async () => {
  const dataDir = await Deno.makeTempDir(), root = new URL("./static/kit/", import.meta.url).pathname;
  const walk = async (d: string): Promise<string[]> =>
    (await Promise.all((await Array.fromAsync(Deno.readDir(root + d))).map((e) => e.isDirectory ? walk(d + e.name + "/") : [d + e.name]))).flat();
  for (const f of (await walk("")).filter((f) => !f.includes("__pycache__/"))) {
    assertEquals((await handler(new Request("http://x/kit/" + f), { dataDir })).status, 200, f);
  }
});

Deno.test("kit: SKILL.md's couch download lists name every file under static/kit/couch", async () => {
  const root = new URL("./static/kit/", import.meta.url).pathname, skill = await Deno.readTextFile(root + "SKILL.md");
  const listed = [...skill.matchAll(/kit\/(couch\/(?:dsmack\/)?)\{([^}]+)\}/g)].flatMap((m) => m[2].split(",").map((f) => m[1] + f));
  const walk = async (d: string): Promise<string[]> =>
    (await Promise.all((await Array.fromAsync(Deno.readDir(root + d))).map((e) => e.isDirectory ? walk(d + e.name + "/") : [d + e.name]))).flat();
  assertEquals(new Set(listed), new Set(await walk("couch/")));
});

Deno.test("couch-slots is the broker's /fleet as one small row per slot", async () => {
  const fleet = await (await fetch(BROKER_FLEET)).text();
  const real = globalThis.fetch;
  globalThis.fetch = (u) => { assertEquals(String(u), BROKER_FLEET); return Promise.resolve(new Response(fleet)); };
  try {
    const res = await handler(new Request("http://x/api/couch-slots"), { dataDir: await Deno.makeTempDir() });
    const body = await res.text(), slots = JSON.parse(body), macs = JSON.parse(fleet);
    assertEquals(slots.length, macs.reduce((n: number, m: { slots: unknown[] }) => n + m.slots.length, 0));
    assertEquals(Object.keys(slots[0]), ["publisher", "chip", "online", "updated_at", "vcpus", "mem_mib", "browse", "slot_id", "state", "unreachable", "last_error_code", "run_id", "verified", "handoverAt", "started_at", "jobs_served", "online_share"]);
    const s = macs[0].slots[0];
    assertEquals([slots[0].slot_id, slots[0].run_id, slots[0].handoverAt, slots[0].verified], [s.slot_id, s.run_id, s.attestation?.admit_until ?? null, s.attestation?.attestation?.status === "verified"]);
    // started_at (slot run start) and jobs_served (stays served) pass through so supply has timestamps and stay counts.
    assertEquals([slots[0].started_at, slots[0].jobs_served], [s.started_at ?? null, s.jobs_served ?? null]);
    // The host's posted browse policy and surcharge, which the amin checks a stay's rate against.
    const b = macs[0].config.browse;
    assertEquals(slots[0].browse, b ? { default: b.default, open: Number(b.price.open_nano_usd_per_second), named: Number(b.price.named_host_nano_usd_per_second) } : null);
    assertEquals(body.includes(macs[0].hardware.name), false);
    console.log(`fleet ${fleet.length} B -> couch-slots ${body.length} B`);
    if (body.length > 4096) throw new Error(`couch-slots is ${body.length} B`);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("couch-slots does not offer a slot whose last relay hop the broker was refused", async () => {
  const slot = (unreachable?: Record<string, unknown>) => ({ slot_id: 0, state: "ready", attestation: { attestation: { status: "verified" }, ...(unreachable ? { unreachable } : {}) } });
  const fleet = [{ publisher: "0xp", hardware: { chip: "M4", name: "mini" }, online: true, updated_at: 1, config: { guest: { vcpus: 1, mem_mib: 4096 } },
    slots: [slot(), slot({ at: 1, error: "failed to connect via relay with status RESOURCE_LIMIT_EXCEEDED" })] }];
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify(fleet)));
  try {
    const slots = await (await handler(new Request("http://x/api/couch-slots"), { dataDir: await Deno.makeTempDir() })).json();
    assertEquals(slots.map((s: Record<string, any>) => [s.state, s.unreachable?.at ?? null]), [["ready", null], ["unreachable", 1]]);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("couch-slots counts, per publisher, the /fleet reads that found it online since this process started", async () => {
  let online = true;
  const fleet = () => [{ publisher: "0xlaptop", hardware: { chip: "M3" }, online, updated_at: 1, config: { guest: { vcpus: 1, mem_mib: 4096 } }, slots: [{ slot_id: 0, state: "ready" }] }];
  const real = globalThis.fetch, read = async () => (await (await handler(new Request("http://x/api/couch-slots"), { dataDir: await Deno.makeTempDir() })).json())[0].online_share;
  globalThis.fetch = () => Promise.resolve(Response.json(fleet()));
  try {
    const a = await read();
    online = false;
    const b = await read();
    online = true;
    const c = await read();
    assertEquals([b.samples - a.samples, b.online - a.online, c.samples - a.samples, c.online - a.online], [1, 0, 2, 1]);
    assertEquals(isNaN(Date.parse(c.since)), false);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("minion rows: kept only with the minion's signature over the exact JSON, never with an address, once per id", async () => {
  const dataDir = await Deno.makeTempDir(), keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const hexOf = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  configure({ minionPub: hexOf(await crypto.subtle.exportKey("raw", keys.publicKey)) });
  const before = Date.now();
  const post = async (row: unknown, signer = keys.privateKey) => {
    const row_json = JSON.stringify(row), sig = hexOf(await crypto.subtle.sign("Ed25519", signer, new TextEncoder().encode(row_json)));
    const r = await handler(new Request("http://x/api/minion/rows", { method: "POST", body: JSON.stringify({ row_json, sig }) }), { dataDir });
    return [r.status, await r.json()];
  };
  const row = { id: "r1", agent_id: "line-a", kind: "fetch", ok: true, pages: [{ site: "www.redfin.com", status: 200, bytes: 816000, class: "served" }] };
  assertEquals(await post(row), [200, { id: "r1" }]);
  assertEquals(await post(row), [200, { id: "r1", duplicate: true }]);
  const other = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair).privateKey;
  assertEquals((await post({ ...row, id: "r2" }, other))[1].error, "sig is not the minion's signature over row_json");
  for (const [i, text] of ["connect 203.0.113.9 refused", "to 1.2.3.4.", "1.2.3.4...", "..1.2.3.4", "4.3.2.1.in-addr.arpa", "x1.2.3.4y", "[2001:db8::1]:443"].entries())
    assertEquals((await post({ ...row, id: `ip${i}`, error: text }))[0], 400, text);
  await post({ ...row, id: "r4", agent_id: "line-b" });
  const get = async (q: string) => await (await handler(new Request("http://x/api/minion/rows" + q), { dataDir })).json();
  assertEquals((await get("")).map((r: { id: string }) => r.id), ["r1", "r4"]);
  assertEquals((await get("?agent_id=line-b")).map((r: { id: string }) => r.id), ["r4"]);
  // The stored row is the signed JSON as received, so the signature can be checked again by anyone.
  const [kept] = await get("?agent_id=line-a");
  assertEquals(JSON.parse(kept.row_json), row);
  assertEquals(await crypto.subtle.verify("Ed25519", keys.publicKey, Uint8Array.from(kept.sig.match(/../g).map((x: string) => parseInt(x, 16))), new TextEncoder().encode(kept.row_json)), true);
  // The row's own JSON has no `at`, so posted_at (when the site received it) is the timestamp the dashboard buckets by.
  assertEquals(row.at, undefined);
  assertEquals(typeof kept.posted_at === "string" && Date.parse(kept.posted_at) >= before && Date.parse(kept.posted_at) <= Date.now(), true);
});

Deno.test("status: last_polled records each guest's latest probe-request poll", async () => {
  const dataDir = await Deno.makeTempDir(), get = async (q: string) => await (await handler(new Request("http://x/api/" + q), { dataDir })).json();
  const before = Date.now();
  await get("probe-requests?agent_id=line-a");
  assertEquals(Date.parse((await get("probe-scheduler")).last_polled["line-a"]) >= before, true);
});

Deno.test("status: souk-dev reachability is reported up with status and latency, or down with the fetch error", async () => {
  const real = globalThis.fetch, get = async () => await (await handler(new Request("http://x/api/status/souk-dev"), { dataDir: await Deno.makeTempDir() })).json();
  try {
    globalThis.fetch = ((u: string) => { assertEquals(u, SOUK_URL + "/"); return Promise.resolve(new Response("hi")); }) as typeof fetch;
    const up = await get();
    assertEquals([up.up, up.status, typeof up.ms], [true, 200, "number"]);
    globalThis.fetch = (() => Promise.reject(new Error("signal timed out"))) as typeof fetch;
    const down = await get();
    assertEquals([down.up, down.error], [false, "signal timed out"]);
  } finally {
    globalThis.fetch = real;
  }
});

const w = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const claimLog = (block: number, user: number, operator: number, terms: number, owed: number, period: number) => ({ address: ESCROW.address, block, block_hash: "0x" + w(block), tx: "0x" + w(block), index: 0,
  data: "0x" + w(owed) + w(period), topics: [CLAIMED, "0x" + w(user), "0x" + w(operator), "0x" + w(terms)] });
// GuestEscrow's Claimed: guestKey indexed, (operator, cumulativeOwed, amount) in data.
const guestLog = (block: number, user: number, operator: number, terms: number, owed: number, amount: number) => ({ address: GUEST_ESCROW, block, block_hash: "0x" + w(block), tx: "0x" + w(block), index: 0,
  data: "0x" + w(operator) + w(owed) + w(amount), topics: [GUEST_CLAIMED, "0x" + w(user), "0x" + w(0x99), "0x" + w(terms)] });
// A stand-in layover-chain in its real shapes: /head, /logs (at most LOG_SPAN blocks, ending at or before the head) and /read of
// the escrow's claimed and claimPeriod, from `state` keyed by "<fn> <user>,<terms>".
const chainStub = (head: number, logs: Rec[], seen: string[], state: Record<string, string> = {}) => (u: URL) => {
  assertEquals(u.origin + u.pathname.replace(/\/[a-z]+$/, ""), CHAIN);
  seen.push(u.pathname + u.search);
  const q = (k: string) => u.searchParams.get(k)!;
  if (u.pathname.endsWith("/head")) return Response.json({ block: head, block_hash: "0x" + w(head), depth: 0, head, head_age_s: 1, verified_by: "helios-opstack" });
  if (u.pathname.endsWith("/read")) {
    if (q("fn") === "CLAIM_GRACE()") return Response.json({ contract: q("contract"), block: head - 30, value: ["86400"], verified_by: "helios-opstack" });
    return Response.json({ block: head - 30, block_hash: "0x" + w(head - 30), head, value: [state[q("contract") + " " + q("fn") + " " + q("args")]], verified_by: "helios-opstack" });
  }
  assertEquals([u.pathname.endsWith("/logs"), [[ESCROW.address, CLAIMED], [GUEST_ESCROW, GUEST_CLAIMED]].some(([a, t]) => a === q("address") && t === q("topics"))], [true, true]);
  const [from, to] = [Number(q("from")), Number(q("to"))];
  if (to - from + 1 > LOG_SPAN || to > head) return Response.json({ error: "from..to must be integers spanning at most 200 blocks" }, { status: 400 });
  return Response.json({ address: ESCROW.address, from, to, head, logs: logs.filter((l) => l.address === q("address") && l.block >= from && l.block <= to), verified_by: "helios-opstack" });
};

configure({ chainCacheMs: 0 });

Deno.test("status: escrow token balance via eth_call; Claimed events indexed forward from layover-chain in 200-block windows, at most INDEX_MAX behind the head, skipped blocks counted", async () => {
  const real = globalThis.fetch, token = "0x036cbd53842c5426634e7929541ec2318f3dcf7e", seen: string[] = [], dataDir = await Deno.makeTempDir();
  let head = 1_000_000;
  const logs = [claimLog(head - 5, 0x51, 0x52, 0x53, 1500000, 2920), claimLog(head - 1500, 0x51, 0x52, 0x53, 1000000, 2919), claimLog(head - 2500, 0x51, 0x52, 0x53, 1, 1)];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(CHAIN)) return chainStub(head, logs, seen)(new URL(url));
    const { params } = JSON.parse(init!.body as string);
    assertEquals(url, ESCROW.rpc);
    const result = params[0].data === "0xfc0c546a" ? "0x" + w(BigInt(token)) : params[0].data === "0x313ce567" ? "0x" + w(6) : "0x" + w(100000000);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;
  const get = async () => await (await handler(new Request("http://x/api/status/escrow"), { dataDir })).json();
  try {
    const e = await get();
    assertEquals([e.token, e.balance, e.decimals, e.chain], [token, "100000000", 6, CHAIN]);
    assertEquals(e.claim_index, { since: head - INDEX_MAX + 1, scanned_to: head, missed_blocks: 0 });
    assertEquals(e.last_claimed, { escrow: "escrow", block: head - 5, tx: "0x" + w(head - 5), user: addr(0x51), operator: addr(0x52), terms_hash: "0x" + w(0x53), cumulative_owed: "1500000", period: "2920" });
    assertEquals(seen.filter((x) => x.includes("/logs")).length, 2 * INDEX_MAX / LOG_SPAN);  // both escrows
    const pairs = (await Deno.readTextFile(dataDir + "/records.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(pairs.map((p) => [p.kind, p.escrow, p.user, p.operator, p.terms_hash, p.first_claim_block]), [["escrow_pair", "escrow", addr(0x51), addr(0x52), "0x" + w(0x53), head - 1500]]);
    head += 10;
    seen.length = 0;
    assertEquals((await get()).claim_index, { since: 1_000_000 - INDEX_MAX + 1, scanned_to: head, missed_blocks: 0 });
    assertEquals(seen.filter((x) => x.includes("/logs")), [`/layover-chain/logs?address=${ESCROW.address}&topics=${CLAIMED}&from=${head - 9}&to=${head}`,
      `/layover-chain/logs?address=${GUEST_ESCROW}&topics=${GUEST_CLAIMED}&from=${head - 9}&to=${head}`]);
    head += INDEX_MAX + 500;
    assertEquals((await get()).claim_index.missed_blocks, 500);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("market: per line health, appraisal, lease prices and fetch jobs; per host couch slots and Claimed amounts; minion summaries; under 12 KB", async () => {
  const real = globalThis.fetch, dataDir = await Deno.makeTempDir(), seen: string[] = [];
  const fleet = [{ publisher: "0x" + "0".repeat(38) + "22", hardware: { chip: "Apple M4 Pro" }, online: true, updated_at: 1, config: { guest: { vcpus: 1, mem_mib: 4096 } },
    slots: [{ slot_id: 0, state: "ready", attestation: { attestation: { status: "verified" } } }, { slot_id: 1, state: "busy", attestation: { attestation: { status: "verified" } } }] }];
  // In the index: two claims under one pair paying 0x22 (the couch publisher above) and one paying 0x44. A pair whose claims all
  // predate the index (0x13/0x35, kept from an earlier run as an escrow_pair record) counts only through its state reads.
  // The index position is module state, so these blocks lie past the escrow test's head.
  const b0 = 2_000_000, T = (n: number) => "0x" + w(n);
  const state = { [`escrow claimed(address,bytes32) ${addr(0x11)},${T(0x33)}`]: "10", [`escrow claimPeriod(address,bytes32) ${addr(0x11)},${T(0x33)}`]: "2",
    [`escrow claimed(address,bytes32) ${addr(0x12)},${T(0x34)}`]: "5", [`escrow claimPeriod(address,bytes32) ${addr(0x12)},${T(0x34)}`]: "1",
    [`escrow claimed(address,bytes32) ${addr(0x13)},${T(0x35)}`]: "40", [`escrow claimPeriod(address,bytes32) ${addr(0x13)},${T(0x35)}`]: "9",
    [`guest_escrow totalClaimed(address,bytes32) ${addr(0x14)},${T(0x36)}`]: "3000000" };
  // GuestEscrow pays 0x22 too: one claim of 2 LAYC, then the pair's total is 3 LAYC (claimed by two guest keys).
  const chain = chainStub(b0 + 900, [claimLog(b0 + 100, 0x11, 0x22, 0x33, 7, 1), claimLog(b0 + 200, 0x11, 0x22, 0x33, 10, 2), claimLog(b0 + 300, 0x12, 0x44, 0x34, 5, 1),
    guestLog(b0 + 400, 0x14, 0x22, 0x36, 2000000, 2000000)], seen, state);
  configure({ custody: "http://custody/", verify: (async () => ({ ok: true, mode: null, facts: { key_id: "k", manifest_sha256: "m", os_image_hash: "o", run: "r" }, checks: [], checked_at: "" })) as never });
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (url === BROKER_FLEET) return Response.json(fleet);
    if (u.origin === "http://custody") return Response.json({ key_id: "k", allowed: { manifests: ["m"], os_image_hashes: ["o"] } });
    return chain(u);
  }) as typeof fetch;
  const att = "83a776657273696f6e01a8706c6174666f726d82a46b696e64b06170706c652d6170702d617474657374a46461746182a66b65795f6964dc00204444444444444444444444444444444444444444444444444444444444444444a9617373657274696f6e91cca0a5737461636b82a46b696e64a664736d61636ba46461746186ab7265706f72745f64617461dc0040195c1bcce0cce9ccaf55cc96ccd5046cccef385949ccaf392f00cca449cc84213816cc9c5c51ccf5cce3ccfb030000000000000000000000000000000000000000000000000000000000000000ad6f735f696d6167655f68617368dc00201111111111111111111111111111111111111111111111111111111111111111af6d616e69666573745f736861323536dc00202222222222222222222222222222222222222222222222222222222222222222a372756edc00203333333333333333333333333333333333333333333333333333333333333333a663616c6c6572dc00205555555555555555555555555555555555555555555555555555555555555555a66576656e74739182a56576656e74ac73797374656d2d7265616479a77061796c6f6164a0", at = "2026-11-05T10:00:00.000Z";
  const recs = [
    { kind: "agent", agent_id: "line-a", enc_pub: "77".repeat(32), attestation: att, coarse: { region: "us-ny", isp_class: "cable", residential: true }, at },
    { kind: "agent", agent_id: "test-smoke-1", enc_pub: "77".repeat(32), attestation: att, coarse: { region: "test", isp_class: "test", residential: false }, at },
    { kind: "appraisal_request", id: "q1", agent_id: "line-a", at },
    { kind: "appraisal", id: "p0", agent_id: "line-a", report: { request_id: "q1", at, guest_version: "1773f002", cgnat: false, bandwidth_mbps: 80 }, attestation: att, at },
    { kind: "appraisal", id: "p1", agent_id: "line-a", report: { request_id: "q1", at, guest_version: "1773f002", cgnat: false, bandwidth_mbps: 80 }, attestation: att, at },
    { kind: "lease", id: "l1", agent_id: "line-a", account: "acct", deposit: 20, at },
    { kind: "lease_decision", lease_id: "l1", decision: "accept", price_per_gb: 400, term_end: at, at },
    { kind: "bounty", id: "b1", agent_id: "line-a", at },
    { kind: "probe_request", id: "00000000-0000-0000-0000-0000000000a1", agent_id: "line-a", requested_by: "s", from: at, drand_round: 1, scheduled_at: at, forced: false, at: "2026-01-01T00:00:00.000Z" },
    { kind: "decision", bounty_id: "b1", decision: "accept", at },
    { kind: "result", bounty_id: "b1", agent_id: "line-a", result: { items: [{ status: 200 }, { status: 403 }] }, attestation: att, at },
    { kind: "escrow_pair", user: addr(0x13), operator: addr(0x22), terms_hash: T(0x35), first_claim_block: 5, at },
    { kind: "escrow_pair", escrow: "escrow", user: addr(0x13), operator: addr(0x22), terms_hash: T(0x35), first_claim_block: 6, at },  // a repeat counts once
    ...[1, 2].map((i) => ({ kind: "minion", sig: "00", row_json: JSON.stringify({ id: "m" + i, agent_id: "line-a", kind: "fetch", ok: true, at, ip_commit: "c" + i, cgnat: i === 2 ? "no" : undefined,
      cgnat_method: "netmeasure", pages: [{ class: "served" }, { class: "challenged" }] }) })),
  ];
  await Deno.writeTextFile(dataDir + "/records.jsonl", recs.map((r) => JSON.stringify(r) + "\n").join(""));
  try {
    await handler(new Request("http://x/api/probe-requests?agent_id=line-a&status=open"), { dataDir });
    const res = await handler(new Request("http://x/api/market"), { dataDir }), body = await res.text(), m = JSON.parse(body);
    assertEquals(res.status, 200);
    const polled = m.lines[0].polled_at;
    if (!(Date.parse(m.at) - Date.parse(polled) < 5000)) throw new Error(`polled_at ${polled} is not the guest's poll just before ${m.at}`);
    assertEquals(m.lines, [{ agent_id: "line-a", region: "us-ny", isp_class: "cable", residential: true, verified: true,
      appraisal: { at, pass: true, guest_version: "1773f002", cgnat: false, bandwidth_mbps: 80 },
      leases: { accepted: 1, ended: 0, charged_cents: 0, last: { at, price_per_gb: 400, price_per_hour: null } },
      fetch_jobs: { done: 1, pages: 2, served: 1, last_at: at },
      polled_at: polled, probe: { at: "2026-01-01T00:10:00.000Z", pass: false, error: "no probe report within 10 minutes" } }]);
    const h = (n: string) => m.hosts["0x" + "0".repeat(38) + n];
    assertEquals([h("22").claims, h("44").claims], [{ escrow: { pairs: 2, paid: "50", last_period: "9", recent: 2, last_block: b0 + 200 }, guest_escrow: { pairs: 1, paid: "3000000", recent: 1, last_block: b0 + 400 } },
      { escrow: { pairs: 1, paid: "5", last_period: "1", recent: 1, last_block: b0 + 300 } }]);
    assertEquals([h("22").slots, h("22").ready, h("44").chip], [2, 1, null]);
    assertEquals(m.escrows.guest_escrow, { address: GUEST_ESCROW, token: "LAYC " + LAYC, claim_grace_s: 86400, withdrawable: "balance minus exposure, at any time" });
    assertEquals([m.claim_index.scanned_to, m.chain_block.block], [b0 + 900, b0 + 870]);
    assertEquals(m.minion["line-a"], { uses: 2, failed_paid_uses: 0, pages: 4, served: 2, thin: 0, challenged: 2, blocked: 0, cgnat: "no", cgnat_method: "netmeasure", addresses: 2, address_measurements: 2, last_at: at });
    if (body.length > 12000) throw new Error(`market is ${body.length} B`);
    const list = (q: string) => handler(new Request("http://x/api/agents/line-a/appraisals" + q), { dataDir }).then((r) => r.json());
    assertEquals([(await list("")).map((p: { id: string }) => p.id), (await list("?limit=1")).map((p: { id: string }) => p.id), (await list("?limit=5")).map((p: { id: string }) => p.id)], [["p0", "p1"], ["p1"], ["p1", "p0"]]);
    assertEquals((await list("?limit=0")).error, "limit: 1 to 99");
    globalThis.fetch = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
    const down = await handler(new Request("http://x/api/market"), { dataDir });
    assertEquals([down.status, (await down.json()).error], [502, `layover-chain ${CHAIN}/head?: connection refused`]);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("market and status/escrow: concurrent GETs run one after another, and an answer is reused for chainCacheMs", async () => {
  const real = globalThis.fetch, dataDir = await Deno.makeTempDir(), seen: string[] = [];
  let inFlight = 0, most = 0;
  const stub = chainStub(3_000_000, [guestLog(3_000_000 - 5, 0x61, 0x62, 0x63, 4, 4)], seen, { [`guest_escrow totalClaimed(address,bytes32) ${addr(0x61)},0x${w(0x63)}`]: "4" });
  globalThis.fetch = (async (url: string) => {
    if (url === BROKER_FLEET) return Response.json([]);
    inFlight++, most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return stub(new URL(url));
  }) as typeof fetch;
  try {
    const get = () => handler(new Request("http://x/api/market"), { dataDir }).then((r) => r.json());
    const [a, b] = await Promise.all([get(), get()]);
    const pairs = (await Deno.readTextFile(dataDir + "/records.jsonl")).trim().split("\n").filter((l) => l.includes("escrow_pair"));
    assertEquals([pairs.length, a.hosts[addr(0x62)].claims.guest_escrow.paid, b.hosts[addr(0x62)].claims.guest_escrow.paid, most], [1, "4", "4", 1]);
    configure({ chainCacheMs: 60000 });
    const n = seen.length, other = await Deno.makeTempDir(), again = () => handler(new Request("http://x/api/market"), { dataDir: other }).then((r) => r.json());
    await again(), await again();
    assertEquals(seen.slice(n).map((x) => x.split("?")[0]), ["/layover-chain/head", "/layover-chain/read"]);  // one fresh answer (nothing new to scan, CLAIM_GRACE), then the cache
  } finally {
    configure({ chainCacheMs: 0 });
    globalThis.fetch = real;
  }
});

Deno.test("leases: an escrow lease's buyer-claimed terms_hash is listed and filterable with the posting account; the guest-signed hash and wallet come from the end statement", async () => {
  let dataDir = await Deno.makeTempDir();
  const H = "0x" + "0e".repeat(32);
  const id = async (b: number) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(32).fill(b)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const [buyer, other] = [await id(0xab), await id(0xcd)];
  configure({ verify: (async () => ({ ok: true, mode: null, facts: { key_id: "k", manifest_sha256: "m", os_image_hash: "o", run: "r" }, checks: [], checked_at: "" })) as never });
  const att = (await Deno.readTextFile(new URL(import.meta.url))).match(/const att = "([0-9a-f]+)"/)![1];
  await Deno.writeTextFile(dataDir + "/records.jsonl", [{ kind: "agent", agent_id: "line-a", enc_pub: "77".repeat(32), attestation: att, coarse: { region: "r", isp_class: "c", residential: true } },
    { kind: "credit", account: buyer, amount: 100, note: "t" }, { kind: "credit", account: other, amount: 100, note: "t" }].map((r) => JSON.stringify({ ...r, at: "2026-11-06T00:00:00.000Z" }) + "\n").join(""));
  const post = async (secret: string, extra: Record<string, unknown>) => {
    const r = await handler(new Request("http://x/api/leases", { method: "POST", headers: { authorization: "Bearer " + secret },
      body: JSON.stringify({ agent_id: "line-a", deposit: 5, exclusive: false, enc: { epk: "11".repeat(32), nonce: "22".repeat(12), ct: "33".repeat(40) }, ...extra }) }), { dataDir });
    return [r.status, await r.json()];
  };
  assertEquals((await post("ab".repeat(32), { terms_hash: "0xABC" }))[1].error, "terms_hash: optional 0x 32-byte lowercase hex");
  const [, a] = await post("ab".repeat(32), { terms_hash: H }), [, b] = await post("ab".repeat(32), {}), [, c] = await post("cd".repeat(32), { terms_hash: H });  // c: someone else claims the hash
  const get = async (q: string) => await (await handler(new Request("http://x/api/" + q), { dataDir })).json();
  assertEquals((await get(`leases?agent_id=line-a&terms_hash=${H}`)).map((l: { id: string }) => l.id), [a.id, c.id]);
  assertEquals((await get(`leases?agent_id=line-a&terms_hash=${H}&account=${buyer}`)).map((l: { id: string }) => l.id), [a.id]);
  const l = (await get(`leases?agent_id=line-a&terms_hash=${H}&account=${buyer}`))[0];
  assertEquals([l.buyer_claimed_terms_hash, l.statement_terms_hash, l.statement_buyer_wallet, "account" in l], [H, null, null, false]);
  assertEquals([(await get(`leases/${a.id}/statement`)).buyer_claimed_terms_hash, (await get(`leases/${b.id}/statement`)).buyer_claimed_terms_hash], [H, null]);
  const W = "0x" + "1f".repeat(20), at = "2026-11-06T01:00:00.000Z";
  await Deno.writeTextFile(dataDir + "/records.jsonl", [{ kind: "lease_decision", lease_id: a.id, agent_id: "line-a", decision: "accept", reason: "ok", price_per_gb: 400, term_end: at, at },
    { kind: "lease_end", lease_id: a.id, agent_id: "line-a", end_reason: "term", attestation: "00", receipts_enc: null, at,
      statement: { lease_id: a.id, terms_hash: H, buyer_wallet: W, bytes_up: 1, bytes_down: 1, log: null, guest_claim: { buyer: W, terms_hash: H, cumulative_owed: "7" } } }].map((r) => JSON.stringify(r) + "\n").join(""), { append: true });
  // The site reads its log once per process: a new data dir holding the extended log stands in for a restart.
  const restarted = await Deno.makeTempDir();
  await Deno.copyFile(dataDir + "/records.jsonl", restarted + "/records.jsonl");
  dataDir = restarted;
  const ended = (await get(`leases?agent_id=line-a&terms_hash=${H}&account=${buyer}`))[0];
  assertEquals([ended.status, ended.statement_terms_hash, ended.statement_buyer_wallet], ["ended", H, W]);
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(Response.json({ key_id: "k", allowed: { manifests: ["m"], os_image_hashes: ["o"] } }))) as typeof fetch;  // custody, for measurement_current
  try {
    const st = await get(`leases/${a.id}/statement`);
    assertEquals([st.statement_buyer_wallet, st.attestation_pass, st.guest_claim, "statement" in st], [W, true, { buyer: W, terms_hash: H, cumulative_owed: "7" }, false], "a verified statement's signed claim is public; the full statement stays with the holder");
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("static: roadmap.json, status.html and the usage dashboard are served and linked", async () => {
  const dataDir = await Deno.makeTempDir(), get = (p: string) => handler(new Request("http://x" + p), { dataDir });
  const r = await get("/roadmap.json");
  assertEquals([r.status, r.headers.get("content-type")], [200, "application/json; charset=utf-8"]);
  assertEquals(Array.isArray((await r.json()).issues), true);
  const status = await (await get("/status.html")).text();
  assertEquals(status.includes("Status"), true);
  // The dashboard is served and linked from status.html and the site nav (common.js).
  const dash = await get("/dashboard.html");
  assertEquals([dash.status, dash.headers.get("content-type")], [200, "text/html; charset=utf-8"]);
  assertEquals(status.includes('href="dashboard.html"'), true);
  assertEquals((await (await get("/common.js")).text()).includes('["dashboard.html", "Usage"]'), true);
});

Deno.test("references: host references the souk replied to the doorman, latest per deal, filtered by subject", async () => {
  const dataDir = await Deno.makeTempDir(), env = { SOUK_DOORMAN_CREDENTIAL: "doorman-token" }, calls: { url: string; auth: string | null; body: unknown }[] = [];
  const out = (text: string) => ({ kind: "Output", thread: null, payload: { text, recipients: ["doorman"] } });
  const ref = (deal: string, subject: string, text: string) => out("reference " + JSON.stringify({ deal, kind: "lease", subject, up: true, text, at: 1 }));
  let inbox: unknown[] = [out("Recorded your reference on deal thread-1.")];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(inbox));
  }) as typeof fetch;
  const get = (q: string, e: Record<string, string> = env) => handler(new Request("http://x/api/references" + q), { dataDir, env: e });
  try {
    await assertRejects(() => get("", {}), Error, "SOUK_DOORMAN_CREDENTIAL");
    const unsubscribed = await get("");
    assertEquals([unsubscribed.status, (await unsubscribed.json()).error.includes('send it kind "references"')], [502, true]);
    inbox = [{ kind: "Message", payload: { text: "{}" } }, out("references subscribed"), ref("thread-2", "resip-mini-1", "fast line"),
      ref("thread-5", "0xa43f9f32411358c1319cb36027650a206644c131", "slot was ready"), ref("thread-2", "resip-mini-1", "fast line"), out("Signed up x")];
    const all = await (await get("")).json();
    assertEquals(all.map((x: { deal: string }) => x.deal), ["thread-5", "thread-2"]);
    assertEquals(await (await get("?subject=0xA43F9F32411358C1319CB36027650A206644C131")).json(), [{ deal: "thread-5", kind: "lease", subject: "0xa43f9f32411358c1319cb36027650a206644c131", up: true, text: "slot was ready", at: 1 }]);
    assertEquals((await (await get("?subject=resip-mini-1")).json()).map((x: { text: string }) => x.text), ["fast line"]);
    assertEquals(calls.length, 2); // the second read came from the 30 s cache
    assertEquals(calls[1], { url: SOUK_URL + "/api/souk_inbox", auth: "Bearer doorman-token", body: { souk_id: SOUK_ID } });
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("a cold process answers stats, couch-slots and guest polls while verdicts are still being checked; verdict readers wait for them", async () => {
  const dataDir = await Deno.makeTempDir(), at = "2026-11-06T00:00:00.000Z", enc_pub = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const att = (await Deno.readTextFile(new URL(import.meta.url))).match(/const att = "([0-9a-f]+)"/)![1];
  let release!: () => void, calls = 0;
  const gate = new Promise<void>((r) => release = r);
  configure({ verify: (async () => { calls++; await gate; return { ok: true, mode: null, facts: { key_id: "k", manifest_sha256: "m", os_image_hash: "o", run: "r" }, checks: [], checked_at: "" }; }) as never,
    custody: "http://custody/" });
  const recs = [{ kind: "agent", agent_id: "line-cold", enc_pub, attestation: att, coarse: { region: "r", isp_class: "c", residential: true } },
    ...Array.from({ length: 50 }, (_, i) => [{ kind: "appraisal_request", id: "cq" + i, agent_id: "line-cold" },
      { kind: "appraisal", id: "cp" + i, agent_id: "line-cold", report: { request_id: "cq" + i, n: i, enc_pub }, attestation: att, registration: { run: "r", manifest_sha256: "m" } }]).flat()];
  await Deno.writeTextFile(dataDir + "/records.jsonl", recs.map((r) => JSON.stringify({ ...r, at }) + "\n").join(""));
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => String(url) === BROKER_FLEET ? Response.json([]) : Response.json({ allowed: { manifests: ["m"], os_image_hashes: ["o"] } })) as typeof fetch;
  try {
    const get = (q: string) => handler(new Request("http://x/api/" + q), { dataDir });
    for (const q of ["stats", "couch-slots", "probe-requests?agent_id=line-cold", "appraisal-requests?agent_id=line-cold"]) assertEquals((await get(q)).status, 200);
    assertEquals((await (await get("stats")).json()).agents, 1);
    let answered = false;
    const agents = get("agents").then(async (r) => { answered = true; return await r.json(); });
    await new Promise((r) => setTimeout(r, 50));
    assertEquals([answered, calls >= 51], [false, true]);
    release();
    assertEquals((await agents).find((a: { agent_id: string }) => a.agent_id === "line-cold").verification.ok, true);
    assertEquals((await (await get("agents/line-cold/appraisals?limit=1")).json())[0].pass, true);
  } finally {
    release();
    globalThis.fetch = real;
  }
});

Deno.test("an upstream that does not answer in time is a 502 naming it, not a 500", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))) as typeof fetch;
  try {
    const r = await handler(new Request("http://x/api/signup", { method: "POST", headers: { "x-real-ip": "timeout-test" }, body: JSON.stringify({ email: "slow@example.com", role: "buyer" }) }),
      { dataDir: await Deno.makeTempDir(), env: { SOUK_DOORMAN_CREDENTIAL: "t" } });
    assertEquals([r.status, (await r.json()).error], [502, "souk invite: no answer in 60 s"]);
    const c = await handler(new Request("http://x/api/couch-slots"), { dataDir: await Deno.makeTempDir() });
    assertEquals([c.status, (await c.json()).error], [502, "broker /fleet: no answer in 15 s"]);
  } finally {
    globalThis.fetch = real;
  }
});

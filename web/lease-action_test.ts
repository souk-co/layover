import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { attestLeaseAction } from "../guest/guest-action.mjs";
import { canonical, hex, registrationIdentity, sha256 } from "./verify.ts";
import { GUEST_ACTION_AUDIENCE, GUEST_ACTION_MAX_AGE_S } from "./guest-action.ts";
import { fixture, encode, F, agentId, resourceId as leaseId, otherId, registrationQuote } from "./guest-action_fixture.ts";

const decline = { decision: "decline", reason: "private host decision", forecasts: { captcha: 0.25 } };
const accept = () => ({ decision: "accept", reason: "agreed", price_per_gb: 200, term_end: new Date(Date.now() + 240000).toISOString(),
  policy_sha256: "cc".repeat(32), forecasts: { captcha: 0.125 } });
const vantage = () => ({ at: new Date().toISOString(), ip_commit: "dd".repeat(32), asn: 123, same_ip: true, same_asn: true });

Deno.test("lease actions: unsigned decision, vantage and completion never write or change balances, including token leases", async () => {
  for (const token of [false, true]) for (const action of ["decision", "vantage", "end"]) {
    const f = await fixture({ active: action !== "decision", token });
    try {
      const payload = action === "decision" ? decline : action === "vantage" ? vantage() : await f.endPayload();
      assertEquals((await f.post(action, payload)).status, 400);
      assertEquals(await f.rows(), f.initial);
      const account = await f.get(`accounts/${f.account}`, true);
      assertEquals(account.balance, token ? 100 : 50);
    } finally { await f.close(); }
  }
});

Deno.test("lease actions: signed guest preserves the legacy payload and accepts fractional forecasts", async () => {
  const f = await fixture();
  try {
    const body = await f.signed("decision", accept());
    const { authorization, ...legacy } = body;
    assertEquals(hex(await sha256(encode(legacy))), authorization.message.payload_sha256);
    const result = await f.post("decision", body);
    assertEquals([result.status, result.body.decision, result.body.forecasts.captcha], [200, "accept", 0.125]);
    assertEquals((await f.post("vantage", await f.signed("vantage", vantage()))).status, 200);
    assertEquals((await f.post("end", await f.signed("end", await f.endPayload()))).status, 200);
    assertEquals((await f.get(`accounts/${f.account}`, true)).balance, 90);
  } finally { await f.close(); }
});

Deno.test("lease actions: authenticate host hardware, run, workload, base image and service caller", async () => {
  const f = await fixture();
  try {
    for (const key of ["key_id", "run", "manifest_sha256", "os_image_hash", "caller"]) {
      const facts = { ...F, [key]: (key === "key_id" ? "66" : "99").repeat(32) };
      const body = await f.signed("decision", decline, facts, key === "key_id" ? f.stranger.privateKey : f.host.privateKey);
      assertEquals((await f.post("decision", body)).status, 400, key);
    }
    assertEquals(await f.rows(), f.initial);
  } finally { await f.close(); }
});

Deno.test("lease actions: bind audience, agent, lease, action and exact body; reject stale authority", async () => {
  const f = await fixture();
  try {
    for (const [key, value] of Object.entries({ audience: "https://other-site", agent_id: "another-host", lease_id: otherId, action: "end",
      kind: "other-protocol", issued_at: Math.floor(Date.now() / 1000) - GUEST_ACTION_MAX_AGE_S - 1 })) {
      const body = await f.signed("decision", decline);
      body.authorization.message[key] = value;
      await f.resign(body);
      assertEquals((await f.post("decision", body)).status, 400, key);
    }
    const future = await f.signed("decision", decline); future.authorization.message.issued_at += 61; await f.resign(future);
    assertEquals((await f.post("decision", future)).status, 400);
    const changedOuter = await f.signed("decision", decline); changedOuter.reason = "changed";
    assertEquals((await f.post("decision", changedOuter)).status, 400);
    const changedBoth = await f.signed("decision", decline); changedBoth.reason = "changed";
    changedBoth.authorization.message.payload_sha256 = hex(await sha256(encode({ ...decline, reason: "changed" })));
    assertEquals((await f.post("decision", changedBoth)).status, 400);
    const body = await f.signed("decision", decline);
    assertEquals((await f.post("decision", body, leaseId, f.dir, { GUEST_ACTION_AUDIENCE: "https://configured-other-deployment" })).status, 400);
    assertEquals(await f.rows(), f.initial);
  } finally { await f.close(); }
});

Deno.test("lease actions: a valid runner quote cannot override custody or the current operator link", async () => {
  const f = await fixture();
  try {
    f.custody.allowed.manifests = [];
    assertEquals((await f.post("decision", await f.signed("decision", decline))).status, 400);
    f.custody.allowed.manifests = [F.manifest_sha256]; f.custody.allowed.os_image_hashes = [];
    assertEquals((await f.post("decision", await f.signed("decision", decline))).status, 400);
    f.custody.allowed.os_image_hashes = [F.os_image_hash]; f.owners.splice(0);
    assertEquals((await f.post("decision", await f.signed("decision", decline))).status, 400);
    assertEquals(await f.rows(), f.initial);
  } finally { await f.close(); }
});

Deno.test("lease actions: concurrent exact retries apply once and reused nonces cannot change the request", async () => {
  const f = await fixture({ active: true });
  try {
    const body = await f.signed("vantage", vantage());
    const results = await Promise.all([f.post("vantage", body), f.post("vantage", body), f.post("vantage", body)]);
    assertEquals(results.map(r => r.status), [200, 200, 200]);
    assertEquals(results.filter(r => r.body.duplicate).length, 2);
    assertEquals((await f.rows()).filter(r => r.kind === "lease_vantage").length, 1);
    const changed = await f.signed("vantage", { ...vantage(), asn: 999 });
    changed.authorization.message.nonce = body.authorization.message.nonce; await f.resign(changed);
    assertEquals((await f.post("vantage", changed)).status, 409);
    const restarted = await f.restart();
    assertEquals((await f.post("vantage", body, leaseId, restarted)).body.duplicate, true);
    const realNow = Date.now;
    try { Date.now = () => realNow() + (GUEST_ACTION_MAX_AGE_S + 10) * 1000; assertEquals((await f.post("vantage", body)).body.duplicate, true); }
    finally { Date.now = realNow; }
    assertEquals((await f.rows()).filter(r => r.kind === "lease_vantage").length, 1);
  } finally { await f.close(); }
});

Deno.test("lease actions: concurrent distinct decisions cannot refund the same deposit twice", async () => {
  const f = await fixture();
  try {
    const first = await f.signed("decision", decline), second = await f.signed("decision", decline);
    const results = await Promise.all([f.post("decision", first), f.post("decision", second)]);
    assertEquals(results.map(r => r.status).sort(), [200, 400]);
    assertEquals((await f.rows()).filter(r => r.kind === "lease_decision").length, 1);
    assertEquals((await f.get(`accounts/${f.account}`, true)).balance, 100);
  } finally { await f.close(); }
});

Deno.test("lease actions: invalid completion statements cannot end a lease; valid completion still succeeds", async () => {
  const f = await fixture({ active: true });
  try {
    assertEquals((await f.post("end", await f.signed("end", await f.endPayload({ badQuote: true })))).status, 400);
    const altered = await f.endPayload(); altered.statement.bytes_down = 1;
    assertEquals((await f.post("end", await f.signed("end", altered))).status, 400);
    const wrongHost = await f.endPayload();
    wrongHost.attestation = await f.quote(await sha256(new TextEncoder().encode(canonical(wrongHost.statement))), { ...F, key_id: "66".repeat(32) }, f.stranger.privateKey);
    assertEquals((await f.post("end", await f.signed("end", wrongHost))).status, 400);
    assertEquals(await f.rows(), f.initial);
    const valid = await f.signed("end", await f.endPayload());
    assertEquals((await f.post("end", valid)).status, 200);
    assertEquals((await f.post("end", valid)).body.duplicate, true);
    assertEquals((await f.rows()).filter(r => r.kind === "lease_end").length, 1);
    assertEquals((await f.get(`accounts/${f.account}`, true)).balance, 90);
  } finally { await f.close(); }
});

Deno.test("lease actions: resumed guest can close missing-log leases; old retries survive run rotation", async () => {
  const f = await fixture({ active: true });
  try {
    const old = await f.signed("vantage", vantage());
    assertEquals((await f.post("vantage", old)).status, 200);
    const next = { ...F, run: "99".repeat(32) };
    assertEquals((await f.register(next)).status, 200);
    assertEquals((await f.post("vantage", old)).body.duplicate, true);
    assertEquals((await f.post("vantage", await f.signed("vantage", vantage()))).status, 400);
    const payload = await f.endPayload({ crash: true });
    payload.attestation = await f.quote(await sha256(new TextEncoder().encode(canonical(payload.statement))), next);
    assertEquals((await f.post("end", await f.signed("end", payload, next))).status, 200);
    assertEquals((await f.get(`accounts/${f.account}`, true)).balance, 100);
    // A restart verifies the stored completion against its historical registration.
    const restarted = await f.restart();
    assertEquals((await f.get(`leases/${leaseId}/statement`, false, restarted)).attestation_pass, true);
  } finally { await f.close(); }
});

Deno.test("lease actions: registration change during signature verification aborts the transition", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  let pending: ReturnType<typeof f.post> | undefined;
  try {
    const body = await f.signed("decision", decline), gate = f.gate(body.authorization.attestation);
    release = gate.release; pending = f.post("decision", body);
    await gate.started;
    assertEquals((await f.register({ ...F, run: "99".repeat(32) })).status, 200);
    gate.release();
    assertEquals((await pending).status, 409);
    assertEquals((await f.rows()).filter(r => r.kind === "lease_decision").length, 0);
  } finally { release?.(); await pending; await f.close(); }
});

Deno.test("lease actions: a slow attestation on one lease does not block another lease", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  let pending: ReturnType<typeof f.post> | undefined;
  try {
    const body = await f.signed("decision", decline), gate = f.gate(body.authorization.attestation);
    release = gate.release; pending = f.post("decision", body);
    await gate.started;
    const other = await f.signed("decision", decline, F, f.host.privateKey, otherId);
    let timeout: number | undefined;
    try {
      const completed = await Promise.race([f.post("decision", other, otherId), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("unrelated lease blocked behind slow verification")), 1000);
      })]);
      assertEquals(completed.status, 200);
    } finally { clearTimeout(timeout); }
    release(); assertEquals((await pending).status, 200);
  } finally { release?.(); await pending; await f.close(); }
});

Deno.test("lease actions: public leases/statements expose no authorization or private signed payload", async () => {
  const f = await fixture({ active: true });
  try {
    const payload = await f.endPayload();
    assertEquals((await f.post("end", await f.signed("end", payload))).status, 200);
    const saved = (await f.rows()).find(r => r.kind === "lease_end");
    assertEquals(Object.keys(saved.authorization).sort(), ["issued_at", "nonce", "request_sha256"]);
    assertEquals(JSON.stringify(saved.authorization).includes("private.example"), false);
    for (const path of ["leases", `leases/${leaseId}`, `leases/${leaseId}/statement`]) {
      const publicText = JSON.stringify(await f.get(path));
      for (const privateText of ["authorization", "request_sha256", "private.example", '"statement":', '"price_per_gb":']) {
        assertEquals(publicText.includes(privateText), false, `${path}: leaked ${privateText}`);
      }
    }
    assertEquals((await f.get(`leases/${leaseId}`, true)).end.statement.domains, ["private.example"]);
  } finally { await f.close(); }
});

Deno.test("lease action signer refuses reserved authority fields and snapshots payload before attesting", async () => {
  await assertRejects(() => attestLeaseAction({ audience: GUEST_ACTION_AUDIENCE, agentId, leaseId, action: "decision", payload: { authorization: {} } }, async () => "00"));
  const payload = { ...decline };
  const result = await attestLeaseAction({ audience: GUEST_ACTION_AUDIENCE, agentId, leaseId, action: "decision", payload }, async () => { payload.reason = "changed during signing"; return "00"; });
  assertEquals(result.reason, decline.reason);
  assertEquals(result.authorization.message.payload_sha256, hex(await sha256(encode(decline))));
});

Deno.test("lease action proof adds constant overhead to a large completion below the control gateway cap", async () => {
  const payload = { end_reason: "term ended", statement: { lease_id: leaseId }, attestation: "ab".repeat(1024),
    receipts_enc: { epk: "11".repeat(32), nonce: "22".repeat(12), ct: "33".repeat(300000) } };
  const signed = await attestLeaseAction({ audience: GUEST_ACTION_AUDIENCE, agentId, leaseId, action: "end", payload }, async () => "cd".repeat(1024));
  const size = encode(signed).length, original = encode(payload).length;
  assertEquals(size < 1048576, true);
  assertEquals(size - original < 4096, true, "proof must not duplicate the encrypted receipts");
});

Deno.test("registration replay: exact current retry is idempotent and cannot change unsigned registration fields", async () => {
  const f = await fixture();
  try {
    const same = await f.register(F);
    assertEquals([same.status, same.body.duplicate], [200, true]);
    const reencoded = f.registration(F, [], true).attestation;
    assertEquals(reencoded === f.initial[0].attestation, false);
    assertEquals(await registrationIdentity(reencoded), await registrationIdentity(f.initial[0].attestation));
    assertEquals((await f.register(F, [], {}, true)).body.duplicate, true);
    assertEquals((await f.register(F, [], { instructions: "changed under the same quote" })).status, 409);
    assertEquals(await f.rows(), f.initial);
    assertEquals((await f.post("decision", await f.signed("decision", decline))).status, 200);
  } finally { await f.close(); }
});

Deno.test("registration replay: a superseded seen quote cannot roll back the current guest run", async () => {
  const f = await fixture();
  try {
    const next = { ...F, run: "99".repeat(32) };
    assertEquals((await f.register(next)).status, 200);
    assertEquals((await f.register(F)).status, 409);
    assertEquals((await f.register(F, [], {}, true)).status, 409, "MessagePack and assertion CBOR re-encoding cannot bypass replay checks");
    assertEquals((await f.register(next)).body.duplicate, true);
    assertEquals((await f.rows()).filter(r => r.kind === "agent").length, 2);
    assertEquals((await f.post("decision", await f.signed("decision", decline))).status, 400);
    assertEquals((await f.post("decision", await f.signed("decision", decline, next))).status, 200);
  } finally { await f.close(); }
});

Deno.test("registration replay: slow legacy registration validation cannot overwrite a newer registration", async () => {
  const f = await fixture();
  let release: (() => void) | undefined, pending: ReturnType<typeof f.register> | undefined;
  try {
    const stale = { ...F, run: "88".repeat(32) }, next = { ...F, run: "99".repeat(32) };
    const gate = f.gate(f.registration(stale).attestation);
    release = gate.release; pending = f.register(stale);
    await gate.started;
    assertEquals((await f.register(next)).status, 200);
    release(); assertEquals((await pending).status, 409);
    assertEquals((await f.rows()).filter(r => r.kind === "agent").length, 2);
    assertEquals((await f.post("decision", await f.signed("decision", decline, stale))).status, 400);
    assertEquals((await f.post("decision", await f.signed("decision", decline, next))).status, 200);
  } finally { release?.(); await pending; await f.close(); }
});

Deno.test("registration replay: a fresh signed authenticator counter permits an update within the same run", async () => {
  const f = await fixture();
  try {
    const first = await registrationIdentity(f.registration().attestation), next = await registrationIdentity(f.registration(F, [1]).attestation);
    assertEquals(first === next, false);
    assertEquals((await f.register(F, [1], { instructions: "updated in the same run" })).status, 200);
    assertEquals((await f.register(F, [1], { instructions: "updated in the same run" }, true)).body.duplicate, true);
    assertEquals((await f.register(F)).status, 409);
    assertEquals((await f.rows()).filter(r => r.kind === "agent").length, 2);
    assertEquals((await f.post("decision", await f.signed("decision", decline))).status, 200);
  } finally { await f.close(); }
});

Deno.test("registration replay: observed quotes cannot be reassigned across agent IDs owned by the same operator", async () => {
  const f = await fixture();
  try {
    const other = { ...F, run: "77".repeat(32) };
    assertEquals((await f.register(other, [], { agent_id: "test-other-agent" })).status, 200);
    assertEquals((await f.register(other)).status, 409);
    assertEquals((await f.register(other, [], {}, true)).status, 409);
    assertEquals((await f.rows()).filter(r => r.kind === "agent").length, 2);
    const fresh = { ...F, run: "78".repeat(32) };
    const replies = await Promise.all([f.register(fresh, [], { agent_id: "test-first" }), f.register(fresh, [], { agent_id: "test-second" }, true)]);
    assertEquals(replies.map(r => r.status).sort(), [200, 409]);
    assertEquals((await f.rows()).filter(r => r.kind === "agent").length, 3);
    assertEquals((await f.post("decision", await f.signed("decision", decline))).status, 200);
  } finally { await f.close(); }
});

Deno.test("registration replay: malformed historical test assertions do not block real registrations; real records still fail closed", async () => {
  for (const historicalAgent of ["test-old-smoke", "real-old-host"]) {
    const f = await fixture();
    try {
      const bad = { ...f.initial[0], agent_id: historicalAgent, attestation: registrationQuote(F, new Uint8Array(64), [], false, []) };
      await Deno.writeTextFile(f.dir + "/records.jsonl", JSON.stringify(bad) + "\n", { append: true });
      const reply = await f.register({ ...F, run: "99".repeat(32) }, [], { agent_id: "new-real-host" });
      assertEquals(reply.status, historicalAgent.startsWith("test-") ? 200 : 400);
      assertEquals((await f.rows()).filter(r => r.agent_id === "new-real-host").length, reply.status === 200 ? 1 : 0);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    const reply = await f.register(F, [], { attestation: registrationQuote(F, new Uint8Array(64), [], false, []) });
    assertEquals(reply.status, 400);
    assertEquals(await f.rows(), f.initial);
  } finally { await f.close(); }
});

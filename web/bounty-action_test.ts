import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { attestLeaseAction } from "../guest/guest-action.mjs";
import { GUEST_ACTION_AUDIENCE, GUEST_ACTION_MAX_AGE_S } from "./guest-action.ts";
import { fixture, F, agentId, resourceId as bountyId, otherId } from "./guest-action_fixture.ts";
import { canonical, sha256 } from "./verify.ts";
import { verifyBountyResponse } from "./verify-offline.ts";

const decline = { decision: "decline", reason: "busy", quote: null, forecasts: { captcha: 0.25 }, policy_sha256: null };
const accept = { ...decline, decision: "accept", reason: "agreed", quote: 12, policy_sha256: "cc".repeat(32) };

Deno.test("bounty actions: unsigned accept, decline and result never write or push a statement", async () => {
  for (const action of ["accept", "decline", "result"]) {
    const f = await fixture({ resource: "bounty", active: action === "result" });
    try {
      const payload = action === "result" ? await f.resultPayload() : action === "accept" ? accept : decline;
      assertEquals((await f.post(action === "result" ? "result" : "decision", payload)).status, 400);
      assertEquals(await f.rows(), f.initial);
      assertEquals(f.pushes, []);
    } finally { await f.close(); }
  }
});

Deno.test("bounty actions: production signer preserves result format, accepts a valid flow and keeps proofs out of public records", async () => {
  const f = await fixture({ resource: "bounty" });
  try {
    const decided = await f.post("decision", await f.signed("decision", accept));
    assertEquals([decided.status, decided.body.forecasts.captcha, f.pushes.length], [200, 0.25, 0]);
    const payload = await f.resultPayload([{ status: 200 }, { status: 403 }, { status: null }]);
    assertEquals(Object.hasOwn(payload.result, "agent_id"), false);
    assertEquals(Object.hasOwn(payload.result, "kind"), false);
    const result = await f.post("result", await f.signed("result", payload));
    assertEquals([result.status, result.body.verification.ok, f.pushes.length], [200, true, 1]);
    const pushed = JSON.parse(f.pushes[0].body.text);
    assertEquals([pushed.status, pushed.requested, pushed.served, pushed.attestation_pass], ["done", 3, 1, true]);
    for (const path of ["bounties", `bounties/${bountyId}`, `bounties/${bountyId}/statement`]) {
      const text = JSON.stringify(await f.get(path));
      assertEquals(text.includes('"authorization":'), false, path);
      assertEquals(text.includes('"registration":'), false, path);
    }
    const stored = (await f.rows()).find(r => r.kind === "result");
    assertEquals(Object.keys(stored.authorization).sort(), ["issued_at", "nonce", "request_sha256"]);
    assertEquals(stored.result, payload.result);
    // The original result still verifies after a registration rotation and site restart.
    assertEquals((await f.register({ ...F, run: "99".repeat(32) })).status, 200);
    const restarted = await f.restart();
    assertEquals((await f.get(`bounties/${bountyId}/statement`, false, restarted)).attestation_pass, true);
  } finally { await f.close(); }
});

Deno.test("bounty actions: bind resource kind, bounty, agent, action and audience", async () => {
  const f = await fixture({ resource: "bounty" });
  try {
    const leaseProof = await attestLeaseAction({ audience: GUEST_ACTION_AUDIENCE, agentId, leaseId: bountyId, action: "decision", payload: decline }, f.quote);
    assertEquals((await f.post("decision", leaseProof)).status, 400, "a matching UUID is not a matching resource domain");
    for (const [key, value] of Object.entries({ kind: "layover-lease-action/1", bounty_id: otherId, agent_id: "other-agent", action: "result", audience: "https://other-deployment" })) {
      const body = await f.signed("decision", decline);
      body.authorization.message[key] = value;
      await f.resign(body);
      assertEquals((await f.post("decision", body)).status, 400, key);
    }
    const body = await f.signed("decision", decline, { ...F, key_id: "66".repeat(32) }, f.stranger.privateKey);
    assertEquals((await f.post("decision", body)).status, 400);
    assertEquals(await f.rows(), f.initial);
    assertEquals(f.pushes, []);
  } finally { await f.close(); }
});

Deno.test("bounty actions: invalid result attestations leave the accepted bounty recoverable", async () => {
  const f = await fixture({ resource: "bounty", active: true });
  try {
    const invalid = { ...await f.resultPayload(), attestation: "00" };
    const changed = await f.resultPayload(); changed.result.items[0].status = 403;
    const otherHost = await f.resultPayload([{ status: 200 }], { ...F, key_id: "66".repeat(32) }, f.stranger.privateKey);
    for (const payload of [invalid, changed, otherHost]) {
      assertEquals((await f.post("result", await f.signed("result", payload))).status, 400);
    }
    assertEquals(await f.rows(), f.initial);
    assertEquals(f.pushes, []);
    assertEquals((await f.get(`bounties/${bountyId}`)).status, "accepted");
    assertEquals((await f.post("result", await f.signed("result", await f.resultPayload()))).status, 200);
    assertEquals(f.pushes.length, 1);
  } finally { await f.close(); }
});

Deno.test("bounty actions: concurrent exact retries, expiry and restart apply once and push once", async () => {
  for (const action of ["decision", "result"]) {
    const f = await fixture({ resource: "bounty", active: action === "result" });
    try {
      const body = await f.signed(action, action === "decision" ? decline : await f.resultPayload());
      const replies = await Promise.all([f.post(action, body), f.post(action, body), f.post(action, body)]);
      assertEquals(replies.map(r => r.status), [200, 200, 200]);
      assertEquals(replies.filter(r => r.body.duplicate).length, 2);
      assertEquals((await f.rows()).filter(r => r.kind === action).length, 1);
      assertEquals(f.pushes.length, 1);
      const restarted = await f.restart();
      assertEquals((await f.post(action, body, bountyId, restarted)).body.duplicate, true);
      const realNow = Date.now;
      try { Date.now = () => realNow() + (GUEST_ACTION_MAX_AGE_S + 10) * 1000; assertEquals((await f.post(action, body)).body.duplicate, true); }
      finally { Date.now = realNow; }
      const changed = await f.signed(action, action === "decision" ? { ...decline, reason: "changed" } : await f.resultPayload([{ status: 403 }]));
      changed.authorization.message.nonce = body.authorization.message.nonce; await f.resign(changed);
      assertEquals((await f.post(action, changed)).status, 409);
      assertEquals(f.pushes.length, 1);
    } finally { await f.close(); }
  }
});

Deno.test("bounty actions: distinct concurrent results cannot overwrite completion or push twice", async () => {
  const f = await fixture({ resource: "bounty", active: true });
  try {
    const first = await f.signed("result", await f.resultPayload([{ status: 200 }]));
    const second = await f.signed("result", await f.resultPayload([{ status: 403 }]));
    const replies = await Promise.all([f.post("result", first), f.post("result", second)]);
    assertEquals(replies.map(r => r.status).sort(), [200, 400]);
    assertEquals((await f.rows()).filter(r => r.kind === "result").length, 1);
    assertEquals(f.pushes.length, 1);
  } finally { await f.close(); }
});

Deno.test("bounty privacy: redacted public results withhold their proof and explicitly refuse independent verification", async () => {
  const f = await fixture({ resource: "bounty", active: true });
  try {
    const payload = await f.resultPayload(); payload.result.region = "Springfield, Illinois, US";
    payload.attestation = await f.quote(await sha256(new TextEncoder().encode(canonical(payload.result))));
    const posted = await f.post("result", await f.signed("result", payload));
    assertEquals(posted.status, 200);
    const bounty = await f.get(`bounties/${bountyId}`), agent = (await f.get("agents?agent_id=" + agentId))[0];
    const listed = (await f.get("bounties")).find((b: any) => b.id === bountyId);
    for (const result of [posted.body, bounty.result, listed.result]) {
      assertEquals(result.result.region, "US");
      assertEquals(result.result_redacted, true);
      assertEquals(result.attestation, undefined);
      assertEquals(result.verification, undefined);
      assertEquals(JSON.stringify(result).includes("Springfield"), false);
      assertEquals(JSON.stringify(result).includes("Illinois"), false);
      assertEquals(JSON.stringify(result).includes(payload.attestation), false);
    }
    let verifierCalls = 0;
    await assertRejects(() => verifyBountyResponse(bounty, agent, (async () => { verifierCalls++; throw new Error("must not verify a redacted payload"); }) as never),
      Error, "Independent result verification unavailable");
    assertEquals(verifierCalls, 0);
    const stored = (await f.rows()).find(r => r.kind === "result");
    assertEquals(stored.result, payload.result);
    assertEquals(stored.attestation, payload.attestation);
    const statement = await f.get(`bounties/${bountyId}/statement`), pushed = JSON.parse(f.pushes[0].body.text);
    assertEquals([statement.attestation_pass, statement.requested, statement.served], [true, 1, 1], "settlement still uses the verified stored original");
    assertEquals([pushed.attestation_pass, pushed.requested, pushed.served], [true, 1, 1]);
  } finally { await f.close(); }
});

Deno.test("bounty privacy: unchanged public results still verify independently and tampered fields fail binding", async () => {
  const f = await fixture({ resource: "bounty", active: true });
  try {
    const payload = await f.resultPayload([{ status: 200 }]);
    assertEquals((await f.post("result", await f.signed("result", payload))).status, 200);
    const bounty = await f.get(`bounties/${bountyId}`), agent = (await f.get("agents?agent_id=" + agentId))[0];
    assertEquals(bounty.result.result_redacted, undefined);
    assertEquals(bounty.result.attestation, payload.attestation);
    const checked = await verifyBountyResponse(bounty, agent, f.verify as never);
    assertEquals([checked.registration.ok, checked.result.ok], [true, true]);
    const tampered = structuredClone(bounty);
    tampered.result.result.items[0].status = 403;
    assertEquals(tampered.result.verification.ok, true, "the site's cached verdict cannot authenticate modified data");
    const refused = await verifyBountyResponse(tampered, agent, f.verify as never);
    assertEquals([refused.registration.ok, refused.result.ok], [true, false]);
    assertEquals(refused.result.checks.find((c: any) => c.name === "report_data")!.ok, false);
  } finally { await f.close(); }
});

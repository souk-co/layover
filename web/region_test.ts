import { assertEquals } from "jsr:@std/assert@1";
import { publicRegion, publicRegions } from "./region.ts";
Deno.test("home regions are country-only unless state sharing is explicitly true; never city", () => {
  for (const consent of [false, undefined]) assertEquals(publicRegion("Springfield, Illinois, US", true, consent), "US");
  assertEquals(publicRegion("Springfield, Illinois, US", true, true), "Illinois, US");
  assertEquals(publicRegion("Springfield", true, true), "Country unavailable");
  assertEquals(publicRegion("US", true), "US");
  assertEquals(publicRegion("Illinois, US", true, true), "US");
});
Deno.test("public projection covers nested raw and verified reports, bounty results and market rows without changing records", () => {
  const home = { agent_id: "home", registered_by: "private-wallet", coarse: { residential: true, region: "Springfield, Illinois, US" } };
  const agents = new Map([["home", home]]), policies = new Map();
  const values = [home, { agent_id: "home", report: { region: "Springfield, Illinois, US", residential: false } },
    { agent_id: "home", result: { result: { region: "Springfield, Illinois, US" } } }, { agent_id: "home", region: "Springfield, Illinois, US" }];
  const out = publicRegions(values, agents, policies);
  assertEquals(JSON.stringify(out).includes("Springfield"), false);
  assertEquals(JSON.stringify(out).includes("private-wallet"), false);
  assertEquals(home.coarse.region, "Springfield, Illinois, US");
  policies.set("home", { show_state: true });
  assertEquals(publicRegions(values, agents, policies)[1].report.region, "Illinois, US");
  for (const connection_kind of ["rented_exit", "vpn"]) {
    policies.set("home", { connection_kind });
    assertEquals(publicRegions(values, agents, policies)[1].report.region, "Springfield, Illinois, US");
  }
  policies.clear();
  const signed = { agent_id: "home", region: home.coarse.region, row_json: JSON.stringify({ agent_id: "home", region: home.coarse.region }), sig: "signed" };
  const projected = publicRegions(signed, agents, policies);
  assertEquals(projected.region, "US");
  assertEquals(projected.row_json, undefined);
  assertEquals(projected.sig, undefined);
  assertEquals(projected.region_redacted, true);
  assertEquals(publicRegions({ coarse: home.coarse }, new Map(), new Map()).coarse.region, "US");
});

Deno.test("only changes to a signed bounty payload withhold its public attestation and binding details", () => {
  const agents = new Map([["home", { agent_id: "home", coarse: { residential: true } }]]);
  const signed = { kind: "result", agent_id: "home", bounty_id: "bounty", result: { region: "Springfield, Illinois, US", items: [] },
    attestation: "original-quote", verification: { ok: true, checks: [{ name: "report_data binds", detail: "original-binding" }] } };
  const before = JSON.stringify(signed);
  for (const show_state of [false, true]) {
    const projected = publicRegions(signed, agents, new Map([["home", { show_state }]]));
    assertEquals(projected.result.region, show_state ? "Illinois, US" : "US");
    assertEquals(projected.result_redacted, true);
    assertEquals(projected.attestation, undefined);
    assertEquals(projected.verification, undefined);
    assertEquals(JSON.stringify(projected).includes("original-binding"), false);
  }
  const unchangedPayload = { ...signed, region: "Springfield, Illinois, US", registered_by: "private-owner", result: { ...signed.result, region: "US" } };
  const projected = publicRegions(unchangedPayload, agents, new Map());
  assertEquals(projected.region, "US");
  assertEquals(projected.registered_by, undefined);
  assertEquals(projected.result_redacted, undefined, "an unrelated wrapper-field change does not invalidate the signed payload");
  assertEquals(projected.attestation, signed.attestation);
  assertEquals(projected.verification, signed.verification);
  const exempt = publicRegions(signed, agents, new Map([["home", { connection_kind: "rented_exit" }]]));
  assertEquals(exempt, signed);
  assertEquals(JSON.stringify(signed), before, "stored signed data remains unchanged");
});

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

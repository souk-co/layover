import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { normalizeStarterEmail, starterCap } from "./starter.ts";
Deno.test("starter identity aliases and cap configuration", () => {
  for (const email of ["First.Name+news@GMAIL.com", "firstname@gmail.com", "FIRST.NAME+other@googlemail.com"])
    assertEquals(normalizeStarterEmail(email), "firstname@gmail.com");
  assertEquals(normalizeStarterEmail(" A.B+news@Example.com "), "a.b@example.com");
  assertEquals(starterCap(undefined, 200), 200);
  assertEquals(starterCap("0", 200), 0);
  for (const v of ["-1", "NaN", "1.5", "Infinity"]) assertThrows(() => starterCap(v, 200));
});

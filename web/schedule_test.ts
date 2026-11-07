// deno test -A web/schedule_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DRAND, hit, PROBE, randomness, roundAt, roundTime, scan } from "./schedule.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fake = async (r: number) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("round " + r))));

Deno.test("round arithmetic", () => {
  assertEquals(roundTime(1), DRAND.genesis * 1000);
  assertEquals(roundAt(roundTime(100)), 100);
  assertEquals(roundAt(roundTime(100) + 1), 101);
});

Deno.test("hit is sha256(randomness || agent_id) below 2^256 / 120, compared as an integer", async () => {
  const x = await fake(1), d = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...x.match(/../g)!.map((b) => parseInt(b, 16)), ...new TextEncoder().encode("a")])));
  assertEquals(await hit(x, "a", PROBE), BigInt("0x" + hex(d)) < 2n ** 256n / 120n);
});

Deno.test("first hit at or after min, forced at max, gaps average about the mean", async () => {
  let from = roundTime(5_000_000), gaps = 0, forced = 0;
  const n = 300;
  for (let i = 0; i < n; i++) {
    const { next } = await scan(from, "resip-mini-1", PROBE, 0, Infinity, fake);
    const gap = (Date.parse(next!.scheduled_at) - from) / 1000;
    assert(gap >= PROBE.min && gap <= PROBE.max + DRAND.period, `gap ${gap}`);
    for (let r = roundAt(from + PROBE.min * 1000); r < next!.drand_round; r++) assert(!(await hit(await fake(r), "resip-mini-1", PROBE)));
    assertEquals(next!.forced, !(await hit(await fake(next!.drand_round), "resip-mini-1", PROBE)));
    gaps += gap; forced += Number(next!.forced);
    from = Date.parse(next!.scheduled_at);
  }
  console.log("mean gap", gaps / n, "s; forced", forced);
  assert(gaps / n > 2800 && gaps / n < 4600);
});

Deno.test("scan stops at upTo without deciding, and resumes", async () => {
  const from = roundTime(6_000_000), all = await scan(from, "x", PROBE, 0, Infinity, fake);
  const part = await scan(from, "x", PROBE, 0, all.next!.drand_round - 1, fake);
  assertEquals(part.next, null);
  assertEquals((await scan(from, "x", PROBE, part.scanned + 1, Infinity, fake)).next, all.next);
});

Deno.test("live drand round", async () => {
  const x = await randomness(roundAt(Date.now()) - 2);
  assertEquals(x.length, 64);
});

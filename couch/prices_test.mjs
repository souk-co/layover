// node --test: every price the kit prints (SKILL.md, mcp.mjs tool descriptions) or sends (the settlement record)
// converts correctly between nano-USD and USD and between per second, per minute and per hour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { settlement } from "./stay.mjs";

const page = f => readFileSync(new URL(f, import.meta.url), "utf8");
const skill = page("./SKILL.md");
const skillRate = skill.match(/(\d+) nano-USD per active guest second \(\$(\d+(?:\.\d+)?) per hour, \$(\d+(?:\.\d+)?) per minute\), (\d+) seconds minimum/);
const skillHour = skill.match(/\$(\d+(?:\.\d+)?) per hour/), skillMinute = skill.match(/\$(\d+(?:\.\d+)?) per minute/);

// A printed dollar figure back to integer nano-USD (1 USD = 10^9 nano-USD, as SKILL.md's close-and-report section states).
function nanoOfDollars(figure) {
  const [whole, frac = ""] = figure.split(".");
  assert.ok(/^\d+$/.test(whole) && frac.length <= 9, "printed dollar figure " + figure);
  return BigInt(whole + frac.padEnd(9, "0"));
}

test("SKILL.md quotes the broker rate per second and converts it to per hour and per minute", () => {
  assert.ok(skillRate, "SKILL.md no longer quotes the broker rate with its per-hour and per-minute conversions");
  const perSecond = BigInt(skillRate[1]), hour = nanoOfDollars(skillRate[2]), minute = nanoOfDollars(skillRate[3]), minimum = BigInt(skillRate[4]);
  assert.equal(perSecond * 3600n, hour, "the per-hour figure must be one hour of the per-second rate");
  assert.equal(perSecond * 60n, minute, "the per-minute figure must be one minute of the per-second rate");
  assert.equal(perSecond * minimum, minute, "the minimum charge is the minimum's worth of rate");
});

test("mcp.mjs's stay_open description quotes the same per-second rate and minimum as SKILL.md", () => {
  const described = page("./mcp.mjs").match(/(\d+) nano-USD per active second, (\d+) s minimum/);
  assert.ok(described, "stay_open no longer names the broker rate and the minimum");
  assert.ok(skillHour && skillMinute, "SKILL.md no longer converts the rate per hour and per minute");
  assert.equal(described[1], skillRate[1], "the two kit surfaces must quote one rate");
  const perSecond = BigInt(described[1]), minimum = BigInt(described[2]);
  assert.equal(perSecond * 3600n, nanoOfDollars(skillHour[1]), "the per-second rate must be the one SKILL.md prices an hour at");
  assert.equal(perSecond * 60n, nanoOfDollars(skillMinute[1]));
  assert.equal(perSecond * minimum, nanoOfDollars(skillMinute[1]), "the minimum charge is one minute of rate");
});

test("SKILL.md's nano-USD to USD rule is 10^9 and its capped-open example covers the minimum in whole minutes", () => {
  const rule = skill.match(/1 USD = 10\^(\d+) nano-USD/);
  assert.ok(rule, "SKILL.md no longer states the nano-USD to USD conversion");
  assert.equal(rule[1], "9");
  assert.equal(nanoOfDollars("1"), 10n ** 9n);
  const example = skill.match(/"max_spend_nano_usd":"(\d+)"/);
  assert.ok(example, "SKILL.md no longer shows a max_spend_nano_usd example");
  const cap = BigInt(example[1]), minute = BigInt(skillRate[1]) * BigInt(skillRate[4]);
  assert.ok(cap >= minute, "the documented example cap must cover the 60-second minimum charge");
  assert.equal(cap % minute, 0n, "the documented example cap is a whole number of rate-minutes");
});

const node = { receiptSigner: "0x" + "11".repeat(20), operator: "0x" + "22".repeat(20) };
// The broker's final view of a stay, as /agent/end answers it.
function endView({ guestSeconds, spent }) {
  return { sessionId: "s9", node: { relay_peer: "12D3KooWpeer" }, placement: { publisher: "0xpub", slot_id: 2 }, guestSeconds,
    rateNanoUsdPerSecond: "15000", browse: { mode: "named", hosts: ["shop.example"], nanoUsdPerSecond: "2500", token: "b".repeat(32) },
    credit: { spentNanoUsd: spent, wallet: "0x" + "33".repeat(20) }, closedReason: "wallet-ended" };
}

test("the settlement record carries the broker's browse terms and never the browse token", () => {
  const record = settlement(endView({ guestSeconds: 60, spent: "1000000" }), node, { spentNanoUsd: "1000000" });
  assert.deepEqual(record.browse, { mode: "named", hosts: ["shop.example"], nanoUsdPerSecond: "2500" });
  assert.equal("token" in record.browse, false);
  assert.equal(JSON.stringify(record).includes("b".repeat(32)), false);
});

test("a settlement whose broker view carries no browse terms omits browse rather than inventing terms", () => {
  const view = endView({ guestSeconds: 60, spent: "900000" });
  delete view.browse;
  const record = settlement(view, node, { spentNanoUsd: "0" });
  assert.equal(record.browse, undefined);
});

test("settlement charges are nano-USD ledger deltas: an hour at the posted rate is $0.054, the minimum is $0.0009", () => {
  const rate = BigInt(skillRate[1]), minimum = BigInt(skillRate[4]);
  const hour = settlement(endView({ guestSeconds: 3600, spent: String(rate * 3600n) }), node, { spentNanoUsd: "0" });
  assert.equal(hour.chargedNanoUsd, "54000000");
  assert.equal(nanoOfDollars(skillHour[1]), BigInt(hour.chargedNanoUsd), "an hour at the rate must settle at SKILL.md's per-hour figure");
  const floor = settlement(endView({ guestSeconds: 5, spent: String(rate * minimum) }), node, { spentNanoUsd: "0" });
  assert.equal(floor.guestSeconds < minimum, true);
  assert.equal(floor.chargedNanoUsd, "900000");
  assert.equal(nanoOfDollars(skillMinute[1]), BigInt(floor.chargedNanoUsd), "a stay under the minimum settles at the minimum, SKILL.md's per-minute figure");
});

test("the settlement record's rates stay per-second nano-USD strings, not per-minute or dollar figures", () => {
  const record = settlement(endView({ guestSeconds: 120, spent: "1800000" }), node, { spentNanoUsd: "0" });
  assert.equal(record.rateNanoUsdPerSecond, "15000");
  assert.equal(record.browse.nanoUsdPerSecond, "2500");
  assert.equal(record.chargedNanoUsd, String(15000n * 120n));
});

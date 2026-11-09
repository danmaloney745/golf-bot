import { test } from "node:test";
import assert from "node:assert/strict";
import { targetWeekend, dublinInstant } from "../src/lib/time.mjs";
import { orderSlots, playersFor, nameMatches } from "../src/lib/slots.mjs";

test("targets this week's weekend on Monday before opening", () => {
  assert.deepEqual(targetWeekend("19:16", new Date("2026-11-09T18:00:00Z")), { opens: "2026-11-09", sat: "2026-11-14", sun: "2026-11-15" });
  assert.equal(targetWeekend("19:16", new Date("2026-11-05T06:00:00Z")).sat, "2026-11-14");
  assert.equal(targetWeekend("19:16", new Date("2026-11-09T20:00:00Z")).sat, "2026-11-21");
});

test("19:16 Dublin in winter and summer", () => {
  assert.equal(dublinInstant("2026-11-09", "19:16").toISOString(), "2026-11-09T19:16:00.000Z");
  assert.equal(dublinInstant("2027-06-07", "19:16").toISOString(), "2027-06-07T18:16:00.000Z");
});

test("slots from 07:20, earliest first, no duplicates", () => {
  const got = orderSlots([{ time: "08:00" }, { time: "07:10" }, { time: "07:30" }, { time: "07:20" }, { time: "07:30" }, { time: "13:00" }], "07:20", "12:00");
  assert.deepEqual(got.map((s) => s.time), ["07:20", "07:30", "08:00"]);
});

test("only ticked players, Dan first", () => {
  const config = { players: { mark: { name: "Mark Armstrong" }, dan: { name: "Daniel Maloney", isBookingAccount: true }, hugh: { name: "Hugh Crowther" } } };
  assert.deepEqual(playersFor("sat", { sat: { mark: true, dan: true, hugh: false } }, config), ["dan", "mark"]);
});

test("name matching handles 'Surname, First'", () => {
  assert.ok(nameMatches("Armstrong, Mark (12.4)", "Mark Armstrong"));
  assert.ok(!nameMatches("Armstrong, Mary", "Mark Armstrong"));
});

test("skips slots without room for everyone", () => {
  const got = orderSlots([{ time: "07:40", free: 2 }, { time: "07:48", free: 4 }, { time: "07:56", free: null }], "07:20", "12:00", 3);
  assert.deepEqual(got.map((s) => s.time), ["07:48", "07:56"]);
});

test("always-in player is booked every day, ticked or not", () => {
  const config = { players: { dan: { name: "Daniel Maloney", isBookingAccount: true, alwaysIn: true }, mark: { name: "Mark Armstrong" }, hugh: { name: "Hugh Crowther" } } };
  assert.deepEqual(playersFor("sun", { sun: { hugh: true } }, config), ["dan", "hugh"]);
  assert.deepEqual(playersFor("sat", {}, config), ["dan"]);
});

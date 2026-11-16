import { test } from "node:test";
import assert from "node:assert/strict";
import { bookDay } from "../src/booker/brs.mjs";

const MEMBERS = ["Maloney, Daniel", "Armstrong, Mark", "Crowther, Hugh", "Duffield, Peter"];

// A fake BRS tab. The tee sheet returns `slots`; the entry form has four player <select>s,
// pre-filled from `form` (e.g. ["Maloney, Daniel"] when you're auto-added as Player 1).
function fakePage(slots, form, picked, firstComp = null, lockedTimes = []) {
  let clicked = null;
  const fields = [0, 1, 2, 3].map((i) => ({
    first() { return this; },
    or() { return { first() { return this; }, waitFor: async () => {} }; },
    waitFor: async () => {},
    evaluate: async function () { return [!!form[i], form[i] || ""]; },
    locator: () => ({ allTextContents: async () => ["Start typing to find player...", ...MEMBERS] }),
    selectOption: async ({ label }) => { picked.push([i + 1, label]); },
  }));
  const fieldList = { first: () => fields[0], count: async () => 4, nth: (i) => fields[i] };
  const isLocked = () => clicked && lockedTimes.includes(clicked.time);
  const other = (sel) => ({
    first() { return this; }, filter() { return this; }, waitFor: async () => {},
    click: async () => { const m = sel.match(/data-bot-book="(\d+)"/); if (m) clicked = slots.find((s) => s.index === Number(m[1])); },
    count: async () => (sel === ".swal2-popup" && isLocked() ? 1 : 0),
    innerText: async () => "Locked by another user This Tee Time has been locked by another user until 19:19:02.",
  });
  return {
    goto: async () => {}, waitForLoadState: async () => {},
    locator: (sel) => (sel.startsWith("select[id^=") ? fieldList : other(sel)),
    evaluate: async (fn, arg) => (arg === "firstComp" ? firstComp : slots),
  };
}
const config = {
  baseUrl: "x", club: "c", courseId: 1, teeSheetPath: "/{club}", earliestTeeTime: "07:20", latestTeeTime: "23:59",
  competitionsOnly: true, retryWindowSeconds: 5,
  players: { dan: { name: "Daniel Maloney", isBookingAccount: true }, mark: { name: "Mark Armstrong" }, hugh: { name: "Hugh Crowther" } },
};
const opts = { dryRun: true, snap: async () => {}, log: () => {} };
const partners = ["Mark Armstrong", "Hugh Crowther"];

test("three-ball on an empty slot where Dan is auto-filled", async () => {
  const picked = [];
  const r = await bookDay(fakePage([{ time: "07:40", index: 0, free: 2, comp: true }, { time: "07:48", index: 1, free: 3, taken: 0, comp: true }], ["Maloney, Daniel"], picked), config, "2026-11-14", partners, opts);
  assert.deepEqual(r, { time: "07:48", unconfirmed: false, dropped: [] });
  assert.deepEqual(picked, [[2, "Armstrong, Mark"], [3, "Crowther, Hugh"]]);
});

test("adds Dan himself when he isn't pre-filled", async () => {
  const picked = [];
  await bookDay(fakePage([{ time: "07:48", index: 0, free: 3, taken: 0, comp: true }], [], picked), config, "2026-11-14", partners, opts);
  assert.deepEqual(picked, [[1, "Maloney, Daniel"], [2, "Armstrong, Mark"], [3, "Crowther, Hugh"]]);
});

test("on a part-booked slot, fills the empty spaces and keeps Dan on it", async () => {
  const picked = [];
  await bookDay(fakePage([{ time: "07:48", index: 0, free: 3, taken: 1, comp: false }], ["Duffield, Peter"], picked), { ...config, competitionsOnly: false }, "2026-11-13", partners, opts);
  assert.deepEqual(picked, [[2, "Maloney, Daniel"], [3, "Armstrong, Mark"], [4, "Crowther, Hugh"]]);
});

test("emptyOnly skips slots someone is already on", async () => {
  const r = await bookDay(fakePage([{ time: "07:48", index: 0, free: 3, taken: 1, comp: false }, { time: "07:56", index: 1, free: 4, taken: 0, comp: false }], [], []), { ...config, competitionsOnly: false, emptyOnly: true }, "2026-11-13", partners, opts);
  assert.equal(r.time, "07:56");
});

test("drops the last partner when nothing fits three", async () => {
  const picked = [];
  const r = await bookDay(fakePage([{ time: "07:40", index: 0, free: 2, comp: true }, { time: "13:40", index: 1, free: 4, comp: false }], ["Maloney, Daniel"], picked), { ...config, twoBallAfterSeconds: 0 }, "2026-11-14", partners, opts);
  assert.deepEqual(r, { time: "07:40", unconfirmed: false, dropped: ["Hugh Crowther"] });
  assert.deepEqual(picked, [[2, "Armstrong, Mark"]]);
});

test("never takes a casual slot in competition mode", async () => {
  const r = await bookDay(fakePage([{ time: "13:40", index: 0, free: 4, comp: false }], [], []), { ...config, retryWindowSeconds: 1 }, "2026-11-14", ["Mark Armstrong"], opts);
  assert.equal(r.time, null);
});

test("skips the competition's first slot and takes the next", async () => {
  const slots = [{ time: "07:56", index: 0, free: 3, taken: 0, comp: true }, { time: "08:04", index: 1, free: 3, taken: 0, comp: true }, { time: "08:12", index: 2, free: 3, taken: 0, comp: true }];
  const r = await bookDay(fakePage(slots, ["Maloney, Daniel"], [], "07:56"), { ...config, skipFirstCompetitionSlot: true }, "2026-11-21", partners, opts);
  assert.equal(r.time, "08:04");
});

test("if the second slot is gone, tries the third, never the first", async () => {
  const slots = [{ time: "07:56", index: 0, free: 3, taken: 0, comp: true }, { time: "08:12", index: 2, free: 3, taken: 0, comp: true }];
  const r = await bookDay(fakePage(slots, ["Maloney, Daniel"], [], "07:56"), { ...config, skipFirstCompetitionSlot: true }, "2026-11-21", partners, opts);
  assert.equal(r.time, "08:12");
});

test("a slot locked by another member is skipped straight away", async () => {
  const picked = [];
  const slots = [{ time: "08:04", index: 0, free: 3, taken: 0, comp: true }, { time: "08:12", index: 1, free: 3, taken: 0, comp: true }, { time: "08:20", index: 2, free: 3, taken: 0, comp: true }];
  const t0 = Date.now();
  const r = await bookDay(fakePage(slots, ["Maloney, Daniel"], picked, null, ["08:04", "08:12"]), config, "2026-11-21", partners, opts);
  assert.equal(r.time, "08:20");
  assert.ok(Date.now() - t0 < 1000, "no waiting on locked slots");
  assert.deepEqual(r.dropped, []);
});

test("doesn't drop to a two-ball while three-ball slots are only locked", async () => {
  const slots = [{ time: "08:04", index: 0, free: 3, taken: 0, comp: true }, { time: "08:12", index: 1, free: 2, taken: 1, comp: true }];
  const r = await bookDay(fakePage(slots, ["Maloney, Daniel"], [], null, ["08:04"]), { ...config, retryWindowSeconds: 2 }, "2026-11-21", partners, opts);
  assert.equal(r.time, null, "waited for 08:04's lock instead of leaving Hugh out");
});

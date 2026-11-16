import { test } from "node:test";
import assert from "node:assert/strict";
import { bookDay, parseSheet } from "../src/booker/brs.mjs";

const MEMBERS = ["Maloney, Daniel", "Armstrong, Mark", "Crowther, Hugh", "Duffield, Peter"];

/** The tee sheet feed as BRS sends it. `rows`: [{ time, comp, people: [name|null|"x" x4], bookable }]. */
function feed(rows, firstComp) {
  const times = {};
  for (const r of rows) {
    times[r.time] = {
      tee_time: {
        reservation_type: r.comp ? "Members Competition" : null,
        participants: (r.people || []).map((name) => ({ name })),
        bookable: r.bookable !== false,
        url: r.bookable !== false ? `/c/bookings/book/tok${r.time.replace(":", "")}/1/20261121/${r.time.replace(":", "")}` : null,
        reason: r.bookable !== false ? null : "Booked",
      },
    };
    if (r.time === firstComp) times[r.time].competition_start = { start_time: firstComp };
  }
  return { times };
}

/**
 * A fake BRS tab. The feed returns `rows`; opening a booking link shows the entry form with four
 * player <select>s pre-filled from `form`, unless that time is in `lockedTimes`.
 */
function fakePage(rows, { form = ["Maloney, Daniel"], picked = [], firstComp = null, lockedTimes = [], opened = [] } = {}) {
  let current = null;
  const isLocked = () => current && lockedTimes.includes(current);
  const fields = [0, 1, 2, 3].map((i) => ({
    evaluate: async () => [!!form[i], form[i] || ""],
    locator: () => ({ allTextContents: async () => ["Start typing to find player...", ...MEMBERS] }),
    selectOption: async ({ label }) => { picked.push([i + 1, label]); },
  }));
  const formLoc = {
    first() { return this; },
    or() { return { first() { return this; }, waitFor: async () => {} }; },
    waitFor: async () => {},
    count: async () => (isLocked() ? 0 : 4),
    nth: (i) => fields[i],
  };
  const lockLoc = {
    first() { return this; }, filter() { return this; }, waitFor: async () => {},
    count: async () => (isLocked() ? 1 : 0),
    innerText: async () => "Locked by another user This Tee Time has been locked by another user until 19:19:02.",
    click: async () => {},
  };
  const request = { get: async () => ({ ok: () => true, status: () => 200, json: async () => feed(rows, firstComp) }) };
  return {
    context: () => ({ request }),
    goto: async (url) => { const m = url.match(/\/(\d{4})$/); current = m ? `${m[1].slice(0, 2)}:${m[1].slice(2)}` : null; opened.push(current); },
    waitForURL: () => new Promise(() => {}),
    url: () => "https://x/c/bookings/book/...",
    waitForLoadState: async () => {},
    locator: (sel) => (sel.startsWith("select[id^=") ? formLoc : lockLoc),
  };
}
const config = {
  baseUrl: "https://x", club: "c", courseId: 1, earliestTeeTime: "07:00", latestTeeTime: "23:59",
  competitionsOnly: true, retryWindowSeconds: 2, twoBallAfterSeconds: 60,
  players: { dan: { name: "Daniel Maloney", isBookingAccount: true }, mark: { name: "Mark Armstrong" }, hugh: { name: "Hugh Crowther" } },
};
const opts = { dryRun: true, snap: async () => {}, log: () => {} };
const partners = ["Mark Armstrong", "Hugh Crowther"];
const empty = [null, null, null, "x"];

test("parses the BRS feed: free spaces, blocked x, booking link, first competition slot", () => {
  const { slots, firstComp } = parseSheet(feed([
    { time: "07:56", comp: true, people: empty },
    { time: "08:04", comp: true, people: ["Colm Brady", "Karl Stewart", null, "x"] },
    { time: "08:12", comp: true, people: ["A", "B", "C", "x"], bookable: false },
  ], "07:56"), "2026-11-21");
  assert.equal(firstComp, "07:56");
  assert.deepEqual(slots.map((s) => [s.time, s.free, s.taken, s.bookable]), [["07:56", 3, 0, true], ["08:04", 1, 2, true], ["08:12", 0, 3, false]]);
  assert.equal(slots[0].path, "/c/bookings/book/tok0756/1/20261121/0756");
});

test("three-ball on the earliest slot with room", async () => {
  const picked = [];
  const r = await bookDay(fakePage([{ time: "07:40", comp: true, people: ["A", null, null, "x"] }, { time: "07:48", comp: true, people: empty }], { picked }), config, "2026-11-14", partners, opts);
  assert.deepEqual(r, { time: "07:48", unconfirmed: false, dropped: [] });
  assert.deepEqual(picked, [[2, "Armstrong, Mark"], [3, "Crowther, Hugh"]]);
});

test("adds Dan himself when he isn't pre-filled", async () => {
  const picked = [];
  await bookDay(fakePage([{ time: "07:48", comp: true, people: empty }], { form: [], picked }), config, "2026-11-14", partners, opts);
  assert.deepEqual(picked, [[1, "Maloney, Daniel"], [2, "Armstrong, Mark"], [3, "Crowther, Hugh"]]);
});

test("on a part-booked slot, fills the empty spaces and keeps Dan on it", async () => {
  const picked = [];
  await bookDay(fakePage([{ time: "07:48", comp: false, people: ["Peter Duffield", null, null, null] }], { form: ["Duffield, Peter"], picked }), { ...config, competitionsOnly: false }, "2026-11-13", partners, opts);
  assert.deepEqual(picked, [[2, "Maloney, Daniel"], [3, "Armstrong, Mark"], [4, "Crowther, Hugh"]]);
});

test("emptyOnly skips slots someone is already on", async () => {
  const r = await bookDay(fakePage([{ time: "07:48", comp: false, people: ["P", null, null, null] }, { time: "07:56", comp: false, people: [null, null, null, null] }]), { ...config, competitionsOnly: false, emptyOnly: true }, "2026-11-13", partners, opts);
  assert.equal(r.time, "07:56");
});

test("skips the competition's first slot and takes the next", async () => {
  const rows = ["07:56", "08:04", "08:12"].map((time) => ({ time, comp: true, people: empty }));
  const r = await bookDay(fakePage(rows, { firstComp: "07:56" }), { ...config, skipFirstCompetitionSlot: true }, "2026-11-21", partners, opts);
  assert.equal(r.time, "08:04");
});

test("a slot locked by another member is skipped straight away", async () => {
  const opened = [];
  const rows = ["08:04", "08:12", "08:20"].map((time) => ({ time, comp: true, people: empty }));
  const t0 = Date.now();
  const r = await bookDay(fakePage(rows, { lockedTimes: ["08:04", "08:12"], opened }), config, "2026-11-21", partners, opts);
  assert.equal(r.time, "08:20");
  assert.deepEqual(opened, ["08:04", "08:12", "08:20"]);
  assert.ok(Date.now() - t0 < 1000, "no waiting on locked slots");
});

test("waits for entry to open, then goes straight in", async () => {
  const rows = [{ time: "08:04", comp: true, people: empty, bookable: false }];
  const page = fakePage(rows);
  setTimeout(() => { rows[0].bookable = true; }, 400);
  const r = await bookDay(page, config, "2026-11-21", partners, opts);
  assert.equal(r.time, "08:04");
});

test("doesn't drop to a two-ball while three-ball slots are only locked", async () => {
  const rows = [{ time: "08:04", comp: true, people: empty }, { time: "08:12", comp: true, people: ["A", null, null, "x"] }];
  const r = await bookDay(fakePage(rows, { lockedTimes: ["08:04"] }), config, "2026-11-21", partners, opts);
  assert.equal(r.time, null, "waited for 08:04's lock instead of leaving Hugh out");
});

test("drops the last partner when nothing fits three", async () => {
  const picked = [];
  const rows = [{ time: "07:40", comp: true, people: ["A", null, null, "x"] }, { time: "13:40", comp: false, people: [null, null, null, null] }];
  const r = await bookDay(fakePage(rows, { picked }), { ...config, twoBallAfterSeconds: 0 }, "2026-11-14", partners, opts);
  assert.deepEqual(r, { time: "07:40", unconfirmed: false, dropped: ["Hugh Crowther"] });
  assert.deepEqual(picked, [[2, "Armstrong, Mark"]]);
});

test("never takes a casual slot in competition mode", async () => {
  const r = await bookDay(fakePage([{ time: "13:40", comp: false, people: [null, null, null, null] }]), { ...config, retryWindowSeconds: 1 }, "2026-11-14", ["Mark Armstrong"], opts);
  assert.equal(r.time, null);
});

test("an empty slot has no participant list: 3 free for a competition, 4 for casual", () => {
  const data = feed([{ time: "08:04", comp: true }, { time: "15:16", comp: false }], null);
  data.times["08:04"].competition_start = { start_time: "07:56", num_bookable_players: 3 };
  const { slots } = parseSheet(data, "2026-11-21");
  assert.deepEqual(slots.map((s) => [s.time, s.free, s.taken]), [["08:04", 3, 0], ["15:16", 4, 0]]);
});

test("uses the feed's full booking link as-is, or completes a partial one", () => {
  const data = { times: {
    "15:16": { tee_time: { participants: [], bookable: true, url: "/c/bookings/book/T%253D/1/20261120/1516" } },
    "15:24": { tee_time: { participants: [], bookable: true, url: "/c/bookings/book/U%253D/1/" } },
  } };
  const { slots } = parseSheet(data, "2026-11-20");
  assert.deepEqual(slots.map((s) => s.path), ["/c/bookings/book/T%253D/1/20261120/1516", "/c/bookings/book/U%253D/1/20261120/1524"]);
});

// ---- clock sync and the opening race

import { readOffset, measureOffset } from "../src/lib/clock.mjs";
import { raceOpening } from "../src/booker/brs.mjs";

/** A fake BRS whose clock runs `skew` ms ahead of ours; its Date header shows whole seconds. */
const fakeServerDate = (skew, latency = 30) => async () => {
  await new Promise((r) => setTimeout(r, latency / 2));
  const t = Math.floor((Date.now() + skew) / 1000) * 1000;
  await new Promise((r) => setTimeout(r, latency / 2));
  return t;
};

for (const skew of [0, 730, -1240, 4380]) {
  test(`clock sync finds a BRS clock ${skew}ms off, to within 60ms`, async () => {
    const { offset, readings } = await measureOffset(fakeServerDate(skew), { readings: 3, gapMs: 0 });
    assert.equal(readings.length, 3);
    assert.ok(Math.abs(offset - skew) <= 60, `measured ${offset}, true ${skew}`);
  });
}

test("one reading reports its own error bound", async () => {
  const r = await readOffset(fakeServerDate(500, 40));
  assert.ok(Math.abs(r.offset - 500) <= r.error + 5, JSON.stringify(r));
});

test("race: with BRS's clock 1.5s ahead, sees the opening within ~150ms of the true moment", async () => {
  const skew = 1500;
  const opensAt = Date.now() + 2500;           // opening time on BRS's clock
  const trueOpenLocal = opensAt - skew;        // when that is on ours
  let requests = 0;
  const fetch = async () => { requests++; await new Promise((r) => setTimeout(r, 40)); return { open: Date.now() >= trueOpenLocal }; };
  const r = await raceOpening(fetch, { opensAt, offset: skew, isOpen: (sh) => sh.open });
  assert.ok(r, "saw it open");
  const late = r.sent - trueOpenLocal;
  assert.ok(late >= -60 && late <= 150, `request that saw it was sent ${late}ms after the true opening`);
  assert.ok(requests < 60, `kept requests modest: ${requests}`);
});

test("race: if the clock sync is wrong, still catches an opening outside the burst", async () => {
  const opensAt = Date.now() + 1000;
  const trueOpenLocal = opensAt + 3000;        // BRS actually opens 3s late
  const fetch = async () => { await new Promise((r) => setTimeout(r, 30)); return { open: Date.now() >= trueOpenLocal }; };
  const r = await raceOpening(fetch, { opensAt, offset: 0, isOpen: (sh) => sh.open });
  assert.ok(r && r.sent - trueOpenLocal <= 250, `late by ${r && r.sent - trueOpenLocal}ms`);
});

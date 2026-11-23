import { test } from "node:test";
import assert from "node:assert/strict";
import { bookDay, parseSheet } from "../src/booker/brs.mjs";

const MEMBERS = [["Maloney, Daniel", "3585"], ["Armstrong, Mark", "3589"], ["Crowther, Hugh", "3593"], ["Duffield, Peter", "3792"], ["Crowther JNR, Rocky", "4100"]];

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
 * A fake BRS tab. The feed returns `rows`. Opening a booking link shows the entry form: four player
 * <select>s listing every member (pre-filled from `form`), unless that time is in `lockedTimes`.
 * Submitting: refusedAtSubmit -> "Locked by another user"; silentAtSubmit -> no answer at all;
 * formBackAtSubmit -> the form comes back (rejected) until Create Booking is pressed the slow way.
 */
function fakePage(rows, { form = ["Maloney, Daniel"], picked = [], firstComp = null, lockedTimes = [], opened = [],
  refusedAtSubmit = [], silentAtSubmit = [], formBackAtSubmit = [], submitted = [], sent = [] } = {}) {
  let current = null, pressed = false, slowPressed = false, boxes = [];
  const refused = () => pressed && refusedAtSubmit.includes(current);
  const silent = () => pressed && silentAtSubmit.includes(current);
  const formBack = () => pressed && formBackAtSubmit.includes(current) && !slowPressed;
  const isLocked = () => (current && lockedTimes.includes(current)) || refused();
  const options = () => [{ value: "", textContent: "Start typing to find player..." }, ...MEMBERS.map(([t, v]) => ({ value: v, textContent: t }))];
  const makeBoxes = () => [0, 1, 2, 3].map((i) => {
    const opts = options();
    const pre = form[i] ? opts.find((o) => o.textContent === form[i]) : null;
    return {
      id: `member_booking_form_player_${i + 1}`, name: `member_booking_form[player_${i + 1}]`, disabled: !!pre, value: pre ? pre.value : "", options: opts,
      classList: { contains: () => false },
      get selectedOptions() { return this.options.filter((o) => o.value && o.value === this.value); },
      appendChild(o) { this.options.push(o); },
      dispatchEvent(ev) { if (ev.type === "change") picked.push([i + 1, this.selectedOptions[0].textContent]); return true; },
    };
  });
  const doc = {
    querySelector: (sel) => (sel.startsWith("form") ? { querySelectorAll: () => boxes, requestSubmit: () => { pressed = true; submitted.push(current); sent.push(boxes.map((b) => b.value).filter(Boolean)); } } : null),
    querySelectorAll: () => boxes,
    getElementById: () => ({}),
  };
  class FakeOption { constructor(text, value, _d, sel) { this.textContent = text; this.value = value; this.selected = sel; } }
  const formLoc = {
    first() { return this; },
    or() { return { first() { return this; }, waitFor: async () => {} }; },
    waitFor: async () => {},
    count: async () => (isLocked() || (pressed && !formBack()) ? 0 : 4),
  };
  const lockLoc = {
    first() { return this; }, filter() { return this; }, waitFor: async () => {},
    count: async () => (isLocked() ? 1 : 0),
    innerText: async () => "Locked by another user This Tee Time has been locked by another user until 19:19:02.",
    click: async () => {},
  };
  const request = { get: async () => ({ ok: () => true, status: () => 200, json: async () => feed(rows, firstComp) }) };
  const answer = () => (pressed && !refused() && !silent() && !formBack() ? "Booking confirmed. Your booking is confirmed." : "Tee sheet");
  return {
    context: () => ({ request }),
    goto: async (url) => { const m = url.match(/\/(\d{4})$/); current = m ? `${m[1].slice(0, 2)}:${m[1].slice(2)}` : null; pressed = false; slowPressed = false; boxes = makeBoxes(); opened.push(current); },
    getByText: () => ({ first() { return this; }, or() { return { first() { return this; }, waitFor: async () => {} }; } }),
    waitForURL: () => new Promise(() => {}),
    waitForFunction: async () => {},
    url: () => (formBack() ? "https://x/c/bookings/store/1/20261128/0812" : pressed ? "https://x/c/tee-sheet/1/2026/11/28" : "https://x/c/bookings/book/tok/1/20261128/0812"),
    waitForLoadState: async () => {},
    evaluate: async (fn, arg) => {
      const saved = { document: globalThis.document, Option: globalThis.Option, window: globalThis.window };
      globalThis.document = doc; globalThis.Option = FakeOption; globalThis.window = {}; // no jQuery: BRS's scripts not loaded yet
      try { return fn(arg); } finally { Object.assign(globalThis, saved); }
    },
    locator: (sel) => {
      if (sel.startsWith("select[id^=")) return formLoc;
      if (sel === "body") return { innerText: async () => answer() };
      if (sel === "#member_booking_form_confirm_booking") return { click: async () => { slowPressed = true; submitted.push(`${current} (slow)`); sent.push(boxes.map((b) => b.value).filter(Boolean)); } };
      if (sel.includes("form-error")) return { allInnerTexts: async () => ["Please select a player"] };
      return lockLoc;
    },
  };
}
const config = {
  baseUrl: "https://x", club: "c", courseId: 1, earliestTeeTime: "07:00", latestTeeTime: "23:59",
  competitionsOnly: true, retryWindowSeconds: 2, twoBallAfterSeconds: 60,
  players: { dan: { name: "Daniel Maloney", isBookingAccount: true, memberId: 3585 }, mark: { name: "Mark Armstrong", memberId: 3589 }, hugh: { name: "Hugh Crowther", memberId: 3593 } },
};
const opts = { dryRun: true, snap: async () => {}, log: (m) => process.env.DEBUG_LOG && console.log(m) };
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
  const r = await bookDay(fakePage(rows, { firstComp: "07:56" }), { ...config, firstSlot: "skip" }, "2026-11-21", partners, opts);
  assert.equal(r.time, "08:04");
});

test("first slot as fallback: tried only after the rest of the window", async () => {
  const opened = [];
  const rows = ["08:04", "08:12", "08:20"].map((time) => ({ time, comp: true, people: empty }));
  const r = await bookDay(fakePage(rows, { lockedTimes: ["08:12", "08:20"], opened }), { ...config, firstSlot: "fallback" }, "2026-11-28", partners, opts);
  assert.equal(r.time, "08:04");
  assert.deepEqual(opened, ["08:12", "08:20", "08:04"]);
});

test("first slot as target: goes for it first", async () => {
  const opened = [];
  const rows = ["08:04", "08:12"].map((time) => ({ time, comp: true, people: empty }));
  const r = await bookDay(fakePage(rows, { opened }), { ...config, firstSlot: "target" }, "2026-11-28", partners, opts);
  assert.equal(r.time, "08:04");
  assert.deepEqual(opened, ["08:04"]);
});

test("first slot is the first real tee time, not the competition's banner time", () => {
  const data = feed([{ time: "08:12", comp: true, people: empty }, { time: "08:20", comp: true, people: empty }], null);
  data.times["07:56"] = { competition_start: { start_time: "07:56", num_bookable_players: 3 } }; // banner only, as on Sun 29 Nov
  assert.equal(parseSheet(data, "2026-11-29").firstComp, "08:12");
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

// ---- pressing Create Booking

const book = { ...opts, dryRun: false };

test("books when BRS confirms", async () => {
  const r = await bookDay(fakePage([{ time: "08:12", comp: true, people: empty }]), config, "2026-11-28", partners, book);
  assert.deepEqual(r, { time: "08:12", unconfirmed: false, dropped: [] });
});

test("refused at Create Booking ('locked by another user'): moves straight on to the next slot", async () => {
  const submitted = [];
  const rows = ["08:12", "08:20", "08:36"].map((time) => ({ time, comp: true, people: empty }));
  const t0 = Date.now();
  const r = await bookDay(fakePage(rows, { refusedAtSubmit: ["08:12"], lockedTimes: ["08:20"], submitted }), config, "2026-11-28", partners, book);
  assert.deepEqual(r, { time: "08:36", unconfirmed: false, dropped: [] });
  assert.deepEqual(submitted, ["08:12", "08:36"], "pressed Create Booking on 08:12 (refused) then 08:36");
  assert.ok(Date.now() - t0 < 1000);
});

test("no confirmation and no refusal: stops, so it can't double-book", async () => {
  const submitted = [];
  const rows = ["08:12", "08:20"].map((time) => ({ time, comp: true, people: empty }));
  const r = await bookDay(fakePage(rows, { silentAtSubmit: ["08:12"], submitted }), config, "2026-11-28", partners, book);
  assert.deepEqual(r, { time: "08:12", unconfirmed: true, dropped: [] });
  assert.deepEqual(submitted, ["08:12"], "never pressed Create Booking on another slot");
});

test("sends all three member numbers with the form, Dan's included", async () => {
  const sent = [];
  await bookDay(fakePage([{ time: "08:12", comp: true, people: empty }], { form: [], sent }), config, "2026-11-28", partners, book);
  assert.deepEqual(sent, [["3585", "3589", "3593"]]);
});

test("if BRS sends the form back, enters the slow way once and books", async () => {
  const submitted = [];
  const r = await bookDay(fakePage([{ time: "08:12", comp: true, people: empty }], { formBackAtSubmit: ["08:12"], submitted }), config, "2026-11-28", partners, book);
  assert.deepEqual(r, { time: "08:12", unconfirmed: false, dropped: [] });
  assert.deepEqual(submitted, ["08:12", "08:12 (slow)"]);
});

test("a member number the rebuilt box lacks is added, not skipped", async () => {
  const sent = [];
  const page = fakePage([{ time: "08:12", comp: true, people: empty }], { form: ["Maloney, Daniel"], sent });
  const goto = page.goto;
  page.goto = async (url) => { await goto(url); }; // boxes start with the full list; remove Mark to mimic a rebuilt box
  const origEval = page.evaluate;
  page.evaluate = async (fn, arg) => origEval((a) => { for (const b of document.querySelectorAll()) b.options = b.options.filter((o) => o.value !== "3589" || b.disabled); return fn(a); }, arg);
  await bookDay(page, config, "2026-11-28", partners, book);
  assert.deepEqual(sent, [["3585", "3589", "3593"]]);
});

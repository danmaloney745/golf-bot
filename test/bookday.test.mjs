import { test } from "node:test";
import assert from "node:assert/strict";
import { bookDay } from "../src/booker/brs.mjs";

// A fake BRS tab: the tee sheet returns `slots`; the entry form has <select>s listing every member.
function fakePage(slots, picked) {
  const select = (n) => ({
    count: async () => 1,
    first() { return this; },
    evaluate: async () => "SELECT",
    locator: () => ({ allTextContents: async () => ["Armstrong, Mark", "Crowther, Hugh"] }),
    selectOption: async ({ label }) => { picked.push([n, label]); },
  });
  const nop = { first() { return this; }, waitFor: async () => {}, click: async () => {} };
  return {
    goto: async () => {}, waitForLoadState: async () => {},
    locator: () => nop,
    evaluate: async () => slots,
    getByLabel: (re) => select(Number(String(re).match(/\d/)[0])),
  };
}
const config = { baseUrl: "x", club: "c", courseId: 1, teeSheetPath: "/{club}", earliestTeeTime: "07:20", latestTeeTime: "23:59", competitionsOnly: true, retryWindowSeconds: 5 };
const opts = { dryRun: true, snap: async () => {}, log: () => {} };

test("three-ball when a slot has room", async () => {
  const picked = [];
  const r = await bookDay(fakePage([{ time: "07:40", index: 0, free: 2, comp: true }, { time: "07:48", index: 1, free: 4, comp: true }], picked), config, "2026-11-14", ["Mark Armstrong", "Hugh Crowther"], opts);
  assert.deepEqual(r, { time: "07:48", unconfirmed: false, dropped: [] });
  assert.equal(picked.length, 2);
});

test("drops the last partner when nothing fits three", async () => {
  const picked = [];
  const r = await bookDay(fakePage([{ time: "07:40", index: 0, free: 2, comp: true }, { time: "13:40", index: 1, free: 4, comp: false }], picked), config, "2026-11-14", ["Mark Armstrong", "Hugh Crowther"], opts);
  assert.deepEqual(r, { time: "07:40", unconfirmed: false, dropped: ["Hugh Crowther"] });
  assert.deepEqual(picked, [[2, "Armstrong, Mark"]]);
});

test("never takes a casual slot", async () => {
  const r = await bookDay(fakePage([{ time: "13:40", index: 0, free: 4, comp: false }], []), { ...config, retryWindowSeconds: 1 }, "2026-11-14", ["Mark Armstrong"], opts);
  assert.equal(r.time, null);
});

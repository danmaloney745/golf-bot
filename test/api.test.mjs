import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Swap DynamoDB for an in-memory map.
const db = {};
mock.module("../src/lib/store.mjs", {
  namedExports: {
    getWeekends: async (ids) => ids.filter((id) => db[id]).map((id) => db[id]),
    setTick: async (w, d, p, v) => { db[w] ??= { weekendOf: w }; db[w][d] = { ...(db[w][d] || {}), [p]: v }; },
  },
});
process.env.PAGE_KEY = "fore";
const { handler } = await import("../src/api/handler.mjs");
const req = (method, rawPath, query, body) => handler({ requestContext: { http: { method } }, rawPath, queryStringParameters: query, body: body && JSON.stringify(body) });

test("rejects requests without the key", async () => {
  assert.equal((await req("GET", "/", {})).statusCode, 403);
  assert.equal((await req("GET", "/", { k: "wrong" })).statusCode, 403);
});

test("serves the page with players filled in", async () => {
  const res = await req("GET", "/", { k: "fore" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Mark Armstrong/);
  assert.doesNotMatch(res.body, /__PLAYERS__|__OPENS_AT__/);
});

test("ticks save and read back", async () => {
  assert.equal((await req("POST", "/api/tick", { k: "fore" }, { weekend: "2026-11-14", day: "sat", player: "hugh", value: true })).statusCode, 200);
  const res = await req("GET", "/api/weekends", { k: "fore", ids: "2026-11-14,2026-11-21" });
  assert.deepEqual(JSON.parse(res.body).weekends, [{ weekendOf: "2026-11-14", sat: { hugh: true } }]);
});

test("rejects bad ticks", async () => {
  assert.equal((await req("POST", "/api/tick", { k: "fore" }, { weekend: "2026-11-14", day: "fri", player: "hugh", value: true })).statusCode, 400);
  assert.equal((await req("POST", "/api/tick", { k: "fore" }, { weekend: "2026-11-14", day: "sat", player: "tiger", value: true })).statusCode, 400);
});

test("Dan's box isn't on the page and can't be ticked", async () => {
  const page = (await req("GET", "/", { k: "fore" })).body;
  assert.doesNotMatch(page, /\["dan","Daniel Maloney"\]/);
  assert.match(page, /const ALWAYS=\["Daniel Maloney"\]/);
  assert.equal((await req("POST", "/api/tick", { k: "fore" }, { weekend: "2026-11-14", day: "sat", player: "dan", value: false })).statusCode, 400);
});

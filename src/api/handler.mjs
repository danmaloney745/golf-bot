// Page + API behind one Lambda function URL. Every request needs ?k=<PAGE_KEY>.
//   GET  /                         availability page
//   GET  /api/weekends?ids=a,b     ticks + booking results for those Saturdays
//   POST /api/tick                 { weekend, day: "sat"|"sun", player, value }
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { getWeekends, setTick } from "../lib/store.mjs";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8")
  .replaceAll("__PLAYERS__", JSON.stringify(Object.entries(config.players).map(([k, p]) => [k, p.name])))
  .replaceAll("__OPENS_AT__", config.opensAt)
  .replaceAll("__EARLIEST__", config.earliestTeeTime);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });

function keyOk(k) {
  const want = Buffer.from(process.env.PAGE_KEY || "");
  const got = Buffer.from(String(k || ""));
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

export async function handler(event) {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const q = event.queryStringParameters || {};

  if (!keyOk(q.k)) {
    return { statusCode: 403, headers: { "content-type": "text/plain" }, body: "This link is missing its key. Ask Dan for the full link." };
  }

  if (method === "GET" && path === "/") {
    return { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: PAGE };
  }

  if (method === "GET" && path === "/api/weekends") {
    const ids = String(q.ids || "").split(",").filter((s) => DATE.test(s)).slice(0, 4);
    return json(200, { weekends: await getWeekends(ids) });
  }

  if (method === "POST" && path === "/api/tick") {
    let body;
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}"); }
    catch { return json(400, { error: "Body must be JSON" }); }
    const { weekend, day, player, value } = body;
    if (!DATE.test(weekend || "") || !["sat", "sun"].includes(day) || !config.players[player] || typeof value !== "boolean") {
      return json(400, { error: "Expected { weekend: YYYY-MM-DD, day: sat|sun, player, value: boolean }" });
    }
    await setTick(weekend, day, player, value);
    return json(200, { ok: true });
  }

  return json(404, { error: "Not found" });
}

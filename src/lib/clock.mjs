// Sync to BRS's server clock. Its HTTP Date header only shows whole seconds, so we send quick
// requests until that second ticks over: the tick happened between the last "old second" response
// and the first "new second" one, which pins the gap between the clocks to within a few tens of ms.
import { sleep } from "./time.mjs";

/** One reading: { offset, error } in ms, where offset = BRS clock − our clock. */
export async function readOffset(fetchDate, { maxMs = 4000 } = {}) {
  const start = Date.now();
  let prev = null;
  while (Date.now() - start < maxMs) {
    const sent = Date.now();
    const server = await fetchDate(); // ms since epoch from the Date header, whole seconds
    const recv = Date.now();
    const mid = (sent + recv) / 2;
    if (prev && server > prev.server) {
      // BRS's clock reached `server` somewhere between the two responses' midpoints.
      const tickLocal = (prev.mid + mid) / 2;
      return { offset: Math.round(server - tickLocal), error: Math.round((mid - prev.mid) / 2 + (recv - sent) / 2) };
    }
    prev = { server, mid };
  }
  throw new Error("BRS clock didn't tick over while measuring");
}

/** Several readings a moment apart; the median is the answer, the spread shows how much to trust it. */
export async function measureOffset(fetchDate, { readings = 5, gapMs = 150 } = {}) {
  const out = [];
  for (let i = 0; i < readings; i++) {
    try { out.push(await readOffset(fetchDate)); } catch { /* skip a failed reading */ }
    await sleep(gapMs);
  }
  if (!out.length) return { offset: 0, error: null, readings: [] };
  const sorted = [...out].sort((a, b) => a.offset - b.offset);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { offset: median.offset, error: median.error, readings: out.map((r) => r.offset) };
}

/** Date-header reader for a Playwright request context. HEAD keeps each request tiny. */
export function dateFetcher(request, url) {
  let method = "HEAD";
  return async () => {
    let res = await request.fetch(url, { method, timeout: 3000, maxRedirects: 0 });
    if (method === "HEAD" && res.status() >= 400) { method = "GET"; res = await request.fetch(url, { method, timeout: 3000, maxRedirects: 0 }); }
    const d = Date.parse(res.headers()["date"] || "");
    if (Number.isNaN(d)) throw new Error("No Date header from BRS");
    return d;
  };
}

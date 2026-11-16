// Booking Lambda. Event: { mode: "book" | "dry-run" | "recon", now?: boolean }
// EventBridge invokes it with { mode: "book" } every Monday at 19:10 Dublin time.
import chromium from "@sparticuz/chromium";
import { chromium as pw } from "playwright-core";
import { readFileSync } from "node:fs";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getWeekend, saveResult } from "../lib/store.mjs";
import { targetWeekend, dublinInstant, sleep } from "../lib/time.mjs";
import { playersFor } from "../lib/slots.mjs";
import { login, bookDay, findSlots, firstCompetitionTime, teeSheetUrl, sheetDataUrl } from "./brs.mjs";
import { measureOffset, dateFetcher } from "../lib/clock.mjs";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const ssm = new SSMClient({});
const s3 = new S3Client({});

async function brsCredentials() {
  const { Parameters = [] } = await ssm.send(new GetParametersCommand({
    Names: ["/golf-bot/brs-username", "/golf-bot/brs-password"], WithDecryption: true,
  }));
  const get = (n) => Parameters.find((p) => p.Name === n)?.Value;
  const user = get("/golf-bot/brs-username"), pass = get("/golf-bot/brs-password");
  if (!user || !pass) throw new Error("BRS credentials missing from SSM (/golf-bot/brs-username, /golf-bot/brs-password)");
  return { user, pass };
}

export async function handler(event = {}) {
  const mode = event.mode || "book";
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + mode;
  const lines = [];
  const log = (...a) => { const l = `${new Date().toISOString()} ${a.join(" ")}`; console.log(l); lines.push(l); };
  const weekend = targetWeekend(config.opensAt);
  log(`Mode ${mode}, target weekend ${weekend.sat}/${weekend.sun}, opens ${weekend.opens} ${config.opensAt}`);

  const executablePath = await chromium.executablePath();
  // Chromium's bundled system libraries are unpacked under /tmp; make sure the child process finds them.
  process.env.LD_LIBRARY_PATH = ["/tmp/al2023/lib", "/tmp/al2/lib", "/tmp", process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  const browser = await pw.launch({ executablePath, args: chromium.args, headless: true });
  // One context = one logged-in session; each tab opened in it shares the login cookies.
  const context = await browser.newContext({ timezoneId: "Europe/Dublin", viewport: { width: 1280, height: 900 } });
  // Speed: skip adverts, analytics, fonts and images. BRS's own pages, scripts and styles still load
  // (styles decide which duplicate player cells are visible), and Stripe in case entry needs payment.
  if (mode !== "recon") {
    await context.route("**/*", (route) => {
      const req = route.request();
      const host = new URL(req.url()).hostname;
      const ours = host === "members.brsgolf.com" || /(^|\.)stripe\.(com|network)$/.test(host);
      if (!ours || ["image", "media", "font"].includes(req.resourceType())) return route.abort();
      return route.continue();
    });
  }
  const newTab = async () => { const p = await context.newPage(); p.setDefaultTimeout(15000); return p; };
  const page = await newTab();

  let shot = 0;
  const snapFor = (pg) => async (label) => {
    const key = `runs/${runId}/${String(++shot).padStart(2, "0")}-${label}`;
    const png = await pg.screenshot({ fullPage: true }).catch(() => null);
    const html = await pg.content().catch(() => "");
    await Promise.all([
      png && s3.send(new PutObjectCommand({ Bucket: process.env.RUNS_BUCKET, Key: `${key}.png`, Body: png, ContentType: "image/png" })),
      s3.send(new PutObjectCommand({ Bucket: process.env.RUNS_BUCKET, Key: `${key}.html`, Body: html, ContentType: "text/html" })),
    ]).catch(() => {});
  };
  const snap = snapFor(page);

  const result = { runId, mode, weekendOf: weekend.sat, sat: null, sun: null, log: lines };
  try {
    const opens = dublinInstant(weekend.opens, config.opensAt);
    if (mode === "book" && !event.now) await sleep(opens - Date.now() - 4 * 60_000);
    await login(page, config, await brsCredentials(), snap);
    log("Logged in");

    if (mode === "recon") {
      // Look at both tee sheets. Only open a booking form when asked ({click: true}): BRS holds the slot while it's open.
      for (const day of event.dates || (event.date ? [event.date] : [weekend.sat, weekend.sun])) {
        await page.goto(teeSheetUrl(config, day), { waitUntil: "domcontentloaded" });
        await snap(`tee-sheet-${day}`);
        const slots = await findSlots(page);
        log(`${day}: first competition slot ${await firstCompetitionTime(page)}`);
        // Network probe: which requests fill in the tee sheet, and how fast.
        const seen = [];
        const onResp = async (r) => {
          const t = r.request().resourceType();
          if (t !== "xhr" && t !== "fetch") return;
          const body = await r.text().catch(() => "");
          seen.push({ url: r.url(), status: r.status(), bytes: body.length, ms: Math.round(r.request().timing().responseEnd) });
          if (/json/i.test(r.headers()["content-type"] || "") && body.length > 1000) {
            await s3.send(new PutObjectCommand({ Bucket: process.env.RUNS_BUCKET, Key: `runs/${runId}/xhr-${day}-${seen.length}.json`, Body: body, ContentType: "application/json" })).catch(() => {});
          }
        };
        page.on("response", onResp);
        const t0 = Date.now();
        await page.goto(teeSheetUrl(config, day), { waitUntil: "domcontentloaded" });
        await page.locator(".size-marker").first().waitFor({ timeout: 10000 }).catch(() => {});
        log(`${day}: full page ${Date.now() - t0}ms; xhr: ${JSON.stringify(seen)}`);
        page.off("response", onResp);
        log(`${day}: book/enter buttons found: ${JSON.stringify(slots.slice(0, 10))}${slots.length > 10 ? ` (+${slots.length - 10} more)` : ""}`);
        if (event.click) slots.splice(0, slots.length, ...(await findSlots(page))); // the probe reloaded the page
        if (event.click && slots.length) {
          // Log every request the click makes, to see how BRS checks locks before opening the form.
          const target = slots.filter((x) => !x.comp && !x.taken).pop() || slots[slots.length - 1];
          const reqs = [];
          const onReq = (r) => { if (!/doubleclick|google|gstatic|fontawesome|adtraffic/.test(r.url())) reqs.push(`${Date.now()} ${r.method()} ${r.resourceType()} ${r.url().replace(/^https:\/\/members\.brsgolf\.com/, "")}`); };
          const onResp = (r) => { if (/members\.brsgolf\.com/.test(r.url()) && !/\.(js|css|png|svg|woff2?)/.test(r.url())) reqs.push(`${Date.now()}   <- ${r.status()} ${r.url().replace(/^https:\/\/members\.brsgolf\.com/, "")} ${r.headers()["location"] || ""}`); };
          page.on("request", onReq); page.on("response", onResp);
          log(`${day}: clicking ${target.time} to watch the requests`);
          await page.locator(`[data-bot-book="${target.index}"]`).click();
          await page.waitForTimeout(5000);
          page.off("request", onReq); page.off("response", onResp);
          log(`${day}: click requests:\n${reqs.join("\n")}`);
          await snap(`booking-form-${day}`);
        }
      }
      return result;
    }

    // Watch a real opening without booking: sync to BRS's clock, race the opening exactly as on a
    // Monday, and stop at "slot is open". Never opens a booking link, so nothing is locked or booked.
    if (mode === "watch") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date || "") || !/^\d{4}-\d{2}-\d{2}$/.test(event.opensDay || "") || !/^\d{2}:\d{2}$/.test(event.at || "")) {
        throw new Error("watch needs date (sheet), opensDay and at (HH:MM)");
      }
      const watchOpens = dublinInstant(event.opensDay, event.at).getTime();
      const watchConfig = { ...config, competitionsOnly: !event.casual, emptyOnly: false };
      const partners = Object.values(config.players).filter((p) => !p.isBookingAccount).map((p) => p.name);
      const clock = dateFetcher(context.request, sheetDataUrl(config, event.date));
      const first = await measureOffset(clock);
      log(`Clock: BRS is ${first.offset}ms ${first.offset >= 0 ? "ahead of" : "behind"} AWS (±${first.error}ms; readings ${first.readings.join(", ")})`);
      await sleep(watchOpens - first.offset - Date.now() - 20_000);
      const sync = await measureOffset(clock);
      log(`Clock 20s before: BRS ${sync.offset}ms (±${sync.error}ms; readings ${sync.readings.join(", ")})`);
      const v = await bookDay(page, watchConfig, event.date, partners, { watchOnly: true, snap, log, opensAt: watchOpens, offset: sync.offset });
      Object.assign(result, { watch: event.date, offset: sync.offset, ...v });
      log(v.time ? `Watched: ${v.time} became bookable` : "Watched: nothing opened");
      return result;
    }

    // One-off test on any date: all three players, a custom time window, casual slots allowed if asked.
    // Never reads or writes the availability page's data.
    if (event.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) throw new Error("date must be YYYY-MM-DD");
      const testConfig = { ...config, earliestTeeTime: event.from || config.earliestTeeTime, latestTeeTime: event.to || config.latestTeeTime, competitionsOnly: !event.casual, emptyOnly: event.emptyOnly !== false };
      const partners = Object.values(config.players).filter((p) => !p.isBookingAccount).map((p) => p.name);
      log(`Test ${mode} on ${event.date} ${testConfig.earliestTeeTime}-${testConfig.latestTeeTime}, ${event.casual ? "casual allowed" : "competitions only"}, with ${partners.join(", ")}`);
      const v = await bookDay(page, testConfig, event.date, partners, { dryRun: mode === "dry-run", snap, log });
      Object.assign(result, { test: event.date, ...v });
      log(v.time ? `${mode === "dry-run" ? "Would book" : v.unconfirmed ? "Submitted but unconfirmed:" : "Booked"} ${v.time}${v.dropped.length ? ` without ${v.dropped.join(", ")}` : ""}` : "Nothing booked");
      return result;
    }

    if (!event.now) await sleep(opens - Date.now() - 30_000);
    const availability = (await getWeekend(weekend.sat)) || { sat: {}, sun: {} };

    // Work out each day's group, and give each day its own tab so neither waits on the other.
    const jobs = [];
    for (const day of ["sat", "sun"]) {
      const keys = playersFor(day, availability, config);
      if (!keys.length) { log(`${day}: nobody ticked`); continue; }
      if (!keys.some((k) => config.players[k].isBookingAccount)) { log(`${day}: Dan not ticked, skipping (bookings use his account)`); continue; }
      const partners = keys.filter((k) => !config.players[k].isBookingAccount).map((k) => config.players[k].name);
      const tab = jobs.length === 0 ? page : await newTab();
      jobs.push({ day, partners, tab, snap: snapFor(tab) });
      log(`${day}: ${keys.length} player(s)`);
    }
    // Warm each tab up on its sheet so BRS's scripts and styles are cached before the race.
    await Promise.all(jobs.map((j) => j.tab.goto(teeSheetUrl(config, weekend[j.day]), { waitUntil: "domcontentloaded" }).catch(() => {})));
    const opensAt = event.now ? Date.now() : opens.getTime();
    // Sync to BRS's clock: it decides the opening moment, not ours.
    let offset = 0;
    if (!event.now && jobs.length) {
      const sync = await measureOffset(dateFetcher(context.request, sheetDataUrl(config, weekend[jobs[0].day])));
      offset = sync.offset;
      log(`Clock: BRS is ${sync.offset}ms ${sync.offset >= 0 ? "ahead of" : "behind"} AWS (±${sync.error}ms; readings ${sync.readings.join(", ")})`);
    }
    const run = (j) => bookDay(j.tab, config, weekend[j.day], j.partners, { dryRun: mode === "dry-run", snap: j.snap, log: (m) => log(`[${j.day}] ${m}`), opensAt, offset });

    // Start polling the sheet 2.5s early so the bot sees the slots the moment BRS opens them.
    if (!event.now) await sleep(opens - offset - Date.now() - 3000);
    const settled = await Promise.allSettled(jobs.map(run));
    const record = (j, v) => {
      result[j.day] = v.time ? (v.unconfirmed ? `${v.time}?` : v.time) : null;
      result[`${j.day}Missing`] = v.time ? v.dropped : [];
    };
    jobs.forEach((j, i) => {
      const s = settled[i];
      if (s.status === "fulfilled") record(j, s.value);
      else log(`[${j.day}] error: ${s.reason?.message || s.reason}`);
    });

    // If BRS only lets one entry be in progress per account, the parallel attempt can lose. Retry those days one at a time.
    if (jobs.length > 1) {
      for (const j of jobs.filter((j) => result[j.day] === null)) {
        log(`[${j.day}] retrying on its own`);
        try { record(j, await run(j)); } catch (e) { log(`[${j.day}] retry error: ${e.message}`); }
      }
    }
    for (const j of jobs) {
      log(`${j.day}: ${result[j.day] ? (result[j.day].endsWith("?") ? `submitted ${result[j.day]} but unconfirmed` : `booked ${result[j.day]}`) : "not booked"}`);
      if (result[`${j.day}Missing`]?.length) log(`${j.day}: left out, needs to enter himself: ${result[`${j.day}Missing`].join(", ")}`);
    }
    return result;
  } catch (e) {
    log(`ERROR ${e.message}`);
    await snap("error");
    result.error = e.message;
    throw e;
  } finally {
    await browser.close().catch(() => {});
    await s3.send(new PutObjectCommand({ Bucket: process.env.RUNS_BUCKET, Key: `runs/${runId}/log.txt`, Body: lines.join("\n"), ContentType: "text/plain" })).catch(() => {});
    if (mode !== "recon" && !event.date) await saveResult(weekend.sat, { runId, mode, sat: result.sat, sun: result.sun, satMissing: result.satMissing || [], sunMissing: result.sunMissing || [], error: result.error || null, at: new Date().toISOString() }).catch((e) => console.error("saveResult", e));
  }
}

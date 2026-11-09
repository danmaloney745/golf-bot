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
import { login, bookDay, findSlots, teeSheetUrl } from "./brs.mjs";

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
      for (const day of event.dates || [weekend.sat, weekend.sun]) {
        await page.goto(teeSheetUrl(config, day), { waitUntil: "domcontentloaded" });
        await snap(`tee-sheet-${day}`);
        const slots = await findSlots(page);
        log(`${day}: book/enter buttons found: ${JSON.stringify(slots.slice(0, 10))}${slots.length > 10 ? ` (+${slots.length - 10} more)` : ""}`);
        if (event.click && slots.length) {
          await page.locator(`[data-bot-book="${slots[0].index}"]`).click();
          await page.waitForLoadState("domcontentloaded");
          await snap(`booking-form-${day}`);
        }
      }
      return result;
    }

    // One-off test on any date: all three players, a custom time window, casual slots allowed if asked.
    // Never reads or writes the availability page's data.
    if (event.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) throw new Error("date must be YYYY-MM-DD");
      const testConfig = { ...config, earliestTeeTime: event.from || config.earliestTeeTime, latestTeeTime: event.to || config.latestTeeTime, competitionsOnly: !event.casual };
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
    const run = (j) => bookDay(j.tab, config, weekend[j.day], j.partners, { dryRun: mode === "dry-run", snap: j.snap, log: (m) => log(`[${j.day}] ${m}`) });

    if (!event.now) await sleep(opens - Date.now());
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

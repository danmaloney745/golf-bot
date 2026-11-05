// Craddockstown BRS tee-time bot.
//   node src/book.mjs            wait for opening, then book whoever opted in
//   node src/book.mjs --recon    log in, save tee sheet + booking form for inspection, book nothing
//   node src/book.mjs --dry-run  full run, but stop before the final confirm button
//   --now                        skip waiting for the opening time
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { targetWeekend, dublinInstant, sleep } from "./time.mjs";
import { orderSlots, playersFor, nameMatches } from "./slots.mjs";

const args = new Set(process.argv.slice(2));
const RECON = args.has("--recon"), DRY = args.has("--dry-run"), NOW = args.has("--now");
const config = JSON.parse(readFileSync("config.json", "utf8"));
const OUT = "out";
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
let shot = 0;
async function snap(page, label) {
  const n = String(++shot).padStart(2, "0");
  await page.screenshot({ path: `${OUT}/${n}-${label}.png`, fullPage: true }).catch(() => {});
  writeFileSync(`${OUT}/${n}-${label}.html`, await page.content().catch(() => ""));
}

const user = process.env.BRS_USERNAME, pass = process.env.BRS_PASSWORD;
if (!user || !pass) throw new Error("BRS_USERNAME and BRS_PASSWORD must be set (GitHub repo secrets).");

const weekend = targetWeekend(config.opensAt);
log("Target weekend", weekend);

function loadAvailability() {
  const a = JSON.parse(readFileSync("availability.json", "utf8"));
  if (a.weekendOf !== weekend.sat) {
    throw new Error(`availability.json is for ${a.weekendOf}, not ${weekend.sat}. Refusing to book from stale ticks.`);
  }
  return a;
}

function teeSheetUrl(dayIso) {
  const [yyyy, mm, dd] = dayIso.split("-");
  return config.baseUrl + config.teeSheetPath
    .replace("{club}", config.club).replace("{courseId}", config.courseId)
    .replace("{yyyy}", yyyy).replace("{mm}", mm).replace("{dd}", dd);
}

async function login(page) {
  await page.goto(`${config.baseUrl}/${config.club}/login`, { waitUntil: "domcontentloaded" });
  const userBox = page.getByLabel(/user ?name|membership/i).or(page.locator('input[name*="user" i]')).first();
  const passBox = page.getByLabel(/password/i).or(page.locator('input[type="password"]')).first();
  await userBox.fill(user);
  await passBox.fill(pass);
  await page.getByRole("button", { name: /log ?in|sign ?in/i }).first().click();
  await page.waitForLoadState("networkidle").catch(() => {});
  if (/\/login/.test(page.url())) {
    await snap(page, "login-failed");
    throw new Error("Login failed: still on the login page. Check the BRS secrets.");
  }
  log("Logged in");
}

/** Find bookable slots on the tee sheet: every "Book" control with the tee time in its row. */
async function findSlots(page) {
  return page.evaluate(() => {
    const out = [];
    const controls = [...document.querySelectorAll("a, button")].filter((el) => /^\s*book\b/i.test(el.textContent || "") && !el.disabled);
    controls.forEach((el, i) => {
      el.setAttribute("data-bot-book", String(i));
      let node = el, time = null;
      for (let up = 0; up < 8 && node && !time; up++, node = node.parentElement) {
        const m = (node.innerText || "").match(/\b([01]\d|2[0-3])[:.]([0-5]\d)\b/);
        if (m) time = `${m[1]}:${m[2]}`;
      }
      if (time) out.push({ time, index: i });
    });
    return out;
  });
}

async function pickPlayer(page, slotNumber, fullName) {
  // Selects labelled "Player 2" etc.
  const select = page.getByLabel(new RegExp(`player\\s*${slotNumber}`, "i")).first();
  if (await select.count()) {
    const tag = await select.evaluate((el) => el.tagName);
    if (tag === "SELECT") {
      const options = await select.locator("option").allTextContents();
      const label = options.find((o) => nameMatches(o, fullName));
      if (!label) throw new Error(`${fullName} not found in Player ${slotNumber} list`);
      await select.selectOption({ label });
      return;
    }
    // Type-ahead search box
    await select.click();
    await select.fill(fullName.split(" ").pop());
    const option = page.getByRole("option").filter({ hasText: new RegExp(fullName.split(" ").pop(), "i") });
    await option.first().waitFor({ timeout: 5000 });
    for (const o of await option.all()) {
      if (nameMatches(await o.innerText(), fullName)) { await o.click(); return; }
    }
    throw new Error(`${fullName} not offered for Player ${slotNumber}`);
  }
  throw new Error(`No Player ${slotNumber} field found on the booking form`);
}

async function tryBook(page, dayIso, slot, partners) {
  await page.locator(`[data-bot-book="${slot.index}"]`).click();
  await page.waitForLoadState("domcontentloaded");
  await snap(page, `${dayIso}-${slot.time.replace(":", "")}-form`);
  for (let i = 0; i < partners.length; i++) await pickPlayer(page, i + 2, partners[i]);
  if (DRY) { log(`DRY RUN: would confirm ${dayIso} ${slot.time}`); await snap(page, "dry-run-ready"); return true; }
  await page.getByRole("button", { name: /confirm|create booking|book now|complete/i }).first().click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await snap(page, `${dayIso}-${slot.time.replace(":", "")}-result`);
  const body = await page.locator("body").innerText();
  if (/booking (confirmed|complete|successful|made)|successfully booked|your booking/i.test(body)) return true;
  throw new Error("No confirmation message after submitting");
}

async function bookDay(page, day, dayIso, availability) {
  const keys = playersFor(day, availability, config);
  if (!keys.length) { log(`${day} ${dayIso}: nobody ticked, skipping`); return null; }
  if (!keys.some((k) => config.players[k].isBookingAccount)) {
    log(`${day} ${dayIso}: Dan isn't ticked, and bookings go through his account, so skipping`);
    return null;
  }
  const partners = keys.filter((k) => !config.players[k].isBookingAccount).map((k) => config.players[k].name);
  log(`${day} ${dayIso}: booking ${keys.length} (${["Dan", ...partners].join(", ")})`);

  const deadline = Date.now() + config.retryWindowSeconds * 1000;
  const tried = new Set();
  while (Date.now() < deadline) {
    await page.goto(teeSheetUrl(dayIso), { waitUntil: "domcontentloaded" });
    const slots = orderSlots(await findSlots(page), config.earliestTeeTime, config.latestTeeTime).filter((s) => !tried.has(s.time));
    if (!slots.length) { await sleep(1500); continue; } // sheet not open yet, or everything tried
    const slot = slots[0];
    tried.add(slot.time);
    try {
      if (await tryBook(page, dayIso, slot, partners)) { log(`BOOKED ${dayIso} ${slot.time}`); return slot.time; }
    } catch (e) {
      log(`${slot.time} failed: ${e.message}. Trying next slot.`);
    }
  }
  log(`${day} ${dayIso}: gave up after ${config.retryWindowSeconds}s`);
  return null;
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ timezoneId: "Europe/Dublin" })).newPage();
page.setDefaultTimeout(15000);
const summary = [];
try {
  if (!RECON && !NOW) {
    const opens = dublinInstant(weekend.opens, config.opensAt);
    log(`Waiting until ${opens.toISOString()} (19:16 Dublin)`);
    await sleep(opens - Date.now() - 4 * 60_000);
  }
  await login(page);

  if (RECON) {
    await page.goto(teeSheetUrl(weekend.sat), { waitUntil: "domcontentloaded" });
    await snap(page, "tee-sheet");
    const slots = await findSlots(page);
    log("Book buttons found:", JSON.stringify(slots));
    if (slots.length) {
      await page.locator(`[data-bot-book="${slots[0].index}"]`).click();
      await page.waitForLoadState("domcontentloaded");
      await snap(page, "booking-form");
    }
  } else {
    // Pick up any last-minute ticks pushed to the repo.
    try { execSync("git pull --ff-only -q", { stdio: "inherit" }); } catch { log("git pull failed; using checked-out availability"); }
    const availability = loadAvailability();
    if (!NOW) await sleep(dublinInstant(weekend.opens, config.opensAt) - Date.now());
    for (const day of ["sat", "sun"]) {
      const time = await bookDay(page, day, weekend[day], availability);
      summary.push(`${day === "sat" ? "Saturday" : "Sunday"} ${weekend[day]}: ${time ? `booked ${time}` : "not booked"}`);
    }
  }
} catch (e) {
  await snap(page, "error");
  throw e;
} finally {
  await browser.close();
  if (summary.length) {
    log(summary.join(" | "));
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary.map((s) => `- ${s}`).join("\n") + "\n", { flag: "a" });
  }
}

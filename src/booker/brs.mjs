// Browser steps against the BRS member site. Selectors are best guesses until a recon run confirms them.
import { orderSlots, nameMatches } from "../lib/slots.mjs";
import { sleep } from "../lib/time.mjs";

export function teeSheetUrl(config, dayIso) {
  const [yyyy, mm, dd] = dayIso.split("-");
  return config.baseUrl + config.teeSheetPath
    .replace("{club}", config.club).replace("{courseId}", config.courseId)
    .replace("{yyyy}", yyyy).replace("{mm}", mm).replace("{dd}", dd);
}

export async function login(page, config, { user, pass }, snap) {
  await page.goto(`${config.baseUrl}/${config.club}/login`, { waitUntil: "domcontentloaded" });
  const userBox = page.getByLabel(/user ?name|membership/i).or(page.locator('input[name*="user" i]')).first();
  const passBox = page.getByLabel(/password/i).or(page.locator('input[type="password"]')).first();
  await userBox.fill(user);
  await passBox.fill(pass);
  await page.getByRole("button", { name: /log ?in|sign ?in/i }).first().click();
  await page.waitForLoadState("networkidle").catch(() => {});
  if (/\/login/.test(page.url())) {
    await snap("login-failed");
    throw new Error("Login failed: still on the login page. Check the BRS username and password.");
  }
}

/**
 * Every enabled "Book"/"Enter" control on the tee sheet, with its tee time and free spaces.
 * BRS renders each tee time as a <tr>: the time in a .size-marker in the row's <th>, and four
 * player spaces as div.flex.items-center cells (a name or "x" when taken, empty when free).
 * `free` is null when the row's spaces can't be read, so the caller doesn't skip it on a guess.
 */
export async function findSlots(page) {
  return page.evaluate(() => {
    const out = [];
    const TIME = /\b([01]\d|2[0-3])[:.]([0-5]\d)\b/;
    const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
    const controls = [...document.querySelectorAll("a, button")]
      .filter((el) => /^\s*(book|enter)\b/i.test(el.textContent || "") && !el.disabled && visible(el));
    controls.forEach((el, i) => {
      el.setAttribute("data-bot-book", String(i));
      const row = el.closest("tr");
      let time = null;
      const marker = row?.querySelector(".size-marker");
      const mm = marker && (marker.textContent || "").match(TIME);
      if (mm) time = `${mm[1]}:${mm[2]}`;
      for (let node = el, up = 0; !time && node && up < 8; up++, node = node.parentElement) {
        const m = (node.innerText || "").match(TIME);
        if (m) time = `${m[1]}:${m[2]}`;
      }
      let free = null;
      if (row) {
        const spaces = [...row.querySelectorAll("td div.flex.items-center")].filter(visible);
        if (spaces.length) free = spaces.filter((s) => !(s.textContent || "").trim()).length;
      }
      if (time) out.push({ time, index: i, free });
    });
    return out;
  });
}

async function pickPlayer(page, slotNumber, fullName) {
  const field = page.getByLabel(new RegExp(`player\\s*${slotNumber}`, "i")).first();
  if (!(await field.count())) throw new Error(`No Player ${slotNumber} field on the booking form`);
  if ((await field.evaluate((el) => el.tagName)) === "SELECT") {
    const label = (await field.locator("option").allTextContents()).find((o) => nameMatches(o, fullName));
    if (!label) throw new Error(`${fullName} not in the Player ${slotNumber} list`);
    await field.selectOption({ label });
    return;
  }
  const surname = fullName.split(" ").pop();
  await field.click();
  await field.fill(surname);
  const options = page.getByRole("option").filter({ hasText: new RegExp(surname, "i") });
  await options.first().waitFor({ timeout: 5000 });
  for (const o of await options.all()) {
    if (nameMatches(await o.innerText(), fullName)) { await o.click(); return; }
  }
  throw new Error(`${fullName} not offered for Player ${slotNumber}`);
}

async function tryBook(page, dayIso, slot, partners, { dryRun, snap }) {
  await page.locator(`[data-bot-book="${slot.index}"]`).click();
  await page.waitForLoadState("domcontentloaded");
  await snap(`${dayIso}-${slot.time.replace(":", "")}-form`);
  for (let i = 0; i < partners.length; i++) await pickPlayer(page, i + 2, partners[i]);
  if (dryRun) { await snap("dry-run-ready"); return true; }
  await page.getByRole("button", { name: /confirm|create booking|book now|complete/i }).first().click();
  // From here the entry may have gone through, so never move on to another slot.
  await page.waitForLoadState("networkidle").catch(() => {});
  await snap(`${dayIso}-${slot.time.replace(":", "")}-result`);
  const body = await page.locator("body").innerText().catch(() => "");
  if (/booking (confirmed|complete|successful|made)|successfully (booked|entered)|your booking|entry (confirmed|received)/i.test(body)) return true;
  throw new SubmittedError("Submitted, but no confirmation message seen");
}

/** Thrown once the final button has been pressed: the entry may exist, so trying another slot could double-book. */
export class SubmittedError extends Error {}

/**
 * Book one day, earliest slot from config.earliestTeeTime, falling back slot by slot.
 * Returns the time booked, "HH:MM?" if submitted but unconfirmed (check BRS), or null.
 */
export async function bookDay(page, config, dayIso, partners, { dryRun, snap, log }) {
  const deadline = Date.now() + config.retryWindowSeconds * 1000;
  const tried = new Set();
  // One load at opening time; if entry isn't showing yet, reload every 3s, at most 8 times.
  let emptyLoads = 0;
  while (Date.now() < deadline) {
    await page.goto(teeSheetUrl(config, dayIso), { waitUntil: "domcontentloaded" });
    await page.locator(".size-marker").first().waitFor({ timeout: 10000 }).catch(() => {});
    const slots = orderSlots(await findSlots(page), config.earliestTeeTime, config.latestTeeTime, partners.length + 1)
      .filter((s) => !tried.has(s.time));
    if (!slots.length) {
      if (++emptyLoads >= 8) { log(`${dayIso}: no enterable slots after ${emptyLoads} loads`); await snap(`${dayIso}-no-slots`); break; }
      await sleep(3000);
      continue;
    }
    const slot = slots[0];
    tried.add(slot.time);
    try {
      if (await tryBook(page, dayIso, slot, partners, { dryRun, snap })) return slot.time;
    } catch (e) {
      if (e instanceof SubmittedError) {
        log(`${dayIso} ${slot.time}: ${e.message}. Stopping this day so it can't double-book; check BRS.`);
        return `${slot.time}?`;
      }
      log(`${dayIso} ${slot.time} failed: ${e.message}. Trying next slot.`);
    }
  }
  return null;
}

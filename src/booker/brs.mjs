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
      let free = null, taken = null;
      if (row) {
        const spaces = [...row.querySelectorAll("td div.flex.items-center")].filter(visible).map((s) => (s.textContent || "").trim());
        if (spaces.length) {
          free = spaces.filter((t) => !t).length;
          taken = spaces.filter((t) => t && t.toLowerCase() !== "x").length; // "x" = space blocked, not a person
        }
      }
      // Competition rows carry "Members Competition"; casual rows only show players' names.
      const comp = /competition/i.test(row?.textContent || "");
      if (time) out.push({ time, index: i, free, taken, comp });
    });
    return out;
  });
}

/**
 * Fill the booking form. Each space is <select id="member_booking_form_player_N">; spaces already
 * taken (by you, or by someone else on a part-booked slot) are disabled with a member selected.
 * Everyone in `names` who isn't already on the booking goes into the empty spaces, in order.
 */
async function fillPlayers(page, names) {
  const fields = page.locator('select[id^="member_booking_form_player_"]');
  await fields.first().waitFor({ state: "attached", timeout: 10000 });
  const spaces = [];
  for (let i = 0; i < (await fields.count()); i++) {
    const f = fields.nth(i);
    const [disabled, current] = await f.evaluate((el) => [el.disabled, el.value ? (el.selectedOptions[0]?.textContent || "").trim() : ""]);
    spaces.push({ f, disabled, current });
  }
  const onIt = spaces.map((s) => s.current).filter(Boolean);
  const todo = names.filter((n) => !onIt.some((c) => nameMatches(c, n)));
  const empty = spaces.filter((s) => !s.disabled && !s.current);
  if (empty.length < todo.length) throw new Error(`Only ${empty.length} free space(s) for ${todo.join(", ")}`);
  for (let i = 0; i < todo.length; i++) {
    const label = (await empty[i].f.locator("option").allTextContents()).find((o) => nameMatches(o, todo[i]));
    if (!label) throw new Error(`${todo[i]} isn't in the player list`);
    await empty[i].f.selectOption({ label: label.trim() }, { force: true });
  }
  return { already: onIt, added: todo };
}

async function tryBook(page, dayIso, slot, names, { dryRun, snap, log }) {
  await page.locator(`[data-bot-book="${slot.index}"]`).click();
  await page.waitForLoadState("domcontentloaded");
  await snap(`${dayIso}-${slot.time.replace(":", "")}-form`);
  const { already, added } = await fillPlayers(page, names);
  log(`${dayIso} ${slot.time}: already on it: ${already.join(", ") || "nobody"}; adding: ${added.join(", ") || "nobody"}`);
  if (dryRun) { await snap("dry-run-ready"); return true; }
  // BRS labels the final button "Update Booking"; the others are fallbacks.
  await page.getByRole("button", { name: /update booking|confirm|create booking|save booking|complete booking/i }).first().click({ timeout: 5000 });
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
 * If entry is open but no slot has room for the whole group, the lowest-priority partner
 * (last in config.players) is dropped, down to a two-ball: BRS only allows one booking per
 * hour per account, so a split across two times isn't possible.
 * Returns { time, unconfirmed, dropped }: time is null if nothing was entered.
 */
export async function bookDay(page, config, dayIso, partners, { dryRun, snap, log }) {
  const deadline = Date.now() + config.retryWindowSeconds * 1000;
  const tried = new Set();
  const group = [...partners], dropped = [];
  const me = Object.values(config.players).find((p) => p.isBookingAccount).name;
  const fits = (open) => orderSlots(open, config.earliestTeeTime, config.latestTeeTime, group.length + 1).filter((s) => !tried.has(s.time));
  // One load at opening time; if entry isn't showing yet, reload every 3s, at most 8 times.
  let emptyLoads = 0;
  while (Date.now() < deadline) {
    await page.goto(teeSheetUrl(config, dayIso), { waitUntil: "domcontentloaded" });
    await page.locator(".size-marker").first().waitFor({ timeout: 10000 }).catch(() => {});
    const open = (await findSlots(page)).filter((s) => (!config.competitionsOnly || s.comp) && (!config.emptyOnly || !s.taken) && !tried.has(s.time));
    let slots = fits(open);
    while (!slots.length && open.length && group.length > 1) {
      dropped.unshift(group.pop());
      log(`${dayIso}: no slot with room for everyone; entering ${group.length + 1} without ${dropped[0]}`);
      slots = fits(open);
    }
    if (!slots.length) {
      if (++emptyLoads >= 8) { log(`${dayIso}: no enterable slots after ${emptyLoads} loads`); await snap(`${dayIso}-no-slots`); break; }
      await sleep(3000);
      continue;
    }
    const slot = slots[0];
    tried.add(slot.time);
    try {
      if (await tryBook(page, dayIso, slot, [me, ...group], { dryRun, snap, log })) return { time: slot.time, unconfirmed: false, dropped };
    } catch (e) {
      if (e instanceof SubmittedError) {
        log(`${dayIso} ${slot.time}: ${e.message}. Stopping this day so it can't double-book; check BRS.`);
        return { time: slot.time, unconfirmed: true, dropped };
      }
      log(`${dayIso} ${slot.time} failed: ${e.message}. Trying next slot.`);
    }
  }
  return { time: null, unconfirmed: false, dropped: [] };
}

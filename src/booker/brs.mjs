// Browser steps against the BRS member site. Selectors are best guesses until a recon run confirms them.
import { orderSlots, nameMatches } from "../lib/slots.mjs";
import { sleep, toMinutes, dublinParts, dublinInstant } from "../lib/time.mjs";

export function teeSheetUrl(config, dayIso) {
  const [yyyy, mm, dd] = dayIso.split("-");
  return config.baseUrl + config.teeSheetPath
    .replace("{club}", config.club).replace("{courseId}", config.courseId)
    .replace("{yyyy}", yyyy).replace("{mm}", mm).replace("{dd}", dd);
}

/** The tee sheet's own data feed: the JSON the page fetches to draw the sheet. */
export function sheetDataUrl(config, dayIso) {
  const [yyyy, mm, dd] = dayIso.split("-");
  return `${config.baseUrl}/${config.club}/tee-sheet/data/${config.courseId}/${yyyy}/${mm}/${dd}`;
}

/**
 * Turn the feed into slots. Each tee time has bookable/url, and four participants:
 * a name when taken, null when free, "x" when the space is blocked.
 */
export function parseSheet(data, dayIso) {
  const ymd = dayIso.replaceAll("-", "");
  const slots = [];
  let firstComp = null;
  // Competitions cap the group (3 at Craddockstown, the 4th space shows "x"); casual slots take 4.
  const compCap = Object.values(data?.times || {}).map((v) => v?.competition_start?.num_bookable_players).find((n) => n > 0) || 3;
  for (const [time, v] of Object.entries(data?.times || {})) {
    const t = v?.tee_time;
    if (!t || !/^\d{2}:\d{2}$/.test(time)) continue;
    const comp = /competition/i.test(t.reservation_type || "");
    const start = v.competition_start?.start_time;
    if (start && (!firstComp || start < firstComp)) firstComp = start;
    const people = Array.isArray(t.participants) ? t.participants : [];
    slots.push({
      time, comp,
      bookable: !!t.bookable && !!t.url,
      // The feed's link normally ends with the date and time already; add them if it doesn't.
      path: t.url ? (/\/\d{8}\/\d{4}$/.test(t.url) ? t.url : `${t.url.replace(/\/?$/, "/")}${ymd}/${time.replace(":", "")}`) : null,
      // An empty slot comes with no participants at all; a part-booked one lists all four spaces.
      free: people.length ? people.filter((p) => p && p.name == null).length : (comp ? compCap : 4),
      taken: people.filter((p) => p && p.name && String(p.name).toLowerCase() !== "x").length,
      reason: t.reason || null,
    });
  }
  if (!firstComp) firstComp = slots.filter((s) => s.comp).map((s) => s.time).sort()[0] || null;
  return { slots, firstComp };
}

/** Fetch the feed with the logged-in session's cookies. Far quicker than rendering the sheet. */
export async function fetchSheet(request, config, dayIso) {
  const res = await request.get(`${sheetDataUrl(config, dayIso)}?_=${Date.now()}`, {
    headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json, text/javascript, */*; q=0.01" },
    timeout: 5000,
  });
  if (!res.ok()) throw new Error(`tee sheet data returned ${res.status()}`);
  return parseSheet(await res.json(), dayIso);
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
/**
 * The competition's first tee time on the sheet, whether or not entry is open yet:
 * the earliest row that says "Competition" and has a time marker. null if none.
 */
export async function firstCompetitionTime(page) {
  return page.evaluate((what) => {
    if (what !== "firstComp") return null;
    const TIME = /\b([01]\d|2[0-3])[:.]([0-5]\d)\b/;
    const times = [...document.querySelectorAll("tr")]
      .filter((r) => /competition/i.test(r.textContent || ""))
      .map((r) => (r.querySelector(".size-marker")?.textContent || "").match(TIME))
      .filter(Boolean).map((m) => `${m[1]}:${m[2]}`).sort();
    return times[0] || null;
  }, "firstComp");
}

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

async function tryBook(page, config, dayIso, slot, names, { dryRun, snap, log, mark }) {
  // Opening the booking link is exactly what Book Now does; BRS locks the slot for us on this request.
  mark(`${slot.time}: opening booking link`);
  await page.goto(config.baseUrl + slot.path, { waitUntil: "commit" });
  // Either the entry form opens, or BRS says another member holds the slot, or sends us back to the sheet.
  const form = page.locator('select[id^="member_booking_form_player_"]').first();
  const locked = page.locator(".swal2-popup").filter({ hasText: /locked by another user/i });
  await Promise.race([
    form.or(locked).first().waitFor({ state: "attached", timeout: 10000 }),
    page.waitForURL(/\/tee-sheet\//, { timeout: 10000 }).then(() => locked.first().waitFor({ state: "attached", timeout: 3000 }).catch(() => {})),
  ]).catch(() => {});
  if (await locked.count()) {
    const text = await locked.first().innerText().catch(() => "");
    await page.locator(".swal2-confirm").first().click({ timeout: 2000 }).catch(() => {});
    throw new LockedError(text);
  }
  if (!(await form.count())) {
    if (/\/tee-sheet\//.test(page.url())) throw new LockedError("");
    throw new Error("Booking form didn't open");
  }
  mark(`${slot.time}: form open`);
  if (dryRun) await snap(`${dayIso}-${slot.time.replace(":", "")}-form`);
  const { already, added } = await fillPlayers(page, names);
  log(`${dayIso} ${slot.time}: already on it: ${already.join(", ") || "nobody"}; adding: ${added.join(", ") || "nobody"}`);
  if (dryRun) { await snap("dry-run-ready"); return true; }
  // BRS labels the final button "Create Booking" (empty slot) or "Update Booking" (part-booked).
  await page.getByRole("button", { name: /update booking|confirm|create booking|save booking|complete booking/i }).first().click({ timeout: 5000 });
  mark(`${slot.time}: submitted`);
  // From here the entry may have gone through, so never move on to another slot.
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.getByText(/booking confirmed|booking is confirmed/i).first().waitFor({ timeout: 8000 }).catch(() => {});
  await snap(`${dayIso}-${slot.time.replace(":", "")}-result`);
  const body = await page.locator("body").innerText().catch(() => "");
  if (/booking (confirmed|complete|successful|made)|successfully (booked|entered)|your booking|entry (confirmed|received)/i.test(body)) { mark(`${slot.time}: confirmed`); return true; }
  throw new SubmittedError("Submitted, but no confirmation message seen");
}

/** Thrown once the final button has been pressed: the entry may exist, so trying another slot could double-book. */
export class SubmittedError extends Error {}

/** Another member is holding the slot. `until` is when their lock runs out (ms), so it can be tried again. */
export class LockedError extends Error {
  constructor(text) {
    super("Locked by another user");
    const m = (text || "").match(/until\s+(\d{2}):(\d{2}):(\d{2})/);
    let until = Date.now() + 180_000;
    if (m) {
      const p = dublinParts();
      const day = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
      until = dublinInstant(day, `${m[1]}:${m[2]}`).getTime() + Number(m[3]) * 1000 + 1000;
    }
    this.until = until;
  }
}

/**
 * Book one day, earliest slot from config.earliestTeeTime, falling back slot by slot.
 * If entry is open but no slot has room for the whole group, the lowest-priority partner
 * (last in config.players) is dropped, down to a two-ball: BRS only allows one booking per
 * hour per account, so a split across two times isn't possible.
 * Returns { time, unconfirmed, dropped }: time is null if nothing was entered.
 */
/**
 * Book one day. Polls the tee sheet feed a few times a second until a target slot is bookable,
 * then opens its booking link straight away. Targets: competition slots after the first one,
 * earliest first, up to latestTeeTime, with room for the whole group.
 * Returns { time, unconfirmed, dropped }: time is null if nothing was entered.
 */
export async function bookDay(page, config, dayIso, partners, { dryRun, snap, log, opensAt = Date.now() }) {
  const deadline = Math.max(Date.now(), opensAt) + config.retryWindowSeconds * 1000;
  const twoBallFrom = opensAt + (config.twoBallAfterSeconds ?? 60) * 1000;
  const retryAt = new Map(); // tee time -> when it may be tried again (locks run out; other failures never)
  const group = [...partners], dropped = [];
  const me = Object.values(config.players).find((p) => p.isBookingAccount).name;
  const request = page.context().request;
  const ready = (s) => (retryAt.get(s.time) ?? 0) <= Date.now();
  const fits = (open) => orderSlots(open, config.earliestTeeTime, config.latestTeeTime, group.length + 1);
  const mark = (m) => log(`${dayIso} ${m} (${Date.now() - opensAt >= 0 ? "+" : ""}${Date.now() - opensAt}ms)`);
  let loggedFirst = false, sawBookable = false, polls = 0, lastErr = "";
  while (Date.now() < deadline) {
    let sheet;
    try { sheet = await fetchSheet(request, config, dayIso); polls++; }
    catch (e) { if (e.message !== lastErr) log(`${dayIso}: ${e.message}`); lastErr = e.message; await sleep(300); continue; }
    // Skip the competition's first tee time: everyone goes for it, so aim for the one after.
    const firstComp = config.skipFirstCompetitionSlot ? sheet.firstComp : null;
    if (firstComp && !loggedFirst) { log(`${dayIso}: first competition slot is ${firstComp}; aiming for the next one`); loggedFirst = true; }
    const open = sheet.slots.filter((s) => s.bookable && (!config.competitionsOnly || s.comp) && (!config.emptyOnly || !s.taken)
      && (!firstComp || toMinutes(s.time) > toMinutes(firstComp)) && ready(s));
    if (open.length && !sawBookable) { mark(`entry open after ${polls} polls`); sawBookable = true; }
    let slots = fits(open);
    // Only settle for a two-ball once a three-ball has had a fair chance (locks run out after 3 minutes).
    while (!slots.length && open.length && group.length > 1 && Date.now() >= twoBallFrom) {
      dropped.unshift(group.pop());
      log(`${dayIso}: no slot with room for everyone; entering ${group.length + 1} without ${dropped[0]}`);
      slots = fits(open);
    }
    if (!slots.length) {
      // Poll fast around opening, then every 3s while locks run out.
      await sleep(Date.now() < opensAt + 20_000 ? 150 : 3000);
      continue;
    }
    for (const slot of slots) {
      try {
        if (await tryBook(page, config, dayIso, slot, [me, ...group], { dryRun, snap, log, mark })) return { time: slot.time, unconfirmed: false, dropped };
      } catch (e) {
        if (e instanceof SubmittedError) {
          log(`${dayIso} ${slot.time}: ${e.message}. Stopping this day so it can't double-book; check BRS.`);
          return { time: slot.time, unconfirmed: true, dropped };
        }
        if (e instanceof LockedError) {
          retryAt.set(slot.time, e.until);
          mark(`${slot.time}: locked by another member until ${new Date(e.until).toISOString().slice(11, 19)}Z; next slot`);
          continue;
        }
        retryAt.set(slot.time, Infinity);
        log(`${dayIso} ${slot.time} failed: ${e.message}.`);
        await snap(`${dayIso}-${slot.time.replace(":", "")}-failed`);
        break;
      }
    }
  }
  log(`${dayIso}: nothing entered within ${config.retryWindowSeconds}s of opening`);
  await snap(`${dayIso}-no-slots`);
  return { time: null, unconfirmed: false, dropped: [] };
}

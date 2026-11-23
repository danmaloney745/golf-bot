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
      detail: t.detail || null,
    });
  }
  if (!firstComp) firstComp = slots.filter((s) => s.comp).map((s) => s.time).sort()[0] || null;
  return { slots, firstComp };
}

/** One line on what BRS says about each slot in the window, e.g. "08:12 open(3) | 08:20 Unavailable(locked until 19:20:38)". */
export function describeWindow(sheet, config) {
  const lo = toMinutes(config.earliestTeeTime), hi = toMinutes(config.latestTeeTime);
  const rows = sheet.slots.filter((s) => (!config.competitionsOnly || s.comp) && toMinutes(s.time) >= lo && toMinutes(s.time) <= hi);
  if (!rows.length) return "no slots in window";
  return rows.map((s) => {
    if (s.bookable) return `${s.time} open(${s.free})`;
    const why = (s.detail || "").replace(/^This Tee Time has been /, "").replace(/ by another user/, "").replace(/\.$/, "").slice(0, 60);
    return `${s.time} ${s.reason || "closed"}${why ? `(${why})` : ""}`;
  }).join(" | ");
}

/**
 * Wrap a sheet fetch so every check is accounted for: errors and slow replies are logged with their
 * timing, and the window is logged whenever what BRS says about it changes.
 */
export function loggedFetch(fetch, { config, log, rel }) {
  let last = null, errors = 0;
  return async () => {
    const t0 = Date.now();
    try {
      const sheet = await fetch();
      const ms = Date.now() - t0;
      const now = describeWindow(sheet, config);
      if (now !== last) { log(`check sent ${rel(t0)}, ${ms}ms: ${now}`); last = now; }
      else if (ms > 1500) log(`check sent ${rel(t0)} was slow: ${ms}ms`);
      return sheet;
    } catch (e) {
      errors++;
      if (errors <= 20 || errors % 10 === 0) log(`check sent ${rel(t0)} FAILED after ${Date.now() - t0}ms: ${e.message}${errors > 1 ? ` (${errors} failures so far)` : ""}`);
      throw e;
    }
  };
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
    // No need to close the popup: the next step opens another link straight away.
    const text = await locked.first().innerText().catch(() => "");
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
 * Wait for the opening on BRS's clock and return the first sheet in which `isOpen` is true.
 * Poller 0 checks every 250ms from 3s before; from 1s before (BRS has been seen opening ~0.1-0.3s
 * early on its own clock) both pollers, staggered, check back to back until 2s after; then every
 * 150ms up to 20s after. Returns null if nothing opens by then.
 */
const BURST_MS = 1000; // fast checks start this long before the opening on BRS's clock

export function raceOpening(fetch, { opensAt, offset = 0, isOpen, pollers = 2, until: stopAt = Infinity }) {
  const opensLocal = opensAt - offset; // when BRS's clock reads the opening time, on our clock
  const until = Math.min(Math.max(opensLocal, Date.now()) + 20_000, stopAt);
  return new Promise((resolve) => {
    let done = false, lastClosedSent = null, requests = 0;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const poller = async (id) => {
      while (!done && Date.now() < until) {
        const toOpen = opensLocal - Date.now();
        if (toOpen > BURST_MS) {
          if (id > 0) { await sleep(Math.min(toOpen - BURST_MS, 250)); continue; }
          if (toOpen > 3000) { await sleep(Math.min(toOpen - 3000, 1000)); continue; }
        } else if (id > 0 && requests === 0) {
          await sleep(40 * id); // stagger the second poller
        }
        const sent = Date.now();
        let sheet;
        try { requests++; sheet = await fetch(); } catch { await sleep(100); continue; }
        if (done) return;
        if (isOpen(sheet)) {
          finish({ sheet, sent, lastClosedSent, requests, poller: id });
          return;
        }
        if (lastClosedSent == null || sent > lastClosedSent) lastClosedSent = sent;
        const now = opensLocal - Date.now();
        if (now > BURST_MS) await sleep(250);
        else if (now < -2000) await sleep(150);
        else await sleep(10); // back to back during the burst, with a breather
      }
      if (id === 0) finish(null);
    };
    for (let i = 0; i < pollers; i++) poller(i);
  });
}

/**
 * Book one day. Polls the tee sheet feed a few times a second until a target slot is bookable,
 * then opens its booking link straight away. Targets: competition slots after the first one,
 * earliest first, up to latestTeeTime, with room for the whole group.
 * Returns { time, unconfirmed, dropped }: time is null if nothing was entered.
 */
export async function bookDay(page, config, dayIso, partners, { dryRun, watchOnly, snap, log, opensAt = Date.now(), offset = 0 }) {
  const deadline = Math.max(Date.now(), opensAt) + config.retryWindowSeconds * 1000;
  const twoBallFrom = opensAt + (config.twoBallAfterSeconds ?? 60) * 1000;
  const retryAt = new Map(); // tee time -> when it may be tried again (locks run out; other failures never)
  const group = [...partners], dropped = [];
  const me = Object.values(config.players).find((p) => p.isBookingAccount).name;
  const request = page.context().request;
  const ready = (s) => (retryAt.get(s.time) ?? 0) <= Date.now();
  const fits = (open) => orderSlots(open, config.earliestTeeTime, config.latestTeeTime, group.length + 1);
  const mark = (m) => log(`${dayIso} ${m} (${Date.now() - (opensAt - offset) >= 0 ? "+" : ""}${Date.now() - (opensAt - offset)}ms)`);
  const targets = (sheet) => {
    // Skip the competition's first tee time: everyone goes for it, so aim for the one after.
    const firstComp = config.skipFirstCompetitionSlot ? sheet.firstComp : null;
    return sheet.slots.filter((s) => s.bookable && (!config.competitionsOnly || s.comp) && (!config.emptyOnly || !s.taken)
      && (!firstComp || toMinutes(s.time) > toMinutes(firstComp)) && ready(s));
  };
  // Race the opening on BRS's clock. Locally, mark() times are on our clock relative to the opening
  // on BRS's clock, so +0ms is the true opening moment.
  const rel = (t) => { const d = t - (opensAt - offset); return `${d >= 0 ? "+" : ""}${d}ms`; };
  const fetch = loggedFetch(() => fetchSheet(request, config, dayIso), { config, log: (m) => log(`${dayIso} ${m}`), rel });
  const markAt = (m, t) => log(`${dayIso} ${m} (${t - (opensAt - offset) >= 0 ? "+" : ""}${t - (opensAt - offset)}ms)`);
  const raced = await raceOpening(fetch, { opensAt, offset, until: deadline, isOpen: (sh) => fits(targets(sh)).length > 0 || (Date.now() >= twoBallFrom && targets(sh).length > 0) });
  if (raced) {
    if (raced.sheet.firstComp && config.skipFirstCompetitionSlot) log(`${dayIso}: first competition slot is ${raced.sheet.firstComp}; aiming for the next one`);
    markAt(`entry open: seen by poller ${raced.poller} after ${raced.requests} requests; last closed check sent at ${raced.lastClosedSent == null ? "n/a" : (raced.lastClosedSent - (opensAt - offset)) + "ms"}`, raced.sent);
    if (watchOnly) return { time: fits(targets(raced.sheet))[0]?.time || targets(raced.sheet)[0]?.time || null, watched: true, sent: raced.sent, lastClosedSent: raced.lastClosedSent };
  } else {
    log(`${dayIso}: nothing opened within 20s of the opening time`);
    if (watchOnly) return { time: null, watched: true };
  }
  let pending = raced?.sheet || null, lastErr = "";
  while (Date.now() < deadline) {
    let sheet = pending;
    pending = null;
    if (!sheet) {
      try { sheet = await fetch(); }
      catch (e) { if (e.message !== lastErr) log(`${dayIso}: ${e.message}`); lastErr = e.message; await sleep(300); continue; }
    }
    const open = targets(sheet);
    let slots = fits(open);
    // Only settle for a two-ball once a three-ball has had a fair chance (locks run out after 3 minutes).
    while (!slots.length && open.length && group.length > 1 && Date.now() >= twoBallFrom) {
      dropped.unshift(group.pop());
      log(`${dayIso}: no slot with room for everyone; entering ${group.length + 1} without ${dropped[0]}`);
      slots = fits(open);
    }
    if (!slots.length) {
      // Every 3s while locks run out (the race above already covered the opening itself).
      await sleep(3000);
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
        await snap(`${dayIso}-${slot.time.replace(":", "")}-failed`, { quick: true });
        break;
      }
    }
  }
  log(`${dayIso}: nothing entered within ${config.retryWindowSeconds}s of opening`);
  await snap(`${dayIso}-no-slots`);
  return { time: null, unconfirmed: false, dropped: [] };
}

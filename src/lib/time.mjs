// Time helpers, all in Europe/Dublin wall-clock time.
const TZ = "Europe/Dublin";

export function dublinParts(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

const isoDay = (dt) => dt.toISOString().slice(0, 10);
const addDays = (dt, n) => new Date(dt.getTime() + n * 864e5);
const hm = (s) => s.split(":").map(Number);

/** The weekend the next booking opening is for. On a Monday before opening time, that's this week's. */
export function targetWeekend(opensAt = "19:16", now = new Date()) {
  const n = dublinParts(now);
  const [oh, om] = hm(opensAt);
  const today = new Date(Date.UTC(n.y, n.m - 1, n.d));
  let toMon = (1 - today.getUTCDay() + 7) % 7;
  // Allow a grace period after opening so a run still targets this weekend while it's booking.
  if (toMon === 0 && n.h * 60 + n.min >= oh * 60 + om + 30) toMon = 7;
  const mon = addDays(today, toMon);
  return { opens: isoDay(mon), sat: isoDay(addDays(mon, 5)), sun: isoDay(addDays(mon, 6)) };
}

/** The real instant at which Dublin wall-clock reads `dayIso hh:mm`. */
export function dublinInstant(dayIso, time) {
  const [y, m, d] = dayIso.split("-").map(Number);
  const [h, min] = hm(time);
  const guess = Date.UTC(y, m - 1, d, h, min);
  // Offset of Dublin from UTC at that moment (0 in winter, +1h in summer).
  const p = dublinParts(new Date(guess));
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return new Date(guess - (asUtc - guess));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function toMinutes(t) {
  const [h, m] = hm(t);
  return h * 60 + m;
}

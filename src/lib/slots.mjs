import { toMinutes } from "./time.mjs";

/** Order bookable slots: earliest first, from `earliest` up to `latest`, with room for `needed` players, duplicates removed. */
export function orderSlots(candidates, earliest, latest, needed = 1) {
  const lo = toMinutes(earliest), hi = toMinutes(latest);
  const seen = new Set();
  return candidates
    .filter((c) => /^\d{2}:\d{2}$/.test(c.time))
    .filter((c) => c.free == null || c.free >= needed)
    .filter((c) => toMinutes(c.time) >= lo && toMinutes(c.time) <= hi)
    .sort((a, b) => toMinutes(a.time) - toMinutes(b.time))
    .filter((c) => (seen.has(c.time) ? false : seen.add(c.time)));
}

/** Who to book for a given day: always-in players plus whoever ticked it, booking account first. */
export function playersFor(day, availability, config) {
  const ticked = availability[day] || {};
  const keys = Object.keys(config.players).filter((k) => config.players[k].alwaysIn || ticked[k]);
  return keys.sort((a, b) => (config.players[b].isBookingAccount ? 1 : 0) - (config.players[a].isBookingAccount ? 1 : 0));
}

/** True if an option label refers to the person, whether shown "Mark Armstrong" or "Armstrong, Mark". */
export function nameMatches(label, fullName) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z' ]/g, " ");
  const words = norm(fullName).split(/\s+/).filter(Boolean);
  const hay = norm(label);
  return words.every((w) => new RegExp(`\\b${w}\\b`).test(hay));
}

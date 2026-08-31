/* Date helpers.
 *
 * The whole app speaks two string formats and never raw Date objects across
 * module boundaries:
 *   dateKey  'YYYY-MM-DD'  — a calendar day in the user's local timezone
 *   timeKey  'HH:MM'       — a wall-clock time on that day
 *
 * Storing wall-clock strings rather than UTC instants keeps the hour grid
 * honest across DST boundaries: 09:00 stays 09:00 on the morning the clocks
 * change. Conversion to RFC3339 for Google happens once, in google.js.
 */

export const MS_DAY = 86400000;

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' using local calendar fields (never toISOString). */
export function toKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date at local midnight. */
export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey() {
  return toKey(new Date());
}

export function nowTimeKey() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Shift a dateKey by n days. */
export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

/** Shift a dateKey by n months, clamping to the end of short months. */
export function addMonths(key, n) {
  const d = fromKey(key);
  const targetDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(targetDay, lastDay));
  return toKey(d);
}

/** Whole days from a to b (b - a). Both are dateKeys. */
export function diffDays(a, b) {
  return Math.round((fromKey(b) - fromKey(a)) / MS_DAY);
}

/** First day of the week containing `key`. weekStart: 0=Sunday, 1=Monday. */
export function startOfWeek(key, weekStart = 1) {
  const d = fromKey(key);
  const shift = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - shift);
  return toKey(d);
}

/** The 7 dateKeys of the week containing `key`. */
export function weekDays(key, weekStart = 1) {
  const start = startOfWeek(key, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function startOfMonth(key) {
  const d = fromKey(key);
  return toKey(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function endOfMonth(key) {
  const d = fromKey(key);
  return toKey(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/**
 * The month grid as an array of weeks, each an array of 7 dateKeys.
 * Includes leading/trailing days from adjacent months so every row is full.
 */
export function monthGrid(key, weekStart = 1) {
  const first = startOfMonth(key);
  const last = endOfMonth(key);
  let cursor = startOfWeek(first, weekStart);
  const weeks = [];
  // Guard at 6 rows: that is the maximum a Gregorian month can occupy.
  while (weeks.length < 6) {
    const week = Array.from({ length: 7 }, (_, i) => addDays(cursor, i));
    weeks.push(week);
    if (week[6] >= last) break;
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export function isToday(key) {
  return key === todayKey();
}

export function isWeekend(key) {
  const dow = fromKey(key).getDay();
  return dow === 0 || dow === 6;
}

export function sameMonth(a, b) {
  return a.slice(0, 7) === b.slice(0, 7);
}

/* ---- time helpers ---- */

/** 'HH:MM' -> minutes since midnight. */
export function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** minutes since midnight -> 'HH:MM' (wraps within the day). */
export function minutesToTime(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/* ---- formatting ---- */

export function formatTime(t, hour12 = true) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (!hour12) return `${pad(h)}:${pad(m)}`;
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${pad(m)}${suffix}`;
}

export function formatHourLabel(h, hour12 = true) {
  if (!hour12) return `${pad(h)}:00`;
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/** 'Thu 14 Aug' */
export function formatDayShort(key) {
  const d = fromKey(key);
  return `${DAY_ABBR[d.getDay()]} ${d.getDate()} ${MONTH_ABBR[d.getMonth()]}`;
}

/** 'Thursday, 14 August 2026' */
export function formatDayLong(key) {
  const d = fromKey(key);
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * 'Tuesday 15 September' — the day, for the header crumb.
 *
 * Shorter than formatDayLong on purpose. That one is a caption with room to
 * breathe; this one is competing for a fixed-height row against a week range,
 * a month, three view buttons and Today, and it was losing — the crumb was
 * being crushed to a single letter, so the header answered every question
 * about the day except which one it was.
 *
 * The comma and the year are what went. The year is already sitting two
 * crumbs to the left in 'September 2026', and a comma inside a date that is
 * fighting for width is punctuation you can read from context.
 */
export function formatDayHeader(key) {
  const d = fromKey(key);
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}

/** 'August 2026' */
export function formatMonthLong(key) {
  const d = fromKey(key);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/** '11 - 17 Aug' or '28 Jul - 3 Aug' when the week straddles two months. */
export function formatWeekRange(key, weekStart = 1) {
  const days = weekDays(key, weekStart);
  const a = fromKey(days[0]);
  const b = fromKey(days[6]);
  const left = a.getMonth() === b.getMonth()
    ? `${a.getDate()}`
    : `${a.getDate()} ${MONTH_ABBR[a.getMonth()]}`;
  return `${left} – ${b.getDate()} ${MONTH_ABBR[b.getMonth()]}`;
}

/** 'Today' / 'Tomorrow' / 'Yesterday' / 'Thu 14 Aug' — for due-date chips. */
export function formatRelativeDay(key) {
  const delta = diffDays(todayKey(), key);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';
  if (delta > 1 && delta < 7) return DAY_NAMES[fromKey(key).getDay()];
  return formatDayShort(key);
}

/** ISO week number — shown in the month view's week rows. */
export function isoWeekNumber(key) {
  const d = fromKey(key);
  // Shift to the Thursday of this ISO week, then count weeks from Jan 4th.
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNum + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  return 1 + Math.round((target - firstThursday) / (7 * MS_DAY));
}

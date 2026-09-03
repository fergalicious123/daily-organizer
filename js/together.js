/* When are you both free?
 *
 * Ben is in the UK on a four-on rota; Sheila is in the Philippines on hers,
 * and both rotas are already in his Google calendar — his as "Night Shift",
 * hers prefixed with her name, "Sheila: Night (11-7)". He has a dual clock in
 * the corner and, in among his tasks, a hand-made event reading "Call Sheila
 * — both free window". He has been working this out on paper. Everything
 * needed to answer it is already in the document.
 *
 * WHAT THIS IS NOT. It is not "when are neither of you at work". That would
 * cheerfully suggest 09:00 on the morning after his night shift, when he has
 * been in bed two hours. Being free means awake, off, and at a civil hour —
 * in BOTH places at once, which is the part a person cannot do in their head
 * while tired.
 *
 * ASSUMPTIONS, ALL OF THEM STATED. This models sleep, and sleep is a guess.
 * Every guess is a named constant below and every window the app shows says
 * which ones it leaned on, because a suggestion you cannot audit is one you
 * stop trusting the first time it is wrong.
 */

import { entryOwner, shiftKindOf, SHIFT } from './state.js';
import { instantAt, timeInZone, partsInZone } from './zones.js';

/* ------------------------------------------------------------------ */
/* The assumptions                                                     */
/* ------------------------------------------------------------------ */

/** His shifts, in minutes past midnight. The rota states these. */
const HIS_HOURS = {
  [SHIFT.DAY]: [6 * 60 + 30, 18 * 60 + 30],
  [SHIFT.NIGHT]: [18 * 60 + 30, 30 * 60 + 30],   // 18:30 -> 06:30 the next day
};

/** Ordinary sleep, when the night before was an ordinary night. */
const SLEEP = [23 * 60, 7 * 60];

/** BETWEEN nights: bed on getting home at 07:00, up mid-afternoon. */
const SLEEP_AFTER_NIGHTS = [7 * 60, 14 * 60];

/**
 * After the LAST night, which is a different morning from the other three.
 *
 * Four and a half hours, not seven. The length of the first sleep after a
 * block decides how many days off it costs: sleep through to 14:30 and you
 * will not be tired at 23:00, so that night goes too and you are not straight
 * until the day after. This was the same figure as the mid-block sleep, so the
 * app offered a call at 14:00 on the morning he should have been up at 12:00 —
 * two hours late, on the one day of the cycle the timing actually matters.
 */
const SLEEP_AFTER_LAST_NIGHT = [7 * 60, 12 * 60];

/**
 * On the day nights START he is up from here.
 *
 * 10:00, not 14:00. He went to bed at about 01:30 — the point of the day
 * before nights is to go late, not to lie in — so by 14:00 he has been up four
 * hours. The old figure threw away her whole evening: 10:00 here is 17:00 in
 * Manila, and the app was calling it busy.
 */
const AWAKE_BEFORE_NIGHTS = 10 * 60;

/**
 * The nap before the first night, which is not optional and is not free time.
 *
 * It is the single highest-value hour of the cycle — what stops the 03:00
 * trough on the first night flattening him — and it sat in the middle of the
 * window the app was most confident about. A suggestion to ring the
 * Philippines at 16:00 that day is a suggestion to skip it.
 */
const NAP_BEFORE_NIGHTS = [15 * 60, 17 * 60];

/** Shorter than this is not a phone call, it is a text. */
export const MIN_WINDOW_MIN = 30;

/* ------------------------------------------------------------------ */
/* Reading her rota out of the calendar                                */
/* ------------------------------------------------------------------ */

/**
 * "Night (11-7)" -> [1380, 1860] — 23:00 to 07:00 the next morning.
 *
 * The numbers alone are ambiguous: 11-7 is a night, 7-3 a morning and 3-11 an
 * afternoon, and all three are written on a twelve-hour clock with no am or
 * pm. The WORD disambiguates the start, and the end is then simply the first
 * reading of the second number that falls after the start — rolling into
 * tomorrow when neither does, which is exactly what a night shift is.
 */
export function parseShiftWindow(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(off|rest|leave|holiday|annual)\b/.test(t)) return { off: true };

  const m = /(\d{1,2})\s*(?::\d{2})?\s*[-–]\s*(\d{1,2})\s*(?::\d{2})?/.exec(t);
  if (!m) return null;

  const h1 = Number(m[1]) % 12;
  const h2 = Number(m[2]) % 12;
  const morning = /\b(morning|early|earlies|am)\b/.test(t);
  const start = (morning ? h1 : h1 + 12) % 24 * 60;

  const candidates = [h2 * 60, (h2 + 12) * 60];
  const end = candidates.find((c) => c > start) ?? h2 * 60 + 24 * 60;
  return { start, end, off: false };
}

/**
 * The name on the other rota, if there is one.
 *
 * Taken from the calendar rather than configured, because it is already
 * there: whoever's name prefixes the most shift-shaped entries is the person
 * this is about. Requires a few to avoid latching onto one entry someone
 * happened to write "Dave: dentist" on.
 */
export function partnerName(items) {
  const counts = new Map();
  for (const item of items) {
    const owner = entryOwner(item.title);
    if (!owner) continue;
    if (!parseShiftWindow(item.title)) continue;
    counts.set(owner, (counts.get(owner) || 0) + 1);
  }
  let best = null;
  for (const [name, n] of counts) if (n >= 3 && (!best || n > best.n)) best = { name, n };
  return best?.name || null;
}

/* ------------------------------------------------------------------ */
/* Busy intervals                                                      */
/* ------------------------------------------------------------------ */

/* Intervals are [from, to) in minutes past local midnight on the day in
   question, and may run past 1440 to mean "into tomorrow". */

function clip(list) {
  return list
    .map(([a, b]) => [Math.max(a, 0), Math.min(b, 1440)])
    .filter(([a, b]) => b > a);
}

/** Everything keeping HIM from a phone call on `dateKey`. */
export function hisBusy(shiftToday, shiftYesterday, shiftTomorrow) {
  const busy = [];
  const assumed = [];

  const hours = HIS_HOURS[shiftToday];
  if (hours) busy.push(hours);
  else if (shiftToday === SHIFT.TRAINING) {
    // A training day is worked, and the roster does not say between when.
    busy.push(HIS_HOURS[SHIFT.DAY]);
    assumed.push('a training day runs like a day shift');
  }

  if (shiftYesterday === SHIFT.NIGHT) {
    // Yesterday's night runs into this morning, and then he sleeps. How long
    // for depends on whether there is another one tonight, which is the whole
    // difference between the fourth morning and the other three.
    busy.push([0, 6 * 60 + 30]);
    if (shiftToday === SHIFT.NIGHT) {
      busy.push(SLEEP_AFTER_NIGHTS);
      assumed.push('you sleep until mid-afternoon between nights');
    } else {
      busy.push(SLEEP_AFTER_LAST_NIGHT);
      assumed.push('you take a short sleep after the last night, not a full one');
    }
  } else {
    busy.push([0, SLEEP[1]]);
  }

  if (shiftToday === SHIFT.NIGHT) {
    // Only on the FIRST night. On a middle one the sleep above already says
    // where the morning went, and saying it twice would bury the nap.
    if (shiftYesterday !== SHIFT.NIGHT) {
      busy.push([0, AWAKE_BEFORE_NIGHTS]);
      busy.push(NAP_BEFORE_NIGHTS);
      assumed.push('you are up late and nap 15:00-17:00 before the first night');
    }
  } else if (shiftTomorrow !== SHIFT.NIGHT) {
    busy.push([SLEEP[0], 1440]);
  }

  return { busy: clip(busy), assumed };
}

/** Everything keeping HER from one, in her own local time. */
export function herBusy(windowToday, windowYesterday) {
  const busy = [];
  const assumed = [];

  if (windowToday && !windowToday.off) {
    busy.push([windowToday.start, windowToday.end]);
    if (windowToday.end > 24 * 60) {
      assumed.push('she sleeps after a night shift');
      busy.push([windowToday.end - 24 * 60 + 30, windowToday.end - 24 * 60 + 30 + 7 * 60]);
    }
  }
  // Yesterday's overnight spilling into this morning, and the sleep after it.
  if (windowYesterday && !windowYesterday.off && windowYesterday.end > 24 * 60) {
    const spill = windowYesterday.end - 24 * 60;
    busy.push([0, spill]);
    busy.push([spill + 30, spill + 30 + 7 * 60]);
    assumed.push('she sleeps after a night shift');
  } else {
    busy.push([0, SLEEP[1]]);
  }

  if (!(windowToday && !windowToday.off && windowToday.end > 24 * 60)) {
    busy.push([SLEEP[0], 1440]);
  }

  return { busy: clip(busy), assumed: [...new Set(assumed)] };
}

/** The gaps left over, as [from, to) minute pairs. */
export function freeFrom(busy) {
  const merged = [...busy].sort((a, b) => a[0] - b[0]).reduce((acc, span) => {
    const last = acc[acc.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else acc.push([...span]);
    return acc;
  }, []);

  const free = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    if (a > cursor) free.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < 1440) free.push([cursor, 1440]);
  return free;
}

/* ------------------------------------------------------------------ */
/* Both at once                                                        */
/* ------------------------------------------------------------------ */

/**
 * Her shift window on a day, read out of his calendar.
 *
 * Null means her rota says nothing about that day, which is different from
 * `{off:true}` — one is "she is free" and the other is "we do not know", and
 * the caller has to be able to tell them apart.
 */
export function herWindowOn(items, name) {
  for (const item of items) {
    if (entryOwner(item.title) !== name) continue;
    const w = parseShiftWindow(item.title);
    if (w) return w;
  }
  return null;
}

/** His shift kind on a day, from the items already fetched for it. */
export function hisShiftOn(items) {
  for (const item of items) {
    const kind = shiftKindOf(item);
    if (kind) return kind;
  }
  return null;
}

/** Local free intervals -> real instants, so two zones can be compared. */
function toInstants(free, dateKey, tz) {
  return free.map(([a, b]) => [instantAt(dateKey, a, tz).getTime(), instantAt(dateKey, b, tz).getTime()]);
}

function overlap(a, b) {
  const out = [];
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      const s = Math.max(as, bs);
      const e = Math.min(ae, be);
      if (e - s >= MIN_WINDOW_MIN * 60000) out.push([s, e]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/**
 * When you are both free on his `dateKey`.
 *
 * Her side is computed for the day before, the day itself and the day after,
 * because a window that is his evening is her small hours of the NEXT day —
 * which is precisely the arithmetic this exists to stop him doing in his head
 * at the end of four nights.
 */
export function windowsOn(dateKey, {
  itemsOnDay, addDays, name, homeTz, awayTz,
}) {
  if (!name) return { windows: [], assumed: [], known: false };

  const yesterday = addDays(dateKey, -1);
  const tomorrow = addDays(dateKey, 1);

  const his = hisBusy(
    hisShiftOn(itemsOnDay(dateKey)),
    hisShiftOn(itemsOnDay(yesterday)),
    hisShiftOn(itemsOnDay(tomorrow)),
  );
  const hisFree = toInstants(freeFrom(his.busy), dateKey, homeTz);

  const assumed = [...his.assumed];
  let herFree = [];
  let known = false;
  for (const day of [yesterday, dateKey, tomorrow]) {
    const today = herWindowOn(itemsOnDay(day), name);
    const before = herWindowOn(itemsOnDay(addDays(day, -1)), name);
    if (today) known = true;
    const hers = herBusy(today, before);
    assumed.push(...hers.assumed);
    herFree = herFree.concat(toInstants(freeFrom(hers.busy), day, awayTz));
  }

  return {
    windows: overlap(hisFree, herFree),
    assumed: [...new Set(assumed)],
    known,
  };
}

/** 'HH:MM–HH:MM' in a zone, for showing a window in someone's own time. */
export function describeWindow([start, end], tz) {
  return `${timeInZone(new Date(start), tz)}\u2013${timeInZone(new Date(end), tz)}`;
}

/** Whether a window lands on a different calendar day in the other zone. */
export function crossesDay([start], homeTz, awayTz) {
  const h = partsInZone(new Date(start), homeTz);
  const a = partsInZone(new Date(start), awayTz);
  return Date.UTC(a.year, a.month - 1, a.day) !== Date.UTC(h.year, h.month - 1, h.day);
}

/**
 * The next few days that have a window, starting today.
 *
 * Stops at the first day whose rota is not written down: suggesting "you are
 * both free all Thursday" because nobody has entered Thursday yet would be
 * inventing good news.
 */
export function nextWindows(fromKey, opts, days = 14, limit = 3) {
  const found = [];
  for (let i = 0; i < days && found.length < limit; i++) {
    const day = opts.addDays(fromKey, i);
    const { windows, assumed, known } = windowsOn(day, opts);
    if (!known) continue;
    for (const w of windows) {
      found.push({ day, window: w, assumed });
      if (found.length >= limit) break;
    }
  }
  return found;
}

/* Wall-clock time in two places at once.
 *
 * Lifted out of the clock widget so the "when are we both free" maths can use
 * the same implementation rather than a second copy of it. Timezone code that
 * exists twice is timezone code that disagrees with itself eventually, and the
 * disagreement shows up twice a year on a Sunday morning.
 *
 * ALL ZONE MATHS GOES THROUGH Intl, NEVER A STORED OFFSET. The gap between
 * London and Manila is 7 hours today and 8 from 25 October, because the UK
 * leaves BST while the Philippines has no DST at all — so anything that
 * hardcodes "+7" is wrong for a third of the year. Intl knows the rules; we
 * ask it every time.
 */

/** The wall-clock fields an instant shows in a given zone. */
export function partsInZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
  };
}

/** How far ahead of UTC a zone is, in minutes, at a given instant. */
export function offsetMinutes(date, timeZone) {
  const p = partsInZone(date, timeZone);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = date.getTime() - date.getMilliseconds();
  return (asIfUTC - whole) / 60000;
}

/**
 * The instant at which `timeZone` reads the given wall-clock time.
 * Resolved twice because the offset used to make the first guess may itself
 * be the wrong side of a DST boundary.
 */
export function instantForZonedTime(year, month, day, hour, minute, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let offset = offsetMinutes(new Date(naive), timeZone);
  let instant = naive - offset * 60000;
  offset = offsetMinutes(new Date(instant), timeZone);
  return new Date(naive - offset * 60000);
}

/** 'HH:MM' in the given zone. */
export function timeInZone(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * The instant at which a zone reads `minutes` past midnight on `dateKey`.
 *
 * Minutes may run past 1440, which is how an overnight shift is expressed —
 * 06:30 the next morning is simply 1830. Date.UTC normalises the overflow, so
 * there is no special case for crossing midnight, month end or new year.
 */
export function instantAt(dateKey, minutes, timeZone) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return instantForZonedTime(y, m, d, 0, minutes, timeZone);
}

/** "7h ahead" / "3h 30m behind" / "same time". */
export function describeGap(date, homeTz, awayTz) {
  const diff = offsetMinutes(date, awayTz) - offsetMinutes(date, homeTz);
  if (diff === 0) return 'same time';
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const span = m ? `${h}h ${m}m` : `${h}h`;
  return `${span} ${diff > 0 ? 'ahead' : 'behind'}`;
}

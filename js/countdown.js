/* Countdowns — how long until something that matters.
 *
 * This started as one number next to one habit: days to the PARA 10, sitting
 * on the training step of the morning ritual, because a daily habit with no
 * horizon is easy to skip and the same habit with "26 days" beside it is a
 * different proposition. It worked, so it spread — the English course start,
 * and anything else Ben marks.
 *
 * Two things can carry one:
 *   a routine step, through `target` / `targetLabel` in settings; and
 *   any dated item, through `countdown: true`, where the date IS the target
 *   and the title is the name.
 * Both end up here so the wording and the sense of urgency are the same
 * wherever a countdown appears.
 *
 * It stops at zero. A date in the past returns null rather than "-12 days",
 * so a race that has been run, or a course that has started, quietly drops
 * out instead of sitting there counting up until someone notices.
 */

import { diffDays, todayKey } from './dates.js';

/** Days from `fromKey` to `target`, or null once the target is behind us. */
export function daysUntil(target, fromKey = todayKey()) {
  if (!target) return null;
  const days = diffDays(fromKey, target);
  return days < 0 ? null : days;
}

/**
 * The chip: `{ days, text, urgent }`, or null when there is nothing to count.
 *
 * Inside a week it turns urgent. That is the point at which the number stops
 * being context and starts being a deadline.
 */
export function countdown(target, label = '', fromKey = todayKey()) {
  const days = daysUntil(target, fromKey);
  if (days == null) return null;
  if (days === 0) return { days, text: label ? `${label} today` : 'Today', urgent: true };
  if (days === 1) return { days, text: 'Tomorrow', urgent: true };
  return { days, text: `${days} days`, urgent: days <= 7 };
}

/** Does this item want counting down to? Needs the flag AND a date to aim at. */
export function isCountdownItem(item) {
  return Boolean(item?.countdown && item.date && !item.done && !item.deleted);
}

/**
 * Every item being counted down to, soonest first.
 *
 * Past ones are dropped by countdown() returning null, so a countdown you set
 * and forgot does not accumulate on the home screen for ever.
 */
export function itemCountdowns(items, fromKey = todayKey()) {
  return items
    .filter(isCountdownItem)
    .map((item) => ({ item, count: countdown(item.date, item.title, fromKey) }))
    .filter((entry) => entry.count)
    .sort((a, b) => a.count.days - b.count.days);
}

/* Handing an alarm to the phone.
 *
 * WHAT THIS IS NOT: it is not an alarm. A web app cannot be one. A web
 * notification is a single chime at notification volume, muted by Do Not
 * Disturb, gone in a second and never repeated -- which is fine for "your
 * dentist is in ten minutes" and useless for waking someone who has been
 * asleep four hours after four night shifts. The scheduled-notification API
 * that would have helped (Notification Triggers) was trialled by Chrome and
 * abandoned, so there is no version of this that ends with the browser making
 * a noise you cannot sleep through.
 *
 * WHAT IT IS: a hand-off. Android exposes SET_ALARM as an intent, and Chrome
 * can fire an intent from a link. So this works out WHICH alarms the rota
 * calls for and hands them to the Clock app one tap at a time. The alarm that
 * ends up on the phone is an ordinary one -- it overrides silent, it overrides
 * DND, it keeps going until it is dismissed -- because the Clock app made it.
 *
 * The whole module is pure except for `setAlarm`, so the times can be tested
 * without a phone attached.
 *
 * THE ONE AWKWARD CONSTRAINT. SET_ALARM takes an hour and a minute and no
 * date, so the alarm lands on the NEXT occurrence of that time. An alarm for
 * 12:00 tomorrow cannot be set the day before yesterday. Every offer is
 * therefore checked against the clock before it is shown (`ringsRight`) --
 * otherwise the button for "get up at 12:00 on Wednesday", tapped on Monday
 * evening, would quietly set one for Tuesday lunchtime and be believed.
 */

import { SHIFT } from './state.js';
import { addDays, toKey } from './dates.js';

/* ------------------------------------------------------------------ */
/* The assumptions, in one place                                       */
/* ------------------------------------------------------------------ */

/* These mirror together.js, which models the same sleep for a different
   question. Both files state their guesses out loud for the same reason: a
   suggestion you cannot audit is one you stop trusting the first time it is
   wrong -- and this one is attached to a button that makes a noise. */

/** How long before a shift starts you need to be awake. Overridable. */
export const DEFAULT_LEAD_MIN = 90;

/** Shift start times, minutes past midnight. The rota states these. */
const STARTS = {
  [SHIFT.DAY]: 6 * 60 + 30,
  [SHIFT.TRAINING]: 6 * 60 + 30,   // worked like a day, per together.js
  [SHIFT.NIGHT]: 18 * 60 + 30,
};

/** Asleep by this, in the middle of a run of nights. 06:30 off, home, down. */
const NIGHT_SLEEP_FROM = 7 * 60 + 30;

/** Seven hours, which is what the day-sleep realistically gets you. */
const NIGHT_SLEEP_MIN = 7 * 60;

/**
 * The short sleep after the LAST night, and the reason this feature exists.
 *
 * Four and a half hours rather than seven. The length of the first sleep after
 * a block decides how many days off you lose to it: sleep through to 14:30 and
 * you will not be tired at 23:00, so that night goes too and you are not right
 * until the day after. Cut it here and you pay one groggy afternoon instead.
 */
const ANCHOR_SLEEP_MIN = 4 * 60 + 30;

/** Worked shifts. OFF and OTHER are not here on purpose -- see shiftStart. */
const WORKED = new Set([SHIFT.DAY, SHIFT.TRAINING, SHIFT.NIGHT]);

/* ------------------------------------------------------------------ */
/* Times                                                               */
/* ------------------------------------------------------------------ */

/** 785 -> "13:05". Wraps past midnight so a night's maths cannot overflow. */
export function hhmm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * When a shift starts, or null if the roster does not actually say.
 *
 * OTHER is the interesting one. An early or a late IS a worked shift, but the
 * app deliberately refuses to guess its hours (see shiftKindOf), and an alarm
 * is the last place to start guessing -- being woken at 05:00 for a late is
 * worse than not being woken at all, because it is a wrong answer you acted on
 * in your sleep. So OTHER gets no alarm and the panel says why.
 */
export function shiftStart(kind) {
  return STARTS[kind] ?? null;
}

/* ------------------------------------------------------------------ */
/* Which alarms a day calls for                                        */
/* ------------------------------------------------------------------ */

export const ALARM = {
  DAY_START: 'day-start',
  NIGHT_WAKE: 'night-wake',
  NAP_WAKE: 'nap-wake',
  ANCHOR: 'anchor',
};

/**
 * The alarms that should RING on `dateKey`.
 *
 * `shiftOn(key)` returns a SHIFT kind or null. Reading the day before and the
 * day itself is enough: every case here turns on the transition, not on where
 * in a block you are. Coming off nights is the same morning whether it was the
 * fourth night or the first.
 *
 * Returns [] for an ordinary day off, which is the point -- a lie-in on the
 * second day of four is not a problem this needs to solve, and an app that
 * offers to wake you on your day off gets switched off.
 */
export function alarmsFor(dateKey, shiftOn, { leadMin = DEFAULT_LEAD_MIN } = {}) {
  const today = shiftOn(dateKey) || null;
  const prev = shiftOn(addDays(dateKey, -1)) || null;

  // Coming off a night. Everything else about today is beside the point --
  // even if today were somehow worked, you would not be setting a 05:00.
  if (prev === SHIFT.NIGHT && today !== SHIFT.NIGHT) {
    return [{
      id: ALARM.ANCHOR,
      time: hhmm(NIGHT_SLEEP_FROM + ANCHOR_SLEEP_MIN),
      label: 'Get up — anchor sleep',
      why: 'Short sleep now, normal bedtime tonight. Sleeping through to the '
        + 'afternoon costs you tonight as well.',
      urgent: true,
    }];
  }

  if (today === SHIFT.NIGHT) {
    // Mid-block: slept from 07:30, up in time to be a person before 18:30.
    if (prev === SHIFT.NIGHT) {
      return [{
        id: ALARM.NIGHT_WAKE,
        time: hhmm(NIGHT_SLEEP_FROM + NIGHT_SLEEP_MIN),
        label: 'Up — on duty 18:30',
        why: 'Seven hours from getting home. Later than this and you are '
          + 'eating dinner on the way in.',
      }];
    }
    // First night of the block. The nap is the highest-value thing in the
    // cycle and the easiest to sleep straight through, which is the whole
    // reason it needs an alarm rather than an intention.
    return [{
      id: ALARM.NAP_WAKE,
      time: hhmm(STARTS[SHIFT.NIGHT] - leadMin),
      label: 'Up from the nap — nights start 18:30',
      why: 'Nap from about 15:00. It is what stops the 03:00 trough on the '
        + 'first night flattening you.',
    }];
  }

  const start = WORKED.has(today) ? shiftStart(today) : null;
  if (start == null) return [];
  return [{
    id: ALARM.DAY_START,
    time: hhmm(start - leadMin),
    label: `Up — on duty ${hhmm(start)}`,
    why: `${leadMin} minutes to be washed, fed and out.`,
  }];
}

/* ------------------------------------------------------------------ */
/* Only offer what the Clock app can actually honour                   */
/* ------------------------------------------------------------------ */

/**
 * The instant an alarm set RIGHT NOW for `time` would go off.
 *
 * Next occurrence, which is all SET_ALARM can express: today if that time is
 * still ahead, otherwise tomorrow.
 */
export function whenItWouldRing(now, time) {
  const [h, m] = String(time).split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** Would setting it now put it on the day we meant? */
export function ringsRight(now, dateKey, time) {
  return toKey(whenItWouldRing(now, time)) === dateKey;
}

/**
 * Every alarm worth offering at this moment, today's and tomorrow's, in the
 * order they will ring.
 *
 * Two days is exactly the reach SET_ALARM has, so looking further would only
 * produce buttons that cannot work. The 05:00 for tomorrow's day shift appears
 * from just after 05:00 today, which is when you would first think about it.
 */
export function pendingAlarms(now, shiftOn, opts = {}) {
  const today = toKey(now);
  const out = [];
  for (const key of [today, addDays(today, 1)]) {
    for (const alarm of alarmsFor(key, shiftOn, opts)) {
      if (!ringsRight(now, key, alarm.time)) continue;
      out.push({ ...alarm, date: key, rings: whenItWouldRing(now, alarm.time) });
    }
  }
  return out.sort((a, b) => a.rings - b.rings);
}

/* ------------------------------------------------------------------ */
/* The hand-off itself                                                 */
/* ------------------------------------------------------------------ */

/** Chrome on Android is the only browser that can fire an intent. */
export function canSetAlarms(ua = navigator.userAgent) {
  return /android/i.test(ua) && !/(firefox|fxios)/i.test(ua);
}

/**
 * An intent: URL the Clock app will answer.
 *
 * Values are URL-encoded because the fragment is parsed on `;` and `=`, and a
 * label reading "Up -- on duty 06:30" contains neither only by luck.
 *
 * SKIP_UI is the difference between one tap and two. True creates the alarm
 * outright; false opens the Clock app with it filled in and waits for a tap.
 * The default is true because that is the thing worth having at 07:00, but not
 * every Clock app honours it -- and one that ignores it silently does nothing
 * at all, which is why the panel offers the other way as a fallback.
 */
export function alarmUrl({ hour, minute, message = '', skipUi = true }) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new RangeError(`bad hour: ${hour}`);
  if (!Number.isInteger(m) || m < 0 || m > 59) throw new RangeError(`bad minute: ${minute}`);

  const extras = [
    'action=android.intent.action.SET_ALARM',
    `i.android.intent.extra.alarm.HOUR=${h}`,
    `i.android.intent.extra.alarm.MINUTES=${m}`,
    `B.android.intent.extra.alarm.SKIP_UI=${skipUi ? 'true' : 'false'}`,
    'B.android.intent.extra.alarm.VIBRATE=true',
  ];
  if (message) extras.push(`S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(message)}`);
  return `intent:#Intent;${extras.join(';')};end`;
}

/** The same, from an alarm out of alarmsFor. */
export function urlForAlarm(alarm, { skipUi = true } = {}) {
  const [hour, minute] = String(alarm.time).split(':').map(Number);
  return alarmUrl({ hour, minute, message: alarm.label, skipUi });
}

/**
 * Fire it. The only impure function here.
 *
 * `location.href` rather than a synthetic click, because Chrome treats an
 * intent: navigation from a real user gesture as trusted and a scripted click
 * on an anchor as not always so.
 */
export function setAlarm(alarm, { skipUi = true } = {}) {
  window.location.href = urlForAlarm(alarm, { skipUi });
}

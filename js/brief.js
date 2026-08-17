/* The morning brief.
 *
 * One paragraph answering "what am I meant to be doing today", composed from
 * what the app already knows. Two rules shaped it:
 *
 *  1. It is built by rules, not written by a model. A brief that is wrong is
 *     worse than no brief — you act on it before you are properly awake. This
 *     one cannot invent a shift you are not on or drop a task you are. It also
 *     costs nothing and works with no signal, which matters for something you
 *     read at 06:00 in a car park.
 *
 *  2. The same text serves every channel. What you read on Home, what gets
 *     sent to WhatsApp, and what goes in a calendar reminder are one string —
 *     so they can never drift out of step with each other.
 *
 * An optional rewrite through Claude sits on top of this (see ai.js). It never
 * replaces the facts; it only reworders them, and it falls back to this text
 * the moment anything goes wrong.
 */

import {
  itemsOnDay, overdueTasks, unscheduledTasks, settings,
  shiftOnDay, crewOnDay, shiftKindOf, SHIFT,
  routineSteps, routineStepDone, linkedTask,
} from './state.js';
import { quoteFor } from './quotes.js';

import { todayKey, formatDayLong, formatTime, timeToMinutes } from './dates.js';

/** Said the way you would say it out loud, not as a label. */
const SHIFT_LINE = {
  [SHIFT.NIGHT]: 'You are on NIGHTS',
  [SHIFT.DAY]: 'You are on DAYS',
  [SHIFT.ONCALL]: 'You are ON CALL',
  [SHIFT.TRAINING]: 'Training day',
  [SHIFT.OFF]: 'You are off today',
  [SHIFT.OTHER]: 'You are on shift',
};

/** Hours are only stated where they are known rather than inferred. */
const SHIFT_HOURS = {
  [SHIFT.DAY]: '0630-1830',
  [SHIFT.NIGHT]: '1830-0630',
};

function greeting(hour) {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Build the brief for a day.
 *
 * Returns both a `lines` array (for rendering, so each part can be styled) and
 * a `text` string (for sending), rather than making the caller re-derive one
 * from the other and risk them disagreeing.
 */
export function composeBrief(dateKey = todayKey(), { now = new Date() } = {}) {
  const cfg = settings();
  const items = itemsOnDay(dateKey).filter((i) => !i.deleted);
  const open = items.filter((i) => !i.done);

  const shift = shiftOnDay(dateKey);
  const crew = crewOnDay(dateKey);

  // Tasks the ritual already speaks for. Without this, the course task lands
  // under "First things" as Study English AND again under "Also today" under
  // its own name — one job, listed twice, which is the fastest way to make a
  // brief look untrustworthy.
  const spokenFor = new Set(
    routineSteps().map((step) => linkedTask(step, dateKey)?.id).filter(Boolean),
  );

  const skip = (i) => isShiftEntry(i, shift) || spokenFor.has(i.id);

  // Anything with a clock time, in the order it happens. Shift entries are
  // excluded — the shift already has its own line, and repeating it here as
  // "0630 Days" is noise on the one line you most want to be scannable.
  const timed = open
    .filter((i) => i.time && !skip(i))
    .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));

  const untimed = open.filter((i) => !i.time && !skip(i));

  const overdue = overdueTasks();
  const waiting = unscheduledTasks().filter((i) => !i.done);

  const lines = [];

  lines.push({ kind: 'head', text: `${greeting(now.getHours())} — ${formatDayLong(dateKey)}` });

  if (shift) {
    const hours = SHIFT_HOURS[shift];
    const withCrew = crew.length ? `, with ${crew.join(', ')}` : '';
    lines.push({
      kind: 'shift',
      shift,
      text: `${SHIFT_LINE[shift] || 'On shift'}${hours ? ` (${hours})` : ''}${withCrew}.`,
    });
  }

  // The ritual leads, ahead of anything the day imposes. That ordering is the
  // whole point of it — a brief that opens with a 09:00 meeting has already
  // conceded the morning to someone else's schedule.
  const ritual = routineSteps();
  if (ritual.length) {
    const outstanding = ritual.filter((step) => !routineStepDone(step, dateKey));
    if (outstanding.length) {
      lines.push({ kind: 'label', text: 'First things' });
      for (const step of outstanding) {
        lines.push({ kind: 'routine', text: step.label });
      }
      // One quote, from the voice belonging to the first thing still to do.
      // Two would be a poster; one is a nudge at the moment it is useful.
      const quote = quoteFor(outstanding[0].kind, dateKey);
      if (quote) lines.push({ kind: 'quote', text: `"${quote.text}" — ${quote.author}` });
    } else {
      lines.push({ kind: 'label', text: 'First things' });
      lines.push({ kind: 'routine-done', text: 'Done — study and gym both ticked off.' });
    }
  }

  if (timed.length) {
    lines.push({ kind: 'label', text: 'On the clock' });
    for (const item of timed) {
      lines.push({
        kind: 'timed',
        text: `${formatTime(item.time, cfg.hour12)} — ${item.title || 'Untitled'}`,
      });
    }
  }

  if (untimed.length) {
    lines.push({ kind: 'label', text: 'Also today' });
    for (const item of untimed) {
      lines.push({ kind: 'task', text: item.title || 'Untitled' });
    }
  }

  // The two counts that change what you do next, and nothing else. A brief
  // that also reports streaks and completion percentages is a dashboard, and
  // a dashboard is not what you want before you have had a coffee.
  const tail = [];
  if (overdue.length) tail.push(`${overdue.length} overdue`);
  if (waiting.length) tail.push(`${waiting.length} unscheduled`);
  if (tail.length) lines.push({ kind: 'alert', text: tail.join(' · ') });

  if (!shift && !timed.length && !untimed.length) {
    lines.push({ kind: 'clear', text: 'Nothing scheduled. The day is yours.' });
  }

  return { dateKey, lines, text: toText(lines), counts: {
    timed: timed.length, tasks: untimed.length,
    overdue: overdue.length, unscheduled: waiting.length,
  } };
}

/**
 * Is this item the rota entry the shift line already covers?
 *
 * Asked through the same classifier the calendar uses, so a task that merely
 * mentions "nights" in its title is never silently swallowed — only something
 * the app already treats as a rota entry is folded into the shift line.
 */
function isShiftEntry(item, shift) {
  return Boolean(shift) && shiftKindOf(item) != null;
}

/**
 * The sendable form.
 *
 * WhatsApp reads *asterisks* as bold and nothing else, so the formatting is
 * kept to that one mark — anything richer arrives as literal punctuation.
 */
function toText(lines) {
  const out = [];
  for (const line of lines) {
    if (line.kind === 'head') out.push(`*${line.text}*`);
    else if (line.kind === 'shift') out.push(`*${line.text}*`);
    else if (line.kind === 'label') out.push('', `*${line.text}*`);
    else if (line.kind === 'timed' || line.kind === 'task') out.push(`• ${line.text}`);
    else if (line.kind === 'routine') out.push(`• ${line.text}`);
    else if (line.kind === 'routine-done') out.push(line.text);
    // Set apart with a blank line above it. In a WhatsApp message a quote
    // butted against a task list reads as another task.
    else if (line.kind === 'quote') out.push('', `_${line.text}_`);
    else if (line.kind === 'alert') out.push('', line.text);
    else out.push(line.text);
  }
  return out.join('\n').trim();
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

/**
 * A wa.me link that opens WhatsApp with the brief already typed.
 *
 * This is the delivery path that needs no account, no key and no third party:
 * it opens the app, the message is there, you press send. The number is
 * optional — without one WhatsApp asks who to send it to, which is what you
 * want the first time.
 *
 * Numbers are stripped to digits because wa.me rejects '+', spaces and dashes,
 * and a number copied out of a phone's contacts has all three.
 */
export function whatsappLink(text, phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(text)}`;
}

/**
 * Send the brief without opening WhatsApp, via CallMeBot.
 *
 * Only used when the user has set up a key. Be clear-eyed about what this is:
 * a free third-party relay that reads the message on its way through, run by
 * someone with no obligation to keep running it. That is an acceptable trade
 * for "here is your day" and would not be for anything private, which is why
 * it is off unless switched on and why the deep link above stays the default.
 *
 * `no-cors` because the endpoint sends no CORS headers: the request is made
 * and the message arrives, but nothing can be read back — so success here
 * means "sent", not "delivered".
 */
export async function sendViaCallMeBot(text, { phone, apiKey }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits || !apiKey) throw new Error('Needs a phone number and an API key.');
  const url = 'https://api.callmebot.com/whatsapp.php'
    + `?phone=${encodeURIComponent(`+${digits}`)}`
    + `&text=${encodeURIComponent(text)}`
    + `&apikey=${encodeURIComponent(apiKey)}`;
  await fetch(url, { mode: 'no-cors' });
}

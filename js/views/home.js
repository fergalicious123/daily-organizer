/* Home — the landing screen.
 *
 * The question this view answers is "what should I be doing?", so it leads
 * with what is happening now and what is next, then today's list. Everything
 * else (full calendar, all lists, history) is one click away and stays there.
 *
 * Deliberately not a wall of statistics: the Progress view already does that,
 * and a home screen that takes reading is a home screen you skip past.
 */

import { el, icon, toast } from '../ui.js';
import { routineCard } from './routine.js';
import { composeBrief, whatsappLink, sendViaCallMeBot } from '../brief.js';
import { aiConfigured, polishBrief } from '../ai.js';
import {
  itemsOnDay, overdueTasks, unscheduledTasks, progressFor,
  currentStreak, completionHistory, settings, device, eventColorSlot,
  shiftOnDay, crewOnDay, liveItems, SHIFT, updateSettings, PHASE,
} from '../state.js';
import { itemCountdowns } from '../countdown.js';
import { partnerName, nextWindows, describeWindow } from '../together.js';
import {
  pendingAlarms, canSetAlarms, setAlarm, DEFAULT_LEAD_MIN,
} from '../alarms.js';
import { zoneConfig } from './clocks.js';
import * as usage from '../usage.js';

/** Only stated where they are known rather than inferred. Same table as the
    brief's, which is the other place the hours are said out loud. */
const SHIFT_HOURS = {
  [SHIFT.DAY]: '0630-1830',
  [SHIFT.NIGHT]: '1830-0630',
};

/** Said as a statement, because this is an answer, not a label. */
const SHIFT_LABEL = {
  [SHIFT.NIGHT]: 'You are on NIGHTS today',
  [SHIFT.DAY]: 'You are on DAYS today',
  [SHIFT.ONCALL]: 'You are ON CALL today',
  [SHIFT.TRAINING]: 'Training day today',
  [SHIFT.OFF]: 'You are off today',
  [SHIFT.OTHER]: 'You are on shift today',
};
import {
  todayKey, formatDayLong, formatTime, timeToMinutes, addDays, formatRelativeDay,
} from '../dates.js';
import { taskList, quickAdd } from './tasks.js';
import { sparkline } from '../chart.js';
import { parseCommand } from '../voice.js';

function greeting(hour) {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The item to lead with: whatever is running right now, else the next thing
 * due today, else the first thing tomorrow.
 */
function findFocus() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const cfg = settings();

  const timedToday = itemsOnDay(todayKey())
    .filter((i) => i.time && !i.done)
    .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));

  const current = timedToday.find((i) => {
    const start = timeToMinutes(i.time);
    return minutes >= start && minutes < start + (i.durationMin || cfg.defaultDurationMin);
  });
  if (current) return { item: current, state: 'now' };

  const next = timedToday.find((i) => timeToMinutes(i.time) > minutes);
  if (next) return { item: next, state: 'next' };

  const tomorrow = itemsOnDay(addDays(todayKey(), 1))
    .filter((i) => !i.done)
    .sort((a, b) => timeToMinutes(a.time || '23:59') - timeToMinutes(b.time || '23:59'))[0];
  if (tomorrow) return { item: tomorrow, state: 'tomorrow' };

  return null;
}

/**
 * The morning brief, and the buttons that send it.
 *
 * Shows the exact text that will be sent rather than a prettier version of it.
 * A send button whose result you have not seen is one you stop trusting the
 * first time it surprises you.
 *
 * Built once per render and cached on the node, because rewording it through
 * Claude costs money and a re-render must not silently spend it again.
 */
function briefCard() {
  const cfg = device();
  const brief = composeBrief();

  const body = el('pre.brief-text', brief.text);
  const status = el('span.brief-status');

  const setText = (text) => { body.textContent = text; };

  const send = el('button.btn.btn-primary.brief-send', {
    onclick: async () => {
      usage.record('BRIEF_SEND');
      const text = body.textContent;
      // Auto-send only where it has been deliberately set up. Everyone else
      // gets the deep link, which needs nothing and works everywhere.
      if (cfg.callMeBotKey && cfg.whatsappNumber) {
        status.textContent = 'Sending…';
        try {
          await sendViaCallMeBot(text, { phone: cfg.whatsappNumber, apiKey: cfg.callMeBotKey });
          status.textContent = '';
          toast('Sent to WhatsApp.');
        } catch (err) {
          status.textContent = '';
          toast(err.message || 'Could not send.', { error: true });
        }
        return;
      }
      // Opens WhatsApp with the message already typed; you press send. No
      // account, no key, no third party — and nothing leaves the phone until
      // you choose to send it.
      window.open(whatsappLink(text, cfg.whatsappNumber), '_blank', 'noopener');
    },
  }, icon('send', 'icon'), cfg.callMeBotKey && cfg.whatsappNumber ? 'Send to WhatsApp' : 'Open in WhatsApp');

  const actions = el('div.brief-actions', send, status);

  // Only offered when a key is set. An always-visible button that fails until
  // you go and configure something is a button that teaches you to ignore it.
  if (aiConfigured()) {
    actions.appendChild(el('button.btn.btn-quiet', {
      onclick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        usage.record('BRIEF_REWORD');
        status.textContent = 'Rewording…';
        const result = await polishBrief(brief);
        setText(result.text);
        status.textContent = '';
        button.disabled = false;
        if (result.error) toast(result.error, { error: true });
      },
    }, 'Reword'));
  }

  /* FOLDED BY DEFAULT.
     The brief is a message to be SENT, not a page to be read, and it is built
     out of the things already on this screen -- the ritual, the shift, what is
     on the clock. Open, it ran to about two screens and said all of that a
     second time in WhatsApp markup, which made the home screen exactly the
     thing its own note warns against: one that takes reading, so you skip past
     it. Folded, it is a row with the button on it; the text is one press away
     for the times you want to check what you are about to send. */
  const text = el('div.brief-text-wrap', { hidden: true }, body, actions);

  const toggle = el('button.brief-peek', {
    type: 'button',
    'aria-expanded': 'false',
    onclick: (e) => {
      const open = text.hidden;
      text.hidden = !open;
      e.currentTarget.setAttribute('aria-expanded', String(open));
      e.currentTarget.textContent = open ? 'Hide' : 'Read it';
    },
  }, 'Read it');

  const quickSend = el('button.btn.btn-primary.brief-send-small', {
    onclick: () => send.click(),
  }, icon('send', 'icon'), 'Send');

  return el('section.brief-card',
    el('div.brief-head',
      el('span.brief-title', 'Morning brief'),
      el('span.brief-sub', brief.counts.overdue
        ? `${brief.counts.overdue} overdue`
        : `${brief.counts.timed + brief.counts.tasks} to do`),
      el('div.brief-head-actions', toggle, quickSend),
    ),
    text,
  );
}

/**
 * When you are both free.
 *
 * Only appears when there IS a second rota in the calendar -- three or more
 * name-prefixed shift entries -- so for anyone without one it is not a card
 * that sits there empty, it is a card that does not exist.
 *
 * Says the time in both zones, always. A window is only useful if you can see
 * what hour it is at her end, and the gap is seven hours or eight depending
 * on the month, which is exactly the sum nobody should be doing by hand.
 */
function togetherCard(onNavigate) {
  const items = liveItems();
  const name = partnerName(items);
  if (!name) return null;

  const zones = zoneConfig();
  const opts = {
    itemsOnDay,
    addDays,
    name,
    homeTz: zones.home.tz,
    awayTz: zones.away.tz,
  };

  const found = nextWindows(todayKey(), opts, 14, 3);
  if (!found.length) return null;

  const rows = found.map(({ day, window }) => el('button.together-row', {
    onclick: () => onNavigate({ view: 'day', anchor: day }),
    title: `Open ${formatDayLong(day)}`,
  },
    el('span.together-when', day === todayKey() ? 'Today' : formatRelativeDay(day)),
    el('span.together-hours', describeWindow(window, zones.home.tz)),
    el('span.together-theirs', `${describeWindow(window, zones.away.tz)} ${zones.away.label}`),
  ));

  const assumed = [...new Set(found.flatMap((f) => f.assumed))];

  return el('section.together-card',
    el('div.task-group-label', `Both free \u00b7 ${name}`),
    ...rows,
    // The model guesses at sleep, so it says which guesses it leaned on. A
    // suggestion you cannot audit is one you stop trusting the first time it
    // is wrong.
    assumed.length
      ? el('p.field-hint.together-note', `Assumes ${assumed.join(', and ')}.`)
      : null,
  );
}

/**
 * Set the alarms the rota calls for.
 *
 * The app cannot BE the alarm -- see alarms.js for why not -- so this is a
 * hand-off to the Clock app, one tap per alarm. It is on Home rather than in
 * Settings because the moment you need it is the moment you are looking at
 * Home: 07:00, off the last night, deciding whether to set anything before you
 * get your head down.
 *
 * Absent on an ordinary day off, which is most of the days it could appear on.
 * A panel offering to wake you up when nothing is asking you to be anywhere is
 * how a panel gets ignored, and then how the one that matters gets ignored too.
 */
function alarmCard() {
  const cfg = settings();
  const now = new Date();
  const pending = pendingAlarms(now, shiftOnDay, {
    leadMin: cfg.alarmLeadMin ?? DEFAULT_LEAD_MIN,
  });
  if (!pending.length) return null;

  const android = canSetAlarms();
  const skipUi = cfg.alarmSkipUi !== false;
  const today = todayKey();

  const rows = pending.map((alarm) => {
    const body = [
      // Time over day, as one column. They answer the same question and a
      // three-line reason beside them left the day floating in the middle of
      // the wrap with nothing to line up against.
      el('span.alarm-clock',
        el('span.alarm-time', alarm.time),
        el('span.alarm-when', alarm.date === today ? 'Today' : 'Tomorrow')),
      el('span.alarm-what',
        el('span.alarm-label', alarm.label),
        el('span.alarm-why', alarm.why)),
    ];

    // Off Android there is no intent to fire, so the same rows render as a
    // list you read and act on yourself. Still worth showing: knowing the
    // 12:00 is what you want is most of the value, and Ben plans on a desktop.
    if (!android) {
      return el('div.alarm-row', { class: alarm.urgent ? 'is-urgent' : '' }, ...body);
    }

    return el('button.alarm-row', {
      class: alarm.urgent ? 'is-urgent' : '',
      onclick: () => {
        usage.record('ALARM_SET');
        // Said before the navigation, because firing an intent takes the tab
        // out from under us and nothing after it is guaranteed to run.
        toast(`${alarm.time} \u2014 handing to the Clock app`);
        setAlarm(alarm, { skipUi });
      },
    }, ...body, icon('bell', 'icon alarm-go'));
  });

  return el('section.alarm-card',
    el('div.task-group-label', 'Alarms to set'),
    ...rows,
    android
      // The fallback is offered rather than explained, because the failure it
      // covers is silent: a Clock app that ignores SKIP_UI does nothing at all
      // and looks identical to a tap that did not register.
      ? el('button.alarm-fallback', {
        onclick: () => {
          updateSettings({ alarmSkipUi: !skipUi });
          toast(skipUi
            ? 'Alarms will open the Clock app to confirm.'
            : 'Alarms will be set in one tap.');
        },
      }, skipUi ? 'Nothing happening? Open the Clock app instead' : 'Set in one tap instead')
      : el('p.field-hint.alarm-note',
        'One-tap setting works on Android. Set these on your phone yourself.'),
  );
}


export function homeView({ onNavigate }) {
  const cfg = settings();
  const today = todayKey();
  const items = itemsOnDay(today);
  const tasks = items.filter((i) => i.kind === 'task');
  const progress = progressFor(items);
  const overdue = overdueTasks();
  const unscheduled = unscheduledTasks().filter((i) => !i.done);
  const streak = currentStreak();
  const history = completionHistory(7);
  const focus = findFocus();

  const root = el('div.home.view-anim');

  /* ---- greeting ---- */
  root.appendChild(el('header.home-head',
    el('h1.home-greeting', greeting(new Date().getHours())),
    el('p.home-date', formatDayLong(today)),
  ));

  /* ---- what shift you are on, above everything ---- */
  // On a rota this is the first thing you want and the thing you are most
  // likely to get wrong — four nights and four days look identical on a phone
  // until you read one. It sits above the up-next card because "am I on
  // nights?" outranks "what is next" when the answer changes your whole day.
  const shift = shiftOnDay(today);
  if (shift) {
    const crew = crewOnDay(today);
    root.appendChild(el('button.home-shift', {
      class: `on-${shift}`,
      onclick: () => onNavigate({ view: 'day', anchor: today }),
    },
      el('span.home-shift-kind', SHIFT_LABEL[shift] || 'On shift'),
      // The hours are the half of this that changes what you do with the
      // evening, and the banner knew them and did not say them -- you had to
      // read the brief further down the page to find out.
      SHIFT_HOURS[shift] ? el('span.home-shift-hours', SHIFT_HOURS[shift]) : null,
      crew.length
        ? el('span.home-shift-crew', `With ${crew.join(', ')}`)
        : null,
    ));
  }

  /* ---- the alarms the rota calls for ----
     Directly under the shift banner: the banner says what you are on, and
     this says the one thing that follows from it which the phone cannot
     work out on its own. On the morning off the last night there is no
     banner at all -- the rota says nothing about a day off -- and this is
     the only thing on the page telling you to set the 12:00. */
  const alarms = alarmCard();
  if (alarms) root.appendChild(alarms);

  /* ---- the ritual, before anything the day imposes on you ----
     Above the calendar and above the list on purpose. Everything below this
     point is what the day is asking of Ben; this is the part he chose. */
  const routine = routineCard(today);
  if (routine) root.appendChild(routine);

  /* ---- and the other end of it ----
     Directly under the morning card, so the ritual reads as one thing in the
     order it is performed. It is not hidden until the evening: on nights his
     bedtime is 07:30, so there is no hour of the day at which "before bed" is
     reliably wrong, and guessing would hide it exactly when the rota is
     strangest. */
  const winddown = routineCard(today, { when: PHASE.EVENING });
  if (winddown) root.appendChild(winddown);

  /* ---- when you are both free ----
     Directly under what is happening today, because it is the same kind of
     question -- what can I actually do with the hours I have -- and because
     the answer changes with the rota, which is the thing above it. */
  const together = togetherCard(onNavigate);
  if (together) root.appendChild(together);

  /* ---- what you are counting down to ----
     Sits under the ritual because the two say the same kind of thing: the
     ritual's steps carry their own countdowns inline, where they argue for
     doing the thing today, and these are the dated ones — an exam, a course
     starting, a flight — which would otherwise be invisible until the week
     they arrive, buried on a date you have no reason to scroll to.
     Absent entirely when there is nothing to count. An empty panel headed
     "Counting down" is a worse answer than no panel. */
  const counts = itemCountdowns(liveItems(), today);
  if (counts.length) {
    const strip = el('section.countdown-strip',
      el('div.task-group-label', 'Counting down'));
    for (const { item, count } of counts) {
      strip.appendChild(el('button.countdown-row', {
        class: count.urgent ? 'is-urgent' : '',
        onclick: () => onNavigate({ view: 'day', anchor: item.date }),
      },
        el('span.countdown-name', item.title || 'Untitled'),
        el('span.countdown-when', formatRelativeDay(item.date)),
        el('span.countdown-days', count.text),
      ));
    }
    root.appendChild(strip);
  }

  /* ---- the brief, and the button that sends it ---- */
  root.appendChild(briefCard());

  /* ---- what's happening ---- */
  if (focus) {
    const { item, state } = focus;
    const caption = state === 'now' ? 'Happening now'
      : state === 'next' ? 'Up next'
      : `Tomorrow · ${formatRelativeDay(item.date)}`;
    root.appendChild(el('button.home-focus', {
      // Tinted with the event's own colour, so the thing you are about to do
      // is recognisable here by the same cue as on the calendar.
      class: [state === 'now' ? 'is-now' : '', `ev-${eventColorSlot(item.title) + 1}`].filter(Boolean).join(' '),
      onclick: () => onNavigate({ view: 'day', anchor: item.date }),
    },
      el('span.home-focus-caption', icon('clock', 'icon'), caption),
      el('span.home-focus-title', item.title || 'Untitled'),
      el('span.home-focus-meta',
        item.time ? formatTime(item.time, cfg.hour12) : 'No set time',
        item.durationMin ? ` · ${item.durationMin} min` : '',
      ),
    ));
  } else {
    root.appendChild(el('div.home-focus.is-clear',
      el('span.home-focus-caption', 'Nothing scheduled'),
      el('span.home-focus-title', 'The rest of the day is yours'),
    ));
  }

  /* ---- overdue, only when it exists ---- */
  if (overdue.length) {
    root.appendChild(el('button.home-alert', {
      onclick: () => onNavigate({ view: 'tasks', listId: 'overdue' }),
    },
      icon('warning', 'icon'),
      el('span', `${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}`),
      el('span.home-alert-go', 'Review'),
    ));
  }

  /* ---- the numbers, as a strip rather than three cards ----
     The day view learned this already and Home never got the lesson: a 116px
     donut is the largest, most saturated thing on the page and first thing in
     the morning it reads 0%, so the loudest element on the screen is there to
     tell you that you have not started yet. A bar says the same in a tenth of
     the space, and gives the room back to the things you came to read.
     The three numbers stay, and both halves still go where they went. */
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  root.appendChild(el('div.home-strip',
    el('div.home-strip-cell',
      el('span.home-strip-label', 'Today'),
      el('span.home-strip-value',
        progress.total ? `${progress.done}/${progress.total}` : '\u2014'),
      el('div.home-strip-bar', el('span', { style: { width: `${pct}%` } })),
    ),
    el('button.home-strip-cell.is-clickable', {
      onclick: () => onNavigate({ view: 'stats' }),
    },
      el('span.home-strip-label', 'Streak'),
      el('span.home-strip-value', String(streak)),
      sparkline(history.map((h) => h.count)),
    ),
    el('button.home-strip-cell.is-clickable', {
      onclick: () => onNavigate({ view: 'tasks', listId: null }),
    },
      el('span.home-strip-label', 'Unscheduled'),
      el('span.home-strip-value', String(unscheduled.length)),
      el('span.home-strip-note', unscheduled.length ? 'waiting for a date' : 'nothing waiting'),
    ),
  ));

  /* ---- today's list ---- */
  const list = el('section.home-list',
    el('div.task-group-label', 'Today'),
    quickAdd({
      defaults: { date: today },
      parser: parseCommand,
      placeholder: 'Add to today…  (try “call mum at 3”)',
      focusId: 'quick-add-home',
    }),
    taskList(tasks, {
      showDate: false,
      emptyMessage: items.length
        ? `No tasks — ${items.length} calendar event${items.length === 1 ? '' : 's'}`
        : 'Nothing on today',
      emptyHint: 'Add something above, or open the calendar to plan.',
    }),
  );
  root.appendChild(list);

  return root;
}

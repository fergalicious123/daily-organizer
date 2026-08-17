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
import { composeBrief, whatsappLink, sendViaCallMeBot } from '../brief.js';
import { aiConfigured, polishBrief } from '../ai.js';
import {
  itemsOnDay, overdueTasks, unscheduledTasks, progressFor,
  currentStreak, completionHistory, settings, device, eventColorSlot,
  shiftOnDay, crewOnDay, SHIFT,
} from '../state.js';

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
import { progressRing, sparkline } from '../chart.js';
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
        status.textContent = 'Rewording…';
        const result = await polishBrief(brief);
        setText(result.text);
        status.textContent = '';
        button.disabled = false;
        if (result.error) toast(result.error, { error: true });
      },
    }, 'Reword'));
  }

  return el('section.brief-card',
    el('div.brief-head',
      el('span.brief-title', 'Morning brief'),
      el('span.brief-sub', brief.counts.overdue
        ? `${brief.counts.overdue} overdue`
        : `${brief.counts.timed + brief.counts.tasks} to do`),
    ),
    body,
    actions,
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
      crew.length
        ? el('span.home-shift-crew', `With ${crew.join(', ')}`)
        : null,
    ));
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

  /* ---- tiles ---- */
  const tiles = el('div.home-tiles');

  tiles.appendChild(el('div.home-tile',
    el('h3', 'Today'),
    progressRing(progress, { size: 116, label: 'Today' }),
    el('p.stat-sub', { style: { textAlign: 'center', margin: 0 } },
      progress.total ? `${progress.done} of ${progress.total} done` : 'No tasks yet'),
  ));

  tiles.appendChild(el('button.home-tile.is-clickable', {
    onclick: () => onNavigate({ view: 'stats' }),
  },
    el('h3', 'Streak'),
    el('div.stat-big', String(streak)),
    el('p.stat-sub', { style: { margin: 0 } },
      streak === 0 ? 'Finish one today' : `day${streak === 1 ? '' : 's'} running`),
    sparkline(history.map((h) => h.count)),
  ));

  tiles.appendChild(el('button.home-tile.is-clickable', {
    onclick: () => onNavigate({ view: 'tasks', listId: null }),
  },
    el('h3', 'Unscheduled'),
    el('div.stat-big', String(unscheduled.length)),
    el('p.stat-sub', { style: { margin: 0 } },
      unscheduled.length ? 'waiting for a date' : 'nothing waiting'),
  ));

  root.appendChild(tiles);

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

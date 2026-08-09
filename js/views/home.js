/* Home — the landing screen.
 *
 * The question this view answers is "what should I be doing?", so it leads
 * with what is happening now and what is next, then today's list. Everything
 * else (full calendar, all lists, history) is one click away and stays there.
 *
 * Deliberately not a wall of statistics: the Progress view already does that,
 * and a home screen that takes reading is a home screen you skip past.
 */

import { el, icon } from '../ui.js';
import {
  itemsOnDay, overdueTasks, unscheduledTasks, progressFor,
  currentStreak, completionHistory, settings,
} from '../state.js';
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

  /* ---- what's happening ---- */
  if (focus) {
    const { item, state } = focus;
    const caption = state === 'now' ? 'Happening now'
      : state === 'next' ? 'Up next'
      : `Tomorrow · ${formatRelativeDay(item.date)}`;
    root.appendChild(el('button.home-focus', {
      class: state === 'now' ? 'is-now' : '',
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

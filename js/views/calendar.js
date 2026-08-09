/* The calendar drill-down: month -> week -> day.
 *
 * Each level is a plain render function returning a DOM node. Navigation is
 * the caller's job (app.js owns the route), so these stay dumb and testable.
 */

import { el, isMobile } from '../ui.js';
import {
  monthGrid, weekDays, isoWeekNumber, sameMonth, isToday, isWeekend,
  fromKey, formatHourLabel, formatTime, timeToMinutes, DAY_ABBR,
  todayKey, addDays, formatDayLong,
} from '../dates.js';
import {
  itemsOnDay, timedItemsOnDay, untimedItemsOnDay, settings,
  updateItem, progressFor, getItem,
} from '../state.js';
import { taskList, quickAdd, openItemEditor } from './tasks.js';
import { reopenOnDay } from './done.js';
import { registerDropZone, makeTouchDraggable } from '../dragdrop.js';
import { progressRing } from '../chart.js';
import { parseCommand } from '../voice.js';

/* Two, not three. A month cell cannot fit three chips plus the day number at
 * realistic row heights, and the third was being sliced horizontally through
 * the glyphs at the cell boundary — which reads as a rendering fault, not as
 * truncation. The chip container also clips on an exact chip multiple (see
 * .month-chips in the stylesheet), so if a cell is ever shorter than this
 * assumes, a chip disappears cleanly instead of being cut in half. */
const MAX_CHIPS = 2;

/* ------------------------------------------------------------------ */
/* Month                                                               */
/* ------------------------------------------------------------------ */

/**
 * Weeks are rows, and a row is the click target — that is the first step of
 * the drill-down. Individual day cells drill straight to the day.
 */
export function monthView(anchorKey, { onSelectWeek, onSelectDay }) {
  const weekStart = settings().weekStart;
  const grid = monthGrid(anchorKey, weekStart);
  const dowLabels = Array.from({ length: 7 }, (_, i) => DAY_ABBR[(weekStart + i) % 7]);

  const root = el('div.month.view-anim');

  root.appendChild(el('div.month-dow',
    el('span', ''),
    dowLabels.map((d) => el('span', d)),
  ));

  const weeksHost = el('div.month-weeks');

  for (const week of grid) {
    const row = el('div.week-row', {
      role: 'button',
      tabIndex: 0,
      title: `Open week ${isoWeekNumber(week[0])}`,
      onclick: () => onSelectWeek(week[0]),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectWeek(week[0]); }
      },
    });

    row.appendChild(el('div.week-num',
      el('span.wk-label', 'wk'),
      el('span.wk-value', String(isoWeekNumber(week[0]))),
    ));

    for (const dayKey of week) {
      row.appendChild(monthDayCell(dayKey, anchorKey, onSelectDay));
    }
    weeksHost.appendChild(row);
  }

  root.appendChild(weeksHost);
  return root;
}

function monthDayCell(dayKey, anchorKey, onSelectDay) {
  const items = itemsOnDay(dayKey);
  const outside = !sameMonth(dayKey, anchorKey);

  const cell = el('div.month-day', {
    class: [
      outside ? 'is-outside' : '',
      isWeekend(dayKey) ? 'is-weekend' : '',
      isToday(dayKey) ? 'is-today' : '',
    ].filter(Boolean).join(' '),
    role: 'button',
    tabIndex: -1,
    'aria-label': `${dayKey}, ${items.length} item${items.length === 1 ? '' : 's'}`,
    // fitMonthChips() needs the true total to recompute "+N more" after it
    // drops chips that will not fit whole.
    dataset: { total: String(items.length) },
    onclick: (e) => { e.stopPropagation(); onSelectDay(dayKey); },
  });

  // Month cells accept drops too, so something can be dragged onto a date
  // without first drilling into that day.
  makeDropTarget(cell, dayKey, null);

  // Dots carry the signal on phones, where chips are unreadable.
  const dots = items.slice(0, 4).map(() => el('span.mini-dot'));

  cell.appendChild(el('div.month-day-num',
    el('span', String(fromKey(dayKey).getDate())),
    items.length ? el('span.dot-row', dots) : null,
  ));

  // Chips live in their own clipped box whose height is an exact multiple of
  // the chip height, so the clip edge always lands between chips.
  const chips = el('div.month-chips');
  for (const item of items.slice(0, MAX_CHIPS)) {
    chips.appendChild(el('div.month-chip', {
      class: [item.done ? 'is-done' : '', item.kind === 'event' ? 'is-event' : ''].filter(Boolean).join(' '),
      title: item.title,
    }, item.time ? `${formatTime(item.time, settings().hour12)} ` : '', item.title || 'Untitled'));
  }
  if (items.length) cell.appendChild(chips);

  if (items.length > MAX_CHIPS) {
    cell.appendChild(el('div.month-more', `+${items.length - MAX_CHIPS} more`));
  }

  return cell;
}

/**
 * Drop month chips that cannot be shown whole, and correct the "+N more".
 *
 * Must run after the month view is in the document, because it depends on the
 * laid-out cell height — which varies with the number of week rows. A six-row
 * month gives ~81px cells against ~103px for a five-row one, and only the
 * six-row case is tight enough to matter.
 *
 * Why this is not CSS: the box needs its height floored to a whole multiple of
 * the chip height, and CSS has no floor. Capping with max-height fails because
 * the surrounding flex column shrinks the box below the cap to a fractional
 * chip, which is exactly how a chip ends up sliced through its letters.
 *
 * The label is measured in a second pass: reserving its height changes the
 * capacity, which can change whether a label is needed at all.
 */
export function fitMonthChips(root) {
  const cells = root.querySelectorAll('.month-day');
  if (!cells.length) return;

  const rootStyles = getComputedStyle(document.documentElement);
  const chipH = parseFloat(rootStyles.getPropertyValue('--month-chip-h')) || 17;
  const chipGap = parseFloat(rootStyles.getPropertyValue('--month-chip-gap')) || 2;

  for (const cell of cells) {
    const box = cell.querySelector('.month-chips');
    if (!box) continue;

    const total = Number(cell.dataset.total || 0);
    const numEl = cell.querySelector('.month-day-num');
    const cs = getComputedStyle(cell);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const rowGap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 0;

    const base = cell.clientHeight - padY
      - (numEl ? numEl.offsetHeight + rowGap : 0);

    /** How many whole chips fit in `space`. */
    const capacityFor = (space) =>
      Math.max(0, Math.floor((space + chipGap) / (chipH + chipGap)));

    // First pass with no label reserved.
    let capacity = capacityFor(base);
    let moreEl = cell.querySelector('.month-more');

    // If anything will be hidden, a label is needed — so reserve its height
    // and recompute, because that reservation can cost a chip.
    if (capacity < total) {
      const labelH = moreEl ? moreEl.offsetHeight : 13;
      capacity = capacityFor(base - labelH - rowGap);
    }

    const shown = Math.min(capacity, box.children.length, total);
    while (box.children.length > shown) box.lastElementChild.remove();

    const hidden = total - shown;
    if (hidden > 0) {
      if (!moreEl) {
        moreEl = el('div.month-more');
        cell.appendChild(moreEl);
      }
      moreEl.textContent = `+${hidden} more`;
    } else if (moreEl) {
      moreEl.remove();
    }

    // With nothing left to show, the empty box would still occupy its gap.
    if (!box.children.length) box.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Week                                                                */
/* ------------------------------------------------------------------ */

/** Seven day columns. The column header drills into the day. */
export function weekView(anchorKey, { onSelectDay }) {
  const weekStart = settings().weekStart;
  const days = weekDays(anchorKey, weekStart);
  const root = el('div.week.view-anim');

  for (const dayKey of days) {
    const items = itemsOnDay(dayKey);
    const prog = progressFor(items);
    const d = fromKey(dayKey);

    const col = el('div.week-col', { class: isToday(dayKey) ? 'is-today' : '' });

    col.appendChild(el('div.week-col-head', {
      role: 'button',
      tabIndex: 0,
      title: `Open ${dayKey}`,
      onclick: () => onSelectDay(dayKey),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDay(dayKey); }
      },
    },
      el('div.week-col-dow', DAY_ABBR[d.getDay()]),
      el('div.week-col-date',
        String(d.getDate()),
        prog.total > 0
          ? el('span.week-col-meta', `${prog.done}/${prog.total}`)
          : null,
      ),
    ));

    const body = el('div.week-col-body');
    makeDropTarget(body, dayKey, null);

    for (const item of items) {
      const weekItem = el('div.week-item', {
        class: [item.done ? 'is-done' : '', item.kind === 'event' ? 'is-event' : ''].filter(Boolean).join(' '),
        draggable: 'true',
        onclick: () => openItemEditor(item.id),
        ondragstart: (e) => {
          e.dataTransfer.setData('text/plain', item.id);
          e.dataTransfer.effectAllowed = 'move';
        },
      },
        item.time ? el('span.week-item-time', formatTime(item.time, settings().hour12)) : null,
        el('span.week-item-title', item.title || 'Untitled'),
      );
      makeTouchDraggable(weekItem, () => item.id);
      body.appendChild(weekItem);
    }

    col.appendChild(body);
    root.appendChild(col);
  }

  return root;
}

/* ------------------------------------------------------------------ */
/* Day                                                                 */
/* ------------------------------------------------------------------ */

/** Hour grid plus that day's todo list. */
export function dayView(dayKey, { onOpenItem } = {}) {
  const cfg = settings();
  const timed = timedItemsOnDay(dayKey);
  const untimed = untimedItemsOnDay(dayKey);

  // Widen the visible window if something sits outside the usual day, so an
  // 05:30 run or a 23:00 deadline is never hidden.
  let first = cfg.dayStart;
  let last = cfg.dayEnd;
  for (const item of timed) {
    const h = Math.floor(timeToMinutes(item.time) / 60);
    first = Math.min(first, h);
    last = Math.max(last, h);
  }
  first = Math.max(0, first);
  last = Math.min(23, Math.max(last, first + 1));

  const root = el('div.day.view-anim', { class: isMobile() ? 'is-single' : '' });
  const gridWrap = el('div.day-grid-wrap');

  // All-day strip.
  const allDay = el('div.day-allday');
  if (untimed.length) {
    allDay.appendChild(el('span.day-allday-label', 'All day'));
    for (const item of untimed) {
      allDay.appendChild(el('div.day-event', {
        class: [item.done ? 'is-done' : '', item.kind === 'event' ? 'is-event' : ''].filter(Boolean).join(' '),
        draggable: 'true',
        onclick: () => (onOpenItem ? onOpenItem(item.id) : openItemEditor(item.id)),
        ondragstart: (e) => {
          e.dataTransfer.setData('text/plain', item.id);
          e.dataTransfer.effectAllowed = 'move';
        },
      }, el('span.day-event-title', item.title || 'Untitled')));
    }
  }
  gridWrap.appendChild(allDay);

  // Hour rows.
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  for (let h = first; h <= last; h++) {
    const row = el('div.hour-row', {
      class: (isToday(dayKey) && h * 60 + 59 < nowMinutes) ? 'is-past' : '',
    });
    row.appendChild(el('div.hour-label', formatHourLabel(h, cfg.hour12)));

    const slot = el('div.hour-slot');
    const time = `${String(h).padStart(2, '0')}:00`;
    makeDropTarget(slot, dayKey, time);

    for (const item of timed.filter((i) => Math.floor(timeToMinutes(i.time) / 60) === h)) {
      slot.appendChild(dayEventNode(item, onOpenItem));
    }

    slot.appendChild(el('button.hour-add', {
      'aria-label': `Add something at ${formatHourLabel(h, cfg.hour12)}`,
      onclick: () => openItemEditor(null, { date: dayKey, time }),
    }, '+ add'));

    row.appendChild(slot);
    gridWrap.appendChild(row);
  }

  // "You are here" line, positioned within its hour row.
  if (isToday(dayKey)) {
    const nowHour = Math.floor(nowMinutes / 60);
    if (nowHour >= first && nowHour <= last) {
      const rows = gridWrap.querySelectorAll('.hour-row');
      const target = rows[nowHour - first];
      if (target) {
        target.style.position = 'relative';
        const pct = (nowMinutes % 60) / 60 * 100;
        target.appendChild(el('div.now-line', {
          style: { top: `${pct}%`, left: '56px' },
          'aria-hidden': 'true',
        }));
      }
    }
  }

  root.appendChild(gridWrap);

  // Side panel: the day's tasks and its completion ring.
  const items = itemsOnDay(dayKey);
  const side = el('div.day-side',
    el('div.progress-card',
      el('div.progress-card-head',
        el('span.progress-card-title', 'This day'),
        el('span.progress-card-scope', isToday(dayKey) ? 'today' : ''),
      ),
      progressRing(progressFor(items), { size: 116, label: 'This day' }),
    ),
    (() => {
      const tasks = items.filter((i) => i.kind === 'task');
      const eventCount = items.length - tasks.length;
      return el('div',
        el('div.task-group-label', 'Tasks'),
        quickAdd({
          defaults: { date: dayKey },
          // Every quick-add box parses. Two identical-looking inputs where
          // only one understands "tomorrow at 3" is worse than neither doing.
          parser: parseCommand,
          placeholder: 'Add to this day…',
          focusId: 'quick-add-day',
        }),
        taskList(tasks, {
          showDate: false,
          // A day is a timetable. Keep it in clock order and let the stripe
          // colour carry urgency instead of the ordering.
          urgencyOrder: false,
          // "Nothing on this day" is a lie when the grid is full of calendar
          // events. Anything pulled from Google arrives as an event, not a
          // task, so this panel is legitimately empty while the day is busy —
          // say which it is rather than implying the day is clear.
          emptyMessage: eventCount
            ? `No tasks — ${eventCount} calendar event${eventCount === 1 ? '' : 's'}`
            : 'Nothing on this day',
          emptyHint: eventCount
            ? 'Calendar events show in the grid. Open one to turn it into a task you can tick off.'
            : 'Add something above, or drag a task onto an hour.',
        }),
      );
    })(),
  );
  root.appendChild(side);

  return root;
}

function dayEventNode(item, onOpenItem) {
  const cfg = settings();
  const node = el('div.day-event', {
    class: [item.done ? 'is-done' : '', item.kind === 'event' ? 'is-event' : ''].filter(Boolean).join(' '),
    draggable: 'true',
    onclick: () => (onOpenItem ? onOpenItem(item.id) : openItemEditor(item.id)),
    ondragstart: (e) => {
      e.dataTransfer.setData('text/plain', item.id);
      e.dataTransfer.effectAllowed = 'move';
    },
  },
    el('span.day-event-title', item.title || 'Untitled'),
    el('span.day-event-meta',
      formatTime(item.time, cfg.hour12),
      item.durationMin ? ` · ${formatDuration(item.durationMin)}` : '',
    ),
  );
  makeTouchDraggable(node, () => item.id);
  return node;
}

function formatDuration(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/* ------------------------------------------------------------------ */
/* Day strip                                                           */
/* ------------------------------------------------------------------ */

/**
 * A horizontal row of upcoming days that accept drops.
 *
 * The list views are where undated tasks live, but they show no calendar — so
 * there was nothing on screen to drag a task onto. On a phone that made
 * drag-to-schedule impossible rather than merely awkward, because the sidebar
 * holding the mini-calendar is a closed drawer.
 *
 * Sticky, so it stays reachable while you scroll a long backlog.
 */
export function dayStrip({ days = 14, onSelectDay = null } = {}) {
  const start = todayKey();
  const strip = el('div.day-strip', {
    role: 'group',
    'aria-label': 'Drag a task onto a day to schedule it',
  });

  strip.appendChild(el('div.day-strip-hint', 'Drag onto a day →'));

  const rail = el('div.day-strip-rail');
  for (let i = 0; i < days; i++) {
    const dayKey = addDays(start, i);
    const d = fromKey(dayKey);
    const count = itemsOnDay(dayKey).filter((x) => !x.done).length;

    const card = el('button.day-strip-day', {
      class: [
        i === 0 ? 'is-today' : '',
        isWeekend(dayKey) ? 'is-weekend' : '',
      ].filter(Boolean).join(' '),
      title: `${formatDayLong(dayKey)} — ${count} open item${count === 1 ? '' : 's'}`,
      onclick: () => onSelectDay?.(dayKey),
    },
      el('span.day-strip-dow', i === 0 ? 'Today' : (i === 1 ? 'Tmrw' : DAY_ABBR[d.getDay()])),
      el('span.day-strip-num', String(d.getDate())),
      count
        ? el('span.day-strip-count', String(count))
        : el('span.day-strip-count.is-empty', '·'),
    );

    // Untimed: dropping on a strip day sets the date and leaves the hour open.
    makeDropTarget(card, dayKey, null);
    rail.appendChild(card);
  }

  strip.appendChild(rail);
  return strip;
}

/* ------------------------------------------------------------------ */
/* Drag to schedule                                                    */
/* ------------------------------------------------------------------ */

/**
 * Make a node accept a dragged task and re-date (and optionally re-time) it.
 * Passing time = null moves the task to the day without pinning an hour.
 */
/**
 * What a drop actually does. Shared by the mouse path (HTML5 DnD) and the
 * touch path, so a finger and a cursor cannot drift apart in behaviour.
 */
export function applyDropOnDay({ itemId, dateKey, time }) {
  if (!itemId) return;
  // A completed item dragged onto a day means "do this again": reopen it and
  // reschedule, rather than silently moving a ticked-off task.
  if (reopenOnDay(itemId, dateKey, time)) return;
  const patch = { date: dateKey, time: time || null };
  // Dropping onto an hour gives an untimed task a sensible block length.
  if (time) patch.durationMin = getItem(itemId)?.durationMin || settings().defaultDurationMin;
  updateItem(itemId, patch);
}

function makeDropTarget(node, dayKey, time) {
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('is-drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('is-drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('is-drop-target');
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    applyDropOnDay({ itemId: id, dateKey: dayKey, time });
  });

  // The same node also accepts touch drops.
  registerDropZone(node, { dateKey: dayKey, time }, applyDropOnDay);
}

export { makeDropTarget };

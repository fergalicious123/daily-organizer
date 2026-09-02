/* The calendar drill-down: month -> week -> day.
 *
 * Each level is a plain render function returning a DOM node. Navigation is
 * the caller's job (app.js owns the route), so these stay dumb and testable.
 */

import { el, icon, isMobile, toast } from '../ui.js';
import * as usage from '../usage.js';
import { partnerName, windowsOn, describeWindow } from '../together.js';
import { timeInZone } from '../zones.js';
import { zoneConfig } from './clocks.js';
import {
  monthGrid, weekDays, isoWeekNumber, sameMonth, isToday, isWeekend, isPast,
  fromKey, formatHourLabel, formatTime, timeToMinutes, DAY_ABBR,
  todayKey, addDays, formatDayLong, diffDays,
} from '../dates.js';
import {
  itemsOnDay, timedItemsOnDay, untimedItemsOnDay, unscheduledTasks, settings,
  updateItem, progressFor, getItem, eventColorSlot, liveItems, isSpanning,
  shiftOnDay, crewOnDay, shiftFor, crewFrom, shiftKindOf, hasJournal, SHIFT, store, addItem,
} from '../state.js';

/** How each shift is named wherever one is spelled out rather than coloured. */
const SHIFT_LABEL = {
  [SHIFT.NIGHT]: 'nights',
  [SHIFT.DAY]: 'days',
  [SHIFT.ONCALL]: 'on call',
  [SHIFT.TRAINING]: 'a training day',
  [SHIFT.OFF]: 'off',
  [SHIFT.OTHER]: 'shift',
};

/**
 * The hours a shift actually runs. Days are 0630-1830, twelve hours, as
 * stated. Nights are the other half of the same clock — inferred, not given,
 * so if the handover is not at 1830 this is the line to correct.
 */
const SHIFT_HOURS = {
  [SHIFT.DAY]: '0630-1830',
  [SHIFT.NIGHT]: '1830-0630',
};

/** The word on the month cell. Short, because a cell is ~100px wide. */
const SHIFT_BADGE = {
  [SHIFT.NIGHT]: 'NIGHTS',
  [SHIFT.DAY]: 'DAYS',
  [SHIFT.ONCALL]: 'ON CALL',
  [SHIFT.TRAINING]: 'TRAINING',
  [SHIFT.OFF]: 'OFF',
  [SHIFT.OTHER]: 'SHIFT',
};

/*
 * The long words, on a phone.
 *
 * A month cell is 43px wide at 375px, which leaves 35 for the badge, and
 * "TRAINING" wants 44 even at 8px with the padding trimmed — so the longest
 * badge, on the one day it marks, was losing its last letters. These are the
 * roster's own codes rather than invented shortenings: TRG and OC are what is
 * written on the board, so they need no learning.
 */
const SHIFT_BADGE_TIGHT = {
  ...SHIFT_BADGE,
  [SHIFT.TRAINING]: 'TRG',
  [SHIFT.ONCALL]: 'OC',
};

/** The badge for a month cell, which is the narrowest place one appears. */
function shiftBadge(shift) {
  return (isMobile() ? SHIFT_BADGE_TIGHT : SHIFT_BADGE)[shift] || 'SHIFT';
}
import { taskList, quickAdd, openItemEditor } from './tasks.js';
import { reopenOnDay } from './done.js';
import { journalEditor } from './journal.js';
import { PLAN_PREFIX, takePlanStep } from '../plan.js';
import { registerDropZone, makeTouchDraggable } from '../dragdrop.js';
import { parseCommand } from '../voice.js';

/* Two, not three. A month cell cannot fit three chips plus the day number at
 * realistic row heights, and the third was being sliced horizontally through
 * the glyphs at the cell boundary — which reads as a rendering fault, not as
 * truncation. The chip container also clips on an exact chip multiple (see
 * .month-chips in the stylesheet), so if a cell is ever shorter than this
 * assumes, a chip disappears cleanly instead of being cut in half. */
const MAX_CHIPS = 2;

/** Colour dots per cell on a phone. Two rows of four is all a 45px cell holds
 *  before the dots shrink past the point of telling colours apart. */
const MAX_DOTS = 8;

/** Pixels per hour in the day grid. Sets how tall an hour reads. */
const HOUR_H = 54;

/** Height of a spanning bar in the month grid. */
const SPAN_H = 18;

/**
 * Work out the spanning bars to draw across one week row.
 *
 * Each bar is clipped to the week — a shift running Wednesday to the following
 * Monday draws as two bars, one per row, flagged so the cut ends read as
 * continuations rather than as separate events. Bars are packed into lanes so
 * two overlapping spans never sit on top of each other.
 */
/**
 * Multi-day items drawn as one bar across the row — but NOT shifts.
 *
 * A shift run now draws as its own block inside each day it covers, so that
 * every day can carry its own crew. Left in here as well, the run would appear
 * twice: once as a bar and once as four blocks under it.
 */
function spanningBarsForWeek(week) {
  const weekStartKey = week[0];
  const weekEndKey = week[6];

  const spans = liveItems()
    .filter((i) => isSpanning(i) && !shiftKindOf(i)
      && i.date <= weekEndKey && i.endDate >= weekStartKey)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
      : (b.endDate > a.endDate ? 1 : -1)));

  const lanes = [];          // lane index -> last occupied column
  return spans.map((item) => {
    const startCol = Math.max(0, diffDays(weekStartKey, item.date));
    const endCol = Math.min(6, diffDays(weekStartKey, item.endDate));

    let lane = lanes.findIndex((lastCol) => lastCol < startCol);
    if (lane === -1) { lane = lanes.length; lanes.push(endCol); }
    else lanes[lane] = endCol;

    return {
      item,
      startCol,
      endCol,
      lane,
      continuesBefore: item.date < weekStartKey,
      continuesAfter: item.endDate > weekEndKey,
    };
  });
}

function spanBarNode(bar, onSelectDay) {
  const { item, startCol, endCol, lane } = bar;
  // A shift block is the one thing on this grid that spans on purpose, so the
  // bar carries the rota colour and says what the run is — "DAYS · 0630-1830"
  // across four columns beats the same word repeated in four cells.
  const shift = shiftKindOf(item);
  const label = shift
    ? [SHIFT_BADGE[shift], SHIFT_HOURS[shift]].filter(Boolean).join(' · ')
    : (item.title || 'Untitled');
  return el('button.span-bar', {
    class: [
      shift ? `on-${shift} is-shift` : `ev-${eventColorSlot(item.title) + 1}`,
      bar.continuesBefore ? 'is-cont-before' : '',
      bar.continuesAfter ? 'is-cont-after' : '',
      item.done ? 'is-done' : '',
    ].filter(Boolean).join(' '),
    style: {
      // +2 because column 1 is the week-number gutter.
      gridColumn: `${startCol + 2} / ${endCol + 3}`,
      marginTop: `${6 + lane * (SPAN_H + 2)}px`,
      height: `${SPAN_H}px`,
    },
    title: [
      item.title,
      shift && SHIFT_HOURS[shift] ? SHIFT_HOURS[shift] : null,
      `${item.date} to ${item.endDate}`,
    ].filter(Boolean).join(' · '),
    onclick: (e) => { e.stopPropagation(); onSelectDay(item.date); },
  }, el('span.span-bar-text', label));
}

/**
 * Place timed events into side-by-side lanes so overlaps stay readable.
 *
 * Events are grouped into clusters of mutually-overlapping items, and within a
 * cluster each takes the first lane whose previous occupant has already
 * finished. The lane count is per cluster, not per day — so one busy hour does
 * not squeeze every other event on the day into a narrow column.
 */
export function layoutDayEvents(items, defaultDurationMin = 60) {
  const events = items
    .filter((i) => i.time)
    .map((item) => {
      const start = timeToMinutes(item.time);
      const length = Math.max(item.durationMin || defaultDurationMin, 15);
      return { item, start, end: start + length, lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let cluster = [];
  let clusterEnd = -1;

  const closeCluster = () => {
    if (!cluster.length) return;
    const laneEnds = [];
    for (const e of cluster) {
      let lane = laneEnds.findIndex((end) => end <= e.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(e.end); }
      else laneEnds[lane] = e.end;
      e.lane = lane;
    }
    for (const e of cluster) e.lanes = laneEnds.length;
    cluster = [];
    clusterEnd = -1;
  };

  for (const e of events) {
    // A gap with nothing spanning it ends the cluster.
    if (cluster.length && e.start >= clusterEnd) closeCluster();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  closeCluster();

  return events;
}

/* ------------------------------------------------------------------ */
/* Month                                                               */
/* ------------------------------------------------------------------ */

/**
 * Weeks are rows, and a row is the click target — that is the first step of
 * the drill-down. Individual day cells drill straight to the day.
 */
/**
 * The both-free window on one day, with a way to make it an actual call.
 *
 * He already creates these by hand -- his calendar has a "Call Sheila" event
 * with an hour on it and a reminder -- so the button does exactly that, from
 * a window the app worked out rather than one he did. The reminder is the
 * point: a window you have to remember is a window you miss.
 */
function togetherPanel(dayKey) {
  const name = partnerName(liveItems());
  if (!name) return null;

  const zones = zoneConfig();
  const { windows, assumed } = windowsOn(dayKey, {
    itemsOnDay, addDays, name, homeTz: zones.home.tz, awayTz: zones.away.tz,
  });
  if (!windows.length) return null;

  const title = `Call ${name}`;
  const already = itemsOnDay(dayKey).some(
    (i) => !i.deleted && i.title.trim().toLowerCase() === title.toLowerCase(),
  );

  const rows = windows.map((w) => {
    const [start, end] = w;
    const mine = timeInZone(new Date(start), zones.home.tz);
    const theirs = describeWindow(w, zones.away.tz);
    const lengthMin = Math.round((end - start) / 60000);

    return el('div.together-day-row',
      el('span.together-hours', describeWindow(w, zones.home.tz)),
      el('span.together-theirs', `${theirs} ${zones.away.label}`),
      already
        ? el('span.together-booked', 'in the diary')
        : el('button.btn.btn-quiet.together-book', {
          onclick: () => {
            addItem({
              kind: 'event',
              title,
              date: dayKey,
              time: mine,
              // An hour, or the window if it is shorter than one.
              durationMin: Math.min(60, lengthMin),
              remindMin: 10,
            });
            toast(`${title} at ${mine}`, { action: 'Undo', onAction: () => store.undo() });
            document.dispatchEvent(new CustomEvent('organizer:rerender'));
          },
        }, icon('phone', 'icon'), 'Put it in'),
    );
  });

  return el('div.together-panel',
    el('div.together-panel-head', icon('phone', 'icon'), `Both free \u00b7 ${name}`),
    ...rows,
    assumed.length ? el('p.field-hint', `Assumes ${assumed.join(', and ')}.`) : null,
  );
}

/*
 * Which of these days you and she are both free on.
 *
 * Computed once for a whole grid rather than per cell, and returned as a Set
 * so a cell only has to ask whether it is in it. Costs about 4ms for a month
 * at his data size; see the fast path in zones.js, without which it was 96.
 *
 * Null, not an empty Set, when there is no second rota in the calendar. The
 * caller has to be able to tell "nobody to be free with" from "no windows
 * this month", because the first should draw nothing at all.
 */
function togetherDays(days) {
  const name = partnerName(liveItems());
  if (!name) return null;
  const zones = zoneConfig();
  const opts = {
    itemsOnDay, addDays, name, homeTz: zones.home.tz, awayTz: zones.away.tz,
  };
  const set = new Set();
  for (const day of days) {
    const { windows } = windowsOn(day, opts);
    if (windows.length) set.add(day);
  }
  return set;
}

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
  const together = togetherDays(grid.flat());

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

    // Bars for anything spanning more than one day in this week, laid across
    // the grid columns so a four-day shift reads as one continuous block
    // rather than vanishing after its first day.
    const bars = spanningBarsForWeek(week);
    for (const bar of bars) {
      row.appendChild(spanBarNode(bar, onSelectDay));
    }

    week.forEach((dayKey, i) => {
      const cell = monthDayCell(dayKey, anchorKey, onSelectDay, together);
      // Pin every cell to its own column. Without this the cells are
      // auto-placed, so a bar claiming columns 4-7 pushed them along the row
      // and the grid came apart: two 40px cells, a 191px hole where the bar
      // was, then the rest shunted right. Both the bars and the cells are now
      // explicitly placed, so a bar lies over its days instead of displacing
      // them. +2 because column 1 is the week-number gutter.
      cell.style.gridColumn = String(i + 2);
      // Column index, so a shift run can reveal across its days in order. A
      // run has direction — it starts on one day and ends on another — and the
      // motion says so rather than decorating.
      cell.style.setProperty('--col', String(i));
      // Reserve room so the cell's own content starts below the bars.
      if (bars.length) {
        cell.style.paddingTop = `${6 + bars.length * (SPAN_H + 2)}px`;
      }
      row.appendChild(cell);
    });
    weeksHost.appendChild(row);
  }

  root.appendChild(weeksHost);
  return root;
}

function monthDayCell(dayKey, anchorKey, onSelectDay, together) {
  const all = itemsOnDay(dayKey);
  // Spanning items are drawn once as a bar across the row, so a chip here as
  // well would show the same thing twice. A shift is the exception: it is
  // drawn as a block in this cell, so its chip is dropped on every day it
  // covers, not just the ones it spans.
  const items = all.filter((i) => !isSpanning(i) && !shiftKindOf(i));
  const outside = !sameMonth(dayKey, anchorKey);
  // Derived from the items already fetched above. Calling shiftOnDay and
  // crewOnDay here would each re-scan and re-sort the entire item list, three
  // times per cell and 126 times over a six-week grid.
  const shift = shiftFor(all);
  const crew = crewFrom(all);

  const cell = el('div.month-day', {
    class: [
      outside ? 'is-outside' : '',
      isWeekend(dayKey) ? 'is-weekend' : '',
      isToday(dayKey) ? 'is-today' : '',
      // Every one of these cells is a drop target, and a day that has gone
      // looks exactly like a day that has not until you read the number.
      isPast(dayKey) ? 'is-past' : '',
      shift ? `on-${shift}` : '',
    ].filter(Boolean).join(' '),
    role: 'button',
    tabIndex: -1,
    'aria-label': [
      dayKey,
      shift ? SHIFT_LABEL[shift] : null,
      crew.length ? `with ${crew.join(', ')}` : null,
      `${items.length} item${items.length === 1 ? '' : 's'}`,
    ].filter(Boolean).join(', '),
    // The whole cell is the readable signal for a rota — at a glance you want
    // to see the shape of the block, not read four chips to work it out.
    title: [
      shift ? `On ${SHIFT_LABEL[shift]}` : null,
      shift && SHIFT_HOURS[shift] ? SHIFT_HOURS[shift] : null,
      crew.length ? `With ${crew.join(', ')}` : null,
    ].filter(Boolean).join(' · ') || null,
    // fitMonthChips() needs the true total to recompute "+N more" after it
    // drops chips that will not fit whole.
    dataset: { total: String(items.length) },
    onclick: (e) => { e.stopPropagation(); onSelectDay(dayKey); },
  });

  // Month cells accept drops too, so something can be dragged onto a date
  // without first drilling into that day.
  makeDropTarget(cell, dayKey, null);

  // A number, not a row of dots. Dots capped at four and said nothing about
  // how many there actually were — the one question a month grid is asked.
  const open = items.filter((i) => !i.done).length;
  const allDone = items.length > 0 && open === 0;

  cell.appendChild(el('div.month-day-num',
    el('span.month-day-date', String(fromKey(dayKey).getDate())),
    // A day you wrote something about is a day worth going back to, and there
    // was nothing on the calendar to say which those were.
    hasJournal(dayKey)
      ? el('span.day-diary', { title: 'There is a diary entry for this day' },
          icon('book', 'icon'))
      : null,
    // A day you could actually speak to her on. Small, because it is a
    // possibility rather than a commitment -- nothing is booked.
    together?.has(dayKey)
      ? el('span.day-together', { title: 'You are both free at some point today' },
          icon('phone', 'icon'))
      : null,
    items.length
      ? el('span.month-count', {
        class: allDone ? 'is-clear' : '',
        title: allDone
          ? `${items.length} item${items.length === 1 ? '' : 's'}, all done`
          : `${open} still to do of ${items.length}`,
      }, allDone ? icon('check', 'icon') : String(open))
      : null,
  ));

  // The shift, said in words, above the chips.
  //
  // A tinted cell was not enough and should not have been expected to be: the
  // cell is mostly chips, the tint is behind them, and a wash you have to
  // interpret loses to eight words of black text every time. This is the one
  // fact on the cell that changes what the whole day is, so it gets said
  // outright, at the top, in the shift's colour.
  // The shift, as its own block inside the day. One per day of the run rather
  // than a single bar across it, so each day can carry the crew that was
  // actually on it — a run's crew is constant today, but the roster is not
  // built on that promise and a changeover mid-block should be visible.
  if (shift) {
    // No hours line here. They are the same on all 39 day-shift cells, so
    // repeating them costs a whole line of a 96px cell to say nothing that
    // changes. The crew does change, so that is what the cell spends its
    // space on; the hours live on the day view and the cell's tooltip.
    cell.appendChild(el('div.month-shift',
      el('span.month-shift-label', shiftBadge(shift)),
      crew.length ? el('span.month-shift-crew', crew.join(', ')) : null,
    ));
  }

  // Chips live in their own clipped box whose height is an exact multiple of
  // the chip height, so the clip edge always lands between chips.
  const chips = el('div.month-chips');
  for (const item of items.slice(0, MAX_CHIPS)) {
    chips.appendChild(el('div.month-chip', {
      class: [
        item.done ? 'is-done' : '',
        item.kind === 'event' ? 'is-event' : '',
        `ev-${eventColorSlot(item.title) + 1}`,
      ].filter(Boolean).join(' '),
      title: item.title,
    },
      el('span.chip-dot'),
      el('span.chip-text',
        item.time ? `${formatTime(item.time, settings().hour12)} ` : '',
        item.title || 'Untitled'),
    ));
  }
  if (items.length) cell.appendChild(chips);

  if (items.length > MAX_CHIPS) {
    cell.appendChild(el('div.month-more', `+${items.length - MAX_CHIPS} more`));
  }

  // A phone hides the chips — a 45px cell cannot show a legible label — which
  // also took away every trace of colour. These dots put the colour back
  // without pretending to be readable text. They do NOT bring back the old
  // dots-instead-of-a-count: the count still answers "how many", and these
  // answer "what kind", which is the question the chips used to answer.
  // Hidden on desktop, where the chips say it better. Decorative, so the
  // screen reader keeps using the cell's own label.
  if (items.length) {
    const dots = el('div.month-dots', { 'aria-hidden': 'true' });
    for (const item of items.slice(0, MAX_DOTS)) {
      dots.appendChild(el('span.chip-dot', {
        class: [
          `ev-${eventColorSlot(item.title) + 1}`,
          item.done ? 'is-done' : '',
        ].filter(Boolean).join(' '),
      }));
    }
    cell.appendChild(dots);
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

    // Everything above the chips claims its space first — the date, and on a
    // working day the shift block, which is the tallest thing in the cell.
    // Counting only the date left a shift day asking for 127px of content in a
    // 96px cell, so the chips ran out through the bottom and were clipped
    // mid-glyph. Measured rather than listed, so the next thing added here
    // cannot reintroduce this.
    const shiftEl = cell.querySelector('.month-shift');
    const base = cell.clientHeight - padY
      - (numEl ? numEl.offsetHeight + rowGap : 0)
      - (shiftEl ? shiftEl.offsetHeight + rowGap : 0);

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
  // The month grid and the day both mark these; the week was the gap between
  // them, and it is the view you actually plan a block in.
  const together = togetherDays(days);

  for (const dayKey of days) {
    const items = itemsOnDay(dayKey);
    const prog = progressFor(items);
    const d = fromKey(dayKey);

    /* The rota, on the column itself.
       The month grid has said which shift a day is since v7, and the week
       view never did -- so the one view that shows a whole block of four in
       detail was the one that could not tell you it was a block of four. The
       shift arrived as just another chip reading "Day Shift (D)", indistin-
       guishable from a task called the same thing.
       Derived from the items already fetched above rather than by calling
       shiftOnDay, which re-scans and re-sorts the entire list per call. */
    const shift = shiftFor(items);
    const crew = crewFrom(items);

    const col = el('div.week-col', {
      class: [
        isToday(dayKey) ? 'is-today' : '',
        isPast(dayKey) ? 'is-past' : '',
        shift ? `on-${shift}` : '',
      ].filter(Boolean).join(' '),
    });

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
        // Same language as the month grid: how many are still to do, not a
        // done/total fraction that has to be worked out.
        (() => {
          const open = items.filter((i) => !i.done).length;
          if (!items.length) return null;
          if (open === 0) return el('span.month-count.is-clear', icon('check', 'icon'));
          return el('span.month-count', {
            title: `${open} still to do of ${items.length}`,
          }, String(open));
        })(),
      ),
      // Said in words, not left to the tint alone -- the whole complaint was
      // that this view did not say whether he was on nights or days.
      shift ? el('div.week-col-shift',
        el('span.week-col-shift-label', SHIFT_BADGE[shift] || 'SHIFT'),
        crew.length ? el('span.week-col-crew', crew.join(', ')) : null,
      ) : null,
      hasJournal(dayKey)
        ? el('span.day-diary', { title: 'There is a diary entry for this day' },
            icon('book', 'icon'))
        : null,
      together?.has(dayKey)
        ? el('span.day-together', { title: 'You are both free at some point today' },
            icon('phone', 'icon'))
        : null,
    ));

    const body = el('div.week-col-body');
    makeDropTarget(body, dayKey, null);

    for (const item of items) {
      const weekItem = el('div.week-item', {
        class: [
          item.done ? 'is-done' : '',
          item.kind === 'event' ? 'is-event' : '',
          `ev-${eventColorSlot(item.title) + 1}`,
        ].filter(Boolean).join(' '),
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
/* ------------------------------------------------------------------ */
/* The day's vertical scale                                            */
/* ------------------------------------------------------------------ */

/** Above this many all-day items the strip collapses to a single line. */
const ALLDAY_MAX = 3;
const alldayOpen = new Map();
const alldayOpenFor = (dayKey) => alldayOpen.get(dayKey) === true;

/** A run this long or longer is worth collapsing. Two quiet hours read fine. */
const QUIET_RUN = 3;
/**
 * What a collapsed run costs, however many hours it swallows.
 *
 * 34 rather than the 30 it wants to be: this is a button you tap with a thumb
 * to open the afternoon, and 34px is the floor this app uses everywhere else
 * for touch.
 */
const QUIET_H = 34;

/**
 * Which gaps the user has opened, per day.
 *
 * Kept outside the view because dayView is rebuilt from scratch on every
 * render — a sync tick, a ticked checkbox — and a gap that closed itself every
 * few seconds would be unusable. Keyed by day so opening 10:00 on Monday does
 * not silently open it on Tuesday as well.
 */
const expandedGaps = new Map();
function expandedGapsFor(dayKey) {
  if (!expandedGaps.has(dayKey)) expandedGaps.set(dayKey, new Set());
  return expandedGaps.get(dayKey);
}

/**
 * Build the minute -> pixel mapping for one day.
 *
 * Hours with something in them keep their full height; runs of quiet hours
 * collapse to a single band. An hour counts as busy if any event OVERLAPS it,
 * not merely starts in it — otherwise a four-hour shift would have its middle
 * two hours collapsed out from under it and the block would be drawn across a
 * band claiming to be empty.
 *
 * The hour containing "now" never collapses. Hiding where you are in the day
 * is the one thing this whole grid exists to show.
 */
function buildDayScale({ first, last, laid, nowHour, expanded }) {
  const busy = new Set();
  for (const slot of laid) {
    const from = Math.floor(slot.start / 60);
    const to = Math.ceil(slot.end / 60) - 1;
    for (let h = from; h <= to; h++) busy.add(h);
  }

  const rows = [];
  let y = 0;
  let h = first;

  while (h <= last) {
    const quiet = !busy.has(h) && h !== nowHour;
    if (!quiet) {
      rows.push({ type: 'hour', hour: h, y, h: HOUR_H });
      y += HOUR_H;
      h += 1;
      continue;
    }

    let end = h;
    while (end <= last && !busy.has(end) && end !== nowHour) end += 1;
    const key = `h${h}`;

    if (end - h >= QUIET_RUN && !expanded.has(key)) {
      rows.push({
        type: 'gap', key, fromHour: h, toHour: end - 1, hours: end - h, y, h: QUIET_H,
      });
      y += QUIET_H;
    } else {
      for (let q = h; q < end; q += 1) {
        rows.push({ type: 'hour', hour: q, y, h: HOUR_H });
        y += HOUR_H;
      }
    }
    h = end;
  }

  const span = (row) => (row.type === 'hour'
    ? [row.hour * 60, (row.hour + 1) * 60]
    : [row.fromHour * 60, (row.toHour + 1) * 60]);

  /** Where a given minute sits, interpolating within whichever row holds it. */
  const yFor = (minute) => {
    if (!rows.length) return 0;
    for (const row of rows) {
      const [from, to] = span(row);
      if (minute < to) {
        const frac = Math.max(0, (minute - from) / (to - from));
        return row.y + frac * row.h;
      }
    }
    return y;
  };

  return { rows, total: y, yFor };
}

/**
 * A collapsed run of quiet hours.
 *
 * Still a drop target, landing on the first hour of the run — collapsing the
 * afternoon must not take away the ability to drag something into it. Click
 * opens the run if you want to be more precise than that.
 */
function quietBand(row, dayKey, cfg) {
  const label = `${row.hours} hours clear`;
  const band = el('button.quiet-band', {
    type: 'button',
    style: { top: `${row.y}px`, height: `${row.h}px` },
    title: `${formatHourLabel(row.fromHour, cfg.hour12)} – ${formatHourLabel(row.toHour + 1, cfg.hour12)} — click to open`,
    'aria-label': `${label}. Open these hours`,
    onclick: () => {
      expandedGapsFor(dayKey).add(row.key);
      // Re-render through the store's own channel so the whole view rebuilds
      // the same way it does for any other change.
      document.dispatchEvent(new CustomEvent('organizer:rerender'));
    },
  },
    el('span.quiet-band-line'),
    el('span.quiet-band-text', label),
    el('span.quiet-band-line'),
  );
  makeDropTarget(band, dayKey, `${String(row.fromHour).padStart(2, '0')}:00`);
  return band;
}

export function dayView(dayKey, { onOpenItem } = {}) {
  const cfg = settings();
  const timed = timedItemsOnDay(dayKey);
  const untimed = untimedItemsOnDay(dayKey);

  // Widen the visible window if something sits outside the usual day, so an
  // 05:30 run or a 23:00 deadline is never hidden.
  let first = cfg.dayStart;
  let last = cfg.dayEnd;
  for (const item of timed) {
    const startMin = timeToMinutes(item.time);
    first = Math.min(first, Math.floor(startMin / 60));
    // Widen for where it ENDS as well as where it starts. Widening only for
    // the start left a 20:00 meeting running to 23:00 drawn past the bottom of
    // a grid that stopped at 22:00.
    const endMin = startMin + (item.durationMin || cfg.defaultDurationMin);
    last = Math.max(last, Math.floor(startMin / 60), Math.ceil(endMin / 60) - 1);
  }
  first = Math.max(0, first);
  last = Math.min(23, Math.max(last, first + 1));

  const root = el('div.day.view-anim', { class: isMobile() ? 'is-single' : '' });
  const gridWrap = el('div.day-grid-wrap');

  /* All-day strip.
   *
   * Left expanded it was seven chips stacked three rows deep before you
   * reached a single hour — the top of the page taken up by the part of the
   * day that has no time attached to it. Past a few items it collapses to one
   * line you can open, so the grid starts where the eye lands. */
  const allDayOpen = alldayOpenFor(dayKey);
  const allDay = el('div.day-allday');
  if (untimed.length > ALLDAY_MAX && !allDayOpen) {
    allDay.appendChild(el('span.day-allday-label', 'All day'));
    allDay.appendChild(el('button.day-allday-more', {
      type: 'button',
      onclick: () => {
        alldayOpen.set(dayKey, true);
        document.dispatchEvent(new CustomEvent('organizer:rerender'));
      },
    },
      `${untimed.length} items`,
      icon('chevronRight', 'icon'),
    ));
  } else if (untimed.length) {
    allDay.appendChild(el('span.day-allday-label', 'All day'));
    if (untimed.length > ALLDAY_MAX) {
      allDay.appendChild(el('button.day-allday-more', {
        type: 'button',
        onclick: () => {
          alldayOpen.set(dayKey, false);
          document.dispatchEvent(new CustomEvent('organizer:rerender'));
        },
      }, 'Hide'));
    }
    for (const item of untimed) {
      const chip = el('div.day-event', {
        class: [
          item.done ? 'is-done' : '',
          item.kind === 'event' ? 'is-event' : '',
          `ev-${eventColorSlot(item.title) + 1}`,
        ].filter(Boolean).join(' '),
        draggable: 'true',
        onclick: () => (onOpenItem ? onOpenItem(item.id) : openItemEditor(item.id)),
        ondragstart: (e) => {
          e.dataTransfer.setData('text/plain', item.id);
          e.dataTransfer.effectAllowed = 'move';
        },
      }, el('span.day-event-title', item.title || 'Untitled'));
      // `draggable` is mouse-only — Android and a touchscreen laptop never
      // fire dragstart from a finger. Every other draggable thing in the app
      // pairs it with this; the all-day strip was the one that did not, which
      // meant the items MOST likely to need a time — the ones that have not
      // got one — were the only items that could not be dragged to one.
      makeTouchDraggable(chip, () => item.id);
      allDay.appendChild(chip);
    }
  }
  gridWrap.appendChild(allDay);

  /* A real time grid: events are positioned by their start minute and sized by
     their duration, the way a calendar is supposed to read. Previously
     everything sat inside its start hour at a uniform height, so three
     90-minute events crowded the 9pm band while 10pm looked free.

     The scale is no longer linear, though. On a normal day 14 of 16 hours are
     empty, and giving each of them a full hour of screen meant ~87% of the
     panel was blank while the three things actually happening were squeezed
     into 25px boxes. Long quiet runs now collapse to a single band, and the
     space that frees goes back to the hours that have something in them. */
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const nowHour = isToday(dayKey) ? Math.floor(nowMinutes / 60) : -1;
  const gridStart = first * 60;
  const gridMinutes = (last - first + 1) * 60;
  const gridEnd = gridStart + gridMinutes;

  const laid = layoutDayEvents(timed, cfg.defaultDurationMin);
  const scale = buildDayScale({
    first, last, laid, nowHour,
    expanded: expandedGapsFor(dayKey),
  });

  const grid = el('div.day-grid', { style: { height: `${scale.total}px` } });

  // Hour lines and per-hour drop targets, behind the events.
  for (const row of scale.rows) {
    if (row.type === 'gap') {
      grid.appendChild(quietBand(row, dayKey, cfg));
      continue;
    }
    const h = row.hour;
    const time = `${String(h).padStart(2, '0')}:00`;
    const line = el('div.hour-line', {
      // On TODAY only the hours behind the clock are past. On a day that has
      // already gone, all of them are — which this used to miss entirely, so
      // yesterday's grid looked identical to tomorrow's and every hour on it
      // offered a cheerful + to add something already overdue.
      class: (isPast(dayKey) || (isToday(dayKey) && h * 60 + 59 < nowMinutes)) ? 'is-past' : '',
      style: { top: `${row.y}px`, height: `${row.h}px` },
    },
      el('span.hour-label', formatHourLabel(h, cfg.hour12)),
      el('button.hour-add', {
        'aria-label': `Add something at ${formatHourLabel(h, cfg.hour12)}`,
        onclick: () => openItemEditor(null, { date: dayKey, time }),
      }, '+'),
    );
    makeDropTarget(line, dayKey, time);
    grid.appendChild(line);
  }

  // Events, laid out in lanes so overlaps sit side by side rather than on top
  // of one another.
  //
  // They go in their own box, inset past the hour gutter. Positioned straight
  // onto the grid, a lane's `left: 0%` is the grid's left edge, so every block
  // ran back underneath the hour labels — and an event's fill is translucent,
  // so "7am" showed through the middle of the shift sitting on top of it.
  const lanes = el('div.day-lanes');
  for (const slot of laid) {
    const node = dayEventNode(slot.item, onOpenItem);
    const width = 100 / slot.lanes;
    node.classList.add('day-block');

    // Stop the block at midnight even when the shift does not. A 16:00 start
    // running eight hours ends at 00:00 the next day, nine hours below a grid
    // that stops at 22:00 — and nothing clipped it, so it was drawn straight
    // over the panel beneath, which is what "This day" landing on top of
    // "4pm · 8h" actually was. Squared off at the cut, like the month bars, so
    // it reads as continuing rather than as ending there.
    const drawnEnd = Math.min(slot.end, gridEnd);
    if (slot.end > gridEnd) node.classList.add('is-cont-after');

    const top = scale.yFor(slot.start);
    Object.assign(node.style, {
      top: `${top}px`,
      height: `${Math.max(scale.yFor(drawnEnd) - top - 2, 20)}px`,
      left: `calc(${slot.lane * width}% + 2px)`,
      width: `calc(${width}% - 4px)`,
    });
    // Very short blocks cannot fit two lines of text.
    if ((slot.end - slot.start) < 45) node.classList.add('is-compact');
    lanes.appendChild(node);
  }
  if (laid.length) grid.appendChild(lanes);

  if (isToday(dayKey) && nowMinutes >= gridStart && nowMinutes <= gridStart + gridMinutes) {
    const nowLabel = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
    grid.appendChild(el('div.now-line', {
      style: { top: `${scale.yFor(nowMinutes)}px` },
      'aria-hidden': 'true',
    },
      // Always 24-hour, even when the rest of the grid is on 12-hour labels:
      // this sits in a 46px gutter and "3:04 pm" does not fit where "15:04"
      // does. It is a position marker, not a reading of the clock.
      el('span.now-time', nowLabel),
    ));
  }

  gridWrap.appendChild(grid);

  root.appendChild(gridWrap);

  // Side panel: the day's tasks and its completion ring.
  const items = itemsOnDay(dayKey);
  const dayShift = shiftOnDay(dayKey);
  const dayCrew = crewOnDay(dayKey);
  const together = togetherPanel(dayKey);

  const side = el('div.day-side',
    /* Said outright, above everything.
       Ben opened a day, went to put a task on it, and only just caught that
       the day had already gone. Nothing on the screen had told him: the grid
       looked the same as any other, the hours all offered a +, and the date
       in the header reads as a date rather than as a warning. A tinted grid
       is the ambient version of this; this is the sentence. */
    isPast(dayKey) ? el('div.day-gone',
      el('span.day-gone-label', 'This day has gone'),
      el('span.day-gone-note',
        `${daysAgoLabel(dayKey)} — anything put here is overdue the moment you add it.`),
    ) : null,
    // What this day IS, before what is on it. On a run of nights that is the
    // single most useful line on the screen, and on a phone the month cell's
    // fine print is too small to carry the names.
    dayShift ? el('div.shift-card', { class: `on-${dayShift}` },
      el('span.shift-card-kind',
        `On ${SHIFT_LABEL[dayShift]}`,
        // The hours, here as on the home banner. This card is the answer to
        // "what is this day" and it knew 0630-1830 without saying it, so the
        // one place that spelled the hours out was the brief, on another page.
        SHIFT_HOURS[dayShift] ? el('span.shift-card-hours', SHIFT_HOURS[dayShift]) : null,
      ),
      dayCrew.length
        ? el('span.shift-card-crew', `With ${dayCrew.join(', ')}`)
        : el('span.shift-card-crew.is-empty', 'No crew recorded'),
    ) : null,
    // Under the shift, because it is a consequence of it.
    together,
    /* What is next, and how far through you are — in one strip rather than a
       116px ring. The ring was the largest and most saturated thing on the
       page and, first thing in the morning, it always read 0%. A bar says the
       same in a tenth of the space and gives the rest to the question you
       actually opened the day to answer. */
    (() => {
      const prog = progressFor(items);
      const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
      const next = isToday(dayKey)
        ? timed.find((i) => !i.done && timeToMinutes(i.time) > nowMinutes)
        : timed.find((i) => !i.done);
      return el('div.day-status',
        el('div.day-status-head',
          el('span.day-status-label', isToday(dayKey) ? 'Up next' : 'First up'),
          el('span.day-status-count', `${prog.done}/${prog.total}`),
        ),
        el('div.day-status-next', next
          ? `${formatTime(next.time, cfg.hour12)} · ${next.title || 'Untitled'}`
          : 'Nothing else with a time on it'),
        el('div.day-status-bar', el('span', { style: { width: `${pct}%` } })),
      );
    })(),
    (() => {
      // Only what has NO time. Anything with a clock time is already drawn on
      // the grid a few inches to the left, and listing it twice made the grid
      // look like a decorative copy of the list rather than the point of the
      // page.
      const tasks = items.filter((i) => i.kind === 'task' && !i.time);
      const eventCount = items.length - items.filter((i) => i.kind === 'task').length;
      return el('div',
        el('div.task-group-label', 'No time set'),
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

    // The backlog sits here now, under the day's own tasks, so the two lists
    // you move things BETWEEN are in the same column. The day's notes moved
    // across to the rail, where a write-up gets a column to itself instead of
    // being the last thing at the bottom of a long panel.
    (() => {
      const waiting = unscheduledTasks().filter((i) => !i.done);
      if (!waiting.length) return null;
      return el('div.day-backlog',
        el('div.task-group-label', 'Unscheduled'),
        taskList(waiting, {
          showDate: false,
          groupDone: false,
          emptyMessage: 'Nothing waiting',
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
    class: [
      item.done ? 'is-done' : '',
      item.kind === 'event' ? 'is-event' : '',
      `ev-${eventColorSlot(item.title) + 1}`,
    ].filter(Boolean).join(' '),
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
export function dayStrip({ days = 14, onSelectDay = null, onOpenUnscheduled = null } = {}) {
  const start = todayKey();
  const strip = el('div.day-strip', {
    role: 'group',
    'aria-label': 'Drag a task onto a day to schedule it',
  });

  strip.appendChild(el('div.day-strip-hint', 'Drag onto a day →'));

  const rail = el('div.day-strip-rail');

  // Unscheduled sits at the head of the rail, before Today. Dragging a task
  // FORWARD to a day and dragging it OFF the calendar are the same gesture
  // with the same targets, so parking something is no harder than booking it.
  // Labelled "No date", not "Off": "Off" reads as a rest day next to a row of
  // dates, which is exactly the wrong idea on a rota where OFF means something.
  const inbox = el('button.day-strip-day.is-inbox', {
    title: 'Drop a task here to take it off the calendar — it moves to Unscheduled',
    onclick: () => onOpenUnscheduled?.(),
  },
    el('span.day-strip-dow', 'No date'),
    el('span.day-strip-num', icon('inbox', 'icon')),
    el('span.day-strip-count.is-empty', '·'),
  );
  makeUnscheduleTarget(inbox);
  rail.appendChild(inbox);
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
/**
 * Send a task back to Unscheduled: strip the date, and the rollover history
 * with it.
 *
 * Clearing `rollCount` matters. An overdue task has usually been carried
 * forward twice already, and rollover moves anything at two straight back out
 * of the calendar — so without this, a task you deliberately parked would
 * behave as though it had rotted there, and the next thing you scheduled it
 * for would be undone overnight. Unscheduling by hand is a decision, not a
 * failure, so it starts the count again.
 */
export function applyUnschedule({ itemId }) {
  if (!itemId) return;
  const item = getItem(itemId);
  if (!item) return;
  if (!item.date && !item.done) return;      // already there

  // A finished thing dragged off the calendar means "that is not settled after
  // all" — so it reopens as well as unschedules. Dropping it on a DAY already
  // reopens it (see reopenOnDay); this is the same decision without a date.
  updateItem(itemId, {
    date: null, time: null, endDate: null, durationMin: null,
    rollCount: 0, rolledFrom: null,
    ...(item.done ? { done: false, doneAt: null } : {}),
  });
  toast(
    item.done
      ? `“${item.title || 'Untitled'}” reopened into Unscheduled`
      : `“${item.title || 'Untitled'}” moved to Unscheduled`,
    { action: 'Undo', onAction: () => store.undo() },
  );
}

function makeUnscheduleTarget(node) {
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
    if (id) applyUnschedule({ itemId: id });
  });
  // Same node, touch path.
  registerDropZone(node, {}, applyUnschedule);
}

/** 'Yesterday' / '3 days ago' / '2 weeks ago' — how far behind a day is. */
function daysAgoLabel(dayKey) {
  const days = diffDays(dayKey, todayKey());
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? 'A week ago' : `${weeks} weeks ago`;
}

export function applyDropOnDay({ itemId, dateKey, time }) {
  if (!itemId) return;

  /*
   * Say it out loud when something lands on a day that has gone.
   *
   * The tinted cells and the banner on the day view are the ambient half of
   * this; they only work if you look. A drop is the moment the mistake is
   * actually made, and it can happen with a thumb on a phone where the cell
   * under your finger is the one you cannot see. So this states what just
   * happened, and offers the way out — rather than blocking it, because
   * backdating something you genuinely did on Tuesday is a real thing to want.
   */
  const landsInThePast = isPast(dateKey);
  usage.record('DRAG_SCHEDULE');

  /*
   * A step from a plan, dragged onto a day before it is anything.
   *
   * Threading it through the SAME drop path as a real task is deliberate: the
   * day strip, the month cells, the mini-calendar and the hour lines are all
   * already drop targets, on both the mouse and the touch path, and every one
   * of them works for a plan step for free. Creating the task up front instead
   * would have meant fourteen tasks appearing the moment a plan was generated,
   * whether or not any of it was accepted.
   */
  if (String(itemId).startsWith(PLAN_PREFIX)) {
    const step = takePlanStep(String(itemId).slice(PLAN_PREFIX.length));
    if (!step) return;
    usage.record('PLAN_STEP_TAKE');
    addItem({
      kind: 'task',
      title: step.title,
      date: dateKey,
      time: time || null,
      durationMin: time ? settings().defaultDurationMin : null,
      notes: step.why ? `From a plan: ${step.why}` : '',
    });
    document.dispatchEvent(new CustomEvent('organizer:rerender'));
    if (landsInThePast) warnPastDrop(dateKey);
    return;
  }
  // A completed item dragged onto a day means "do this again": reopen it and
  // reschedule, rather than silently moving a ticked-off task.
  if (reopenOnDay(itemId, dateKey, time)) {
    if (landsInThePast) warnPastDrop(dateKey);
    return;
  }
  const patch = { date: dateKey, time: time || null };
  // Dropping onto an hour gives an untimed task a sensible block length.
  if (time) patch.durationMin = getItem(itemId)?.durationMin || settings().defaultDurationMin;
  updateItem(itemId, patch);
  if (landsInThePast) warnPastDrop(dateKey);
}

/** Undo is the point: the message without it is just bad news. */
function warnPastDrop(dateKey) {
  toast(`${daysAgoLabel(dateKey)} — that day has gone, so this is overdue.`, {
    error: true,
    action: 'Undo',
    onAction: () => store.undo(),
  });
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

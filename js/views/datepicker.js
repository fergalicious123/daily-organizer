/* Picking a date, with the rota on it.
 *
 * The browser's own date picker is a fine picker of dates and knows nothing
 * about Ben's life. Choosing "the 14th" from a bare grid of numbers is a
 * decision made blind: the 14th might be the second of four nights, or the
 * day the English course starts, or already have four things on it. All of
 * that is drawn on the month view two clicks away, and none of it was here —
 * at the one moment the information decides the answer.
 *
 * So this is the month view's cell, shrunk: the same rota tint, the same
 * banding for a day that has gone, and a count of what is already there.
 * The same colours on purpose. A picker with a palette of its own would be a
 * second thing to learn rather than the thing he already reads.
 *
 * It replaces the native input rather than sitting beside it. Two date
 * controls in one form is a question about which one is real.
 */

import { el, icon } from '../ui.js';
import { itemsOnDay, shiftFor, crewFrom, SHIFT } from '../state.js';
import {
  todayKey, fromKey, addMonths, monthGrid, formatMonthLong, formatDayHeader,
  formatDayShort, isToday, isPast, sameMonth, DAY_ABBR,
} from '../dates.js';

/* One or two letters, because a cell here is about 34px wide. The word is in
   the tooltip and the aria-label, so the letter never carries it alone. */
const SHIFT_SHORT = {
  [SHIFT.NIGHT]: 'N',
  [SHIFT.DAY]: 'D',
  [SHIFT.ONCALL]: 'OC',
  [SHIFT.TRAINING]: 'T',
  [SHIFT.OFF]: '',
  [SHIFT.OTHER]: 'S',
};

const SHIFT_WORD = {
  [SHIFT.NIGHT]: 'nights',
  [SHIFT.DAY]: 'days',
  [SHIFT.ONCALL]: 'on call',
  [SHIFT.TRAINING]: 'a training day',
  [SHIFT.OFF]: 'off',
  [SHIFT.OTHER]: 'shift',
};

/**
 * A date field: a button showing the choice, and a month grid behind it.
 *
 * Returns { node, get, set, close } so the caller can drive it — the quick-date
 * pills in the item editor set the date from outside, and the field has to
 * follow rather than sit there showing the old one.
 *
 * @param {object} opts
 * @param {string|null} opts.value       starting date as YYYY-MM-DD, or null
 * @param {number} opts.weekStart        0 Sunday, 1 Monday
 * @param {(key: string|null) => void} opts.onPick
 * @param {string} opts.label            for screen readers
 */
export function dateField({
  value = null, weekStart = 1, onPick = () => {}, label = 'Date',
} = {}) {
  let selected = value || null;
  let month = selected || todayKey();
  let open = false;

  const summary = el('span.dp-value');
  const shiftChip = el('span.dp-trigger-shift');

  const trigger = el('button.dp-trigger', {
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    'aria-label': label,
    onclick: (e) => { e.preventDefault(); toggle(); },
  }, summary, shiftChip, icon('calendar', 'icon'));

  const pop = el('div.dp-pop', {
    role: 'dialog', 'aria-label': 'Choose a date', hidden: true,
  });
  const node = el('div.dp', trigger, pop);

  /* What the closed field says. The shift is on the trigger too, so the answer
     is visible without reopening the grid to check it. */
  function describeTrigger() {
    // Short form. The trigger shares its width with the shift chip, and in the
    // item editor the whole field is half a row — "Wednesday 12 August" was
    // being clipped to "Wednesday 12..." next to a chip reading NIGHTS · GONE,
    // which is the wrong half to lose. The full date is in the grid and in the
    // heading; this only has to identify the day.
    summary.textContent = selected ? formatDayShort(selected) : 'No date';
    summary.classList.toggle('is-empty', !selected);
    shiftChip.textContent = '';
    shiftChip.className = 'dp-trigger-shift';
    if (!selected) return;
    const shift = shiftFor(itemsOnDay(selected));
    const bits = [];
    if (shift && shift !== SHIFT.OFF) {
      bits.push(SHIFT_WORD[shift] || 'shift');
      shiftChip.classList.add(`on-${shift}`);
    }
    if (isPast(selected)) {
      bits.push('gone');
      shiftChip.classList.add('is-past');
    }
    shiftChip.textContent = bits.join(' · ');
  }

  function choose(key) {
    selected = key;
    month = key || todayKey();
    describeTrigger();
    onPick(key);
    close();
    trigger.focus();
  }

  function drawGrid() {
    pop.replaceChildren();

    pop.appendChild(el('div.dp-head',
      el('button.dp-step', {
        type: 'button',
        'aria-label': 'Previous month',
        onclick: () => { month = addMonths(month, -1); drawGrid(); },
      }, icon('chevronLeft', 'icon')),
      el('span.dp-month', formatMonthLong(month)),
      el('button.dp-step', {
        type: 'button',
        'aria-label': 'Next month',
        onclick: () => { month = addMonths(month, 1); drawGrid(); },
      }, icon('chevronRight', 'icon')),
    ));

    const dow = el('div.dp-dow');
    for (let i = 0; i < 7; i++) dow.appendChild(el('span', DAY_ABBR[(weekStart + i) % 7]));
    pop.appendChild(dow);

    const grid = el('div.dp-grid');
    for (const week of monthGrid(month, weekStart)) {
      for (const key of week) {
        /* One pass over the day's items, then everything derived from it.
           shiftOnDay() re-scans and re-sorts the entire item list on every
           call, and this grid has forty-two cells. The month view learned
           that the expensive way. */
        const items = itemsOnDay(key);
        const shift = shiftFor(items);
        const crew = crewFrom(items);
        const openCount = items.filter((i) => !i.done).length;
        const gone = isPast(key);

        const described = [
          formatDayHeader(key),
          shift ? `on ${SHIFT_WORD[shift]}` : null,
          crew.length ? `with ${crew.join(', ')}` : null,
          openCount ? `${openCount} to do` : null,
          gone ? 'this day has gone' : null,
        ].filter(Boolean);

        grid.appendChild(el('button.dp-day', {
          type: 'button',
          class: [
            !sameMonth(key, month) ? 'is-outside' : '',
            isToday(key) ? 'is-today' : '',
            gone ? 'is-past' : '',
            key === selected ? 'is-selected' : '',
            shift ? `on-${shift}` : '',
          ].filter(Boolean).join(' '),
          // The colour is never the only thing saying it: the letter is in the
          // cell, and the words are here for a tooltip and a screen reader.
          title: described.join(' — '),
          'aria-label': described.join(', '),
          'aria-pressed': key === selected ? 'true' : 'false',
          onclick: (e) => { e.preventDefault(); choose(key); },
        },
          el('span.dp-num', String(fromKey(key).getDate())),
          shift && SHIFT_SHORT[shift] ? el('span.dp-shift', SHIFT_SHORT[shift]) : null,
          openCount ? el('span.dp-count', String(openCount)) : null,
        ));
      }
    }
    pop.appendChild(grid);

    pop.appendChild(el('div.dp-foot',
      el('button.btn.btn-quiet', { type: 'button', onclick: () => choose(todayKey()) }, 'Today'),
      el('div', { style: { flex: '1' } }),
      el('button.btn.btn-quiet', { type: 'button', onclick: () => choose(null) }, 'No date'),
    ));
  }

  function onOutside(e) { if (!node.contains(e.target)) close(); }

  function onKey(e) {
    if (e.key !== 'Escape' || !open) return;
    /* Stopped here, or Escape reaches the modal underneath and closing the
       date picker would throw away everything typed into the form. */
    e.stopPropagation();
    close();
    trigger.focus();
  }

  function openPop() {
    open = true;
    drawGrid();
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  function close() {
    if (!open) return;
    open = false;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function toggle() { if (open) close(); else openPop(); }

  describeTrigger();

  return {
    node,
    get: () => selected,
    set: (key) => {
      selected = key || null;
      month = selected || todayKey();
      describeTrigger();
    },
    close,
  };
}

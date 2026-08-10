/* Task rows, task lists, and the item editor.
 * Shared by the right rail, the day view's side panel, and the list views.
 */

import { el, icon, toast, openModal, confirmDialog, haptic } from '../ui.js';
import { makeTouchDraggable } from '../dragdrop.js';
import {
  store, PRIORITY, getList, getItem, addItem, updateItem, removeItem,
  toggleDone, toggleSubtask, addSubtask, removeSubtask, settings, liveItems,
  byUrgency, eventColorSlot,
} from '../state.js';
import {
  todayKey, formatRelativeDay, formatTime, addDays, DAY_ABBR,
} from '../dates.js';


/* ------------------------------------------------------------------ */
/* Checkbox                                                            */
/* ------------------------------------------------------------------ */

function checkbox(checked, priority, onToggle, small = false) {
  const box = el('button.checkbox', {
    class: [checked ? 'is-checked' : '', priority ? `p-${priority}` : ''].filter(Boolean).join(' '),
    role: 'checkbox',
    'aria-checked': String(checked),
    'aria-label': checked ? 'Mark as not done' : 'Mark as done',
    onclick: (e) => { e.stopPropagation(); onToggle(); },
  }, icon('check'));
  if (small) box.classList.add('is-small');
  return box;
}

/* ------------------------------------------------------------------ */
/* Meta chips                                                          */
/* ------------------------------------------------------------------ */

function metaChips(item, { showDate = true, showList = true } = {}) {
  const chips = [];
  const today = todayKey();

  if (showDate && item.date) {
    const overdue = !item.done && item.date < today;
    const isToday = item.date === today;
    chips.push(el('span.chip', {
      class: overdue ? 'is-overdue' : (isToday ? 'is-today' : ''),
    },
      item.time ? formatTime(item.time, settings().hour12) : formatRelativeDay(item.date),
      item.time && item.date !== today ? ` · ${formatRelativeDay(item.date)}` : '',
    ));
  }

  // Say why something moved. A task that silently relocates itself overnight
  // is indistinguishable from a bug.
  if (item.rollCount >= 2) {
    chips.push(el('span.chip.is-rolled', { title: 'Carried over twice, so it left the calendar' },
      icon('undo', 'icon'), 'unactioned'));
  } else if (item.rollCount === 1 && item.rolledFrom) {
    chips.push(el('span.chip.is-rolled', { title: `Moved from ${formatRelativeDay(item.rolledFrom)}` },
      icon('undo', 'icon'), 'carried over'));
  }

  if (item.recur) {
    chips.push(el('span.chip.is-recur', icon('repeat', 'icon'), recurLabel(item.recur)));
  }
  if (item.remindMin != null) {
    chips.push(el('span.chip.is-remind', icon('bell', 'icon'), `${item.remindMin}m`));
  }
  if (item.subtasks?.length) {
    const done = item.subtasks.filter((s) => s.done).length;
    chips.push(el('span.chip', `${done}/${item.subtasks.length}`));
  }
  if (showList && item.kind === 'task') {
    const list = getList(item.listId);
    if (list) {
      chips.push(el('span.chip.is-list',
        el('span.list-dot', { style: { background: list.color, color: list.color } }),
        list.name,
      ));
    }
  }
  if (item.gcalId) {
    chips.push(el('span.chip', { title: 'Synced to Google Calendar' }, icon('cloud', 'icon')));
  }
  return chips;
}

function recurLabel(recur) {
  if (!recur) return '';
  const { freq, interval = 1, byDay } = recur;
  if (freq === 'weekly' && byDay?.length) {
    if (byDay.length === 5 && [1, 2, 3, 4, 5].every((d) => byDay.includes(d))) return 'weekdays';
    return byDay.map((d) => DAY_ABBR[d]).join(', ');
  }
  const unit = { daily: 'day', weekly: 'week', monthly: 'month' }[freq] || freq;
  return interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
}

/* ------------------------------------------------------------------ */
/* Task row                                                            */
/* ------------------------------------------------------------------ */

/**
 * One task/event row.
 * `onChange` is called after any mutation so the caller can re-render.
 */
export function taskRow(item, {
  showDate = true, showList = true, draggable = true, urgency = 0,
} = {}) {
  const row = el('div.task', {
    // Two colour channels, deliberately kept on different parts of the row.
    //
    // `u-N` drives the left edge stripe: an ordinal ramp, darkest/brightest at
    // rank 1. Only unfinished tasks carry it — a finished row wants no shout.
    //
    // `ev-N` is the kind colour, the same slot the calendar uses, so a row and
    // its chip on the month grid are recognisably the same thing. It sits on
    // the row so both the dot and the background wash read from one `--ev`.
    class: [
      item.done ? 'is-done' : '',
      (!item.done && item.kind === 'task' && urgency) ? `u-${Math.min(urgency, 5)}` : '',
      `ev-${eventColorSlot(item.title) + 1}`,
    ].filter(Boolean).join(' '),
    dataset: { id: item.id },
    draggable: draggable ? 'true' : null,
    onclick: (e) => {
      if (e.target.closest('button')) return;
      openItemEditor(item.id);
    },
  });

  if (draggable) {
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    // Touch cannot fire dragstart, so it needs its own path.
    makeTouchDraggable(row, () => item.id);
  }

  row.append(
    checkbox(item.done, item.priority, () => {
      toggleDone(item.id);
      if (!item.done) haptic();
    }),
    el('div.task-main',
      el('div.task-title',
        // Every row carries the dot, task or event. Gating it on `kind` looked
        // principled and was wrong in practice: imported shifts arrive as
        // tasks, so the one thing that most needed a shared colour was the one
        // thing that never got one.
        el('span.chip-dot.row-dot'),
        item.title || 'Untitled'),
      (() => {
        const chips = metaChips(item, { showDate, showList });
        return chips.length ? el('div.task-meta', chips) : null;
      })(),
      item.subtasks?.length ? el('div.subtasks', item.subtasks.map((sub) =>
        el('div.subtask', { class: sub.done ? 'is-done' : '' },
          checkbox(sub.done, 0, () => toggleSubtask(item.id, sub.id), true),
          el('span', sub.title),
        ),
      )) : null,
    ),
    el('div.task-actions',
      el('button', {
        'aria-label': 'Edit',
        title: 'Edit',
        onclick: (e) => { e.stopPropagation(); openItemEditor(item.id); },
      }, icon('edit')),
      el('button.is-danger', {
        'aria-label': 'Delete',
        title: 'Delete',
        onclick: (e) => { e.stopPropagation(); deleteWithUndo(item.id); },
      }, icon('trash')),
    ),
  );

  return row;
}

function deleteWithUndo(id) {
  const item = getItem(id);
  if (!item) return;
  removeItem(id);
  toast(`Deleted “${item.title || 'Untitled'}”`, {
    action: 'Undo',
    onAction: () => store.undo(),
  });
}

/* ------------------------------------------------------------------ */
/* Grouped task list                                                   */
/* ------------------------------------------------------------------ */

/**
 * Render a set of items, optionally grouped. Completed items sink to the
 * bottom under their own heading so finishing something feels like progress
 * rather than making the row vanish.
 */
export function taskList(items, {
  emptyMessage = 'Nothing here yet', emptyHint = '', groupDone = true,
  // Order the open items most-urgent first. Off where the list has its own
  // meaningful order — the day view is chronological, and shuffling a
  // timetable by urgency would make it unreadable.
  urgencyOrder = true,
  // 'none' | 'list' | 'priority' | 'due'
  groupBy = 'none',
  ...rowOpts
} = {}) {
  const frag = document.createDocumentFragment();

  if (!items.length) {
    frag.appendChild(el('div.empty-state',
      el('div.empty-icon', '·'),
      el('p', emptyMessage),
      emptyHint ? el('p.empty-hint', emptyHint) : null,
    ));
    return frag;
  }

  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const today = todayKey();
  const overdue = open.filter((i) => i.date && i.date < today);
  const rest = open.filter((i) => !overdue.includes(i));

  // Rank ALWAYS comes from urgency, never from position — otherwise a list
  // shown in clock order (the day view) would shade by where a row happens to
  // sit, which is worse than no shading at all. Ranking spans every open item
  // rather than each group, so the scale reads as one gradient down the page
  // instead of restarting under each heading.
  const ranked = new Map();
  byUrgency(open, today).forEach((item, i) => ranked.set(item.id, i + 1));
  const withRank = (item) => ({ ...rowOpts, urgency: ranked.get(item.id) || 0 });

  // Grouping replaces the default overdue/rest split — under "group by due"
  // an Overdue heading would appear twice, and under the others the split
  // fights the grouping the user actually asked for.
  if (groupBy && groupBy !== 'none') {
    const groups = groupItems(urgencyOrder ? byUrgency(open, today) : open, groupBy, today);
    for (const [label, members] of groups) {
      if (!members.length) continue;
      frag.appendChild(el('div.task-group-label',
        { class: label === 'Overdue' ? 'is-overdue' : '' },
        label === 'Overdue' ? icon('warning', 'icon') : null,
        `${label} · ${members.length}`));
      for (const item of members) frag.appendChild(taskRow(item, withRank(item)));
    }
    if (groupDone && done.length) {
      frag.appendChild(el('div.task-group-label', `Completed · ${done.length}`));
      for (const item of done) frag.appendChild(taskRow(item, rowOpts));
    }
    return frag;
  }

  const orderedOverdue = urgencyOrder ? byUrgency(overdue, today) : overdue;
  const orderedRest = urgencyOrder ? byUrgency(rest, today) : rest;

  if (orderedOverdue.length) {
    frag.appendChild(el('div.task-group-label.is-overdue',
      icon('warning', 'icon'), `Overdue · ${orderedOverdue.length}`));
    for (const item of orderedOverdue) frag.appendChild(taskRow(item, withRank(item)));
  }

  for (const item of orderedRest) frag.appendChild(taskRow(item, withRank(item)));

  if (groupDone && done.length) {
    frag.appendChild(el('div.task-group-label', `Completed · ${done.length}`));
    for (const item of done) frag.appendChild(taskRow(item, rowOpts));
  }

  return frag;
}

/**
 * Bucket items under headings.
 *
 * Returns an array of [label, items] rather than an object, because the order
 * of the headings is itself meaningful — Overdue before Today before Later,
 * High before Low — and object key order would not survive numeric-looking
 * labels.
 */
function groupItems(items, groupBy, today) {
  const buckets = new Map();
  const put = (label, item) => {
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(item);
  };

  if (groupBy === 'list') {
    // Follow the sidebar's order so the two readings of "my lists" agree.
    for (const list of store.state.lists) buckets.set(list.name, []);
    for (const item of items) put(getList(item.listId)?.name || 'No list', item);
    return [...buckets.entries()];
  }

  if (groupBy === 'priority') {
    const order = ['High', 'Medium', 'Low', 'No priority'];
    for (const label of order) buckets.set(label, []);
    for (const item of items) {
      put(['No priority', 'Low', 'Medium', 'High'][item.priority || 0], item);
    }
    return order.map((label) => [label, buckets.get(label) || []]);
  }

  // groupBy === 'due'
  const order = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'No date'];
  for (const label of order) buckets.set(label, []);
  const tomorrow = addDays(today, 1);
  const weekOut = addDays(today, 7);
  for (const item of items) {
    if (!item.date) put('No date', item);
    else if (item.date < today) put('Overdue', item);
    else if (item.date === today) put('Today', item);
    else if (item.date === tomorrow) put('Tomorrow', item);
    else if (item.date <= weekOut) put('This week', item);
    else put('Later', item);
  }
  return order.map((label) => [label, buckets.get(label) || []]);
}

/* ------------------------------------------------------------------ */
/* Quick add                                                           */
/* ------------------------------------------------------------------ */

/**
 * The single-line add box. Runs the same natural-language parser the voice
 * capture uses, so typing "gym tomorrow 7am" behaves identically to saying it.
 */
export function quickAdd({
  defaults = {}, parser = null, onAdd = null,
  placeholder = 'Add a task…',
  // Stable identity so focus and caret survive a re-render. Boxes in
  // different places need different ids, or focus would jump between them.
  focusId = 'quick-add',
} = {}) {
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;

    let fields = { ...defaults, title: text };
    if (parser) {
      const parsed = parser(text);
      fields = { ...defaults, ...parsed, title: parsed.title || text };
      // A default date means "the day you're looking at". It should only be
      // overridden when the text actually named a date, not when the parser
      // merely fell back to today.
      if (defaults.date && !parsed.dateExplicit) fields.date = defaults.date;
      delete fields.dateExplicit;
    }

    const item = addItem(fields);
    input.value = '';
    onAdd?.(item);
  };

  const input = el('input', {
    type: 'text',
    placeholder,
    'aria-label': placeholder,
    autocomplete: 'off',
    dataset: { focusId },
    onkeydown: (e) => {
      // Stop single-letter keys reaching the global shortcut handler even if
      // focus bookkeeping ever fails again.
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') input.blur();
    },
  });

  return el('div.quick-add',
    icon('plus', 'icon'),
    input,
    el('button.btn.btn-ghost.btn-icon', { 'aria-label': 'Add', onclick: submit }, icon('check')),
  );
}

/* ------------------------------------------------------------------ */
/* Item editor                                                         */
/* ------------------------------------------------------------------ */

const PRIORITY_LABELS = [
  { value: PRIORITY.NONE, label: 'None' },
  { value: PRIORITY.LOW, label: 'Low' },
  { value: PRIORITY.MEDIUM, label: 'Medium' },
  { value: PRIORITY.HIGH, label: 'High' },
];

const REMINDER_OPTIONS = [
  { value: null, label: 'None' },
  { value: 0, label: 'At time' },
  { value: 10, label: '10 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 1440, label: '1 day' },
];

/** Open the full editor for an existing item, or a new one when id is null. */
export function openItemEditor(id, presets = {}) {
  const existing = id ? getItem(id) : null;
  // Whether a type change should propagate to every item sharing this title.
  let applyToSeries = false;
  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
      kind: 'task', title: '', notes: '', listId: store.state.inboxListId,
      date: null, time: null, durationMin: null, priority: 0,
      subtasks: [], recur: null, remindMin: null, ...presets,
    };

  openModal({
    title: existing ? 'Edit' : 'New item',
    render: (close) => {
      const fields = [];

      // Title
      const titleInput = el('input', {
        type: 'text', value: draft.title, placeholder: 'What needs doing?',
        oninput: (e) => { draft.title = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(close); } },
      });
      fields.push(el('div.field', el('label', 'Title'), titleInput));

      // Kind — a task can be ticked off; an event just occupies time.
      // A recurring calendar entry arrives as dozens of separate items, so
      // changing the type one instance at a time is not realistic. If other
      // items share this title, offer to convert the whole series at once.
      const siblings = existing
        ? liveItems().filter((i) => i.id !== existing.id
            && i.title.trim().toLowerCase() === draft.title.trim().toLowerCase())
        : [];

      const typeField = el('div.field',
        el('label', 'Type'),
        el('div.pill-row',
          ...['task', 'event'].map((k) => el('button.pill', {
            class: draft.kind === k ? 'is-active' : '',
            onclick: (e) => {
              draft.kind = k;
              e.target.parentElement.querySelectorAll('.pill').forEach((p) => p.classList.remove('is-active'));
              e.target.classList.add('is-active');
            },
          }, k === 'task' ? 'Task' : 'Event')),
        ),
      );

      if (siblings.length) {
        const seriesToggle = el('button.pill', {
          class: applyToSeries ? 'is-active' : '',
          onclick: (e) => {
            applyToSeries = !applyToSeries;
            e.target.classList.toggle('is-active', applyToSeries);
          },
        }, `Apply type to all ${siblings.length + 1}`);
        typeField.append(
          seriesToggle,
          el('p.field-hint',
            `${siblings.length} other item${siblings.length === 1 ? '' : 's'} share this title — `,
            'likely the same repeating entry from your calendar.'),
        );
      }

      fields.push(typeField);

      // Date + time
      const dateInput = el('input', {
        type: 'date', value: draft.date || '',
        oninput: (e) => { draft.date = e.target.value || null; },
      });
      const timeInput = el('input', {
        type: 'time', value: draft.time || '',
        oninput: (e) => { draft.time = e.target.value || null; },
      });
      fields.push(el('div.field-row',
        el('div.field', el('label', 'Date'), dateInput),
        el('div.field', el('label', 'Time'), timeInput),
      ));

      // Quick date shortcuts — the common cases without opening a picker.
      fields.push(el('div.pill-row',
        ...[
          ['Today', todayKey()],
          ['Tomorrow', addDays(todayKey(), 1)],
          ['Next week', addDays(todayKey(), 7)],
          ['No date', null],
        ].map(([label, value]) => el('button.pill', {
          onclick: () => { draft.date = value; dateInput.value = value || ''; },
        }, label)),
      ));

      // Duration
      fields.push(el('div.field-row',
        el('div.field',
          el('label', 'Duration (minutes)'),
          el('input', {
            type: 'number', min: '5', step: '5', value: draft.durationMin ?? '',
            placeholder: String(settings().defaultDurationMin),
            oninput: (e) => { draft.durationMin = e.target.value ? Number(e.target.value) : null; },
          }),
        ),
        el('div.field',
          el('label', 'List'),
          el('select', {
            onchange: (e) => { draft.listId = e.target.value; },
          }, store.state.lists.map((l) => el('option', {
            value: l.id, selected: l.id === draft.listId,
          }, l.name))),
        ),
      ));

      // Priority
      fields.push(el('div.field',
        el('label', 'Priority'),
        el('div.pill-row', PRIORITY_LABELS.map((p) => el('button.pill', {
          class: [`p-${p.value}`, draft.priority === p.value ? 'is-active' : ''].join(' '),
          onclick: (e) => {
            draft.priority = p.value;
            e.target.parentElement.querySelectorAll('.pill').forEach((x) => x.classList.remove('is-active'));
            e.target.classList.add('is-active');
          },
        }, p.label))),
      ));

      // Reminder
      fields.push(el('div.field',
        el('label', 'Remind me'),
        el('div.pill-row', REMINDER_OPTIONS.map((r) => el('button.pill', {
          class: draft.remindMin === r.value ? 'is-active' : '',
          onclick: (e) => {
            draft.remindMin = r.value;
            e.target.parentElement.querySelectorAll('.pill').forEach((x) => x.classList.remove('is-active'));
            e.target.classList.add('is-active');
          },
        }, r.label))),
        el('p.field-hint',
          'Reminders ride on the Google Calendar event, so your phone fires the notification even with this app closed.'),
      ));

      // Repeat
      fields.push(el('div.field',
        el('label', 'Repeat'),
        el('div.pill-row',
          ...[
            ['Never', null],
            ['Daily', { freq: 'daily', interval: 1 }],
            ['Weekdays', { freq: 'weekly', byDay: [1, 2, 3, 4, 5] }],
            ['Weekly', { freq: 'weekly', interval: 1 }],
            ['Monthly', { freq: 'monthly', interval: 1 }],
          ].map(([label, value]) => el('button.pill', {
            class: JSON.stringify(draft.recur) === JSON.stringify(value) ? 'is-active' : '',
            onclick: (e) => {
              draft.recur = value;
              e.target.parentElement.querySelectorAll('.pill').forEach((x) => x.classList.remove('is-active'));
              e.target.classList.add('is-active');
            },
          }, label)),
        ),
      ));

      // Subtasks
      const subHost = el('div.subtasks');
      const renderSubs = () => {
        subHost.replaceChildren(...draft.subtasks.map((sub) => el('div.subtask',
          { class: sub.done ? 'is-done' : '' },
          checkbox(sub.done, 0, () => { sub.done = !sub.done; renderSubs(); }, true),
          el('span', { style: { flex: '1' } }, sub.title),
          el('button.btn.btn-ghost.btn-icon', {
            'aria-label': 'Remove step',
            onclick: () => {
              draft.subtasks = draft.subtasks.filter((s) => s !== sub);
              renderSubs();
            },
          }, icon('close')),
        )));
      };
      renderSubs();
      const subInput = el('input', {
        type: 'text', placeholder: 'Add a step and press Enter',
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const v = e.target.value.trim();
          if (!v) return;
          draft.subtasks.push({ id: crypto.randomUUID?.() || String(Date.now()), title: v, done: false });
          e.target.value = '';
          renderSubs();
        },
      });
      fields.push(el('div.field', el('label', 'Steps'), subHost, subInput));

      // Notes
      fields.push(el('div.field',
        el('label', 'Notes'),
        el('textarea', {
          value: draft.notes,
          placeholder: 'Anything else…',
          oninput: (e) => { draft.notes = e.target.value; },
        }),
      ));

      return fields;
    },

    footer: (close) => [
      existing ? el('button.btn.btn-danger', {
        onclick: async () => {
          close();
          deleteWithUndo(existing.id);
        },
      }, 'Delete') : null,
      el('div', { style: { flex: '1' } }),
      el('button.btn', { onclick: close }, 'Cancel'),
      el('button.btn.btn-primary', { onclick: () => save(close) }, existing ? 'Save' : 'Add'),
    ],
  });

  function save(close) {
    if (!draft.title.trim()) {
      toast('Give it a title first.', { error: true });
      return;
    }
    // A timed item with no duration gets the default, so it occupies a
    // sensible block on the hour grid rather than a hairline.
    if (draft.time && !draft.durationMin) draft.durationMin = settings().defaultDurationMin;
    if (existing) {
      updateItem(existing.id, draft);
      if (applyToSeries) {
        // Only the type propagates. Dates, notes and completion are per
        // occurrence, and overwriting those across a series would destroy
        // real data to fix a classification.
        const title = draft.title.trim().toLowerCase();
        const series = liveItems().filter(
          (i) => i.id !== existing.id && i.title.trim().toLowerCase() === title,
        );
        for (const item of series) updateItem(item.id, { kind: draft.kind }, { undoable: false });
        toast(`Changed ${series.length + 1} items to ${draft.kind}s`, {
          action: 'Undo',
          onAction: () => store.undo(),
        });
      }
    } else {
      addItem(draft);
    }
    close();
  }
}

/** Delete a list, after confirming, moving its tasks back to the Inbox. */
export async function confirmDeleteList(list, count) {
  const ok = await confirmDialog({
    title: `Delete “${list.name}”?`,
    message: count
      ? `${count} task${count === 1 ? '' : 's'} will move to your Inbox. Nothing is lost.`
      : 'This list is empty.',
    confirmLabel: 'Delete list',
    danger: true,
  });
  return ok;
}

export { metaChips, checkbox, recurLabel };

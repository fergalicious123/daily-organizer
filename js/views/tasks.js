/* Task rows, task lists, and the item editor.
 * Shared by the right rail, the day view's side panel, and the list views.
 */

import { el, icon, toast, openModal, confirmDialog, haptic, clear as clearNode } from '../ui.js';
import { makeTouchDraggable, registerDropZone } from '../dragdrop.js';
import {
  store, PRIORITY, getList, getItem, addItem, updateItem, removeItem,
  toggleDone, toggleSubtask, addSubtask, removeSubtask, settings, liveItems,
  byUrgency, eventColorSlot, titleCount, itemLog, addNote, removeNote, NOTE_SOURCE,
} from '../state.js';
import {
  todayKey, formatRelativeDay, formatTime, addDays, toKey, isPast,
  formatDayHeader, fromKey, DAY_ABBR,
} from '../dates.js';
import { voice, speechSupported } from '../voice.js';
import { countdown, daysUntil } from '../countdown.js';
import * as usage from '../usage.js';
import { dateField } from './datepicker.js';
import { looksLikeMarkdown, markdownBlock } from '../markdown.js';
import { stampPaste } from '../paste.js';


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

  // The days left, on the row itself. Home lists these together, but a task
  // you meet in a list should say it is being counted down to — otherwise the
  // switch in the editor looks like it did nothing.
  const count = item.countdown ? countdown(item.date, item.title) : null;
  if (count) {
    chips.push(el('span.chip.is-countdown', {
      class: count.urgent ? 'is-urgent' : '',
      title: 'Counting down to this',
    }, count.text));
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
  // Notes are otherwise invisible until you open the item, which makes a job
  // you have already said three things about look identical to one you have
  // never touched — and the review reads exactly those notes back.
  const notes = itemLog(item).length;
  if (notes) {
    chips.push(el('span.chip.is-noted', {
      title: `${notes} note${notes === 1 ? '' : 's'} on this`,
    }, icon('mic', 'icon'), String(notes)));
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
  showDate = true, showList = true, draggable = true,
} = {}) {
  // Twice or more in the document: the hue is identifying something. Once: it
  // is a colour for its own sake.
  const recurringTitle = titleCount(item.title) >= 2;
  const listColour = getList(item.listId)?.color || '';

  const row = el('div.task', {
    // Two colour channels, deliberately kept on different parts of the row.
    //
    // `u-N` drives the left edge stripe: an ordinal ramp, darkest/brightest at
    // rank 1. Only unfinished tasks carry it — a finished row wants no shout.
    //
    /* `ev-N` is the kind colour, the same slot the calendar uses, so a row and
       its chip on the month grid are recognisably the same thing.
       ONLY WHERE THE TITLE COMES ROUND AGAIN. A colour shared by four cells is
       how a block of nights reads as one thing; a colour given to "Book MOT",
       which will never share it with anything, is decoration. A list of five
       one-off jobs was five unrelated hues plus five dots plus a list chip:
       three coloured marks a row, two of them saying nothing you could act on.
       A one-off takes its LIST's colour instead, set below — so a list is at
       most three colours and each of them answers a real question. */
    class: [
      item.done ? 'is-done' : '',
      recurringTitle ? `ev-${eventColorSlot(item.title) + 1}` : '',
    ].filter(Boolean).join(' '),
    dataset: { id: item.id },
    draggable: draggable ? 'true' : null,
    onclick: (e) => {
      if (e.target.closest('button')) return;
      openItemEditor(item.id);
    },
  });

  /* Through setProperty, not el()'s `style` option -- that uses Object.assign,
     which drops custom properties without a word. The routine card's stagger
     was silently flat for the same reason. */
  if (!recurringTitle && listColour) row.style.setProperty('--ev', listColour);

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
      usage.record('ITEM_DONE');
      if (!item.done) haptic();
    }),
    el('div.task-main',
      el('div.task-title',
        // The dot and the left edge are the same colour, so on a one-off they
        // were the same nothing said twice. It stays where the colour is
        // identifying something that recurs -- which, note, includes imported
        // shifts: those arrive as TASKS, so gating this on `kind` looked
        // principled and dropped the colour from the rows that most needed it.
        recurringTitle ? el('span.chip-dot.row-dot') : null,
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
  usage.record('ITEM_DELETE');
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

  /* The per-row urgency RANK is gone, and with it a second full sort of every
     open item on every render. It fed one thing: a `u-N` class carrying an
     ordinal red ramp that no rule in styles.css ever painted — the work was
     done, the class was stamped, and nothing appeared. byUrgency still ORDERS
     the list below; that half was always real. */

  // Grouping replaces the default overdue/rest split — under "group by due"
  // an Overdue heading would appear twice, and under the others the split
  // fights the grouping the user actually asked for.
  if (groupBy && groupBy !== 'none') {
    const groups = groupItems(urgencyOrder ? byUrgency(open, today) : open, groupBy, today);
    for (const [label, members, patch] of groups) {
      // An EMPTY group still gets a heading now, where before it was skipped.
      // That was right when a heading was only a label -- an empty one said
      // nothing -- and wrong the moment it became a place to put things: the
      // list you most want to drag a task into is usually the one with
      // nothing in it yet.
      if (!members.length && !patch) continue;
      const head = el('div.task-group-label',
        { class: [label === 'Overdue' ? 'is-overdue' : '', members.length ? '' : 'is-empty']
          .filter(Boolean).join(' ') },
        label === 'Overdue' ? icon('warning', 'icon') : null,
        members.length ? `${label} · ${members.length}` : label);
      frag.appendChild(makeGroupTarget(head, patch, label));
      for (const item of members) frag.appendChild(taskRow(item, rowOpts));
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
    for (const item of orderedOverdue) frag.appendChild(taskRow(item, rowOpts));
  }

  for (const item of orderedRest) frag.appendChild(taskRow(item, rowOpts));

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
/**
 * The groups, each with the patch that MOVING something into it would apply.
 *
 * The patch is the point. A heading used to be a string, which is fine to
 * read and useless to drop on: "High" tells you nothing about what to do to a
 * task dragged onto it. Carrying `{ priority: 3 }` alongside makes the
 * heading a place you can put something, and means the drop handler never has
 * to reverse-engineer a label back into a field.
 *
 * A null patch is a group you cannot drop into. "Overdue" is the only one:
 * there is no sensible date that means "make this late", and quietly picking
 * yesterday to satisfy the gesture would be inventing a decision.
 */
function groupItems(items, groupBy, today) {
  const buckets = new Map();
  const patches = new Map();
  const put = (label, item) => {
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(item);
  };

  if (groupBy === 'list') {
    // Follow the sidebar's order so the two readings of "my lists" agree.
    for (const list of store.state.lists) {
      buckets.set(list.name, []);
      patches.set(list.name, { listId: list.id });
    }
    for (const item of items) put(getList(item.listId)?.name || 'No list', item);
    return [...buckets.entries()].map(([label, members]) =>
      [label, members, patches.get(label) || null]);
  }

  if (groupBy === 'priority') {
    const order = ['High', 'Medium', 'Low', 'No priority'];
    const value = { High: 3, Medium: 2, Low: 1, 'No priority': 0 };
    for (const label of order) buckets.set(label, []);
    for (const item of items) {
      put(['No priority', 'Low', 'Medium', 'High'][item.priority || 0], item);
    }
    return order.map((label) => [label, buckets.get(label) || [], { priority: value[label] }]);
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
  const datePatch = {
    Overdue: null,                          // nothing sane to set
    Today: { date: today },
    Tomorrow: { date: tomorrow },
    'This week': { date: weekOut },
    Later: { date: addDays(today, 14) },
    'No date': { date: null },
  };
  return order.map((label) => [label, buckets.get(label) || [], datePatch[label]]);
}

/**
 * Make a group heading somewhere you can drop a task.
 *
 * Both drag paths, because the tasks list is used as much on the phone as on
 * the laptop: HTML5 for the mouse, registerDropZone for the finger.
 */
function makeGroupTarget(node, patch, label) {
  if (!patch) return node;
  node.classList.add('is-droppable');
  node.title = `Drop a task here to move it to ${label}`;

  const apply = ({ itemId }) => {
    const item = itemId ? getItem(itemId) : null;
    if (!item) return;
    updateItem(itemId, { ...patch });
    toast(`Moved to ${label}`, { action: 'Undo', onAction: () => store.undo() });
  };

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
    if (id) apply({ itemId: id });
  });
  registerDropZone(node, { group: label }, apply);
  return node;
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

    usage.record('QUICK_ADD');
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
/* ------------------------------------------------------------------ */
/* Notes as you go                                                     */
/* ------------------------------------------------------------------ */

/**
 * The running note log for an item: what you said about it, when.
 *
 * Saved immediately rather than with the rest of the dialog. A note dictated
 * between jobs is the thing most likely to be interrupted — you get called
 * away and the dialog never gets closed — and losing it because Cancel was
 * pressed would defeat the point of being able to speak it in the first place.
 *
 * That is also why it sits at the bottom, below Save's usual reach: these are
 * a different kind of edit from the fields above, and mixing them would make
 * "Cancel" mean two things at once.
 */
function noteLog(item) {
  const field = el('div.field.note-log');
  const list = el('div.note-list');

  const redraw = () => {
    clearNode(list);
    const notes = itemLog(getItem(item.id) || item);
    if (!notes.length) {
      list.appendChild(el('p.field-hint.note-empty',
        'Nothing yet. Press the mic and talk, or paste notes in.'));
      return;
    }
    for (const note of notes) {
      list.appendChild(el('div.note-row',
        el('div.note-row-head',
          el('span.note-when', formatNoteTime(note.at)),
          note.source === NOTE_SOURCE.VOICE ? icon('mic', 'icon note-src') : null,
          note.source === NOTE_SOURCE.PASTE ? icon('clipboard', 'icon note-src') : null,
          el('button.note-del', {
            type: 'button',
            title: 'Delete this note',
            'aria-label': 'Delete this note',
            onclick: () => { removeNote(item.id, note.id); redraw(); },
          }, icon('trash', 'icon')),
        ),
        // Notes get pasted into as often as they get typed into, and a
        // pasted table is the case where the shape carries the meaning.
        looksLikeMarkdown(note.text)
          ? markdownBlock(note.text, 'md note-md')
          : el('p.note-text', note.text),
      ));
    }
  };

  const status = el('span.note-status');
  const box = el('textarea.note-input', {
    placeholder: 'Add a note…',
    rows: 2,
    onpaste: (e) => stampPaste(e, box, () => {}),
  });

  const commit = (source = NOTE_SOURCE.TYPED) => {
    const text = box.value.trim();
    if (!text) return;
    addNote(item.id, text, source);
    usage.record('NOTE_ADD');
    box.value = '';
    redraw();
  };

  const mic = el('button.btn.btn-quiet.note-mic', {
    type: 'button',
    title: speechSupported() ? 'Dictate a note' : 'This browser cannot listen — type instead',
    disabled: !speechSupported(),
    onclick: () => {
      if (voice.listening) { voice.stop(); return; }
      // Dictation adds to whatever is already in the box rather than replacing
      // it, so a second thought after a pause joins the first note instead of
      // wiping it.
      const before = box.value.trim() ? `${box.value.trim()} ` : '';
      mic.classList.add('is-live');
      status.textContent = 'Listening…';
      voice.start({
        continuous: true,
        onInterim: (final, interim) => { box.value = before + final + interim; },
        onFinal: (text) => { box.value = before + text; commit(NOTE_SOURCE.VOICE); },
        onError: (message) => toast(message, { error: true }),
        onEnd: () => { mic.classList.remove('is-live'); status.textContent = ''; },
      });
    },
  }, icon('mic', 'icon'));

  // Granola, and anything else that produces text you want kept with a task.
  // Deliberately a paste box rather than an integration: Granola's API needs a
  // Business plan, and this needs nothing at all.
  const paste = el('button.btn.btn-quiet', {
    type: 'button',
    title: 'Paste notes from Granola or anywhere else',
    onclick: async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) { toast('Clipboard is empty.'); return; }
        box.value = text.trim();
        commit(NOTE_SOURCE.PASTE);
        toast('Pasted in');
      } catch {
        // Permission refused, or a browser that will not hand it over without
        // a real paste gesture. Focusing the box makes Ctrl+V the fallback.
        box.focus();
        toast('Paste into the box with Ctrl+V.');
      }
    },
  }, icon('clipboard', 'icon'));

  field.append(
    el('label', 'Notes as you go'),
    list,
    el('div.note-compose',
      box,
      el('div.note-compose-actions',
        mic,
        paste,
        el('button.btn.btn-quiet', {
          type: 'button', onclick: () => commit(NOTE_SOURCE.TYPED),
        }, 'Add'),
        status,
      ),
    ),
  );

  redraw();
  return field;
}

function formatNoteTime(iso) {
  const when = new Date(iso);
  const day = toKey(when);
  const time = formatTime(`${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`,
    settings().hour12);
  return day === todayKey() ? time : `${formatRelativeDay(day)} ${time}`;
}

export function openItemEditor(id, presets = {}) {
  usage.record('EDITOR_OPEN');
  const existing = id ? getItem(id) : null;
  // Whether a type change should propagate to every item sharing this title.
  let applyToSeries = false;
  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
      kind: 'task', title: '', notes: '', listId: store.state.inboxListId,
      /* TODAY, not null.
         A new item used to land in Unscheduled unless you went looking for
         the date field, which is the opposite of what typing a task into a
         box called "What needs doing?" means. Ben typed one, expected it on
         today, and it went somewhere he had to go and find.
         `presets` still wins, so clicking an hour on the day grid or a day in
         the month still puts it there. */
      date: todayKey(),
      time: null, durationMin: null, priority: 0,
      subtasks: [], recur: null, remindMin: null, ...presets,
    };

  openModal({
    title: existing ? 'Edit' : 'New item',
    // Closing the dialog must stop the microphone. Start dictating a note,
    // then press Escape or tap the backdrop, and nothing else in the app ever
    // told it to stop — a phone left listening indefinitely, with the only
    // indicator gone from the screen along with the dialog.
    onClose: () => { if (voice.listening) voice.stop(); },
    render: (close) => {
      const fields = [];

      // Title
      const titleInput = el('input', {
        type: 'text', value: draft.title, placeholder: 'What needs doing?',
        oninput: (e) => { draft.title = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(close); } },
      });
      fields.push(el('div.field', el('label', 'Title'), titleInput));

      /* ---- when ----
         Five choices, in front of you, because "when" is the only thing you
         almost always want to say about a new task and the only one that was
         hidden. Everything else about an item can wait behind More; this
         cannot, or the answer is decided by a default you never saw.
         The next two days are named rather than counted -- "Wed" is the same
         fact as "in 2 days" and is the one you can act on without doing the
         arithmetic. The full date is in the title attribute and in the line
         underneath. */
      const whenChoices = [
        { label: 'Today', value: todayKey() },
        { label: 'Tomorrow', value: addDays(todayKey(), 1) },
        { label: DAY_ABBR[fromKey(addDays(todayKey(), 2)).getDay()], value: addDays(todayKey(), 2), note: 'In 2 days' },
        { label: DAY_ABBR[fromKey(addDays(todayKey(), 3)).getDay()], value: addDays(todayKey(), 3), note: 'In 3 days' },
        { label: 'Unscheduled', value: null, note: 'No date \u2014 sits in Unscheduled until you give it one' },
      ];

      const whenRow = el('div.pill-row.when-row');
      const paintWhen = () => {
        for (const pill of whenRow.querySelectorAll('.pill')) {
          const raw = pill.dataset.when;
          const value = raw === '' ? null : raw;
          pill.classList.toggle('is-active', value === draft.date);
        }
      };
      for (const choice of whenChoices) {
        whenRow.appendChild(el('button.pill', {
          type: 'button',
          dataset: { when: choice.value || '' },
          title: choice.note || (choice.value ? formatDayHeader(choice.value) : ''),
          onclick: () => setWhen(choice.value),
        }, choice.label));
      }
      fields.push(el('div.field', el('label', 'When'), whenRow));

      /* One route for a date change, whichever control caused it: the pills,
         the grid in More, or a quick pill inside it. Four controls showing
         four different answers is the failure this avoids. */
      const setWhen = (value) => {
        draft.date = value;
        paintWhen();
        picker.set(value);
        describeLanding();
        syncCountdown();
      };

      /* ---- everything else, folded away ----
         The dialog used to open with eleven controls on show: type, date,
         time, four date shortcuts, duration, list, four priorities, six
         reminders, five repeats, steps and notes. Almost all of it is a
         decision you have not made yet at the moment you are trying to get a
         sentence out of your head, and a form that asks twelve questions to
         accept one is a form you stop opening.
         So: the title, a line saying where it will land, and a way in to the
         rest. Nothing has been removed — it is one press away, and an item
         that already HAS these things set opens with them showing, so editing
         never hides what you came to change. */
      const more = [];
      const moreBox = el('div.editor-more');

      // Says what pressing Add will actually do. A dialog that has hidden its
      // date field has to state the date somewhere, or "Add" becomes a guess.
      const landing = el('p.editor-landing');
      const describeLanding = () => {
        landing.classList.remove('is-past');
        if (!draft.date) {
          landing.textContent = 'Goes to Unscheduled — drag it onto a day when you want it.';
          return;
        }
        const when = formatRelativeDay(draft.date);
        const at = draft.time ? ` at ${formatTime(draft.time, settings().hour12)}` : '';
        // The dialog is the other way onto a day that has gone — typed or
        // preset rather than dropped — and the date field alone will not tell
        // you, least of all in a format like 15/09/2026.
        if (isPast(draft.date)) {
          landing.classList.add('is-past');
          landing.textContent = `${when}${at} — that day has gone, so this will be overdue straight away.`;
          return;
        }
        landing.textContent = draft.time
          ? `Lands on ${when}${at}.`
          : `Lands on ${when}, with no set time.`;
      };


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

      more.push(typeField);

      // Date + time
      // The rota-aware grid, in place of the browser's own picker. See the
      // note at the top of datepicker.js: choosing a date without being able
      // to see whether it is the second of four nights is choosing blind.
      const picker = dateField({
        value: draft.date,
        weekStart: settings().weekStart,
        label: 'Date',
        onPick: (key) => {
          usage.record('DATE_PICKER');
          draft.date = key;
          paintWhen();
          describeLanding();
          syncCountdown();
        },
      });
      const timeInput = el('input', {
        type: 'time', value: draft.time || '',
        oninput: (e) => { draft.time = e.target.value || null; describeLanding(); },
      });
      more.push(el('div.field-row',
        el('div.field', el('label', 'Date'), picker.node),
        el('div.field', el('label', 'Time'), timeInput),
      ));


      /* ---- count down to it ----
         The same thing the training step does for the PARA 10, available on
         anything with a date: an exam, a course starting, a flight. The date
         is the target and the title is the name, so there is nothing extra to
         fill in — which is the whole reason this is a switch and not a second
         date field that could disagree with the first.
         Meaningless without a date, so it says so rather than offering a
         switch that silently does nothing. */
      const countdownPill = el('button.pill', {
        type: 'button',
        class: draft.countdown ? 'is-active' : '',
        onclick: (e) => {
          draft.countdown = !draft.countdown;
          if (draft.countdown) usage.record('COUNTDOWN_SET');
          e.currentTarget.classList.toggle('is-active', Boolean(draft.countdown));
          e.currentTarget.setAttribute('aria-pressed', String(Boolean(draft.countdown)));
          syncCountdown();
        },
        'aria-pressed': String(Boolean(draft.countdown)),
      }, 'Count down to it');
      const countdownHint = el('p.field-hint');
      const syncCountdown = () => {
        countdownPill.disabled = !draft.date;
        const days = daysUntil(draft.date);
        countdownHint.textContent = !draft.date
          ? 'Give it a date first — a countdown needs something to count to.'
          : days == null
            ? 'That date has been and gone, so there is nothing left to count.'
            : draft.countdown
              ? `Shown on Home: ${days} day${days === 1 ? '' : 's'} to go.`
              : 'Puts the days remaining on Home, and on this task wherever it appears.';
      };
      syncCountdown();
      more.push(el('div.field',
        el('label', 'Countdown'),
        el('div.pill-row', countdownPill),
        countdownHint,
      ));

      // Duration
      more.push(el('div.field-row',
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
      more.push(el('div.field',
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
      more.push(el('div.field',
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
      more.push(el('div.field',
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
      more.push(el('div.field', el('label', 'Steps'), subHost, subInput));

      // Notes
      more.push(el('div.field',
        el('label', 'Notes'),
        el('textarea', {
          value: draft.notes,
          placeholder: 'Anything else…',
          oninput: (e) => { draft.notes = e.target.value; },
        }),
      ));


      describeLanding();
      paintWhen();
      // Open on anything already carrying detail, so Edit never appears to
      // have lost the fields you came for. `presets` count: clicking an empty
      // hour in the day grid hands over a date AND a time, and that is a
      // deliberate choice worth showing rather than burying.
      const richPresets = Boolean(presets.time || presets.priority || presets.recur);
      const startOpen = Boolean(existing) || richPresets;
      moreBox.append(...more);
      moreBox.hidden = !startOpen;

      const moreToggle = el('button.btn.btn-quiet.editor-more-toggle', {
        type: 'button',
        'aria-expanded': startOpen ? 'true' : 'false',
        onclick: (e) => {
          const open = moreBox.hidden;
          if (open) usage.record('EDITOR_MORE');
          moreBox.hidden = !open;
          e.currentTarget.setAttribute('aria-expanded', String(open));
          e.currentTarget.textContent = open ? 'Fewer options' : 'Date, time, list and more';
        },
      }, startOpen ? 'Fewer options' : 'Date, time, list and more');

      fields.push(landing, moreToggle, moreBox);

      // Notes as you go — only on something that already exists, because they
      // are saved the instant they are spoken rather than when the dialog is
      // closed, and there is nothing to attach them to until the item is real.
      if (existing) fields.push(noteLog(existing));

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
      usage.record('ITEM_ADD');
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

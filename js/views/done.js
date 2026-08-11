/* Completed — where finished things go.
 *
 * Two jobs beyond "a list of what you did":
 *   - a comment per item, written after the fact (how it went, what it cost)
 *   - drag any of it back onto a day, which reopens it and reschedules it
 *
 * Grouped by when it was finished rather than paged, because the useful
 * question is almost always "what did I get done this week", not "show me
 * item 340".
 */

import { el, icon, toast, openModal } from '../ui.js';
import {
  store, completedItems, updateItem, toggleDone, getList, settings, eventColorSlot,
} from '../state.js';
import { todayKey, addDays, formatDayLong, formatRelativeDay, formatTime } from '../dates.js';
import { makeTouchDraggable } from '../dragdrop.js';
import { dayStrip } from './calendar.js';

/** Bucket by completion date: Today, Yesterday, This week, Earlier. */
function bucketFor(doneAt) {
  if (!doneAt) return 'No date recorded';
  const day = doneAt.slice(0, 10);
  const today = todayKey();
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  if (day > addDays(today, -7)) return 'Earlier this week';
  if (day > addDays(today, -31)) return 'This month';
  return 'Older';
}

const BUCKET_ORDER = ['Today', 'Yesterday', 'Earlier this week', 'This month', 'Older', 'No date recorded'];

export function doneView({ onNavigate }) {
  const items = completedItems();
  const root = el('div.done-view.view-anim');

  root.appendChild(el('header.done-head',
    el('h1.done-title', 'Completed'),
    el('p.done-sub', items.length
      ? `${items.length} finished item${items.length === 1 ? '' : 's'} · drag one onto a day to do it again, or onto Off to reopen it without a date`
      : 'Nothing finished yet'),
  ));

  // The same strip the list views use. Without it this screen had days to drop
  // onto only via the button, and no way at all to reopen something without
  // committing to a date — which is the case when a result changes and you do
  // not yet know when you will get back to it.
  if (items.length) {
    root.appendChild(dayStrip({
      onSelectDay: (dayKey) => onNavigate({ view: 'day', anchor: dayKey }),
      onOpenUnscheduled: () => onNavigate({ view: 'tasks', listId: null }),
    }));
  }

  if (!items.length) {
    root.appendChild(el('div.empty-state',
      el('div.empty-icon', '·'),
      el('p', 'Nothing completed yet'),
      el('p.empty-hint', 'Tick something off and it will appear here.'),
    ));
    return root;
  }

  const buckets = new Map();
  for (const item of items) {
    const key = bucketFor(item.doneAt);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }

  for (const name of BUCKET_ORDER) {
    const group = buckets.get(name);
    if (!group?.length) continue;
    root.appendChild(el('div.task-group-label', `${name} · ${group.length}`));
    for (const item of group) root.appendChild(doneRow(item, { onNavigate }));
  }

  return root;
}

function doneRow(item, { onNavigate }) {
  const cfg = settings();
  const list = getList(item.listId);

  const row = el('div.done-row', {
    // Keeps its true kind colour rather than going green like a finished row
    // elsewhere. On this screen everything is finished, so a green dot on every
    // line would say nothing; the colour that still carries information is the
    // one that groups the fortnight's night shifts together.
    class: `ev-${eventColorSlot(item.title) + 1}`,
    draggable: 'true',
    dataset: { id: item.id },
    ondragstart: (e) => {
      e.dataTransfer.setData('text/plain', item.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
    },
    ondragend: () => row.classList.remove('is-dragging'),
  });

  // Dragging a finished thing back onto a day is the main point of this view,
  // and on a phone that only works through the touch path.
  makeTouchDraggable(row, () => item.id);

  const commentBox = el('div.done-comment-box', { hidden: !item.comment });
  const commentInput = el('textarea', {
    placeholder: 'How did it go? Anything worth remembering…',
    value: item.comment || '',
    rows: 2,
    dataset: { focusId: `comment-${item.id}` },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') e.target.blur();
    },
    // Save on blur rather than per keystroke: every save re-renders, and
    // re-rendering mid-sentence is how you lose a comment.
    onblur: (e) => {
      const value = e.target.value.trim();
      if (value !== (item.comment || '')) {
        updateItem(item.id, { comment: value });
        toast(value ? 'Comment saved' : 'Comment cleared');
      }
    },
  });
  commentBox.appendChild(commentInput);

  row.append(
    el('button.done-tick', {
      title: 'Mark as not done',
      'aria-label': 'Mark as not done',
      onclick: () => {
        toggleDone(item.id);
        toast(`Reopened “${item.title}”`, { action: 'Undo', onAction: () => store.undo() });
      },
    }, icon('check')),

    el('div.done-main',
      el('div.done-row-title', el('span.chip-dot.row-dot'), item.title || 'Untitled'),
      el('div.done-meta',
        item.doneAt
          ? el('span.chip', `done ${formatRelativeDay(item.doneAt.slice(0, 10))}`)
          : null,
        item.date
          ? el('span.chip', item.time
            ? `${formatRelativeDay(item.date)} ${formatTime(item.time, cfg.hour12)}`
            : formatRelativeDay(item.date))
          : null,
        list ? el('span.chip.is-list',
          el('span.list-dot', { style: { background: list.color, color: list.color } }),
          list.name) : null,
      ),
      commentBox,
    ),

    el('div.done-actions',
      el('button', {
        title: item.comment ? 'Edit comment' : 'Add a comment',
        'aria-label': item.comment ? 'Edit comment' : 'Add a comment',
        onclick: () => {
          commentBox.hidden = false;
          commentInput.focus();
        },
      }, icon('edit')),
      // Dragging is nice on a desktop, but on a phone the Completed screen has
      // no drop target in sight — the calendar is not on screen and the
      // sidebar is a closed drawer. So the button is the dependable route and
      // the drag is the shortcut, not the other way round.
      el('button', {
        title: 'Move to a day',
        'aria-label': 'Move to a day',
        onclick: () => openReschedule(item),
      }, icon('calendar')),
    ),
  );

  return row;
}

/**
 * Pick a day to move a finished item back to. The no-drag path, and the only
 * one that works on a phone.
 */
function openReschedule(item) {
  openModal({
    title: 'Move to a day',
    render: (close) => {
      const dateInput = el('input', {
        type: 'date',
        value: todayKey(),
        onkeydown: (e) => e.stopPropagation(),
      });

      const go = (dateKey) => {
        if (!dateKey) { toast('Pick a date first.', { error: true }); return; }
        reopenOnDay(item.id, dateKey);
        close();
      };

      return [
        el('p', { style: { margin: 0, color: 'var(--text-muted)', fontSize: '13px' } },
          `“${item.title}” will be reopened and moved to the day you choose.`),
        el('div.pill-row',
          ...[
            ['Today', todayKey()],
            ['Tomorrow', addDays(todayKey(), 1)],
            ['Next week', addDays(todayKey(), 7)],
          ].map(([label, value]) => el('button.pill', { onclick: () => go(value) }, label)),
        ),
        el('div.field', el('label', 'Or pick a date'), dateInput),
        el('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
          el('button.btn.btn-primary', { onclick: () => go(dateInput.value) }, 'Move it'),
        ),
      ];
    },
  });
}

/**
 * Reopen a completed item onto a new day.
 * Shared by every drop target so "drag it back" behaves the same everywhere.
 */
export function reopenOnDay(itemId, dateKey, time = null) {
  const item = store.state.items.find((i) => i.id === itemId);
  if (!item) return false;
  if (!item.done) return false;      // not ours to handle

  updateItem(itemId, {
    done: false,
    doneAt: null,
    date: dateKey,
    time: time || null,
  });
  toast(`“${item.title}” moved to ${formatDayLong(dateKey)}`, {
    action: 'Undo',
    onAction: () => store.undo(),
  });
  return true;
}

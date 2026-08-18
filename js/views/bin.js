/* The bin.
 *
 * A drop target for deleting things by dragging them, rather than opening a
 * row and hunting for the trash icon.
 *
 * It only exists while you are dragging. That is deliberate on two counts: a
 * permanently visible delete target is a permanently available mistake, and it
 * would cost screen space on every view for a gesture used a few times a week.
 * The drag already flags the document — `is-mouse-dragging` / `is-touch-
 * dragging`, set in dragdrop.js — so the bin can simply appear whenever a drag
 * is in flight and get out of the way the instant it ends.
 *
 * Deleting is a tombstone, not an erase: `removeItem` sets `deleted` so the
 * deletion travels to Drive and to the other device instead of the item coming
 * back on the next sync. It also lands on the undo stack, which is what the
 * toast is wired to. Nothing here asks "are you sure" — a confirmation on a
 * drag gesture defeats the point of the gesture — so the undo is the whole
 * safety net and it has to be prominent and slow to disappear.
 */

import { el, icon, toast, haptic } from '../ui.js';
import { registerDropZone } from '../dragdrop.js';
import { store, removeItem, getItem } from '../state.js';

let node = null;

/** Take the item out, and offer it straight back. */
function dropIntoBin({ itemId }) {
  if (!itemId) return;
  const item = getItem(itemId);
  if (!item) return;
  const title = item.title || 'Untitled';

  removeItem(itemId);
  haptic(18);

  // Long, because this is the only way back and the person has just made a
  // gesture that can be made by accident. `store.undo()` emits, so the app
  // redraws itself — no explicit render needed here.
  toast(`Deleted "${truncate(title)}"`, {
    action: 'Undo',
    onAction: () => store.undo(),
    duration: 9000,
  });
}

function truncate(text, max = 38) {
  const clean = String(text).trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Put the bin on the page. Safe to call more than once.
 *
 * Appended to <body> rather than into a view, because every view rebuilds on
 * render and the bin must survive a redraw that happens mid-drag.
 */
export function mountBin() {
  if (node) return node;

  node = el('div.bin', { 'aria-hidden': 'true' },
    icon('trash', 'icon'),
    el('span.bin-label', 'Drop here to delete'),
  );

  // Mouse path: HTML5 drag-and-drop delivers straight to the element under
  // the cursor, so this needs its own listeners.
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('is-drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('is-drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('is-drop-target');
    const itemId = e.dataTransfer.getData('text/plain');
    dropIntoBin({ itemId });
  });

  // Touch path: found by elementFromPoint, so the bin must be hit-testable
  // while a drag is running. The highlight class is applied for us.
  registerDropZone(node, {}, dropIntoBin);

  document.body.appendChild(node);
  return node;
}

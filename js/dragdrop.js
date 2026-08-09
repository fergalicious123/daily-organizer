/* Touch dragging.
 *
 * HTML5 drag-and-drop (draggable="true" + dragstart/drop) is mouse-only:
 * Android and iOS browsers never fire those events from a finger. So every
 * drag in this app — scheduling a task onto an hour, moving one between days,
 * pulling a completed item back onto a date — silently did nothing on a phone
 * or a touchscreen laptop.
 *
 * This adds a pointer path alongside the native one. Mouse users keep real
 * HTML5 DnD; touch users get an equivalent built on touch events.
 *
 * Two details that matter:
 *   - A long press starts the drag, not a move. Starting on movement would
 *     make every attempt to scroll a list pick up a task instead.
 *   - The touchmove listener is non-passive so it can preventDefault() once
 *     dragging begins. Without that the page scrolls under the drag and the
 *     gesture is unusable.
 */

const HOLD_MS = 320;        // long-press before a drag begins
const SLOP_PX = 10;         // finger wander allowed before it counts as a scroll

/** node -> handler({ itemId, dateKey, time }). Weak so re-renders don't leak. */
const zones = new WeakMap();

/**
 * Mark a node as able to receive drops.
 * `meta` carries whatever the drop needs to know (a date, an hour).
 */
export function registerDropZone(node, meta, handler) {
  node.dataset.dropZone = '1';
  zones.set(node, { meta, handler });
}

function zoneAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const node = el.closest('[data-drop-zone]');
  if (!node) return null;
  const entry = zones.get(node);
  return entry ? { node, ...entry } : null;
}

/**
 * Make a node draggable by touch. `getItemId` is a function so the id is read
 * at drag time rather than captured when the row was built.
 */
export function makeTouchDraggable(node, getItemId) {
  node.dataset.touchDrag = '1';

  let holdTimer = null;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let ghost = null;
  let lastZone = null;

  const cleanup = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (ghost) { ghost.remove(); ghost = null; }
    if (lastZone) { lastZone.node.classList.remove('is-drop-target'); lastZone = null; }
    node.classList.remove('is-dragging');
    document.body.classList.remove('is-touch-dragging');
    dragging = false;
  };

  const onStart = (e) => {
    if (e.touches.length !== 1) return;
    // Let taps on real controls through — a checkbox is not a drag handle.
    if (e.target.closest('button, input, textarea, select, a')) return;

    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;

    holdTimer = setTimeout(() => {
      dragging = true;
      node.classList.add('is-dragging');
      document.body.classList.add('is-touch-dragging');

      const rect = node.getBoundingClientRect();
      ghost = node.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${rect.width}px`;
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      document.body.appendChild(ghost);

      try { navigator.vibrate?.(15); } catch { /* unsupported */ }
    }, HOLD_MS);
  };

  const onMove = (e) => {
    const touch = e.touches[0];
    if (!touch) return;

    if (!dragging) {
      // Moved before the hold completed: this is a scroll, not a drag.
      if (Math.abs(touch.clientX - startX) > SLOP_PX
        || Math.abs(touch.clientY - startY) > SLOP_PX) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      return;
    }

    // Now we own the gesture — stop the page scrolling beneath it.
    e.preventDefault();

    if (ghost) {
      ghost.style.transform =
        `translate(${touch.clientX - startX}px, ${touch.clientY - startY}px)`;
    }

    const zone = zoneAt(touch.clientX, touch.clientY);
    if (zone?.node !== lastZone?.node) {
      lastZone?.node.classList.remove('is-drop-target');
      zone?.node.classList.add('is-drop-target');
      lastZone = zone;
    }
  };

  const onEnd = (e) => {
    if (!dragging) { cleanup(); return; }
    const touch = e.changedTouches[0];
    const zone = touch ? zoneAt(touch.clientX, touch.clientY) : null;
    const itemId = getItemId();
    cleanup();
    if (zone && itemId) zone.handler({ itemId, ...zone.meta });
  };

  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchmove', onMove, { passive: false });
  node.addEventListener('touchend', onEnd);
  node.addEventListener('touchcancel', cleanup);
}

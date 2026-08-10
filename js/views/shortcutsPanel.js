/* The keyboard-shortcuts help: a corner button and the panel it opens.
 *
 * Rendered from the shared list in shortcuts.js rather than written out here,
 * so it cannot promise a key that does not exist.
 *
 * Mounted outside the app's render tree, next to the clock, for the same
 * reason the clock is: nothing that redraws a view should be able to move it.
 */

import { el, icon, openModal } from '../ui.js';
import { shortcutGroups, SHORTCUT_CAVEATS } from '../shortcuts.js';

/**
 * Which build this device is actually running, read from CacheStorage — so it
 * is the service worker's own version constant rather than a second copy that
 * could disagree with it.
 *
 * Lives here rather than in app.js, which already imports this module: taking
 * it from there would close an import cycle for the sake of six lines.
 */
async function buildVersion() {
  try {
    const keys = await caches.keys();
    return keys.find((k) => k.startsWith('organizer-')) || null;
  } catch {
    return null;
  }
}

/** One key as a keycap. */
function cap(text) {
  return el('kbd.keycap', text);
}

export function openShortcutsPanel() {
  openModal({
    title: 'Keyboard shortcuts',
    width: '460px',
    render: () => [
      el('div.shortcut-groups',
        ...shortcutGroups().map(([group, items]) => el('section.shortcut-group',
          el('h3.shortcut-group-title', group),
          el('dl.shortcut-list',
            ...items.flatMap((s) => [
              el('dt.shortcut-keys',
                ...s.display.flatMap((k, i) => (i === 0 ? [cap(k)] : [el('span.keycap-plus', '+'), cap(k)])),
              ),
              el('dd.shortcut-label',
                s.label,
                s.note ? el('span.shortcut-note', s.note) : null,
              ),
            ]),
          ),
        )),
      ),
      el('div.shortcut-caveats',
        el('h3.shortcut-group-title', 'When they do nothing'),
        el('ul', ...SHORTCUT_CAVEATS.map((line) => el('li', line))),
      ),
      // Worth saying on a tablet, where both the panel and a touchscreen are
      // in reach. Phones never see this button at all.
      el('p.shortcut-touch',
        icon('chevronRight', 'icon'),
        'On a touchscreen, swipe left and right to move between days, weeks or months.'),

      buildStamp(),
    ],
  });
}

/**
 * Which build is running here. Filled in asynchronously because it comes from
 * CacheStorage; absent when there is no worker at all (a plain file:// open,
 * or a browser with service workers switched off), and saying so is more
 * useful than showing nothing.
 */
function buildStamp() {
  const node = el('p.build-stamp', 'Checking version…');
  buildVersion().then((version) => {
    node.textContent = version ? `Build ${version}` : 'No offline cache on this device';
  });
  return node;
}

let mounted = null;

/** Put the "?" button in the corner, once. */
export function mountShortcutsButton() {
  if (mounted?.isConnected) return mounted;
  mounted = el('button.shortcuts-fab', {
    type: 'button',
    title: 'Keyboard shortcuts',
    'aria-label': 'Keyboard shortcuts',
    onclick: openShortcutsPanel,
  }, '?');
  document.body.appendChild(mounted);
  return mounted;
}

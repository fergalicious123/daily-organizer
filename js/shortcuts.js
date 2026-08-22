/* The keyboard shortcuts, as data.
 *
 * One list, read by both the handler that runs the keys and the panel that
 * explains them. They were written out separately before and drifted: the
 * documented list lost `H` entirely and claimed the arrows stepped by a day in
 * every view. A help panel that lies is worse than no help panel, so the only
 * way to add a key is to add it here, where both sides see it.
 *
 * `key` is the literal `KeyboardEvent.key`, so it is what app.js looks up.
 * Entries with `key: null` are handled elsewhere (the browser's own modifier
 * combinations) and appear in the panel for completeness.
 */

export const SHORTCUTS = [
  { group: 'Views', key: 'h', display: ['H'], label: 'Home' },
  { group: 'Views', key: 'm', display: ['M'], label: 'Month' },
  { group: 'Views', key: 'w', display: ['W'], label: 'Week' },
  { group: 'Views', key: 'd', display: ['D'], label: 'Day — whichever day you are on' },
  { group: 'Views', key: 't', display: ['T'], label: 'Jump to today' },
  {
    group: 'Views',
    key: 'r',
    display: ['R'],
    label: 'Review the last block',
    note: 'The run of shifts you have just finished, read back in one place.',
  },

  {
    group: 'Moving around',
    key: 'ArrowLeft',
    display: ['←'],
    label: 'Back one period',
    note: 'A month in Month view, a week in Week view, a day everywhere else.',
  },
  { group: 'Moving around', key: 'ArrowRight', display: ['→'], label: 'Forward one period' },

  { group: 'Doing things', key: 'n', display: ['N'], label: 'New item' },
  { group: 'Doing things', key: null, display: ['Ctrl', 'Z'], label: 'Undo' },
  { group: 'Doing things', key: null, display: ['Ctrl', 'Shift', 'Z'], label: 'Redo' },
  {
    group: 'Doing things',
    key: 'Escape',
    display: ['Esc'],
    label: 'Close what you are in',
    note: 'A dialog first, then the sidebar or side panel. In a text field it just steps out.',
  },
];

/** The rules that decide whether a key does anything at all. */
export const SHORTCUT_CAVEATS = [
  'Lower case only — with Shift or Caps Lock held, the letters do nothing.',
  'Switched off while you are typing, so writing “make the appointment” cannot throw you into Month view.',
  'Switched off while a dialog is open, so its own keys win.',
  'Ctrl + Z is the exception: it works everywhere except inside a field, where it is the browser’s own undo.',
];

/** Grouped in the order the groups first appear, for rendering. */
export function shortcutGroups() {
  const groups = new Map();
  for (const s of SHORTCUTS) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  return [...groups.entries()];
}

/**
 * Every key this list claims exists. app.js checks its handler table against
 * this at startup, so a key added in one place and forgotten in the other is
 * caught on the next page load rather than by a user pressing it.
 */
export function declaredKeys() {
  return SHORTCUTS.filter((s) => s.key).map((s) => s.key);
}

/* What actually gets used.
 *
 * Ben's question: in three months, which of this is worth keeping? A lot has
 * been built fast — a review, a triage, a day summary, a planner, a brief, a
 * note app — and some of it will turn out to be scaffolding he never touches.
 * Guessing which is exactly the thing people get wrong about their own tools,
 * so this counts instead.
 *
 * It counts ACTIONS, not screens-with-things-on. A view opening is recorded
 * because navigating somewhere is a choice; a render is not, because renders
 * happen for reasons that have nothing to do with wanting anything.
 *
 * WHERE IT LIVES, and why it is not one flat set of numbers.
 * Counts are kept per device inside the synced document:
 *
 *   usage: { [deviceId]: { [feature]: { n, first, last } } }
 *
 * A single shared map would be wrong. Two devices each holding "review: 4"
 * cannot be merged: last-write-wins throws half the count away, and adding
 * them double-counts everything that had already synced. Per device, only one
 * writer ever touches a bucket, so the merge is a union and the newer copy of
 * a bucket is always the more complete one. Summing happens at the point of
 * reading, which is the only place it is safe.
 *
 * NOTHING LEAVES THE DEVICE that was not already leaving it. This rides in the
 * same Drive file as the tasks, under Ben's own account. It is counters and
 * timestamps: no titles, no text, no content of any kind.
 */

import { store, device, updateDevice } from './state.js';

/**
 * The things worth asking "do I still want this?" about.
 *
 * Deliberately a fixed list rather than free strings. A typo'd key would sit
 * in the report for three months looking like a real feature nobody used,
 * which is precisely the wrong answer to give someone deciding what to cut.
 */
export const FEATURES = {
  // Getting things in
  ITEM_ADD: 'Add an item',
  QUICK_ADD: 'Quick add line',
  VOICE_ADD: 'Add by voice',
  EDITOR_OPEN: 'Open the editor',
  EDITOR_MORE: 'Open the editor\u2019s extra fields',
  DRAG_SCHEDULE: 'Drag onto a day',
  DATE_PICKER: 'Pick a date from the grid',
  SEARCH: 'Find something',

  // Getting things done
  ITEM_DONE: 'Tick something off',
  ITEM_DELETE: 'Delete something',
  UNDO: 'Undo',
  ROUTINE_TICK: 'Tick a first-things step',

  // The clever bits, which are the ones most likely to be scaffolding
  REVIEW_RUN: 'Run a block review',
  TRIAGE_RUN: 'Sort caught notes',
  DAYLOG_WRITE: 'Write up a day',
  PLAN_MAKE: 'Make a plan from the overdue pile',
  PLAN_STEP_TAKE: 'Use a step from a plan',
  BRIEF_SEND: 'Send the morning brief',
  BRIEF_REWORD: 'Reword the brief',
  NOTE_ADD: 'Add a note to a task',
  CAPTURE_ADD: 'Catch a note',
  CAPTURE_SEND: 'Send a caught note to the organizer',
  COUNTDOWN_SET: 'Set a countdown',
  ALARM_SET: 'Hand an alarm to the phone',

  // Where the time goes
  VIEW_HOME: 'Home',
  VIEW_DAY: 'Day view',
  VIEW_WEEK: 'Week view',
  VIEW_MONTH: 'Month view',
  VIEW_TASKS: 'Task lists',
  VIEW_JOURNAL: 'Diary',
  VIEW_REVIEW: 'Review',
  VIEW_STATS: 'Progress',
  VIEW_CAPTURE: 'Catch',

  // Housekeeping
  SYNC_CONNECT: 'Connect to Google',
  SETTINGS_OPEN: 'Open Settings',
};

const KNOWN = new Set(Object.keys(FEATURES));

/** A stable id for this browser, minted once. Not identifying; just a bucket. */
export function deviceId() {
  const d = device();
  if (d.deviceId) return d.deviceId;
  const id = (crypto.randomUUID?.() || `d${Date.now()}${Math.random()}`).slice(0, 12);
  updateDevice({ deviceId: id });
  return id;
}

/**
 * Count one use of a feature.
 *
 * Silent about unknown keys in production but loud in the console, because a
 * mistyped key is a measurement that quietly never happens.
 *
 * Not undoable and silent: this is bookkeeping. Putting it on the undo stack
 * would mean Ctrl+Z sometimes just un-counted something, and emitting would
 * re-render the whole app every time anything at all happened.
 */
export function record(feature, times = 1) {
  if (!KNOWN.has(feature)) {
    console.warn(`usage: unknown feature "${feature}"`);
    return;
  }
  const id = deviceId();
  const at = new Date().toISOString();
  store.mutate((s) => {
    if (!s.usage || typeof s.usage !== 'object') s.usage = {};
    const bucket = s.usage[id] || (s.usage[id] = {});
    const entry = bucket[feature] || (bucket[feature] = { n: 0, first: at, last: at });
    entry.n += times;
    entry.last = at;
  }, { undoable: false, silent: true });
}

/**
 * The report: every feature, most used first, summed across devices.
 *
 * Features with a count of zero are INCLUDED. They are the whole point — the
 * question is what to remove, and a feature that never appears in a list of
 * what you used is easy to miss. A zero is the loudest answer here.
 */
export function report() {
  const usage = store.state.usage || {};
  const totals = new Map();
  for (const key of Object.keys(FEATURES)) {
    totals.set(key, { key, label: FEATURES[key], n: 0, first: '', last: '' });
  }
  for (const bucket of Object.values(usage)) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [key, entry] of Object.entries(bucket)) {
      const row = totals.get(key);
      if (!row || !entry) continue;
      row.n += Number(entry.n) || 0;
      if (entry.first && (!row.first || entry.first < row.first)) row.first = entry.first;
      if (entry.last && entry.last > row.last) row.last = entry.last;
    }
  }
  return [...totals.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

/** When counting started, so a report can say how much it is speaking from. */
export function since() {
  const rows = report().filter((r) => r.first);
  if (!rows.length) return '';
  return rows.reduce((a, r) => (a < r.first ? a : r.first), rows[0].first);
}

/** Start again — after a review, or if the numbers stop meaning anything. */
export function reset() {
  store.mutate((s) => { s.usage = {}; }, { undoable: false, silent: true });
}

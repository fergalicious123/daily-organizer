/* The single source of truth for the app.
 *
 * Design notes:
 *  - Tasks and events are ONE collection (`items`) distinguished by `kind`.
 *    A task with a date and a time is, structurally, an event you can tick off.
 *    Unifying them means one sync/merge path instead of two, and it makes
 *    "drag a todo onto 3pm" a field update rather than a type conversion.
 *  - Every item carries `updatedAt` and a `deleted` tombstone. Both exist for
 *    sync: last-write-wins needs a clock, and a hard delete on one device would
 *    otherwise be resurrected by the next pull from another.
 *  - Mutations go through mutate() so persistence, undo and notification all
 *    happen in exactly one place.
 */

import { todayKey, diffDays } from './dates.js';

const STORAGE_KEY = 'daily-organizer:v1';
const UNDO_LIMIT = 40;

/**
 * The Google OAuth client for this app.
 *
 * This is deliberately committed. Browser OAuth clients have no client secret;
 * the security boundary is the authorized-origins allowlist in Google Cloud
 * Console, so a copy of this ID is useless from any other domain. Shipping it
 * means a fresh install — most importantly on a phone, where typing it would
 * be miserable — is configured the moment it loads.
 *
 * Settings can still override it, which is what a second person forking this
 * would do.
 */
const DEFAULT_CLIENT_ID =
  '866873823601-a6bojdgs4gqbmufvcd20lb7lh1h1cbfi.apps.googleusercontent.com';

export const PRIORITY = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export const LIST_COLORS = [
  '#5b7fd4', '#c2683f', '#4a9d7f', '#a45ba4',
  '#c9a227', '#5aa0c4', '#b5555f', '#6f7b8a',
];

function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function nowISO() {
  return new Date().toISOString();
}

/**
 * The starting lists.
 *
 * These ids are FIXED, not generated. Sync merges lists by id, so random ids
 * meant every fresh install minted its own "Work" that the merge could not
 * recognise as the same list — union them with what was already in Drive and
 * you get two of everything. Stable ids make a fresh install converge with an
 * existing account instead of duplicating it.
 */
const DEFAULT_LISTS = [
  { id: 'list-personal', name: 'Personal', color: LIST_COLORS[0], order: 0 },
  { id: 'list-work', name: 'Work', color: LIST_COLORS[1], order: 1 },
  { id: 'list-finances', name: 'Finances', color: LIST_COLORS[2], order: 2 },
];

/** The list that catches anything without one of its own. */
const DEFAULT_LIST_ID = 'list-personal';

function defaultState() {
  return {
    version: 1,
    listsVersion: 2,
    items: [],
    // normalised event title -> colour slot. See eventColorSlot().
    eventColors: {},
    // dateKey -> { text, updatedAt }. One entry a day, written after the fact.
    // Keyed by day rather than held as a list so a phone and a laptop editing
    // different days never collide, and the same day merges last-write-wins.
    journal: {},
    lists: DEFAULT_LISTS.map((l) => ({ ...l, updatedAt: nowISO() })),
    settings: {
      theme: 'auto',
      weekStart: 1,          // Monday
      hour12: true,
      dayStart: 7,           // first hour shown in the day grid
      dayEnd: 22,
      defaultRemindMin: 10,
      defaultDurationMin: 60,
      googleClientId: DEFAULT_CLIENT_ID,
      googleCalendarId: 'primary',
      googleEnabled: false,
      // Keep the access token across reloads. Off means re-authorising every
      // time the page loads, which is safer but tiresome.
      staySignedIn: true,
      // Move unfinished tasks forward a day, then to Unscheduled.
      rollover: true,
      lastRolloverOn: '',
      groupBy: 'none',       // none | list | priority | due
      driveFileId: '',
      lastSyncAt: '',
    },
    // Historic field name; it is simply the fallback list.
    inboxListId: DEFAULT_LIST_ID,
    updatedAt: nowISO(),
  };
}

/**
 * Collapse duplicate lists and move to the Personal/Work/Finances set.
 *
 * Runs once per document (guarded by `listsVersion`). Two jobs:
 *  1. Repair — merge lists that share a name, reassigning their items. This
 *     undoes the damage from the random-id bug above.
 *  2. Restructure — fold the old "Inbox" into "Personal" and ensure
 *     "Finances" exists.
 *
 * Items are always reassigned before a list is dropped, so nothing is
 * orphaned and no task is ever lost.
 */
/**
 * @param {object} state
 * @param {{restructure?: boolean}} opts
 *   `restructure` performs the ONE-TIME move to Personal/Work/Finances —
 *   folding the old Inbox away and creating Finances. Deduping happens
 *   regardless, on every load.
 */
function repairLists(state, { restructure = true } = {}) {
  const lists = Array.isArray(state.lists) ? [...state.lists] : [];
  const items = Array.isArray(state.items) ? state.items : [];
  if (!lists.length) {
    state.lists = DEFAULT_LISTS.map((l) => ({ ...l, updatedAt: nowISO() }));
    state.inboxListId = DEFAULT_LIST_ID;
    state.listsVersion = 2;
    return state;
  }

  const remap = new Map();          // dropped list id -> surviving list id
  const keptByName = new Map();     // lowercase name -> surviving list
  const kept = [];

  for (const list of lists) {
    const name = String(list.name || '').trim();
    const key = name.toLowerCase();
    const existing = keptByName.get(key);
    if (existing) {
      remap.set(list.id, existing.id);
    } else {
      keptByName.set(key, list);
      kept.push(list);
    }
  }

  // "Inbox" was the old catch-all; Personal takes that role now.
  const inbox = restructure ? keptByName.get('inbox') : null;
  const personal = keptByName.get('personal');
  if (inbox && personal) {
    remap.set(inbox.id, personal.id);
    const index = kept.indexOf(inbox);
    if (index >= 0) kept.splice(index, 1);
    keptByName.delete('inbox');
  } else if (inbox && !personal) {
    // No Personal to fold into, so just rename it.
    inbox.name = 'Personal';
    inbox.updatedAt = nowISO();
    keptByName.delete('inbox');
    keptByName.set('personal', inbox);
  }

  for (const item of items) {
    if (remap.has(item.listId)) {
      item.listId = remap.get(item.listId);
      item.updatedAt = nowISO();
    }
  }

  // Only on the one-time restructure. Recreating it every load would
  // resurrect a list the user had deliberately deleted.
  if (restructure && !keptByName.has('finances')) {
    kept.push({
      id: 'list-finances', name: 'Finances',
      color: LIST_COLORS[2], order: kept.length, updatedAt: nowISO(),
    });
  }

  // Put the three standard lists in their intended order; anything the user
  // added themselves keeps its relative position after them.
  const preferred = DEFAULT_LISTS.map((l) => l.name.toLowerCase());
  kept.sort((a, b) => {
    const ai = preferred.indexOf(String(a.name).trim().toLowerCase());
    const bi = preferred.indexOf(String(b.name).trim().toLowerCase());
    if (ai === -1 && bi === -1) return (a.order ?? 0) - (b.order ?? 0);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  kept.forEach((list, i) => { list.order = i; });

  state.lists = kept;
  const fallback = keptByName.get('personal') || kept[0];
  state.inboxListId = fallback.id;
  // Anything still pointing at a list that no longer exists comes home.
  const validIds = new Set(kept.map((l) => l.id));
  for (const item of items) {
    if (!validIds.has(item.listId)) item.listId = fallback.id;
  }
  if (restructure) state.listsVersion = 2;
  return state;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

class Store {
  constructor() {
    this.state = this._load();
    this._listeners = new Set();
    this._undo = [];
    this._redo = [];
    this._saveTimer = null;
    /** Set whenever local data changes; sync.js clears it after a Drive push. */
    this.dirty = false;
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return this._migrate(parsed);
    } catch (err) {
      console.error('Could not read saved data, starting fresh.', err);
      return defaultState();
    }
  }

  _migrate(data) {
    const base = defaultState();
    // Merge settings so a new setting added in a later version gets a default
    // rather than being undefined for existing users.
    const settings = { ...base.settings, ...(data.settings || {}) };
    // A saved empty string is not a deliberate choice — it is data written
    // before the built-in client ID existed. Spreading would let it win over
    // the default and leave the app looking unconfigured.
    if (!settings.googleClientId) settings.googleClientId = base.settings.googleClientId;
    const merged = {
      ...base,
      ...data,
      settings,
      items: Array.isArray(data.items) ? data.items : [],
      lists: Array.isArray(data.lists) && data.lists.length ? data.lists : base.lists,
      inboxListId: data.inboxListId || (data.lists?.[0]?.id) || base.inboxListId,
    };
    // Older documents carry duplicate lists and the old Inbox. Fix once.
    // Test the SAVED document, not the merged one: `merged` inherits
    // listsVersion 2 from the defaults, so checking it would always look
    // already-repaired and the fix would never run.
    // Dedupe ALWAYS. Gating it behind the version flag made it a one-shot,
    // so anything that reintroduced duplicates afterwards — a Drive copy
    // written before list ids were stable, a merge from another device —
    // left them in place permanently, because the document already claimed
    // to be repaired. Deduping is idempotent; on clean data it does nothing.
    repairLists(merged, { restructure: data.listsVersion !== 2 });
    return merged;
  }

  /* ---- subscription ---- */

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(detail = {}) {
    for (const fn of this._listeners) {
      try {
        fn(this.state, detail);
      } catch (err) {
        console.error('A view failed to update.', err);
      }
    }
  }

  /* ---- persistence ---- */

  save() {
    // Debounced: typing in a title field should not hit localStorage per keypress.
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (err) {
      console.error('Could not save. Storage may be full.', err);
    }
  }

  /**
   * Apply a change. `fn` mutates a draft; everything else is bookkeeping.
   * Pass { undoable: false } for changes that should not land on the undo stack
   * (settings toggles, sync writes).
   */
  mutate(fn, { undoable = true, label = '', silent = false } = {}) {
    if (undoable) {
      this._undo.push({ snapshot: JSON.stringify(this.state), label });
      if (this._undo.length > UNDO_LIMIT) this._undo.shift();
      this._redo.length = 0;
    }
    const result = fn(this.state);
    this.state.updatedAt = nowISO();
    this.dirty = true;
    this.save();
    if (!silent) this.emit({ label });
    return result;
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  undo() {
    const entry = this._undo.pop();
    if (!entry) return null;
    this._redo.push({ snapshot: JSON.stringify(this.state), label: entry.label });
    this.state = JSON.parse(entry.snapshot);
    this.dirty = true;
    this.save();
    this.emit({ label: 'undo' });
    return entry.label;
  }

  redo() {
    const entry = this._redo.pop();
    if (!entry) return null;
    this._undo.push({ snapshot: JSON.stringify(this.state), label: entry.label });
    this.state = JSON.parse(entry.snapshot);
    this.dirty = true;
    this.save();
    this.emit({ label: 'redo' });
    return entry.label;
  }

  /**
   * Replace state wholesale — used by sync when Drive wins. Deliberately not
   * undoable, and it bypasses the dirty flag so we don't immediately push back
   * what we just pulled.
   */
  replaceState(next) {
    this.state = this._migrate(next);
    this.dirty = false;
    this.saveNow();
    this.emit({ label: 'sync' });
  }
}

export const store = new Store();

/* ------------------------------------------------------------------ */
/* Item helpers                                                        */
/* ------------------------------------------------------------------ */

export function makeItem(fields = {}) {
  const s = store.state;
  return {
    id: uid(),
    kind: 'task',
    title: '',
    notes: '',
    // Written after the fact — how it went, what it cost, what to remember.
    // Kept separate from `notes` so completing something never overwrites
    // instructions you wrote for yourself beforehand.
    comment: '',
    listId: s.inboxListId,
    done: false,
    doneAt: null,
    date: null,
    // Last day an all-day item covers, inclusive. Null for a single day.
    // A four-day shift is one item spanning four dates, not four items.
    endDate: null,
    time: null,
    durationMin: null,
    priority: PRIORITY.NONE,
    subtasks: [],
    recur: null,
    remindMin: null,
    gcalId: null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    deleted: false,
    ...fields,
  };
}

export function addItem(fields = {}) {
  const item = makeItem(fields);
  store.mutate((s) => s.items.push(item), { label: 'add' });
  return item;
}

export function getItem(id) {
  return store.state.items.find((i) => i.id === id) || null;
}

export function updateItem(id, patch, opts = {}) {
  return store.mutate((s) => {
    const item = s.items.find((i) => i.id === id);
    if (!item) return null;
    // Deliberately giving something a date is you taking charge of it, so the
    // rollover counter starts again — otherwise a task you just rescheduled
    // would be flung into Unscheduled on the next run for a decision you made
    // days ago.
    const setsDate = Object.prototype.hasOwnProperty.call(patch, 'date')
      && patch.date && patch.date !== item.date;
    Object.assign(item, patch, { updatedAt: nowISO() });
    if (setsDate) { item.rollCount = 0; item.rolledFrom = null; }
    return item;
  }, { label: 'edit', ...opts });
}

/** Soft delete — the tombstone is what stops sync resurrecting it. */
export function removeItem(id) {
  return store.mutate((s) => {
    const item = s.items.find((i) => i.id === id);
    if (!item) return null;
    item.deleted = true;
    item.updatedAt = nowISO();
    return item;
  }, { label: 'delete' });
}

export function toggleDone(id) {
  return store.mutate((s) => {
    const item = s.items.find((i) => i.id === id);
    if (!item) return null;
    item.done = !item.done;
    item.doneAt = item.done ? nowISO() : null;
    item.updatedAt = nowISO();
    // Finishing it clears its rollover history — if it ever comes back, it
    // starts with a clean slate rather than one chase from being banished.
    if (item.done) { item.rollCount = 0; item.rolledFrom = null; }
    // A completed recurring task spawns its next occurrence rather than
    // vanishing, so the series survives being ticked off.
    if (item.done && item.recur) {
      const next = nextOccurrence(item);
      if (next) s.items.push(makeItem({ ...item, id: undefined, date: next, done: false, doneAt: null, gcalId: null, createdAt: nowISO() }));
    }
    return item;
  }, { label: 'toggle' });
}

/** The date of the occurrence after this item's own date. */
export function nextOccurrence(item) {
  if (!item.recur || !item.date) return null;
  const { freq, interval = 1, byDay } = item.recur;
  const d = new Date(item.date + 'T00:00:00');
  if (freq === 'daily') {
    d.setDate(d.getDate() + interval);
  } else if (freq === 'weekly') {
    if (byDay?.length) {
      // Step day by day to the next selected weekday.
      for (let i = 1; i <= 371; i++) {
        d.setDate(d.getDate() + 1);
        if (byDay.includes(d.getDay())) break;
      }
    } else {
      d.setDate(d.getDate() + 7 * interval);
    }
  } else if (freq === 'monthly') {
    d.setMonth(d.getMonth() + interval);
  } else {
    return null;
  }
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (item.recur.until && key > item.recur.until) return null;
  return key;
}

/* ---- queries ---- */

/** All live items (tombstones filtered out). */
export function liveItems() {
  return store.state.items.filter((i) => !i.deleted);
}

/** True when `dateKey` falls anywhere inside the item's span. */
export function coversDay(item, dateKey) {
  if (!item.date) return false;
  if (item.date === dateKey) return true;
  return Boolean(item.endDate) && item.date <= dateKey && dateKey <= item.endDate;
}

/** Multi-day, so it wants a spanning bar rather than a chip. */
export function isSpanning(item) {
  return Boolean(item.endDate && item.endDate > item.date);
}

export function itemsOnDay(dateKey) {
  return liveItems()
    .filter((i) => coversDay(i, dateKey))
    .sort(sortByTimeThenPriority);
}

export function timedItemsOnDay(dateKey) {
  return itemsOnDay(dateKey).filter((i) => i.time);
}

export function untimedItemsOnDay(dateKey) {
  return itemsOnDay(dateKey).filter((i) => !i.time);
}

export function itemsInRange(startKey, endKey) {
  return liveItems()
    // Overlap, not containment: a shift starting before the window and ending
    // inside it still belongs to that window.
    .filter((i) => i.date && i.date <= endKey && (i.endDate || i.date) >= startKey)
    .sort(sortByTimeThenPriority);
}

/** Tasks with no date at all — the backlog. */
export function unscheduledTasks() {
  return liveItems()
    .filter((i) => i.kind === 'task' && !i.date)
    .sort(sortByTimeThenPriority);
}

export function tasksInList(listId) {
  return liveItems()
    .filter((i) => i.kind === 'task' && i.listId === listId)
    .sort(sortByTimeThenPriority);
}

/**
 * Everything finished, newest first. Items completed without a `doneAt`
 * (imported, or ticked before that field existed) sort to the end rather than
 * being dropped.
 */
export function completedItems() {
  return liveItems()
    .filter((i) => i.done)
    .sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
}

/**
 * How pressing something is. Higher is more urgent.
 *
 * Deliberately dominated by the date: an overdue task outranks a high-priority
 * one that is not due for a fortnight, because lateness is a fact and priority
 * is an opinion. Priority breaks ties rather than driving the order.
 */
export function urgencyScore(item, today = todayKey()) {
  if (!item || item.done) return -1;
  let score = 0;

  if (item.date) {
    const delta = diffDays(today, item.date);   // negative once overdue
    if (delta < 0) {
      // Older overdue items climb, but with a ceiling — something three months
      // late should not permanently outrank everything you must do this week.
      score += 200 + Math.min(-delta, 21) * 4;
    } else if (delta === 0) {
      score += 160;
    } else {
      score += Math.max(0, 130 - delta * 9);
    }
  } else {
    score += 15;                                 // undated: a quiet backlog
    // Something that fell out of the calendar after being ignored twice sits
    // at the top of that backlog. It has already been passed over more than
    // anything else there.
    if ((item.rollCount || 0) >= 2) score += 45;
  }

  score += (item.priority || 0) * 14;
  if (item.time) score += 6;                     // a set time is a commitment
  if (item.subtasks?.length) {
    const open = item.subtasks.filter((s) => !s.done).length;
    if (open === 0) score += 8;                  // all steps done, just needs ticking
  }
  return score;
}

/**
 * Carry unfinished work forward: overdue → today → Unscheduled.
 *
 * A task you did not get to yesterday appears on today. If you still do not
 * action it, the next run drops it out of the calendar entirely and parks it at
 * the top of Unscheduled — because a task you have now ignored twice is not
 * really scheduled, and leaving it to rot on a past date just makes the
 * calendar lie.
 *
 * This rewrites dates, and dated items sync to the real Google Calendar, so it
 * is deliberately narrow about what it will touch. It skips:
 *   - events — you do not reschedule a shift or an appointment by not doing it
 *   - anything with a repeat rule of its own
 *   - one occurrence of a repeating Google series (`seriesId`), where moving a
 *     single instance would corrupt a genuinely recurring entry
 *   - anything already done
 *
 * Returns what it changed so the caller can say so out loud. Silent mutation of
 * someone's calendar is not acceptable, even when they asked for it.
 */
export function rollOverdueTasks({ today = todayKey() } = {}) {
  const moved = [];
  const unscheduled = [];

  store.mutate((s) => {
    for (const item of s.items) {
      if (item.deleted || item.done) continue;
      if (item.kind !== 'task') continue;
      if (item.recur || item.seriesId) continue;
      if (!item.date || item.date >= today) continue;

      const rolls = item.rollCount || 0;
      if (rolls === 0) {
        // Record where it came from BEFORE overwriting the date.
        item.rolledFrom = item.rolledFrom || item.date;
        item.date = today;
        item.rollCount = 1;
        moved.push(item.title || 'Untitled');
      } else {
        // Chased once already and still untouched: stop pretending it has a day.
        item.date = null;
        item.time = null;
        item.rollCount = 2;
        unscheduled.push(item.title || 'Untitled');
      }
      item.updatedAt = nowISO();
    }
    s.settings.lastRolloverOn = today;
  }, { label: 'rollover' });

  return { moved, unscheduled, total: moved.length + unscheduled.length };
}

/** Has today's rollover already run? */
export function rolloverDue(today = todayKey()) {
  const cfg = settings();
  return cfg.rollover !== false && cfg.lastRolloverOn !== today;
}

/** Sort a copy most-urgent first. */
export function byUrgency(items, today = todayKey()) {
  return [...items].sort((a, b) => urgencyScore(b, today) - urgencyScore(a, today));
}

/* ------------------------------------------------------------------ */
/* Event colours                                                       */
/* ------------------------------------------------------------------ */

/** How many distinct colours exist before they start repeating. */
export const EVENT_COLOR_SLOTS = 8;

/**
 * Reduce a title to the thing that identifies its *kind*, so every
 * "Night Shift (N)" lands on one colour and every "Day Shift (D)" on another.
 * Strips a leading time, punctuation and casing, but keeps the words — two
 * genuinely different shifts must not collapse into one another.
 */
export function colorKeyFor(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^\s*\d{1,2}([:.]\d{2})?\s*(am|pm)?\s*[-–—:]?\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The colour slot for a title, assigned on first sight and then fixed.
 *
 * Persisted rather than hashed, for two reasons: a hash collides, putting two
 * unrelated event types on one colour with no way to fix it; and colour must
 * follow the entity, so it cannot shift about as the diary fills up. Slots are
 * handed out in order, and the palette is ordered so the earliest slots are the
 * most distinguishable — including under colour blindness.
 */
export function eventColorSlot(title) {
  const key = colorKeyFor(title);
  if (!key) return 0;
  const map = store.state.eventColors || (store.state.eventColors = {});
  if (map[key] === undefined) {
    const used = Object.keys(map).length;
    map[key] = used % EVENT_COLOR_SLOTS;
    // Not undoable and not a user edit: this is bookkeeping, and it must not
    // land on the undo stack or mark the document dirty for sync.
    store.save();
  }
  return map[key];
}

/** Every distinct event kind and its colour — for a legend. */
export function eventColorLegend() {
  const map = store.state.eventColors || {};
  const seen = new Map();
  for (const item of liveItems()) {
    const key = colorKeyFor(item.title);
    if (key && !seen.has(key)) seen.set(key, { title: item.title, slot: map[key] ?? 0 });
  }
  return [...seen.values()];
}

/** Incomplete, dated before today — the stuff quietly rotting. */
export function overdueTasks() {
  const today = todayKey();
  return liveItems()
    .filter((i) => i.kind === 'task' && !i.done && i.date && i.date < today)
    .sort(sortByTimeThenPriority);
}

function sortByTimeThenPriority(a, b) {
  if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.time && !b.time) return -1;
  if (!a.time && b.time) return 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
}

/* ---- lists ---- */

export function getList(id) {
  return store.state.lists.find((l) => l.id === id) || null;
}

export function addList(name) {
  const list = {
    id: uid(),
    name,
    color: LIST_COLORS[store.state.lists.length % LIST_COLORS.length],
    order: store.state.lists.length,
    updatedAt: nowISO(),
  };
  store.mutate((s) => s.lists.push(list), { label: 'add list' });
  return list;
}

export function renameList(id, name) {
  store.mutate((s) => {
    const list = s.lists.find((l) => l.id === id);
    if (list) { list.name = name; list.updatedAt = nowISO(); }
  }, { label: 'rename list' });
}

export function removeList(id) {
  if (id === store.state.inboxListId) return false;
  store.mutate((s) => {
    s.lists = s.lists.filter((l) => l.id !== id);
    // Orphaned tasks fall back to the Inbox rather than disappearing.
    for (const item of s.items) {
      if (item.listId === id) { item.listId = s.inboxListId; item.updatedAt = nowISO(); }
    }
  }, { label: 'delete list' });
  return true;
}

/* ---- subtasks ---- */

export function addSubtask(itemId, title) {
  return store.mutate((s) => {
    const item = s.items.find((i) => i.id === itemId);
    if (!item) return null;
    const sub = { id: uid(), title, done: false };
    item.subtasks.push(sub);
    item.updatedAt = nowISO();
    return sub;
  }, { label: 'add subtask' });
}

export function toggleSubtask(itemId, subId) {
  store.mutate((s) => {
    const item = s.items.find((i) => i.id === itemId);
    const sub = item?.subtasks.find((x) => x.id === subId);
    if (sub) { sub.done = !sub.done; item.updatedAt = nowISO(); }
  }, { label: 'toggle subtask' });
}

export function removeSubtask(itemId, subId) {
  store.mutate((s) => {
    const item = s.items.find((i) => i.id === itemId);
    if (!item) return;
    item.subtasks = item.subtasks.filter((x) => x.id !== subId);
    item.updatedAt = nowISO();
  }, { label: 'delete subtask' });
}

/* ---- settings ---- */

export function updateSettings(patch) {
  store.mutate((s) => Object.assign(s.settings, patch), { undoable: false, label: 'settings' });
}

export function settings() {
  return store.state.settings;
}

/* ---- stats ---- */

/**
 * Completion figures for a set of items. `total` deliberately counts only
 * tasks: events are not something you complete, so including them would make
 * the donut permanently unfinishable.
 */
export function progressFor(items) {
  const tasks = items.filter((i) => i.kind === 'task');
  const done = tasks.filter((i) => i.done).length;
  const total = tasks.length;
  return {
    done,
    total,
    remaining: total - done,
    ratio: total === 0 ? 0 : done / total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/** Tasks completed per day over the last `days` days, oldest first. */
export function completionHistory(days = 7) {
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const count = liveItems().filter((it) => it.doneAt && it.doneAt.slice(0, 10) === key).length;
    out.push({ date: key, count });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

/** What was written for a day, or null. */
export function journalFor(dateKey) {
  const entry = store.state.journal?.[dateKey];
  return entry && entry.text ? entry : null;
}

/**
 * Write (or clear) a day's entry.
 *
 * Empty text deletes the key rather than storing a blank, so an entry the user
 * emptied stops appearing in the diary and stops travelling to Drive.
 */
export function setJournal(dateKey, text) {
  const clean = String(text ?? '').trim();
  return store.mutate((s) => {
    if (!s.journal) s.journal = {};
    if (clean) s.journal[dateKey] = { text: clean, updatedAt: nowISO() };
    else delete s.journal[dateKey];
  }, { label: 'journal' });
}

/** Every written day, newest first. */
export function journalEntries() {
  const journal = store.state.journal || {};
  return Object.entries(journal)
    .filter(([, e]) => e && e.text)
    .map(([date, e]) => ({ date, ...e }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** What was ticked off on a given day — the diary's other half. */
export function completedOn(dateKey) {
  return liveItems()
    .filter((i) => i.doneAt && i.doneAt.slice(0, 10) === dateKey)
    .sort((a, b) => (a.doneAt || '').localeCompare(b.doneAt || ''));
}

/** Consecutive days up to today with at least one completed task. */
export function currentStreak() {
  const byDay = new Set(
    liveItems().filter((i) => i.doneAt).map((i) => i.doneAt.slice(0, 10)),
  );
  let streak = 0;
  const d = new Date();
  // Today not yet counted shouldn't break a streak, so start from yesterday
  // if today is empty but yesterday is not.
  const key = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if (!byDay.has(key(d))) d.setDate(d.getDate() - 1);
  while (byDay.has(key(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

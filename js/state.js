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

import { todayKey, diffDays, addDays, toKey } from './dates.js';

const STORAGE_KEY = 'daily-organizer:v1';
/*
 * How much of the past to keep, in bytes rather than in steps.
 *
 * Undo works by snapshotting the whole document, so what one step costs
 * depends entirely on how much you have. Forty steps was fine when that meant
 * forty copies of a short list. Measured against a 481KB document -- his is
 * 309KB and growing -- forty edits grew the heap by 18MB, which is a lot to
 * ask of a phone for an undo nobody uses past the second step.
 *
 * A byte budget adapts instead: a small document keeps its forty, a large one
 * keeps fewer, and neither has a number in it that someone guessed. UNDO_MIN
 * is the floor, so even a document larger than the whole budget can still be
 * undone a few times.
 */
const UNDO_BUDGET_BYTES = 4 * 1024 * 1024;
const UNDO_MIN = 5;
const UNDO_LIMIT = 40;

/**
 * Device-local settings, deliberately OUTSIDE the synced document.
 *
 * The main state travels: it goes to Google Drive and it comes out of "Export
 * backup" as a plain JSON file. Neither is a place for an API key. Putting
 * these in `settings` would have meant a key sitting in a file people mail to
 * themselves, and a key in Drive that a later Drive-wide share would carry
 * with it — a leak with no visible moment of leaking.
 *
 * So the delivery settings for the brief live here, on this device only. The
 * cost is re-entering them on a second device; the benefit is that they cannot
 * escape by a route nobody was thinking about.
 */
const DEVICE_KEY = 'daily-organizer:device';

const DEVICE_DEFAULTS = {
  // Only ever used to address a WhatsApp message you send yourself.
  whatsappNumber: '',
  // Optional third-party relay for hands-off sending. See brief.js.
  callMeBotKey: '',
  // Optional. See the note at the top of ai.js about what storing this means.
  anthropicKey: '',
};

let deviceCache = null;

/** Device-local settings. Never synced, never exported. */
export function device() {
  if (!deviceCache) {
    try {
      deviceCache = { ...DEVICE_DEFAULTS, ...JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}') };
    } catch {
      deviceCache = { ...DEVICE_DEFAULTS };
    }
  }
  return deviceCache;
}

export function updateDevice(patch) {
  deviceCache = { ...device(), ...patch };
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(deviceCache));
  } catch {
    // Private mode, or storage full. The app keeps working; the setting just
    // does not survive a reload, which is better than throwing here.
  }
  return deviceCache;
}

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

/*
 * "No reminder", as a value you can actually store.
 *
 * `null` already means something else: "nothing chosen, use the default". Both
 * the notifier and the calendar writer read it that way -- `remindMin ??
 * defaultRemindMin`, and `useDefault: true` on the Google event -- which is
 * what makes the default reminder setting work at all.
 *
 * So the picker's "None" option, which stored null, did not turn a reminder
 * off. It asked for the default one. Choosing None on a 07:00 task still
 * notified at 06:50, on the phone as well, because Google was told to use the
 * calendar's own defaults. A distinct value is the only way to say the thing
 * the button claims to say.
 *
 * Negative rather than a string so every existing comparison keeps working,
 * and existing items with null keep their current meaning untouched -- no
 * migration, no change to anything already saved.
 */
export const REMINDER_NONE = -1;

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

/**
 * The shape of `routineSteps` this build expects. Bumping it runs the steps
 * below that a saved document has not seen yet.
 */
const ROUTINE_VERSION = 4;

/**
 * Bring an already-saved routine up to the current shape.
 *
 * Necessary because `routineSteps` lives in settings, and settings are merged
 * from the SAVED document — so editing the default alone changes nothing for
 * anyone who has already run the app. Ben's saved copy still said "Gym".
 *
 * Guarded by `routineVersion` and tested against the saved document rather
 * than the merged one, for the same reason the list repair is: `merged`
 * inherits the current version from the defaults, so checking it would always
 * look already-migrated and the fix would never run.
 *
 * Deliberately narrow. It only rewrites a step that still looks like the old
 * default — if the label has been changed by hand, that edit is left alone and
 * only the version marker moves. A migration that overwrites a deliberate
 * change is worse than one that does nothing.
 */
function migrateRoutine(state, saved) {
  const version = saved?.settings?.routineVersion || 0;
  if (version >= ROUTINE_VERSION) return state;
  const steps = Array.isArray(state.settings.routineSteps) ? state.settings.routineSteps : [];

  if (version < 2) {
    const gym = steps.find((s) => s.id === 'gym');
    if (gym && /^gym$/i.test(String(gym.label || '').trim())) {
      gym.label = 'Para 10 training';
      gym.match = '';
      gym.target = '2026-09-26';
      gym.targetLabel = 'Para 10';
    }
  }

  // v3: the studying gets a horizon of its own. The training step has had one
  // since v2 and it is the half of the ritual that gets done; "20 days" next
  // to Study English is the same argument made for the other half.
  //
  // Only when the step is not already counting down to something. If a target
  // has been set by hand — through Settings, which can now do this — that is a
  // decision, and a migration that overwrites a decision is worse than one
  // that does nothing.
  if (version < 3) {
    const study = steps.find((s) => s.id === 'study');
    if (study && !study.target) {
      study.target = '2026-09-20';
      study.targetLabel = 'English course';
    }
  }

  // v4: the ritual gets an evening end. ADDED rather than rewritten, and only
  // when there is no evening step already -- if one has been put there by
  // hand, that is the decision and this must not duplicate it.
  //
  // Assigned back rather than relying on the push: `steps` is only the same
  // array as the saved one when the saved one was an array to begin with, and
  // a document that lost the field would otherwise migrate into nothing.
  if (version < 4 && !steps.some((s) => s?.when === 'evening')) {
    steps.push({
      id: 'winddown',
      label: 'Phone down, book instead',
      kind: 'winddown',
      when: 'evening',
      match: '',
      note: 'The screen keeps you up. Read something on paper for the last half hour.',
    });
    state.settings.routineSteps = steps;
  }

  state.settings.routineVersion = ROUTINE_VERSION;
  return state;
}

/**
 * Give an id to anything saved without one.
 *
 * Cleaning up after the makeItem bug documented above: for as long as that
 * was live, ticking off a repeating task pushed its next occurrence into the
 * document with `id: undefined`. Those are still sitting in saved data, and
 * they are inert — every lookup in the app finds items by id, so the row is
 * drawn but cannot be edited, completed, deleted or synced.
 *
 * Runs on every load rather than behind a version flag, because a document
 * merged from a device still running the old code can bring fresh ones back.
 * On clean data it does nothing.
 */
function repairIds(state) {
  for (const item of state.items) {
    if (!item.id) item.id = uid();
  }
  return state;
}

/*
 * How long a deletion has to keep announcing itself.
 *
 * A tombstone exists so a delete travels: without one, the next sync sees an
 * item on Drive that is missing locally and helpfully puts it back. But it
 * only has to outlive the chance of another device still holding the live
 * copy, and nothing ever removed them -- so every task Ben has deleted since
 * June is still in the document, still syncing, still parsed on every open,
 * for ever.
 *
 * Ninety days. A device that has not synced in three months will resurrect a
 * handful of long-deleted items on its next connection, which is a small,
 * one-off annoyance; the alternative is a file that only grows. Nothing shows
 * tombstones to anyone -- the bin is a drop target, not a recycle bin, and the
 * safety net is the undo toast -- so there is no view to break.
 */
const TOMBSTONE_DAYS = 90;

/**
 * Drop deletions old enough to have reached everywhere.
 *
 * Runs inside _migrate, which is deliberate: that is called on load AND on
 * every sync result, so a tombstone the remote still holds is purged again
 * from the merged document rather than travelling back and forth for ever.
 */
export function purgeTombstones(state, now = Date.now()) {
  const cutoff = now - TOMBSTONE_DAYS * 86400000;
  const stale = (x) => {
    if (!x?.deleted) return false;
    const at = Date.parse(x.updatedAt || x.at || '');
    // An undated tombstone is kept: guessing it is old enough to drop is the
    // one way this can lose something that still matters somewhere.
    return Number.isFinite(at) && at < cutoff;
  };
  if (Array.isArray(state.items)) state.items = state.items.filter((i) => !stale(i));
  if (Array.isArray(state.captures)) state.captures = state.captures.filter((c) => !stale(c));
  return state;
}

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
    /*
     * dateKey -> { text, updatedAt }. The written-up summary of a day.
     *
     * Deliberately NOT a field on the journal entry beside your own writing.
     * setJournal() replaces that object wholesale on every save, so a summary
     * living inside it would be wiped the next time you typed a character —
     * and it merges per day, last write wins, so a summary written on the
     * laptop and a sentence typed on the phone would fight over the same key.
     * Its own map merges independently, exactly like `routine` below.
     */
    journalSummary: {},
    /*
     * Lines caught by the capture app, before they are anything else.
     *
     * A flat append-only list rather than a per-day map, because a capture is a
     * moment, not a day: three in one minute is normal, and they are triaged
     * as a pile rather than read back as an entry. Each carries its own id and
     * time so two devices merge by union instead of one overwriting the other,
     * and deletes are tombstoned — the same shape, and the same reasoning, as
     * the notes on an item.
     */
    captures: [],
    /*
     * deviceId -> feature -> { n, first, last }. What gets used, so that in
     * three months there is an answer to "what is worth keeping" that is not
     * a guess. Per device because counts cannot be merged any other way —
     * see the note at the top of usage.js. Counters and timestamps only.
     */
    usage: {},
    // dateKey -> { steps: [stepId], updatedAt }. Same shape as `journal` on
    // purpose: sync merges both the same way, per day, newest write wins.
    routine: {},
    lists: DEFAULT_LISTS.map((l) => ({ ...l, updatedAt: nowISO() })),
    settings: {
      theme: 'auto',
      weekStart: 1,          // Monday
      hour12: true,
      dayStart: 7,           // first hour shown in the day grid
      dayEnd: 22,
      defaultRemindMin: 10,
      // How long before a shift starts you need to be awake, which is the
      // only figure the alarm hand-off cannot read off the rota -- it is a
      // commute and a shower, not a shift pattern. 90 puts a 06:30 start at
      // an 05:00 alarm.
      alarmLeadMin: 90,
      // Create the alarm outright rather than opening the Clock app with it
      // filled in. One tap instead of two, where the Clock app honours it --
      // and the panel offers the other way when it does not.
      alarmSkipUi: true,
      defaultDurationMin: 60,
      googleClientId: DEFAULT_CLIENT_ID,
      googleCalendarId: 'primary',
      googleEnabled: false,
      // Which Google account this is connected to, learned from the primary
      // calendar's id (which IS the address) rather than by asking for a
      // profile scope we do not otherwise need. Used only as a sign-in hint.
      googleAccount: '',
      // Keep the access token across reloads. Off means re-authorising every
      // time the page loads, which is safer but tiresome.
      staySignedIn: true,
      // Move unfinished tasks forward a day, then to Unscheduled.
      rollover: true,
      lastRolloverOn: '',
      // Last day a shift-block review was sat down with. Empty means never,
      // which is why reviewDue() compares with < rather than testing presence.
      lastReviewOn: '',
      groupBy: 'none',       // none | list | priority | due
      // Your own name, as it appears prefixed on shared-calendar entries.
      // Only needed if your rota is written "Ben: Night Shift" rather than
      // plain "Night Shift" — it decides whose shifts colour the calendar.
      myName: '',
      /* The morning ritual, in order. Order is the point — Ben's rule is
         study first, then the gym — so this is a list, not a set, and the
         card draws it as a sequence rather than a checklist.
         `match` links a step to a real task by title fragment, so ticking the
         step ticks the actual course task instead of tracking a second,
         parallel copy of the same thing. */
      routineSteps: [
        { id: 'study', label: 'Study English', kind: 'study', match: 'online course', target: '2026-09-20', targetLabel: 'English course' },
        // No `match`: there is no daily "training" task to tie this to, and
        // matching loosely on "para" would have latched onto "Sign up for
        // para 10" — ticking a session would have closed the sign-up.
        { id: 'gym', label: 'Para 10 training', kind: 'gym', match: '', target: '2026-09-26', targetLabel: 'Para 10' },
        /* The other end of the day. `when` is what separates the two cards;
           `note` is the reason, which for this one is the whole point --
           "phone down" on its own reads as nagging, and the sentence after it
           is what makes it an argument. */
        {
          id: 'winddown',
          label: 'Phone down, book instead',
          kind: 'winddown',
          when: 'evening',
          match: '',
          note: 'The screen keeps you up. Read something on paper for the last half hour.',
        },
      ],
      routineVersion: ROUTINE_VERSION,
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
    repairIds(merged);
    purgeTombstones(merged);
    migrateRoutine(merged, data);
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
    // Nulled, not just cleared. adoptStored() below asks "is a write of mine
    // still pending?" and a cleared-but-not-nulled timer id stays truthy for
    // the life of the tab, so after the first save ever the answer would have
    // been yes for ever.
    this._saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      this._saveFailed = false;
    } catch (err) {
      /*
       * A failed save was a console line and nothing else.
       *
       * That is the worst shape a failure can have: everything keeps working,
       * the app stays exactly as responsive, and nothing written from that
       * point on survives a reload. Whoever is using it finds out the next
       * morning. It has to reach the screen.
       *
       * Announced ONCE per run of failures, not per save — saves are debounced
       * to every 250ms while typing, and a toast per keystroke would bury the
       * message it is trying to deliver.
       */
      console.error('Could not save. Storage may be full.', err);
      if (!this._saveFailed) {
        this._saveFailed = true;
        document.dispatchEvent(new CustomEvent('organizer:save-failed', {
          detail: { message: String(err?.name || err) },
        }));
      }
    }
  }

  /**
   * Take on what another tab has just written to storage.
   *
   * Catch and the organizer share one document, so each has to notice when
   * the other saves. Catch answered that with `location.reload()`, which is
   * true to the data and brutal to the person: the organizer writes on every
   * sync poll and every time it meets an event title it has not coloured yet,
   * so a phone with both open reloaded the note app under your thumb, again
   * and again, losing the half-sentence in the box each time. Re-reading the
   * document and redrawing gets the same state without the page going away.
   *
   * If one of our own writes is still sitting in the 250ms debounce, that
   * write wins and we adopt nothing: a line just caught here has not reached
   * storage yet, and adopting a snapshot taken before it existed would delete
   * it. Better to be a moment behind the other tab than to swallow the thing
   * that was just said.
   */
  adoptStored() {
    if (this._saveTimer) { this.saveNow(); return false; }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      this.state = this._migrate(JSON.parse(raw));
      this.dirty = false;
      this.emit({ label: 'storage' });
      return true;
    } catch (err) {
      console.error('Could not read the other tab’s save.', err);
      return false;
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
      this._trimUndo();
      this._redo.length = 0;
    }
    const result = fn(this.state);
    this.state.updatedAt = nowISO();
    this.dirty = true;
    this.save();
    if (!silent) this.emit({ label });
    return result;
  }

  /** What the undo history is currently costing. */
  undoBytes() {
    let bytes = 0;
    for (const entry of this._undo) bytes += entry.snapshot.length;
    return bytes;
  }

  /** Drop the oldest steps until the stack fits its budget. */
  _trimUndo() {
    while (this._undo.length > UNDO_LIMIT) this._undo.shift();
    while (this._undo.length > UNDO_MIN && this.undoBytes() > UNDO_BUDGET_BYTES) {
      this._undo.shift();
    }
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  undo() {
    const entry = this._undo.pop();
    if (!entry) return null;
    this._redo.push({ snapshot: JSON.stringify(this.state), label: entry.label });
    // Redo is the same snapshots pointing the other way, so it needs the same
    // ceiling; without one, undoing forty times rebuilt the stack we just
    // spent the trouble bounding.
    while (this._redo.length > UNDO_LIMIT) this._redo.shift();
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

/**
 * Drop keys whose value is undefined.
 *
 * Spreading `fields` over the defaults below looks like "the caller wins where
 * it said something", but object spread copies a key even when its value is
 * undefined — so saying nothing and saying `undefined` were the same thing,
 * and both wiped the default.
 *
 * That was not theoretical. Two callers pass undefined ON PURPOSE, meaning
 * "you decide": sendCaptureToOrganizer passes `listId: listId || undefined`,
 * which put every line sent from Catch into no list at all; and toggleDone
 * spawns the next occurrence of a repeating task with `id: undefined` to ask
 * for a fresh one — and got an item with NO id, which cannot be edited,
 * deleted, merged or synced, because every one of those looks it up by id.
 * Tick off a daily task and its replacement was born broken.
 */
function stated(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

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
    // Timestamped notes added as you go: dictated, typed, or pasted in from
    // somewhere else. Append-only, and every entry carries its own id and
    // time. That shape is doing two jobs — it lets a review ask "what did I
    // say about this during the last block", and it lets two devices merge
    // their notes rather than one silently overwriting the other's.
    log: [],
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
    ...stated(fields),
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
      if (!isSlippedTask(item, today)) continue;
      // A repeating entry and one occurrence of a Google series are both real
      // calendar records that are meant to stay where they are.
      if (item.recur || item.seriesId) continue;

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

/* ------------------------------------------------------------------ */
/* Shifts                                                              */
/* ------------------------------------------------------------------ */

export const SHIFT = {
  NIGHT: 'night', DAY: 'day', ONCALL: 'oncall', TRAINING: 'training', OFF: 'off',
  // Clearly a rota entry, but not in a code this knows yet. Coloured neutrally
  // and labelled "on shift" rather than dropped: a working day rendered as a
  // blank cell is a silent wrong answer, whereas an unnamed one is visible and
  // tells you a code needs adding.
  OTHER: 'other',
};

/**
 * Highest first. A day carrying more than one shift entry — the tail of a run
 * and the head of the next — takes the more disruptive of the two, because
 * that is the one that decides what the day is actually like.
 */
const SHIFT_PRIORITY = [
  SHIFT.NIGHT, SHIFT.DAY, SHIFT.TRAINING, SHIFT.ONCALL, SHIFT.OTHER, SHIFT.OFF,
];

/**
 * Does this title belong to someone else?
 *
 * A shared calendar carries other people's rotas. "Sheila: 11-7 night shift
 * (PH)" is a Philippine night shift belonging to somebody else, and colouring
 * a day dark because of it would be worse than not colouring it at all — it
 * would be confidently wrong about which nights you are working.
 *
 * A leading "Word:" is treated as someone else's unless it is your own name,
 * which Settings can set. Titles with no prefix are assumed to be yours.
 */
export function entryOwner(title) {
  const match = /^\s*([\p{Lu}][\p{L}'’-]*)\s*:/u.exec(String(title || ''));
  return match ? match[1] : null;
}

function isMine(title) {
  const owner = entryOwner(title);
  if (!owner) return true;
  const mine = String(settings().myName || '').trim();
  return Boolean(mine) && owner.toLowerCase() === mine.toLowerCase();
}

/**
 * Only claim things that actually look like rota entries.
 *
 * ANCHORED to the start of the title, which is the whole trick. Matching the
 * words anywhere caught "book the car in on my day off" and then, once
 * training days were added, "sort out leave/training day requirements" — a
 * task ABOUT a training day, painted as one. A rota entry leads with what it
 * is; a task that merely mentions a shift does not.
 */
const SHIFT_SHAPED = new RegExp(
  '^\\s*(?:'
  + 'day\\s*shift|night\\s*shift|late\\s*shift|early\\s*shift'   // "Day Shift (D)"
  + '|training\\s*day|on[-\\s]?call'                             // "Training Day (TD)"
  + '|\\(?(?:n|d|e|l|oc|td|ld|ln)\\)'                            // a bare code
  + '|nights?|days?|off|rest(?:\\s*day)?'                        // the word alone
  + ')\\b\\s*(?:\\(|$|[-–:,]|\\s)',
  'i',
);

/** Which kind of shift an item is, or null if it is not one (or not yours). */
export function shiftKindOf(item) {
  const title = String(item?.title || '');
  if (!title || !isMine(title)) return null;
  if (!SHIFT_SHAPED.test(title)) return null;

  const t = title.toLowerCase();

  // "Alternative Training Day" is the white T on the roster: a day you are NOT
  // working, listed only so the pattern reads. It contains the word "training"
  // and was being coloured as a training day you had to turn up for, which is
  // the worst kind of wrong — it invents a shift.
  if (/\balternative\b/.test(t)) return null;

  if (/on[-\s]?call|\(oc\)/.test(t)) return SHIFT.ONCALL;
  // Before the day test, and not optional: "Training Day (TD)" contains the
  // word "Day", so checking days first would file every training day as a
  // normal one — and they are worked differently.
  if (/\btraining\b|\(td\)/.test(t)) return SHIFT.TRAINING;
  if (/\bnights?\b|\(n\)|\(ln\)/.test(t)) return SHIFT.NIGHT;
  if (/\bdays?\b|\(d\)|\(ld\)/.test(t)) return SHIFT.DAY;
  if (/\boff\b|\brest\b/.test(t)) return SHIFT.OFF;
  // Earlies and lates are neither, and folding them into "days" would be a
  // guess presented as a fact. They stay OTHER until the roster says.
  return SHIFT.OTHER;
}

/**
 * The shift across a set of items already in hand.
 *
 * Separate from shiftOnDay so a caller that has just fetched a day's items —
 * which every month cell has — does not fetch them again. Rendering a month
 * was scanning and sorting the whole item list three times per cell, 126 times
 * over a six-week grid, purely to re-derive what the cell already held.
 */
export function shiftFor(items) {
  const kinds = new Set();
  for (const item of items) {
    const kind = shiftKindOf(item);
    if (kind) kinds.add(kind);
  }
  return SHIFT_PRIORITY.find((k) => kinds.has(k)) || null;
}

/** The shift for a whole day, across everything covering it. */
export function shiftOnDay(dateKey) {
  return shiftFor(itemsOnDay(dateKey));
}

/**
 * Who you were on with.
 *
 * Read from the entry's own notes, because that is the one place the
 * information can live before a roster is loaded — Google Calendar carries a
 * description and nothing else useful. Accepts the forms people actually
 * write: "With: Smith, Jones", "Crew - Smith/Jones", "Team: Smith & Jones".
 */
export function crewFor(item) {
  const notes = String(item?.notes || '');
  const line = /^[ \t]*(?:with|crew|team|on with)[ \t]*[:\-–][ \t]*(.+)$/im.exec(notes);
  if (!line) return [];
  return line[1]
    .split(/[,/&]|\band\b|\+/i)
    .map((name) => name.trim().replace(RANK, '').trim())
    .filter(Boolean);
}

/**
 * Ranks are stripped so a cell shows surnames.
 *
 * Google holds "Sgt Smith, Cpl Brown, LCpl Jewitt, Pte Thuku" while the roster
 * sheet says "Smith, Brown, Jewitt, Thuku". Four ranks cost about a third of
 * the width of a month cell and tell you nothing you do not already know about
 * the people you work every shift with.
 */
const RANK = /^(?:sgt|ssgt|cpl|lcpl|pte|cfn|spr|tpr|gnr|wo[12]?|ssm|csm|rsm|2lt|lt|capt|maj|lt\s?col|col)\.?\s+/i;

/** Everyone named across a day's shift entries, de-duplicated, order kept. */
export function crewOnDay(dateKey) {
  return crewFrom(itemsOnDay(dateKey));
}

/** As crewOnDay, for items the caller already has. */
export function crewFrom(items) {
  const seen = new Map();
  for (const item of items) {
    if (!shiftKindOf(item)) continue;
    for (const name of crewFor(item)) {
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
  }
  return [...seen.values()];
}

/**
 * How many live items share a title's colour key.
 *
 * The event palette hands a hue to every distinct title, which is exactly
 * right on a calendar — seeing the same colour on four cells is how a block
 * of nights reads as one thing — and close to meaningless in a list, where
 * "Book MOT" gets a hue it will never share with anything.
 *
 * So the question a list should ask is not "is this an event" (imported
 * shifts arrive as tasks, which is why gating on kind failed) but "does this
 * title come round again". A colour that repeats is doing work; a colour that
 * appears once is decoration.
 *
 * Memoised against the document's own updatedAt, because the alternative is a
 * full scan per row and lists are the longest thing this app draws.
 */
let titleCounts = { stamp: null, map: null };
export function titleCount(title) {
  const stamp = store.state.updatedAt;
  if (titleCounts.stamp !== stamp) {
    const map = new Map();
    for (const item of liveItems()) {
      const key = colorKeyFor(item.title);
      if (key) map.set(key, (map.get(key) || 0) + 1);
    }
    titleCounts = { stamp, map };
  }
  const key = colorKeyFor(title);
  return key ? (titleCounts.map.get(key) || 0) : 0;
}

/** Incomplete, dated before today — the stuff quietly rotting. */
/**
 * Is this a job that has slipped, or just a day that has been?
 *
 * A rota entry is something you were INSIDE of, not something you complete.
 * A worked shift is not an outstanding task and must never be treated as one.
 *
 * This matters more than it looks. inferKind() files a single all-day Google
 * entry as a TASK -- which is what keeps a recurring "Wedding Planning"
 * reminder tickable, and is also exactly the shape of one day of a rota. So
 * an imported "Day Shift" arrives as an undone, dated task, and without this
 * guard it would: appear in the Overdue list; be sent to Claude as something
 * to catch up on, asking for a plan to re-work a shift already worked; be
 * moved to today by the rollover; and then, the day after, be stripped of its
 * date entirely -- with every one of those changes written back to the real
 * calendar it came from.
 *
 * Five other places in this file already exclude shift-shaped items. These
 * two did not.
 */
export function isSlippedTask(item, today = todayKey()) {
  if (!item || item.deleted || item.done) return false;
  if (item.kind !== 'task') return false;
  if (!item.date || item.date >= today) return false;
  return !shiftKindOf(item);
}

export function overdueTasks() {
  const today = todayKey();
  return liveItems()
    .filter((i) => isSlippedTask(i, today))
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
 *
 * `live` marks a save made WHILE the box is still being typed in, and changes
 * two things that both mattered:
 *
 *   - It labels the change 'journal-live', which the app's render subscriber
 *     ignores. A normal save redraws the whole app, which tore down the
 *     textarea under the caret every 700ms — see the note in journalEditor.
 *   - It keeps the change off the undo stack. Every undoable mutation
 *     JSON.stringifies the ENTIRE state, so writing a long entry pushed a full
 *     snapshot of every item every time you paused for breath. On a phone with
 *     a year of rota on it that is a stall you can feel, for undo steps nobody
 *     wants — undo should step over the whole entry, not each pause in it.
 *
 * The final save on blur is not live, so the app catches up once, at the point
 * where a redraw costs nothing.
 */
export function setJournal(dateKey, text, { live = false } = {}) {
  const clean = String(text ?? '').trim();
  return store.mutate((s) => {
    if (!s.journal) s.journal = {};
    if (clean) s.journal[dateKey] = { text: clean, updatedAt: nowISO() };
    else delete s.journal[dateKey];
  }, { label: live ? 'journal-live' : 'journal', undoable: !live });
}

/** The written-up summary for a day, or null. */
export function journalSummaryFor(dateKey) {
  const entry = store.state.journalSummary?.[dateKey];
  return entry && entry.text ? entry : null;
}

/** Save, replace, or (with empty text) clear a day's summary. */
export function setJournalSummary(dateKey, text) {
  const clean = String(text ?? '').trim();
  return store.mutate((s) => {
    if (!s.journalSummary) s.journalSummary = {};
    if (clean) s.journalSummary[dateKey] = { text: clean, updatedAt: nowISO() };
    else delete s.journalSummary[dateKey];
  }, { label: 'journal-summary' });
}

/**
 * What actually happened on a day, gathered from what the app already knows.
 *
 * This is the whole input to the summary, and it is assembled by rules for the
 * same reason the morning brief is: a diary that quietly invents a shift you
 * did not work, or a job you did not finish, is worse than an empty one — you
 * would find out months later, with no way to tell which entries were real.
 */
export function dayMaterial(dateKey) {
  const shift = shiftOnDay(dateKey);
  const crew = crewOnDay(dateKey);

  const done = liveItems()
    .filter((i) => i.done && i.doneAt && toKey(new Date(i.doneAt)) === dateKey && !shiftKindOf(i))
    .map((i) => ({ title: i.title || 'Untitled', time: i.time || null }));

  const notes = [];
  for (const item of liveItems()) {
    for (const note of itemLog(item)) {
      if (toKey(new Date(note.at)) !== dateKey) continue;
      notes.push({ text: note.text, itemTitle: item.title || 'Untitled' });
    }
  }

  const routine = routineSteps()
    .filter((step) => routineStepDone(step, dateKey))
    .map((step) => step.label);

  // Dated for this day, still not done, and the day is behind us.
  const missed = liveItems()
    .filter((i) => i.kind === 'task' && !i.done && i.date === dateKey
      && dateKey < todayKey() && !shiftKindOf(i))
    .map((i) => i.title || 'Untitled');

  return {
    dateKey, shift, crew, done, notes, routine, missed,
    written: journalFor(dateKey)?.text || '',
  };
}

/** Is there anything at all to write up? */
export function hasDayMaterial(m) {
  return Boolean(m && (m.shift || m.done.length || m.notes.length
    || m.routine.length || m.missed.length || m.written));
}

/** Every written day, newest first. */
/**
 * Is there a diary entry for this day?
 *
 * Whitespace does not count. setJournal writes an empty string when an entry
 * is cleared rather than deleting the key, so testing for the key would mark
 * every day he had ever opened and thought better of.
 */
export function hasJournal(dateKey) {
  return Boolean(store.state.journal?.[dateKey]?.text?.trim());
}

export function journalEntries() {
  const journal = store.state.journal || {};
  return Object.entries(journal)
    .filter(([, e]) => e && e.text)
    .map(([date, e]) => ({ date, ...e }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/* ------------------------------------------------------------------ */
/* Captures — the note app's pile                                      */
/* ------------------------------------------------------------------ */

/** Where a capture ended up. `open` means nobody has triaged it yet. */
export const CAPTURE = { OPEN: 'open', NOW: 'now', LATER: 'later', NOTE: 'note' };

/** Every live capture, oldest first. */
export function captures() {
  const all = Array.isArray(store.state.captures) ? store.state.captures : [];
  return all.filter((c) => c && !c.deleted);
}

/** Just the ones still waiting to be sorted. */
export function openCaptures() {
  return captures().filter((c) => (c.kind || CAPTURE.OPEN) === CAPTURE.OPEN);
}

export function addCapture(text, source = NOTE_SOURCE.VOICE) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  let entry = null;
  store.mutate((s) => {
    if (!Array.isArray(s.captures)) s.captures = [];
    entry = { id: uid(), at: nowISO(), text: clean, source, kind: CAPTURE.OPEN, itemId: null };
    s.captures.push(entry);
  }, { label: 'capture' });
  return entry;
}

export function setCaptureKind(id, kind) {
  return store.mutate((s) => {
    const c = (s.captures || []).find((x) => x.id === id);
    if (c) { c.kind = kind; c.updatedAt = nowISO(); }
  }, { label: 'capture' });
}

/** Tombstoned, not spliced — see removeNote() for why. */
export function removeCapture(id) {
  return store.mutate((s) => {
    const c = (s.captures || []).find((x) => x.id === id);
    if (!c) return;
    c.deleted = true;
    c.text = '';
    c.updatedAt = nowISO();
  }, { label: 'capture' });
}

/**
 * Turn a capture into a real task in the organizer.
 *
 * This is the whole point of the two apps sharing an origin: it is a local
 * write, so it is instant, works with no signal, and cannot half-succeed. The
 * organizer's own sync carries it to Google afterwards, with all the retry and
 * merge behaviour that already exists.
 *
 * The capture is kept and marked rather than consumed, so the pile stays an
 * honest record of what was said and you can see what became of each line.
 */
export function sendCaptureToOrganizer(id, { date = null, listId = null, title = null } = {}) {
  const capture = captures().find((c) => c.id === id);
  if (!capture) return null;
  const chosen = String(title || '').trim() || capture.text;
  const item = addItem({
    kind: 'task',
    title: chosen,
    date,
    listId: listId || undefined,
    // When the wording was changed, the original goes in the notes. In a
    // month's time "did I mean that?" has an answer, and a rewording can never
    // quietly become the only record of what was said.
    notes: chosen === capture.text
      ? `Caught on ${capture.at.slice(0, 10)}.`
      : `Caught on ${capture.at.slice(0, 10)}. You said: "${capture.text}"`,
  });
  store.mutate((s) => {
    const c = (s.captures || []).find((x) => x.id === id);
    if (c) { c.kind = CAPTURE.LATER; c.itemId = item.id; c.updatedAt = nowISO(); }
  }, { label: 'capture' });
  return item;
}

/* ------------------------------------------------------------------ */
/* Notes on an item                                                    */
/* ------------------------------------------------------------------ */

/** Where a note came from. Kept so a review can say so, and for the icon. */
export const NOTE_SOURCE = { VOICE: 'voice', TYPED: 'typed', PASTE: 'paste' };

/** An item's live notes, oldest first, tolerating items saved before this existed. */
export function itemLog(item) {
  if (!Array.isArray(item?.log)) return [];
  return item.log.filter((n) => n && !n.deleted);
}

/**
 * Add a note to an item.
 *
 * Append-only by design. Dictation in particular arrives in bursts — you talk
 * about something, stop, then remember one more thing — and a second burst
 * that replaced the first would be worse than not recording it at all.
 */
export function addNote(itemId, text, source = NOTE_SOURCE.TYPED) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  let entry = null;
  store.mutate((s) => {
    const item = s.items.find((i) => i.id === itemId);
    if (!item) return;
    if (!Array.isArray(item.log)) item.log = [];
    entry = { id: uid(), at: nowISO(), text: clean, source };
    item.log.push(entry);
    item.updatedAt = nowISO();
  }, { label: 'note' });
  return entry;
}

/**
 * Bury a note.
 *
 * Tombstoned rather than spliced out, for the same reason items are: the sync
 * unions notes from both devices so neither loses one, and a hard delete would
 * be undone by the first device that still had a copy — forever, on every
 * sync. A marker travels; an absence does not.
 */
export function removeNote(itemId, noteId) {
  return store.mutate((s) => {
    const item = s.items.find((i) => i.id === itemId);
    if (!item || !Array.isArray(item.log)) return;
    const note = item.log.find((n) => n.id === noteId);
    if (!note) return;
    note.deleted = true;
    note.text = '';
    item.updatedAt = nowISO();
  }, { label: 'note' });
}

/* ------------------------------------------------------------------ */
/* Shift blocks and the review                                         */
/* ------------------------------------------------------------------ */

/** An explicit day off is not a worked day, and neither is no entry at all. */
function worked(dateKey) {
  const kind = shiftOnDay(dateKey);
  return kind && kind !== SHIFT.OFF ? kind : null;
}

/**
 * The most recent run of worked days, and whether it is finished.
 *
 * A week is the wrong unit for looking back at this rota. Four days then four
 * nights does not divide into sevens, so a Sunday review lands three days into
 * a run of nights — half a block behind you, half still to come, and the part
 * you most want to think about split across two reviews.
 *
 * The natural boundary is the end of a block: the last day you worked before
 * the shift changed or ran out. Walks back at most a fortnight, so a gap in
 * the rota ends the search rather than scanning the whole history.
 */
export function shiftBlock(dateKey = todayKey()) {
  let end = null;
  for (let i = 0; i <= 14; i += 1) {
    const key = addDays(dateKey, -i);
    if (worked(key)) { end = key; break; }
  }
  if (!end) return null;

  const kind = worked(end);
  let start = end;
  for (let i = 1; i <= 14; i += 1) {
    const key = addDays(end, -i);
    if (worked(key) !== kind) break;
    start = key;
  }
  /*
   * `gatherTo` is where to stop COLLECTING, which is not always where the
   * block stops.
   *
   * A night runs 18:30 to 06:30, so the last shift of a run of nights finishes
   * on the morning AFTER its own date. Notes are stamped with the wall-clock
   * day they were made on, and the small hours are exactly when there is time
   * to dictate one — so on a night block everything said after midnight fell
   * outside the range and the review quietly did not include it. Half of Ben's
   * rota is nights, so this was half the notes.
   *
   * A day shift ends the same day it starts, so nothing is added there.
   */
  const gatherTo = kind === SHIFT.NIGHT ? addDays(end, 1) : end;

  // Finished if today is not itself part of it — either you are off, or the
  // shift has changed under you and a new block has started.
  return { start, end, gatherTo, kind, ended: end !== dateKey };
}

/**
 * Is there a block worth sitting down with?
 *
 * Deliberately quiet: it only asks once per block, and only once the block is
 * actually over. Being prompted to reflect on a run of nights while you are
 * still three shifts into it is how a prompt gets ignored permanently.
 */
export function reviewDue(dateKey = todayKey()) {
  const block = shiftBlock(dateKey);
  if (!block?.ended) return false;
  return String(settings().lastReviewOn || '') < block.end;
}

export function markReviewed(dateKey = todayKey()) {
  return updateSettings({ lastReviewOn: dateKey });
}

/**
 * Everything written between two days, gathered for reading back.
 *
 * Notes carry an ISO instant while the rest of the app works in local
 * wall-clock days, so they are bucketed through toKey() rather than compared
 * as strings — otherwise a note written at 23:00 on a night shift lands on the
 * wrong side of a boundary, which is precisely the note you wanted.
 */
export function reflectionMaterial(fromKey, untilKey) {
  const inRange = (key) => key >= fromKey && key <= untilKey;

  const notes = [];
  for (const item of liveItems()) {
    for (const note of itemLog(item)) {
      const day = toKey(new Date(note.at));
      if (!inRange(day)) continue;
      notes.push({ ...note, day, itemId: item.id, itemTitle: item.title || 'Untitled' });
    }
  }
  notes.sort((a, b) => (a.at < b.at ? -1 : 1));

  const journal = journalEntries().filter((e) => inRange(e.date)).reverse();

  const done = liveItems()
    .filter((i) => i.done && i.doneAt && inRange(toKey(new Date(i.doneAt))))
    .map((i) => ({ id: i.id, title: i.title || 'Untitled', day: toKey(new Date(i.doneAt)) }));

  // Still open and already past its date. This is the half of a review that is
  // uncomfortable and therefore the half worth showing.
  //
  // TASKS only. An event is not a thing that can slip — it happened, or it did
  // not, and either way there is nothing to tick, so `done` is false forever.
  // Without the kind check every appointment Ben had ever been to came back
  // under "still not done", and went to Claude under a heading saying so —
  // which is a recipe for being told to rebook a dentist he already saw.
  const slipped = liveItems()
    .filter((i) => i.kind === 'task' && !i.done && i.date
      && i.date >= fromKey && i.date <= untilKey
      && i.date < todayKey() && !shiftKindOf(i))
    .map((i) => ({ id: i.id, title: i.title || 'Untitled', day: i.date }));

  return { from: fromKey, to: untilKey, notes, journal, done, slipped };
}

/* ------------------------------------------------------------------ */
/* Morning routine                                                     */
/* ------------------------------------------------------------------ */

/** The ritual, in the order it must be done. */
/**
 * Set (or clear) what a ritual step is counting down to.
 *
 * Writes through settings like every other routine field, so it syncs with
 * the rest of the document. An empty date clears the countdown outright —
 * including the name, because a name with nothing to count to would sit in
 * the settings panel looking like it was still doing something.
 */
export function setRoutineTarget(stepId, { target, targetLabel } = {}) {
  const steps = routineSteps().map((step) => {
    if (step.id !== stepId) return step;
    const next = { ...step };
    if (target !== undefined) next.target = target || '';
    if (targetLabel !== undefined) next.targetLabel = targetLabel || '';
    if (!next.target) { next.target = ''; next.targetLabel = ''; }
    return next;
  });
  updateSettings({ routineSteps: steps });
  return steps;
}

/**
 * Reword a step.
 *
 * Separate from setRoutineTarget because they are different edits with
 * different rules: a countdown clears its own label when the date goes, and a
 * label must never clear itself -- a step with no words is a row you cannot
 * identify and cannot fix. An empty label is therefore ignored rather than
 * written, and the note is free to be emptied because a step without a reason
 * is still a step.
 */
export function setRoutineText(stepId, { label, note } = {}) {
  const steps = routineSteps().map((step) => {
    if (step.id !== stepId) return step;
    const next = { ...step };
    const trimmed = String(label ?? '').trim();
    if (label !== undefined && trimmed) next.label = trimmed;
    if (note !== undefined) next.note = String(note).trim();
    return next;
  });
  updateSettings({ routineSteps: steps });
  return steps;
}

/**
 * When a step belongs. A step with no `when` is a morning one.
 *
 * Defaulted rather than required, because every step saved before this
 * existed is a morning step and a migration that rewrote them all would touch
 * labels Ben has edited by hand for no reason.
 */
export const PHASE = { MORNING: 'morning', EVENING: 'evening' };

export function stepPhase(step) {
  return step?.when === PHASE.EVENING ? PHASE.EVENING : PHASE.MORNING;
}

/** The ritual, all of it or one phase of it. */
export function routineSteps(when = null) {
  const steps = settings().routineSteps;
  const live = Array.isArray(steps) ? steps.filter((s) => s && s.id) : [];
  return when ? live.filter((s) => stepPhase(s) === when) : live;
}

/**
 * The real task a step stands for, if there is one today.
 *
 * Without this the card would be a second place to tick "study English" while
 * the actual course task sat untouched a few inches below it — two records of
 * one thing, guaranteed to disagree. Matching by title fragment keeps the
 * routine a VIEW of the day rather than a parallel copy of it.
 *
 * Only undone tasks are matched first so that on a day with both a finished
 * and an unfinished match, ticking the step closes the one still outstanding.
 */
export function linkedTask(step, dateKey) {
  const needle = String(step?.match || '').trim().toLowerCase();
  if (!needle) return null;
  const onDay = itemsOnDay(dateKey).filter(
    (i) => i.kind === 'task' && String(i.title || '').toLowerCase().includes(needle),
  );
  return onDay.find((i) => !i.done) || onDay[0] || null;
}

/** Step ids ticked on a day that have no task of their own to stand in for. */
function loggedSteps(dateKey) {
  return new Set(store.state.routine?.[dateKey]?.steps || []);
}

/** Is this step done today — by its linked task, or by its own tick? */
export function routineStepDone(step, dateKey) {
  const task = linkedTask(step, dateKey);
  if (task) return Boolean(task.done);
  return loggedSteps(dateKey).has(step.id);
}

/**
 * Tick or untick a step.
 *
 * A step backed by a real task defers to it entirely, so the two can never
 * drift apart; only a step with nothing behind it is recorded here.
 */
export function toggleRoutineStep(step, dateKey) {
  const task = linkedTask(step, dateKey);
  if (task) return toggleDone(task.id);

  return store.mutate((s) => {
    if (!s.routine) s.routine = {};
    const current = new Set(s.routine[dateKey]?.steps || []);
    if (current.has(step.id)) current.delete(step.id);
    else current.add(step.id);

    if (current.size) s.routine[dateKey] = { steps: [...current], updatedAt: nowISO() };
    else delete s.routine[dateKey];
  }, { label: 'routine' });
}

/** How much of the ritual is behind you. */
export function routineProgress(dateKey, when = null) {
  const steps = routineSteps(when);
  const done = steps.filter((s) => routineStepDone(s, dateKey)).length;
  return { done, total: steps.length };
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

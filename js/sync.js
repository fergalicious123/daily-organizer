/* Two-way sync: local <-> Google Drive (task data) and Google Calendar (events).
 *
 * The model:
 *   Drive holds the whole document (tasks, lists, settings). It is the store
 *   of record for anything Calendar cannot represent — subtasks, priority,
 *   list membership, completion history.
 *   Calendar holds anything with a date, so it shows up on the phone and can
 *   fire native reminders. Each synced item remembers its gcalId.
 *
 * Conflict rule: last-write-wins per item on `updatedAt`, with tombstones so a
 * delete on one device is not resurrected by the next pull from another.
 *
 * Everything here is defensive: a phone on a bad connection is the normal
 * case, not the exception. Failed writes queue and retry rather than surface
 * as data loss.
 */

import { google, itemToEvent, eventToItem, isOurEvent } from './google.js';
import { store, settings, updateSettings } from './state.js';
import { todayKey, addDays } from './dates.js';

const SYNC_WINDOW_BACK = 60;    // days of history to reconcile
const SYNC_WINDOW_FWD = 180;
const QUEUE_KEY = 'daily-organizer:queue:v1';
/** Give up on a queued write after this many failures rather than retrying forever. */
const MAX_QUEUE_ATTEMPTS = 3;

export const SyncState = {
  IDLE: 'idle',
  SYNCING: 'syncing',
  OK: 'ok',
  ERROR: 'error',
  OFFLINE: 'offline',
};

class SyncEngine extends EventTarget {
  constructor() {
    super();
    this.state = SyncState.IDLE;
    this.message = 'Not connected';
    this.lastError = null;
    this.running = false;
    this.timer = null;
    this.queue = loadQueue();
  }

  setState(state, message) {
    this.state = state;
    this.message = message;
    this.dispatchEvent(new CustomEvent('change', { detail: { state, message } }));
  }

  get isConnected() {
    return settings().googleEnabled && google.isSignedIn;
  }

  /* ---------------- connection ---------------- */

  async connect({ interactive = true } = {}) {
    const cfg = settings();
    if (!cfg.googleClientId) {
      throw new Error('Add your Google Client ID in Settings first. See SETUP-GOOGLE.md.');
    }
    this.setState(SyncState.SYNCING, 'Connecting…');
    try {
      await google.init(cfg.googleClientId);
      await google.requestToken({ interactive });
      updateSettings({ googleEnabled: true });
      this.setState(SyncState.OK, 'Connected');
      // Must start the scheduler here as well as in resume(). Without it a
      // fresh interactive connect syncs exactly once and then goes silent
      // forever — no timer, no focus listener — so nothing you create
      // afterwards is ever pushed.
      this.start();
      await this.syncNow();
      return true;
    } catch (err) {
      this.lastError = err;
      this.setState(SyncState.ERROR, err.message);
      throw err;
    }
  }

  /** Silent reconnect on load — no popup unless consent has lapsed. */
  async resume() {
    const cfg = settings();
    if (!cfg.googleEnabled || !cfg.googleClientId) return false;
    google.setPersistence(cfg.staySignedIn !== false);

    // A token restored from the last session is still good — use it and skip
    // the round trip entirely. This is what makes a reload seamless instead of
    // dropping you back to "Sign in to sync".
    if (google.isSignedIn) {
      this.setState(SyncState.OK, 'Connected');
      this.start();
      return true;
    }

    try {
      await google.init(cfg.googleClientId);
      await google.requestToken({ interactive: false });
      this.setState(SyncState.OK, 'Connected');
      this.start();
      return true;
    } catch {
      // Expected when consent lapsed; the user reconnects from the sidebar.
      this.setState(SyncState.IDLE, 'Sign in to sync');
      return false;
    }
  }

  disconnect() {
    google.signOut();
    updateSettings({ googleEnabled: false, driveFileId: '' });
    this.stop();
    this.setState(SyncState.IDLE, 'Not connected');
  }

  /* ---------------- scheduling ---------------- */

  start() {
    this.stop();
    // Poll on a timer, and opportunistically whenever the app regains focus:
    // coming back to the tab is the moment a stale view is most obvious.
    this.timer = setInterval(() => this.syncNow({ quiet: true }), 5 * 60 * 1000);
    this._onFocus = () => { if (!document.hidden) this.syncNow({ quiet: true }); };
    this._onOnline = () => this.syncNow({ quiet: true });
    document.addEventListener('visibilitychange', this._onFocus);
    window.addEventListener('online', this._onOnline);

    // Push local edits promptly. Waiting up to five minutes for a task you
    // just typed to reach your phone reads as "it didn't work" — and that is
    // exactly how the push path looked broken. Debounced so a burst of edits
    // is one sync, and ignoring sync-driven changes so it cannot feed itself.
    this._unsubscribe = store.subscribe((_state, detail) => {
      if (detail?.label === 'sync') return;
      clearTimeout(this._pushTimer);
      this._pushTimer = setTimeout(() => this.syncNow({ quiet: true }), 3000);
    });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this._pushTimer);
    if (this._onFocus) document.removeEventListener('visibilitychange', this._onFocus);
    if (this._onOnline) window.removeEventListener('online', this._onOnline);
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /* ---------------- the sync pass ---------------- */

  async syncNow({ quiet = false } = {}) {
    if (this.running) return;
    if (!this.isConnected) {
      if (!settings().googleEnabled) return;
      const resumed = await this.resume();
      if (!resumed) return;
    }
    if (!navigator.onLine) {
      this.setState(SyncState.OFFLINE, 'Offline — changes are queued');
      return;
    }

    this.running = true;
    if (!quiet) this.setState(SyncState.SYNCING, 'Syncing…');

    try {
      await this.flushQueue();
      await this.syncDrive();
      await this.syncCalendar();
      updateSettings({ lastSyncAt: new Date().toISOString() });
      // Never report a clean sync while writes are still outstanding — that is
      // what let an unsent op sit in the queue across a "successful" sync.
      this.setState(
        this.queue.length ? SyncState.ERROR : SyncState.OK,
        this.queue.length
          ? `Synced ${formatClock(new Date())} · ${this.queue.length} unsent`
          : `Synced ${formatClock(new Date())}`,
      );
      this.lastError = null;
    } catch (err) {
      this.lastError = err;
      this.setState(SyncState.ERROR, err.message || 'Sync failed');
      console.error('Sync failed', err);
    } finally {
      this.running = false;
    }
  }

  /* ---------------- Drive ---------------- */

  async syncDrive() {
    const cfg = settings();
    let fileId = cfg.driveFileId;

    // Locate (or create) the file once, then remember its id.
    if (!fileId) {
      const found = await google.findDataFile();
      if (found) {
        fileId = found.id;
      } else {
        const created = await google.createDataFile(exportDocument());
        fileId = created.id;
        updateSettings({ driveFileId: fileId });
        return;   // nothing remote to merge — we just wrote it
      }
      updateSettings({ driveFileId: fileId });
    }

    let remote = null;
    try {
      remote = await google.downloadFile(fileId);
    } catch (err) {
      // The file was deleted or unshared behind our back — start a new one.
      if (/404|not found/i.test(err.message)) {
        const created = await google.createDataFile(exportDocument());
        updateSettings({ driveFileId: created.id });
        return;
      }
      throw err;
    }

    const merged = mergeDocuments(store.state, remote);
    if (merged.changedLocal) {
      store.replaceState(merged.document);
    }
    // Push when we hold changes the remote lacks, or the merge produced
    // something newer than what is stored there.
    if (merged.changedRemote || store.dirty) {
      await google.updateDataFile(fileId, exportDocument());
      store.dirty = false;
    }
  }

  /* ---------------- Calendar ---------------- */

  async syncCalendar() {
    const cfg = settings();
    const calendarId = cfg.googleCalendarId || 'primary';

    // Read from EVERY selected calendar, not just the one we write to. Shifts,
    // work rotas and shared calendars normally live somewhere other than the
    // primary, and reading only one meant they simply never appeared — with
    // nothing to indicate anything was missing.
    const readIds = Array.isArray(cfg.syncCalendarIds) && cfg.syncCalendarIds.length
      ? [...new Set(cfg.syncCalendarIds)]
      : [calendarId];

    const from = addDays(todayKey(), -SYNC_WINDOW_BACK);
    const to = addDays(todayKey(), SYNC_WINDOW_FWD);
    const timeMin = new Date(`${from}T00:00:00`).toISOString();
    const timeMax = new Date(`${to}T23:59:59`).toISOString();

    const remoteEvents = [];
    for (const id of readIds) {
      try {
        const events = await google.listEvents(id, timeMin, timeMax);
        // Remember the source: an edit has to go back to the calendar the
        // event actually lives on, not to whichever one we write new items to.
        for (const e of events) remoteEvents.push({ ...e, _calendarId: id });
      } catch (err) {
        // One unreadable calendar (unshared, deleted) must not sink the pass.
        console.warn('Could not read calendar %s: %s', id, err.message);
      }
    }
    const byGcalId = new Map(remoteEvents.map((e) => [e.id, e]));

    /* --- pull: remote -> local --- */
    for (const event of remoteEvents) {
      const mapped = eventToItem(event);
      if (!mapped) continue;

      const local = store.state.items.find((i) => i.gcalId === event.id);

      if (event.status === 'cancelled') {
        // Remote deletion becomes a local tombstone.
        if (local && !local.deleted) {
          store.mutate((s) => {
            const item = s.items.find((i) => i.id === local.id);
            if (item) { item.deleted = true; item.updatedAt = new Date().toISOString(); }
          }, { undoable: false, silent: true });
        }
        continue;
      }

      if (!local) {
        // A genuinely new remote event. Import it so the calendar the user
        // already keeps shows up here without retyping.
        store.mutate((s) => {
          s.items.push({
            id: crypto.randomUUID(),
            kind: mapped.kind,
            title: mapped.title,
            notes: mapped.notes,
            listId: s.inboxListId,
            done: mapped.done,
            doneAt: mapped.doneAt,
            date: mapped.date,
            // Never carried across on import, so EVERY multi-day event from
            // Google has been stored as a single day since spanning bars
            // shipped. A four-day shift arrived, kept its start, lost its end,
            // and drew as one cell — which is exactly what it looked like.
            endDate: mapped.endDate ?? null,
            time: mapped.time,
            durationMin: mapped.durationMin,
            priority: 0,
            subtasks: [],
            recur: null,
            remindMin: mapped.remindMin,
            gcalId: event.id,
            gcalCalendarId: event._calendarId || calendarId,
            // Remember how Google phrased the timing, and in which zone, so a
            // later title edit does not rewrite it in ours.
            tz: mapped.tz,
            remoteTiming: mapped.remoteTiming,
            seriesId: mapped.seriesId,
            createdAt: event.created || new Date().toISOString(),
            updatedAt: mapped.updatedAt,
            deleted: false,
          });
        }, { undoable: false, silent: true });
      } else if (!local.deleted && newer(mapped.updatedAt, local.updatedAt)) {
        // Remote is fresher — take its fields, but never clobber the local-only
        // metadata Calendar cannot represent.
        store.mutate((s) => {
          const item = s.items.find((i) => i.id === local.id);
          if (!item) return;
          Object.assign(item, {
            title: mapped.title,
            date: mapped.date,
            // The last day a multi-day item covers. Absent from this list until
            // now, which meant a block imported as one day stayed one day for
            // ever: lengthening a shift from one day to four in Google updated
            // its title and start here and silently kept the old end, so four
            // day-shifts rendered as one. Explicitly nulled rather than left
            // alone when the remote has no end, or shortening a block would be
            // just as stuck.
            endDate: mapped.endDate ?? null,
            time: mapped.time,
            durationMin: mapped.durationMin ?? item.durationMin,
            done: mapped.done,
            doneAt: mapped.doneAt ?? item.doneAt,
            remindMin: mapped.remindMin,
            // Refresh the snapshot: this IS now what Google holds, so a later
            // local edit compares against the current remote timing.
            tz: mapped.tz,
            remoteTiming: mapped.remoteTiming,
            seriesId: mapped.seriesId,
            updatedAt: mapped.updatedAt,
          });
        }, { undoable: false, silent: true });
      }
    }

    /* --- push: local -> remote --- */
    const pushable = store.state.items.filter((i) => i.date);

    for (const item of pushable) {
      try {
        // An existing event is edited on ITS OWN calendar; only brand-new
        // items go to the default one. Patching a shift against the primary
        // calendar would 404 rather than move it.
        const targetCal = item.gcalCalendarId || calendarId;

        if (item.deleted) {
          if (item.gcalId && byGcalId.has(item.gcalId)) {
            await google.deleteEvent(targetCal, item.gcalId);
          }
          continue;
        }

        const body = buildPatch(item);

        if (!item.gcalId) {
          const created = await google.createEvent(calendarId, body);
          store.mutate((s) => {
            const target = s.items.find((i) => i.id === item.id);
            if (target) {
              target.gcalId = created.id;
              target.gcalCalendarId = calendarId;
            }
          }, { undoable: false, silent: true });
        } else {
          const remote = byGcalId.get(item.gcalId);
          // Only push when we are the fresher side; otherwise the pull above
          // already won and pushing would undo it.
          if (!remote || newer(item.updatedAt, remote.updated)) {
            await google.updateEvent(targetCal, item.gcalId, body);
          }
        }
      } catch (err) {
        // One bad item must not abort the whole pass. Queue and move on.
        this.enqueue({ type: 'push-item', itemId: item.id });
        console.warn('Could not sync item', item.title, err.message);
      }
    }

    store.emit({ label: 'sync' });
  }

  /* ---------------- offline queue ---------------- */

  enqueue(op) {
    // Collapse duplicates: the queue records intent, not history.
    if (!this.queue.some((q) => q.type === op.type && q.itemId === op.itemId)) {
      this.queue.push({ ...op, at: Date.now() });
      saveQueue(this.queue);
    }
  }

  /**
   * Drain queued writes.
   *
   * The first version had three faults that compounded into "sync says OK
   * while a write sits unsent forever":
   *   - it stopped at the first failure, so one permanently-unwritable item
   *     (a read-only calendar, a since-deleted event) blocked every other
   *     queued write behind it, indefinitely;
   *   - it swallowed the error entirely, so syncNow carried on and reported a
   *     clean "Synced HH:MM" with work still outstanding;
   *   - it retried forever, with nothing to break the loop.
   *
   * Now: every op is attempted, failures are counted and given up on, and
   * the outcome is reported rather than hidden.
   */
  async flushQueue() {
    if (!this.queue.length) return;
    const pending = [...this.queue];
    this.queue = [];
    saveQueue(this.queue);

    const calendarId = settings().googleCalendarId || 'primary';
    const retry = [];
    const abandoned = [];

    for (const op of pending) {
      try {
        if (op.type !== 'push-item') continue;
        const item = store.state.items.find((i) => i.id === op.itemId);
        if (!item || !item.date) continue;      // gone: nothing to send
        const body = buildPatch(item);
        const targetCal = item.gcalCalendarId || calendarId;
        if (item.deleted && item.gcalId) {
          await google.deleteEvent(targetCal, item.gcalId);
        } else if (item.gcalId) {
          await google.updateEvent(targetCal, item.gcalId, body);
        } else {
          const created = await google.createEvent(calendarId, body);
          store.mutate((s) => {
            const target = s.items.find((i) => i.id === item.id);
            if (target) target.gcalId = created.id;
          }, { undoable: false, silent: true });
        }
      } catch (err) {
        // Carry on with the rest — do not let one bad op hold up the queue.
        const attempts = (op.attempts || 0) + 1;
        const next = { ...op, attempts, lastError: err.message };
        if (attempts >= MAX_QUEUE_ATTEMPTS) abandoned.push(next);
        else retry.push(next);
      }
    }

    this.queue = retry;
    saveQueue(this.queue);

    if (abandoned.length) {
      // Say so out loud. A write that will never land is not a detail to bury.
      const titles = abandoned
        .map((op) => store.state.items.find((i) => i.id === op.itemId)?.title)
        .filter(Boolean);
      this.dispatchEvent(new CustomEvent('abandoned', { detail: { ops: abandoned, titles } }));
      console.warn('Gave up sending after %d attempts: %s (%s)',
        MAX_QUEUE_ATTEMPTS, titles.join(', ') || 'unknown item', abandoned[0].lastError);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

/** The subset of state that travels to Drive. Tokens never do. */
function exportDocument() {
  const { settings: cfg, ...rest } = store.state;
  return {
    ...rest,
    settings: {
      // Device-specific values stay device-specific.
      theme: cfg.theme,
      weekStart: cfg.weekStart,
      hour12: cfg.hour12,
      dayStart: cfg.dayStart,
      dayEnd: cfg.dayEnd,
      defaultRemindMin: cfg.defaultRemindMin,
      defaultDurationMin: cfg.defaultDurationMin,
      googleCalendarId: cfg.googleCalendarId,
    },
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Per-item last-write-wins union of local and remote documents.
 * Returns the merged doc plus flags saying which side needs writing.
 */
export function mergeDocuments(local, remote) {
  if (!remote || typeof remote !== 'object' || !Array.isArray(remote.items)) {
    return { document: local, changedLocal: false, changedRemote: true };
  }

  const merged = new Map();
  let changedLocal = false;
  let changedRemote = false;

  for (const item of local.items) merged.set(item.id, item);

  for (const item of remote.items) {
    const mine = merged.get(item.id);
    if (!mine) {
      merged.set(item.id, item);
      changedLocal = true;
    } else if (newer(item.updatedAt, mine.updatedAt)) {
      merged.set(item.id, item);
      changedLocal = true;
    } else if (newer(mine.updatedAt, item.updatedAt)) {
      changedRemote = true;
    }
  }
  if (local.items.some((i) => !remote.items.find((r) => r.id === i.id))) changedRemote = true;

  // Lists merge the same way, keyed by id.
  const lists = new Map();
  for (const list of remote.lists || []) lists.set(list.id, list);
  for (const list of local.lists || []) {
    const theirs = lists.get(list.id);
    if (!theirs || newer(list.updatedAt, theirs.updatedAt)) lists.set(list.id, list);
  }

  // Journal entries, keyed by day, newest write wins. Spreading `...local`
  // below would otherwise hand the local object straight back and quietly
  // strand every entry written on the other device.
  const journal = { ...(remote.journal || {}) };
  for (const [day, mine] of Object.entries(local.journal || {})) {
    const theirs = journal[day];
    if (!theirs || newer(mine.updatedAt, theirs.updatedAt)) {
      journal[day] = mine;
      if (theirs || !remote.journal) changedRemote = true;
    } else {
      changedLocal = true;
    }
  }
  for (const day of Object.keys(remote.journal || {})) {
    if (!(day in (local.journal || {}))) changedLocal = true;
  }
  for (const day of Object.keys(local.journal || {})) {
    if (!(day in (remote.journal || {}))) changedRemote = true;
  }

  return {
    document: {
      ...local,
      items: [...merged.values()],
      journal,
      lists: [...lists.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      inboxListId: local.inboxListId || remote.inboxListId,
      // A Drive copy written before lists had stable ids still holds the old
      // duplicates, and unioning them back in would undo the local repair.
      // Withhold the "already repaired" marker until BOTH sides are clean, so
      // state.js re-runs the fix on the merged result. It is idempotent.
      listsVersion: (local.listsVersion === 2 && remote.listsVersion === 2) ? 2 : undefined,
    },
    changedLocal,
    changedRemote,
  };
}

/**
 * Build the patch to send for an item, dropping timing fields when the user
 * has not actually changed them.
 *
 * This matters more than it looks. We import an event by converting it to
 * local wall-clock, and we push by rebuilding an instant from that wall-clock
 * using the CURRENT offset — which silently re-anchors the event to the local
 * timezone. For an event authored elsewhere (a Philippine shift, a flight, a
 * call with someone abroad) that is corruption: it looks right today and goes
 * an hour wrong at the next DST change on either side.
 *
 * Since Google's update is a PATCH, the fix is simply not to send start/end
 * unless the timing genuinely changed. Editing a title then leaves the
 * original zoned times completely untouched.
 */
export function buildPatch(item) {
  const body = itemToEvent(item, { defaultDurationMin: settings().defaultDurationMin });
  const snapshot = item.remoteTiming;
  if (!snapshot) return body;   // we created it, so we own its timing

  const unchanged = snapshot.date === item.date
    && snapshot.time === item.time
    && (snapshot.durationMin ?? null) === (item.durationMin ?? null);

  if (unchanged) {
    delete body.start;
    delete body.end;
    delete body.recurrence;
  }
  return body;
}

function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  return new Date(a).getTime() > new Date(b).getTime();
}

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; }
}

function saveQueue(queue) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch { /* full */ }
}

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const sync = new SyncEngine();

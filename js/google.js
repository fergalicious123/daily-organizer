/* Google Identity Services auth + Calendar and Drive REST calls.
 *
 * Browser-side OAuth using the GIS token client. Notes that matter:
 *  - The Client ID is NOT a secret. Browser OAuth clients have no secret; the
 *    security boundary is the authorized-origins list in Google Cloud Console.
 *    Committing it is normal and correct.
 *  - Tokens are short-lived (~1h) and deliberately kept in memory only, so a
 *    shared or stolen localStorage dump does not carry calendar access. The
 *    cost is a silent re-auth on reload, which GIS handles without a prompt
 *    once the user has granted consent.
 *  - Scopes are the minimum that does the job: full calendar, and drive.file
 *    (per-file access to files this app creates) rather than whole-Drive.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export const DATA_FILENAME = 'organizer-data.json';

const TOKEN_KEY = 'daily-organizer:token:v1';

class GoogleClient {
  constructor() {
    this.token = null;
    this.expiresAt = 0;
    this.tokenClient = null;
    this.clientId = null;
    this.gisReady = null;
    this.persist = true;
    this._restoreToken();
  }

  /**
   * Keep the access token across reloads.
   *
   * Originally this was memory-only, which is the safer default — but it made
   * every reload a fresh round trip to Google, and Google's silent refresh
   * (prompt:'none') fails often in Chrome because it needs a third-party
   * cookie. The result was constant manual reconnecting.
   *
   * The trade: the token sits in localStorage for up to an hour, so anyone
   * with access to this browser profile could read it during that window. It
   * grants only calendar + drive.file on this one account, it expires on its
   * own, and "Disconnect" wipes it immediately. Turn it off with the
   * "Stay signed in" switch in Settings.
   */
  _restoreToken() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      // Only trust it with real time left — a token about to expire mid-sync
      // is worse than no token.
      if (saved?.token && saved.expiresAt > Date.now() + 120_000) {
        this.token = saved.token;
        this.expiresAt = saved.expiresAt;
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch {
      // Corrupt or unavailable storage: carry on tokenless.
    }
  }

  _saveToken() {
    if (!this.persist) return;
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify({
        token: this.token, expiresAt: this.expiresAt,
      }));
    } catch { /* storage full or blocked */ }
  }

  _clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing to do */ }
  }

  /** Turn persistence on or off; off wipes anything already stored. */
  setPersistence(enabled) {
    this.persist = Boolean(enabled);
    if (!this.persist) this._clearToken();
    else if (this.token) this._saveToken();
  }

  get isSignedIn() {
    return Boolean(this.token) && Date.now() < this.expiresAt - 60_000;
  }

  /** Inject the GIS script once. */
  loadGis() {
    if (this.gisReady) return this.gisReady;
    this.gisReady = new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection.'));
      document.head.appendChild(script);
    });
    return this.gisReady;
  }

  async init(clientId) {
    if (!clientId) throw new Error('No Google Client ID set. Add one in Settings.');
    await this.loadGis();
    if (this.tokenClient && this.clientId === clientId) return;
    this.clientId = clientId;
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {},   // replaced per-request in requestToken()
    });
  }

  /**
   * Get a token. `interactive: false` attempts a silent refresh — used on
   * load and before background syncs so the user is not prompted repeatedly.
   */
  requestToken({ interactive = true } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.tokenClient) return reject(new Error('Google client not initialised.'));

      this.tokenClient.callback = (response) => {
        if (response.error) {
          return reject(new Error(describeAuthError(response.error)));
        }
        this.token = response.access_token;
        this.expiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        this._saveToken();
        resolve(this.token);
      };

      this.tokenClient.error_callback = (err) => {
        reject(new Error(describeAuthError(err?.type || 'popup_failed')));
      };

      try {
        this.tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
      } catch (err) {
        reject(err);
      }
    });
  }

  async ensureToken({ interactive = false } = {}) {
    if (this.isSignedIn) return this.token;
    return this.requestToken({ interactive });
  }

  signOut() {
    if (this.token && window.google?.accounts?.oauth2) {
      try { window.google.accounts.oauth2.revoke(this.token, () => {}); } catch { /* best effort */ }
    }
    this.token = null;
    this.expiresAt = 0;
    this._clearToken();
  }

  /** Authenticated fetch with one automatic retry after a token refresh. */
  async request(url, options = {}, retry = true) {
    await this.ensureToken({ interactive: false });
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(options.headers || {}),
      },
    });

    if (response.status === 401 && retry) {
      // A stored token can be revoked server-side before it expires, so a 401
      // means bin it rather than keep re-presenting it.
      this.token = null;
      this.expiresAt = 0;
      this._clearToken();
      try {
        await this.requestToken({ interactive: false });
      } catch {
        await this.requestToken({ interactive: true });
      }
      return this.request(url, options, false);
    }

    if (response.status === 403) {
      const body = await safeJson(response);
      const reason = body?.error?.errors?.[0]?.reason;
      if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
        throw new RateLimitError('Google is rate-limiting us. Sync will retry shortly.');
      }
      throw new Error(body?.error?.message || 'Google refused the request.');
    }

    if (!response.ok) {
      const body = await safeJson(response);
      throw new Error(body?.error?.message || `Google request failed (${response.status}).`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  /* ---------------- Calendar ---------------- */

  async listCalendars() {
    const data = await this.request(`${CAL_API}/users/me/calendarList?maxResults=250`);
    return (data.items || []).map((c) => ({
      id: c.id,
      name: c.summary,
      primary: Boolean(c.primary),
      accessRole: c.accessRole,
    }));
  }

  /**
   * Events in a window. Uses singleEvents so recurring series arrive as
   * individual occurrences, which is what a day grid needs.
   */
  async listEvents(calendarId, timeMinISO, timeMaxISO) {
    const params = new URLSearchParams({
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      showDeleted: 'true',   // needed so remote deletions reach our tombstones
    });

    // Follow nextPageToken. Google caps a page well below maxResults when the
    // window contains many expanded recurrences — a rota of shifts is exactly
    // that — so reading only the first page silently loses events, with no
    // error to say so.
    const all = [];
    let pageToken = null;
    let pages = 0;
    do {
      if (pageToken) params.set('pageToken', pageToken);
      const data = await this.request(
        `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      );
      all.push(...(data.items || []));
      pageToken = data.nextPageToken || null;
      pages++;
      // A guard, not a limit: without it a malformed token could spin forever.
    } while (pageToken && pages < 20);

    return all;
  }

  createEvent(calendarId, body) {
    return this.request(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  updateEvent(calendarId, eventId, body) {
    return this.request(
      `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }

  async deleteEvent(calendarId, eventId) {
    try {
      await this.request(
        `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'DELETE' },
      );
    } catch (err) {
      // Already gone is a success for our purposes.
      if (!/410|404|not found|deleted/i.test(err.message)) throw err;
    }
  }

  /* ---------------- Drive ---------------- */

  /** Find our data file. Returns { id, modifiedTime } or null. */
  async findDataFile() {
    const params = new URLSearchParams({
      q: `name='${DATA_FILENAME}' and trashed=false`,
      fields: 'files(id,name,modifiedTime)',
      spaces: 'drive',
      pageSize: '10',
    });
    const data = await this.request(`${DRIVE_API}/files?${params}`);
    const file = (data.files || [])[0];
    return file ? { id: file.id, modifiedTime: file.modifiedTime } : null;
  }

  async getFileMeta(fileId) {
    return this.request(`${DRIVE_API}/files/${fileId}?fields=id,modifiedTime`);
  }

  async downloadFile(fileId) {
    await this.ensureToken({ interactive: false });
    const response = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`Could not read your Drive file (${response.status}).`);
    return response.json();
  }

  /** Create the data file. Returns its id. */
  async createDataFile(contents) {
    const boundary = 'organizer-' + Math.random().toString(36).slice(2);
    const metadata = { name: DATA_FILENAME, mimeType: 'application/json' };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(contents)}\r\n` +
      `--${boundary}--`;

    const data = await this.request(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return data;
  }

  /** Overwrite the data file in place, keeping its id. */
  async updateDataFile(fileId, contents) {
    return this.request(`${DRIVE_UPLOAD}/files/${fileId}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contents),
    });
  }
}

export class RateLimitError extends Error {}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function describeAuthError(code) {
  const map = {
    popup_closed_by_user: 'Sign-in was closed before it finished.',
    popup_failed_to_open: 'The sign-in popup was blocked. Allow popups for this site and try again.',
    access_denied: 'Access was declined.',
    interaction_required: 'Google needs you to sign in again.',
    invalid_client: 'That Client ID is not valid for this address. Check the authorized JavaScript origins in Google Cloud Console.',
    idpiframe_initialization_failed: 'Google sign-in could not start. Third-party cookies may be blocked.',
  };
  return map[code] || `Google sign-in failed (${code}).`;
}

export const google = new GoogleClient();

/* ------------------------------------------------------------------ */
/* Mapping between our items and Google events                         */
/* ------------------------------------------------------------------ */

/**
 * Our item -> a Google Calendar event body.
 *
 * Reminders are attached here rather than handled in-app: this is what makes
 * a notification reach the phone when the app is closed. The Google Calendar
 * app fires it natively.
 */
export function itemToEvent(item, { defaultDurationMin = 60 } = {}) {
  const body = {
    summary: item.title || 'Untitled',
    description: buildDescription(item),
  };

  if (item.time) {
    const start = new Date(`${item.date}T${item.time}:00`);
    const end = new Date(start.getTime() + (item.durationMin || defaultDurationMin) * 60000);
    body.start = { dateTime: toRfc3339(start), timeZone: localTimeZone() };
    body.end = { dateTime: toRfc3339(end), timeZone: localTimeZone() };
  } else {
    // All-day events are half-open in the API: end is the following day.
    const end = new Date(`${item.date}T00:00:00`);
    end.setDate(end.getDate() + 1);
    body.start = { date: item.date };
    body.end = { date: `${end.getFullYear()}-${p2(end.getMonth() + 1)}-${p2(end.getDate())}` };
  }

  if (item.remindMin != null) {
    body.reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: Math.max(0, item.remindMin) }],
    };
  } else {
    body.reminders = { useDefault: true };
  }

  if (item.recur) body.recurrence = [toRrule(item.recur)];

  // A completed task keeps its slot but says so, so history stays readable.
  if (item.done) body.summary = `✓ ${body.summary}`;

  return body;
}

/** A Google event -> our item shape (partial; caller merges). */
export function eventToItem(event) {
  const allDay = Boolean(event.start?.date);
  const startISO = event.start?.dateTime || event.start?.date;
  if (!startISO) return null;

  let date;
  let endDate = null;
  let time = null;
  let durationMin = null;

  if (allDay) {
    // Some callers hand back all-day dates with a time bolted on
    // ("2026-08-07T00:00:00Z") rather than the bare "2026-08-07" the API
    // documents. Left alone, the end-date maths below built
    // `new Date("2026-08-07T00:00:00ZT00:00:00")` — an Invalid Date — so
    // endDate silently stayed null and every four-day block collapsed to its
    // first day. Trim to the date part before touching either end.
    date = String(event.start.date).slice(0, 10);
    // Google's all-day end is EXCLUSIVE, so a shift block running the 11th to
    // the 14th arrives as end.date = the 15th. Store the last day it actually
    // covers. Without this the span is lost and a four-day shift shows on one
    // day only.
    if (event.end?.date) {
      const end = new Date(`${String(event.end.date).slice(0, 10)}T00:00:00`);
      end.setDate(end.getDate() - 1);
      const last = `${end.getFullYear()}-${p2(end.getMonth() + 1)}-${p2(end.getDate())}`;
      if (last > date) endDate = last;
    }
  } else {
    const start = new Date(startISO);
    date = `${start.getFullYear()}-${p2(start.getMonth() + 1)}-${p2(start.getDate())}`;
    time = `${p2(start.getHours())}:${p2(start.getMinutes())}`;
    if (event.end?.dateTime) {
      durationMin = Math.round((new Date(event.end.dateTime) - start) / 60000) || null;
    }
  }

  let rawTitle = event.summary || 'Untitled';

  // The chat inbox. Anything on the calendar tagged #unscheduled is not really
  // a calendar entry — it is a note-to-self that needed somewhere to land, so
  // it arrives here as an undated task instead of pinning itself to whatever
  // day it was dictated on.
  //
  // Read from the title as well as the description because that is the only
  // field a voice assistant can reliably set, and stripped from the title so
  // the tag does not become part of the task's name.
  const inbox = INBOX_TAG.test(rawTitle) || INBOX_TAG.test(event.description || '');
  if (inbox) {
    rawTitle = rawTitle.replace(INBOX_TAG, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
    date = null;
    endDate = null;
    time = null;
    durationMin = null;
  }

  const done = rawTitle.startsWith('✓ ');

  const reminder = event.reminders?.overrides?.find((r) => r.method === 'popup');

  return {
    title: done ? rawTitle.slice(2) : rawTitle,
    notes: stripMarker(event.description || '').replace(INBOX_TAG, ' ').replace(/[ \t]+/g, ' ').trim(),
    date,
    endDate,
    time,
    durationMin,
    // The timezone the event was authored in, and what its timing looked like
    // when we imported it. Both exist so we can avoid rewriting the timing of
    // events we did not create — see the note in sync.js's push loop.
    tz: event.start?.timeZone || null,
    remoteTiming: { date, time, durationMin },
    // Set when this is one occurrence of a repeating Google event. Rollover
    // uses it as a hard stop: shifting a single instance of a recurring series
    // would rewrite a real calendar entry that is meant to repeat.
    seriesId: event.recurringEventId || null,
    done,
    doneAt: done ? (event.updated || new Date().toISOString()) : null,
    remindMin: reminder ? reminder.minutes : null,
    gcalId: event.id,
    // An undated event is a contradiction; anything from the inbox is a task.
    kind: inbox ? 'task' : inferKind(event),
    deleted: event.status === 'cancelled',
    updatedAt: event.updated || new Date().toISOString(),
  };
}

/** Events this app wrote carry a marker, so we can tell ours from theirs. */
const MARKER = '\n\n[daily-organizer]';

/**
 * The tag that turns a calendar entry into an undated task — the way to get
 * something into Unscheduled from outside the app, whether that is Claude
 * writing to the calendar, the Google Calendar app, or a voice assistant.
 *
 * Word-boundaried so a task genuinely about "#unscheduledmaintenance" is left
 * alone, and case-insensitive because nothing dictating this will capitalise
 * consistently.
 */
const INBOX_TAG = /#unscheduled\b/i;

function buildDescription(item) {
  const parts = [];
  if (item.notes) parts.push(item.notes);
  if (item.subtasks?.length) {
    parts.push(item.subtasks.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.title}`).join('\n'));
  }
  return parts.join('\n\n') + MARKER;
}

function stripMarker(description) {
  return description.replace(MARKER, '').trim();
}

/**
 * Decide whether an imported Google event is something you ATTEND (an event)
 * or something you DO (a task you can tick off).
 *
 * The first version imported everything as an event, which was wrong for real
 * calendars: on Ben's, roughly 35 of 49 August entries were actionable — a
 * daily 08:00 "Complete online course(s)" and weekly wedding-planning items —
 * against about ten genuine shift blocks. Defaulting to event meant the
 * progress ring ignored 70% of what was actually actionable.
 *
 * So the default is now `task`, and we carve out the things that are clearly
 * appointments. No heuristic gets this fully right — the escape hatch is the
 * item editor, which can flip a whole repeated series at once.
 */
function inferKind(event) {
  // Our own events: only an appointment if it has appointment-ish properties.
  if (event.description?.includes(MARKER.trim())) {
    return event.start?.dateTime && (event.attendees?.length || event.location) ? 'event' : 'task';
  }

  // Google's own special types are never tasks.
  if (['birthday', 'outOfOffice', 'workingLocation', 'fromGmail'].includes(event.eventType)) {
    return 'event';
  }

  // Someone else is involved, or there is a place to be: an appointment.
  if (event.attendees?.length || event.location || event.hangoutLink) return 'event';

  // A multi-day all-day block is a shift, a holiday or a trip — something you
  // are inside of, not something you complete. A SINGLE all-day entry stays a
  // task, which is what keeps recurring reminders like "Wedding Planning"
  // tickable.
  if (event.start?.date && event.end?.date) {
    const spanDays = Math.round(
      (new Date(event.end.date) - new Date(event.start.date)) / 86400000,
    );
    if (spanDays > 1) return 'event';
  }

  // Transparent ("free") entries are markers rather than commitments.
  if (event.transparency === 'transparent') return 'task';

  return 'task';
}

export function isOurEvent(event) {
  return Boolean(event.description?.includes('[daily-organizer]'));
}

function toRrule(recur) {
  const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const parts = [];
  if (recur.freq === 'daily') parts.push('FREQ=DAILY');
  else if (recur.freq === 'weekly') parts.push('FREQ=WEEKLY');
  else if (recur.freq === 'monthly') parts.push('FREQ=MONTHLY');
  if (recur.interval && recur.interval > 1) parts.push(`INTERVAL=${recur.interval}`);
  if (recur.byDay?.length) parts.push(`BYDAY=${recur.byDay.map((d) => days[d]).join(',')}`);
  if (recur.until) parts.push(`UNTIL=${recur.until.replace(/-/g, '')}T235959Z`);
  return `RRULE:${parts.join(';')}`;
}

function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
}

const p2 = (n) => String(n).padStart(2, '0');

/** Local wall-clock -> RFC3339 with the real UTC offset. */
function toRfc3339(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}` +
    `T${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}` +
    `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

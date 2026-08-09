# Daily Organizer

A calendar and todo app that drills month → week → day → hours, understands
plain English when you type, shows how far through your tasks you are, syncs
two ways with Google Calendar, and installs on an Android phone as a real app
that can notify you.

No build step, no framework, no npm. Plain ES modules that a browser runs
directly.

---

## Run it locally

The app **must be served over HTTP** — ES modules and service workers do not
work from a `file://` path.

Double-click `start.bat`, or run:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

Everything except Google sync works immediately, with data saved in the
browser. To add sync, follow [SETUP-GOOGLE.md](SETUP-GOOGLE.md).

---

## Getting it on your phone

Phones only allow notifications from an installed app served over HTTPS, so it
needs hosting. GitHub Pages is free and permanent.

### Deploy

From inside this folder:

```bash
git init -b main
```
```bash
git add -A
```
```bash
git commit -m "Daily organizer"
```

Create an empty repo on GitHub named `daily-organizer` (no README, no
.gitignore), then:

```bash
git remote add origin https://github.com/fergalicious123/daily-organizer.git
```
```bash
git push -u origin main
```

On GitHub: **Settings** → **Pages** → Source: *Deploy from a branch* → Branch:
`main`, folder `/ (root)` → **Save**. After a minute your app is live at
`https://fergalicious123.github.io/daily-organizer/`.

Add `https://fergalicious123.github.io` to your OAuth client's authorized origins
(see SETUP-GOOGLE.md step 5).

### Install on Android

1. Open the Pages URL in Chrome.
2. Menu (⋮) → **Install app** (or *Add to Home screen*).
3. Open it from your home screen — it runs standalone, without browser chrome.

To redeploy after changes: bump `CACHE_VERSION` in `sw.js`, then commit and push.

---

## How notifications actually reach you

This matters, so it is worth being precise:

| Situation | What fires it |
|---|---|
| App open on screen | The app itself, via the Notification API |
| Installed PWA running in background | Same, while Android keeps it alive |
| **App fully closed** | **Google Calendar** |

A web app cannot wake itself when it is closed without a push server. So every
timed item is written to your Google Calendar **with its reminder attached**,
and the Google Calendar app already on your phone delivers the notification
natively — reliable, battery-friendly, and working whether or not this app has
been opened in a week.

That is why connecting Google is what makes phone reminders real. Without it,
notifications only fire while the app is open.

---

## Typing in plain English

Every quick-add box runs a natural-language parser, so you type one line
instead of filling in a form.

Things it understands:

```
remind me to call mum tomorrow at 3
gym every monday 7am
dentist on the 14th for an hour
team meeting friday 2pm for 90 minutes
urgent finish the report today at 17:30
standup every weekday at 9:15am
pay rent on 1 September
book flights in 2 weeks
review notes 30 minutes before
```

It reads dates, times, durations, repeats, priority, reminder lead time, and
which list to file it under. Anything it cannot place stays in the title.

**Voice capture is switched off for now.** The speech-recognition code is still
in `js/voice.js` and still works — it is simply not wired to any button. The
header of that file has the steps to bring it back.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `M` / `W` / `D` | Month / week / day view |
| `T` | Jump to today |
| `←` `→` | Previous / next period |
| `N` | New item |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Esc` | Close panels |

On a phone, swipe left and right to move between days, weeks or months.

---

## Tasks vs events, and what gets imported

A **task** is something you do and tick off; it counts toward the progress
ring. An **event** is something you attend; it occupies time but isn't
completable.

Everything pulled from Google has to be sorted into one or the other. The rule:

| Google entry | Imported as |
|---|---|
| Has attendees, a location, or a Meet link | Event |
| Birthday, out-of-office, working location | Event |
| All-day spanning **more than one day** (shifts, holidays, trips) | Event |
| Everything else — timed reminders, single all-day items | **Task** |

The default is *task* on purpose. On a real calendar most entries turn out to
be actionable — recurring habits, chores, reminders — and defaulting to event
meant the progress ring ignored the majority of what was actually actionable.

No rule gets this right every time. When it guesses wrong, open the item and
switch the type. If other items share the same title — which is what a
recurring calendar entry looks like once imported — you'll be offered
**"Apply type to all N"**, so a daily habit is one click rather than thirty.

## Adding things from the Claude chat

Because timed items live in your Google Calendar, Claude can add them there and
they appear here on the next sync (on app focus, or within five minutes).

Ask for things like *"put a dentist appointment in my calendar for Tuesday at
2pm"* and it lands in the organizer too.

---

## How your data is stored

| Where | What | Why |
|---|---|---|
| Browser localStorage | Everything | Instant, works offline |
| Google Drive `organizer-data.json` | Tasks, lists, subtasks, priorities, history | Syncs PC ↔ phone; you own the file |
| Google Calendar | Anything with a date | Shows on your phone, fires reminders |

Conflicts resolve last-write-wins per item, and deletions leave tombstones so a
delete on one device is not resurrected by another. Changes made offline queue
and flush when you reconnect.

**Settings → Export backup** writes a JSON file you can keep anywhere.

---

## Files

```
index.html              shell
css/styles.css          design system, light + dark, responsive
js/app.js               routing, chrome, wiring
js/state.js             data model, undo, queries
js/dates.js             date helpers (local wall-clock, never UTC)
js/ui.js                DOM builder, icons, toasts, modals
js/chart.js             progress ring, columns, bars, sparkline
js/voice.js             natural-language parser (+ speech capture, unwired)
js/google.js            OAuth, Calendar and Drive REST
js/sync.js              two-way merge, conflict resolution, offline queue
js/notify.js            in-app notification scheduling
js/views/calendar.js    month, week, day
js/views/tasks.js       task rows, lists, item editor
sw.js                   offline shell (network-first for code)
tools/make_icons.py     regenerates the PWA icons
```

---

## Notes on a few decisions

**Dates are stored as local wall-clock strings**, not UTC instants, so 09:00
stays 09:00 on the morning the clocks change.

**Tasks and events are one data type** distinguished by a `kind` field. A task
with a date and a time *is* an event you can tick off, so unifying them gives
one sync path instead of two and makes "drag a todo onto 3pm" a field update.

**The progress ring is a meter, not a pie.** It is one ratio against a limit, so
the unfilled part is a lighter step of the same colour rather than a second
category. The fill and track contrast ratios were measured, not eyeballed.

**The service worker is network-first for code.** The usual
stale-while-revalidate leaves every user one version behind — a fix only lands
on their second visit. Offline still works; the cache is the fallback.

**Rendering redraws whole regions** rather than diffing. With a few hundred
items it is imperceptible, and it removes a whole class of stale-UI bugs.

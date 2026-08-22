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

### Checking nothing is broken

Two checks, both runnable with nothing installed:

```bash
python tools/contrast.py
```

Reads the colour tokens straight out of `styles.css` and works out every
contrast ratio the app actually renders, in both themes. Exits non-zero if any
falls below WCAG AA. Three known failures are listed in the file rather than
hidden, because fixing them changes the look of things already in daily use.

With the server running, open **`/tools/selftest.html`**. It imports every
module — which catches a syntax error immediately — and exercises the logic
where a mistake would be silent: calendar event ids, the quote check behind the
review's proposals, and the sync merge, where a wrong answer is unrecoverable
data loss rather than a visible bug. It only calls pure functions, so running
it cannot touch your data.

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

The **`?`** button in the bottom-right corner, beside the clock, opens this
same list in the app. It is generated from the same table the keys themselves
run off, so it cannot fall out of date the way this file did. Hidden on phones,
where every row of it would need a keyboard.

| Key | Action |
|---|---|
| `H` | Home |
| `M` | Month view |
| `W` | Week view |
| `D` | Day view — the day you are currently on |
| `T` | Jump to today |
| `R` | Review the last block |
| `←` `→` | Previous / next period |
| `N` | New item |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Esc` | Close the modal, drawer, or field you are in |

**`←` and `→` step by whatever you are looking at:** a month in month view, a
week in week view, a day everywhere else.

**`D` versus `T`:** `D` opens the day view on whatever date you are already
looking at, so arrowing to the 14th in month view and pressing `D` opens the
14th. `T` always jumps to today.

The letter keys are lower case only — with Caps Lock or Shift held, nothing
happens. They are also switched off while you are typing in any field and while
a dialog is open, so writing "make the appointment" in a task box cannot throw
you into Month view halfway through the word. `Ctrl+Z` works everywhere except
inside a field, where it is the browser's own undo.

`Esc` does the nearest thing first: closes an open dialog, otherwise closes the
sidebar or side panel, and in a text field it just steps out of the field.

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

### Sending something to Unscheduled

Not everything has a day. Anything on the calendar tagged **`#unscheduled`**
arrives here as an undated task in Unscheduled, rather than pinning itself to
whichever day it happened to be written on.

The tag is read from the event's **title or its description**, so every route
in works:

| From | What to do |
|---|---|
| Claude chat | *"add 'book the MOT' to my unscheduled"* — Claude writes the tag for you |
| Google Calendar app | Put `#unscheduled` anywhere in the title or description |
| Google Assistant | *"Hey Google, create an event called book the MOT hashtag unscheduled"* |

The tag is stripped, so the task is named *Book the MOT*, not *Book the MOT
#unscheduled*. Anything else you wrote in the description becomes the task's
notes.

While it sits in Unscheduled the app never writes back to that calendar entry.
Drag it onto a day and it becomes a normal two-way item — and the push clears
the tag from Google, so it cannot bounce back to Unscheduled afterwards.

`#unscheduledmaintenance` and the like are left alone; the tag has to be a
whole word.

---

## Your rota on the calendar

Days you are working are coloured across the **whole month cell**, so a
four-on block reads as a block rather than as four chips you have to decode.

| Shift | Colour | Recognised from |
|---|---|---|
| Nights | deep indigo | `night`, `nights`, `(N)` |
| Days | warm amber | `day`, `days`, `(D)` |
| On call | violet | `on call`, `on-call`, `(OC)` |
| Off | green | `off`, `rest`, `rest day` |
| Something else | grey | anything else clearly a shift |

Colour here is **semantic, not categorical** — nights cool and dark, days warm
and bright — so it is fixed, unlike event colours which are handed out in the
order titles first appear.

**Earlies and lates come out grey, deliberately.** Folding them into "days"
would be a guess presented as a fact. Tell me what they should count as and
they get their own colour.

### What counts as a shift

An entry has to *look* like one: contain the word **shift**, or carry a
bracketed code like **(N)**, or be nothing but the word itself (`OFF`,
`Nights`). Without that gate a task called *"book the car in on my day off"*
would repaint the whole day as a rest day.

**Other people's shifts are ignored.** A leading `Name:` — as in
*"Sheila: 11-7 night shift (PH)"* — means the entry belongs to someone else and
never colours your calendar. If your own rota is written `Ben: Night Shift`,
put your name in **Settings → your name** so those count as yours.

A shift spanning several days colours every day it covers.

### Who you were on with

Put a line in the **event's description** and it shows in fine print along the
bottom of the cell, and in full when you open the day:

```
With: Adamson, Reid, Okafor
Crew - Adamson / Reid
Team: Nowak and Reid
```

`With`, `Crew`, `Team` and `On with` all work, separated by commas, slashes,
ampersands or "and". On a phone the fine print is hidden — two initials and an
ellipsis is not information — but the shift colour still shows and tapping the
day gives the names in full.

### Sending a year's roster

Send it in whatever form you have it and I will convert it. What I need to know:

- **Which codes mean what** — especially earlies, lates, and anything like `LD`
  or `LN`
- **Whether the crew is per-shift or per-team** — one line per day, or a team
  roster that repeats
- **Where the year starts**, if the pattern is a repeating cycle rather than
  dated entries

---

## The diary

**Diary** in the sidebar. One entry a day, in your own words, next to the list
of what you actually finished that day — the written note without the list
forgets what happened, and the list without the note is just a tally.

- Write it in the Diary, or in **Notes on this day** in any day view. Both
  edit the same entry.
- **Dictate** speaks it instead of typing. Dictation keeps listening through
  pauses and appends to whatever is already there, so you can talk through a
  day in pieces.
- Entries save when you click away, sync through Drive like everything else,
  and merge per day — writing tonight's entry on your phone never collides
  with an older one edited on the laptop.

Days you wrote nothing but finished something still appear, because those are
the ones worth writing up.

**Reading a stretch of diary back with AI:** the app does this itself now — see
**The review** below. It used to say this had to happen in the Claude chat,
because a key in a static site would be readable by anyone who opened the page.
That is still true of a key committed to the repo, which is why the one the app
uses is typed into Settings and kept in that browser only: out of the repo, out
of Drive sync, and out of exported backups.

Claude can also still read your `organizer-data.json` from Drive directly, which
is the better route for anything spanning months rather than one block.

---

## Notes as you go

Open any task and there is a **Notes as you go** box under the usual fields.
This is for what you find out while doing something, as opposed to the
instructions you wrote for yourself beforehand — those stay in **Notes**.

- **Mic** dictates. It keeps listening through pauses and adds to what is
  already there, so you can talk about something in two goes without the
  second wiping the first.
- **Clipboard** pastes whatever you have copied — Granola notes, an email, a
  WhatsApp message. If your browser will not hand the clipboard over without a
  real gesture it focuses the box instead, and Ctrl+V works.
- Each note is stamped with the time it was made and saved immediately, not
  when you close the dialog. A note dictated between jobs is the one most
  likely to be interrupted, and pressing Cancel should not lose it.

Notes merge properly across devices. Every other field on a task is
last-write-wins, which is right for a title; notes are unioned by entry
instead, so dictating one on your phone and another on the laptop before either
syncs keeps both. Deleting one leaves a tombstone, so the delete sticks rather
than being handed back by the next device that still had a copy.

---

## The review

**Review** in the sidebar, and a dot on it when there is one waiting.

It covers one **shift block** — four days, or four nights — rather than a week.
Weeks are the wrong unit for this rota: they do not divide into fours, so a
Sunday review lands three days into a run of nights, with half the block behind
you and half still to come. The app walks back through your rota to find the
last run of worked days, and offers a review once that run is over. Once, not
every time you open the app.

The page puts the block in one place, in the order it happened:

| | |
|---|---|
| **Diary** | what you wrote each day |
| **Notes you made** | grouped by the task they are about, so four remarks about one job look different from four about four |
| **Finished** | what you actually got done |
| **Slipped** | still open, date gone past — the uncomfortable half, and the one worth looking at |

The pills switch to a fixed 7 or 14 days when a block is not the right unit —
a stretch of leave, or a block you never got round to.

**All of the above works offline, with no API key, for nothing.** Gathering and
reading back is the part that has to be right, so it is done by rules.

### Turning it into actions

At the bottom, **Read it back** sends the diary entries and notes above to
Claude and asks what actions they imply. Three things about it:

- **Nothing is created until you say so.** Every suggestion is a proposal with
  **Add it** and **No** next to it.
- **Every proposal quotes the words it came from, and the quote is checked**
  against what was actually sent. One that cannot be found is labelled *not
  found in your notes* and outlined differently, rather than being passed off
  as something you said. This is the difference between a tool that reads your
  notes and one that makes things up about your life.
- **Accepted proposals carry their source into their own notes**, so "why is
  this on my list" still has an answer in a month.

Something dated *now* lands **tomorrow**, not today — you read this at the end
of a block, when today is usually already spoken for, and dating something to a
day that is nearly over just makes it overdue before you have seen it.

**What leaves the device:** your diary entries and task notes go to Anthropic's
API with your own key. That is more personal than the morning brief, which only
ever sent times and titles. **See exactly what gets sent** shows you the literal
text before you press anything.

Roughly 3–5p a review at a block's worth of writing.

---

## How your data is stored

| Where | What | Why |
|---|---|---|
| Browser localStorage | Everything | Instant, works offline |
| Google Drive `organizer-data.json` | Tasks, lists, subtasks, priorities, history | Syncs PC ↔ phone; you own the file |
| Google Calendar | Anything with a date | Shows on your phone, fires reminders |

Conflicts resolve last-write-wins per item, and deletions leave tombstones so a
delete on one device is not resurrected by another. The one exception is the
notes on a task: those are unioned entry by entry rather than letting the newer
copy win, because they are observations rather than a current value, and losing
one would be silent and unrecoverable. Changes made offline queue
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
js/brief.js             the morning brief, built by rules
js/ai.js                optional: Claude rewords the brief
js/reflect.js           optional: Claude proposes actions from a block
js/quotes.js            the two voices, one pairing a day
js/dragdrop.js          touch dragging, edge scrolling
js/shortcuts.js         the declared keyboard map
js/views/calendar.js    month, week, day
js/views/tasks.js       task rows, lists, item editor, notes as you go
js/views/review.js      the shift-block review
js/views/journal.js     the diary
js/views/routine.js     First things
js/views/bin.js         drag-to-delete, with undo
sw.js                   offline shell (cache-first; network-first on localhost)
tools/make_icons.py     regenerates the PWA icons
tools/contrast.py       checks every token pair meets WCAG AA, both themes
tools/selftest.html     runs the pure logic in a browser; no build step
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

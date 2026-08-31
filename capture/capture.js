/* Catch — the note app.
 *
 * One job: take a sentence before the thought goes, and get out of the way.
 * Everything else on the screen is secondary to the box being ready.
 *
 * It shares an ORIGIN with the organizer, which is the whole architecture. The
 * two apps read and write the same storage, so "send this to the organizer" is
 * a local write: instant, works with no signal, and cannot half-succeed. The
 * organizer's own sync then carries it to Google with all the retry and merge
 * behaviour that already exists. A separately-hosted app would have needed its
 * own Google sign-in, its own sync and its own merge, and every hand-off would
 * have been a network round trip that could fail with a note in mid-air.
 *
 * It deliberately imports only what it needs — the data model and the speech
 * capture — rather than the organizer's twenty-five modules and its 120KB of
 * calendar styling, none of which this app has any use for.
 */

import {
  store, addCapture, captures, openCaptures, setCaptureKind, removeCapture,
  sendCaptureToOrganizer, CAPTURE, NOTE_SOURCE, settings,
} from '../js/state.js';
import { voice, speechSupported } from '../js/voice.js';
import { triage, triageConfigured } from '../js/triage.js';
import { todayKey, addDays, formatTime } from '../js/dates.js';

const box = document.getElementById('box');
const micBtn = document.getElementById('mic');
const micLabel = document.getElementById('micLabel');
const addBtn = document.getElementById('add');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');

/** Triage results, keyed by capture id, until they are accepted or dropped. */
let sorted = new Map();
let sorting = false;
let failure = '';

/* ------------------------------------------------------------------ */
/* Catching                                                            */
/* ------------------------------------------------------------------ */

function commit(source = NOTE_SOURCE.TYPED) {
  const text = box.value.trim();
  if (!text) return;
  addCapture(text, source);
  box.value = '';
  box.style.height = '';
  render();
}

addBtn.addEventListener('click', () => commit());

box.addEventListener('input', () => {
  // Grow with the text rather than making you scroll a three-line box.
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
});

box.addEventListener('keydown', (e) => {
  // Enter catches it. A thought is one line far more often than it is a
  // paragraph, and reaching for a button breaks the flow of talking to it.
  // Shift+Enter is still a newline for the times it is not.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commit();
  }
});

/* ------------------------------------------------------------------ */
/* Talking                                                             */
/* ------------------------------------------------------------------ */

function startListening() {
  if (!speechSupported()) {
    setStatus('This browser cannot listen — type instead.');
    box.focus();
    return;
  }
  const before = box.value.trim() ? `${box.value.trim()} ` : '';
  micBtn.classList.add('live');
  micLabel.textContent = 'Stop';
  setStatus('Listening…');

  voice.start({
    continuous: true,
    onInterim: (final, interim) => {
      box.value = before + final + interim;
      box.style.height = 'auto';
      box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
    },
    // Saved the moment you stop talking. A caught line that needed a second
    // press to keep would be a line lost every time something interrupted.
    onFinal: (text) => { box.value = before + text; commit(NOTE_SOURCE.VOICE); },
    onError: (message) => setStatus(message),
    onEnd: () => {
      micBtn.classList.remove('live');
      micLabel.textContent = 'Talk';
      setStatus('');
    },
  });
}

micBtn.addEventListener('click', () => {
  if (voice.listening) { voice.stop(); return; }
  startListening();
});

// Leaving the app stops the microphone. A phone left listening because you
// switched away mid-sentence is the one failure this app must not have.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && voice.listening) voice.stop();
});
window.addEventListener('pagehide', () => { if (voice.listening) voice.stop(); });

function setStatus(text) { statusEl.textContent = text || ''; }

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

async function runTriage() {
  const open = openCaptures();
  if (!open.length) return;
  sorting = true;
  failure = '';
  render();
  try {
    const result = await triage(open.map((c) => ({ id: c.id, text: c.text })));
    sorted = new Map(result.map((r) => [r.id, r]));
  } catch (err) {
    failure = err?.message || 'Could not sort these.';
  } finally {
    sorting = false;
    render();
  }
}

/** Accept a suggestion: it becomes a task, or is filed, keeping the original. */
function accept(capture, suggestion) {
  const kind = suggestion?.kind || CAPTURE.LATER;
  if (kind === CAPTURE.NOTE) {
    setCaptureKind(capture.id, CAPTURE.NOTE);
  } else {
    // `now` lands tomorrow rather than today for the same reason the review's
    // does: you are usually sorting these at the end of a day that is already
    // spoken for, and dating something to a day that is nearly over just makes
    // it overdue before you have seen it.
    const date = kind === CAPTURE.NOW ? addDays(todayKey(), 1) : null;
    sendCaptureToOrganizer(capture.id, { date, title: suggestion?.title });
  }
  sorted.delete(capture.id);
  render();
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function el(tag, props, ...kids) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  // The second argument is props OR the first child. Requiring props meant
  // every `el('p.hint', 'some text')` silently set attributes named 0, 1, 2…
  // from the string's own indices and rendered nothing at all — a whole
  // screen of empty elements that looked like a render bug.
  if (props != null && (typeof props !== 'object' || props.nodeType)) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = `${node.className} ${v}`.trim();
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function whenLabel(iso) {
  const d = new Date(iso);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = todayKey();
  const its = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = formatTime(hhmm, settings().hour12);
  return its === day ? time : `${its.slice(5)} ${time}`;
}

function captureRow(capture) {
  const suggestion = sorted.get(capture.id);
  const row = el('div.line');
  const main = el('div.line-main');

  if (suggestion && suggestion.kind) {
    main.appendChild(el('p.line-text', suggestion.title));
    // Your own words stay visible under any rewording. A suggestion sits
    // beside what you said; it never quietly replaces it.
    if (suggestion.reworded) {
      main.appendChild(el('p.line-original', `You said: ${suggestion.original}`));
    }
    if (suggestion.why) main.appendChild(el('p.line-why', suggestion.why));
    main.appendChild(el('div.line-actions',
      el('button.primary', { onclick: () => accept(capture, suggestion) },
        suggestion.kind === CAPTURE.NOTE ? 'Keep as a note'
          : suggestion.kind === CAPTURE.NOW ? 'Add for tomorrow' : 'Add to Unscheduled'),
      suggestion.reworded
        ? el('button', {
          onclick: () => accept(capture, { ...suggestion, title: suggestion.original }),
        }, 'Use my wording')
        : null,
      el('button', { onclick: () => { sorted.delete(capture.id); render(); } }, 'Leave it'),
    ));
  } else {
    main.appendChild(el('p.line-text', capture.text));
    main.appendChild(el('div.line-actions',
      el('button', { onclick: () => {
        sendCaptureToOrganizer(capture.id, { date: addDays(todayKey(), 1) });
        render();
      } }, 'Tomorrow'),
      el('button', { onclick: () => { sendCaptureToOrganizer(capture.id, { date: null }); render(); } },
        'Unscheduled'),
      el('button', { onclick: () => { setCaptureKind(capture.id, CAPTURE.NOTE); render(); } },
        'Just a note'),
      el('button.bin', { onclick: () => { removeCapture(capture.id); render(); } }, 'Bin'),
    ));
  }

  row.append(el('span.line-when', whenLabel(capture.at)), main);
  return row;
}

/**
 * A line that has been dealt with — and can still be undealt with.
 *
 * This used to be inert: text, a timestamp, a tag, and nothing you could
 * press. Which made "Just a note" a one-way door. Say something, file it as a
 * note, then realise an hour later it was actually a job — and there was no
 * route from here to the organizer, no way back to the caught pile, and not
 * even a way to bin it. The tag told you where it had gone and the row gave
 * you no say in it.
 *
 * A note keeps every option it had while it was waiting. One that has already
 * become a task does not: sending it twice would put two copies in the
 * organizer, and binning the line here would not touch the task it made, so
 * the row would appear to delete something it had no power over. That one
 * says where it went and stops.
 */
function doneRow(capture) {
  const sent = Boolean(capture.itemId);
  const row = el('div.line', { class: 'is-settled' });
  const main = el('div.line-main',
    el('p.line-text', capture.text),
    el('p.line-why', sent ? 'In the organizer.' : 'Kept as a note.'),
  );

  if (!sent) {
    main.appendChild(el('div.line-actions',
      el('button', { onclick: () => {
        sendCaptureToOrganizer(capture.id, { date: addDays(todayKey(), 1) });
        render();
      } }, 'Tomorrow'),
      el('button', { onclick: () => { sendCaptureToOrganizer(capture.id, { date: null }); render(); } },
        'Unscheduled'),
      // Back to the top of the page, where the sort button can reach it again.
      el('button', { onclick: () => { setCaptureKind(capture.id, CAPTURE.OPEN); render(); } },
        'Back to caught'),
      el('button.bin', { onclick: () => { removeCapture(capture.id); render(); } }, 'Bin'),
    ));
  }

  row.append(
    el('span.line-when', whenLabel(capture.at)),
    main,
    el('span.tag', { class: sent ? 'sent' : 'note' }, sent ? 'sent' : 'note'),
  );
  return row;
}

function render() {
  listEl.replaceChildren();
  const open = openCaptures();
  const settled = captures().filter((c) => (c.kind || CAPTURE.OPEN) !== CAPTURE.OPEN);

  document.querySelector('.count')?.remove();

  if (open.length) {
    const bar = el('div.bar');
    if (triageConfigured()) {
      bar.appendChild(el('button.primary', { disabled: sorting, onclick: runTriage },
        sorting ? 'Sorting…' : `Sort these ${open.length}`));
    }
    listEl.append(el('p.section-label', `Caught · ${open.length}`), bar);

    if (sorting) listEl.appendChild(el('p.hint', el('span.spinner'), ' Reading them through…'));
    if (failure) listEl.appendChild(el('p.err', failure));
    if (!triageConfigured() && !failure) {
      listEl.appendChild(el('p.hint',
        'Add an Anthropic key in the organizer’s Settings and these can be sorted '
        + 'and reworded for you. Until then, the buttons on each line do the same job.'));
    }
    for (const c of open) listEl.appendChild(captureRow(c));
  } else {
    listEl.appendChild(el('p.empty', 'Nothing waiting. Say something and it lands here.'));
  }

  if (settled.length) {
    listEl.appendChild(el('p.section-label', 'Dealt with'));
    for (const c of settled.slice().reverse().slice(0, 25)) listEl.appendChild(doneRow(c));
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

// Another tab — the organizer, or a second copy of this — writing to the same
// storage. Both apps share one document, so a note caught here while the
// organizer is open must not be lost when that tab next saves over it.
//
// This used to call location.reload(), and on a phone that was miserable. The
// organizer saves far more often than "when something changed": every sync
// poll, and every time it meets an event title it has not assigned a colour
// to. Each of those fired this listener and threw the page away mid-sentence
// — the box emptied, the keyboard dropped, dictation stopped. Re-reading the
// document and redrawing the list gets exactly the same result, and because
// only the list is rebuilt, whatever is half-typed in the box stays put.
window.addEventListener('storage', (e) => {
  // Same key, actually different content. A storage event can carry a write
  // of identical bytes, and redrawing for that is pure churn.
  if (e.key !== 'daily-organizer:v1' || e.newValue === e.oldValue) return;
  store.adoptStored();
});

store.subscribe(() => render());
render();

// The box is the app. Focus it immediately so a thought can go straight in;
// on a phone this puts the caret in without raising the keyboard uninvited.
box.focus({ preventScroll: true });

if (!speechSupported()) {
  micBtn.disabled = true;
  micBtn.title = 'This browser cannot listen — type instead';
}

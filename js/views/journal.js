/* The diary.
 *
 * Two halves that answer different questions. What you *wrote* about a day is
 * the reflection; what you *ticked off* is the record. Neither alone is much
 * use for "how did that go and what next" — the written note without the list
 * forgets what actually happened, and the list without the note is a tally.
 * So every entry shows both, and a day with nothing written but things done
 * still appears, because that is exactly the day worth writing up.
 *
 * Text is stored per day and merged per day, so writing tonight's entry on a
 * phone never collides with an older one edited on a laptop.
 */

import { el, icon, toast } from '../ui.js';
import {
  journalFor, setJournal, journalEntries, completedOn, settings,
  journalSummaryFor, setJournalSummary, dayMaterial, hasDayMaterial,
} from '../state.js';
import { writeUpDay, plainSummary, materialToText, daylogConfigured } from '../daylog.js';
import { todayKey, formatDayLong, formatRelativeDay, formatTime, addDays } from '../dates.js';
import { voice, speechSupported } from '../voice.js';

/* ------------------------------------------------------------------ */
/* The editor, shared by the day view and the diary                    */
/* ------------------------------------------------------------------ */

/** The marker a new line gets. One character, so it never eats the width. */
const BULLET = '• ';

/**
 * The editor currently on screen, if any.
 *
 * Backgrounding the app is the moment text is most likely to be lost: on a
 * phone the page can be frozen without blur ever firing. Both events below are
 * needed because neither is reliable alone — pagehide does not fire on every
 * Android dismissal, and visibilitychange does not fire on a reload.
 */
let liveEditor = null;

const commitLive = () => {
  if (liveEditor?.area.isConnected) liveEditor.commit({ quiet: true });
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') commitLive();
});
window.addEventListener('pagehide', commitLive);

/** Strip any leading list marker from a line — •, -, * or a numbered one. */
function stripMarker(line) {
  return line.replace(/^\s*(?:[•*•-]|\d+[.)])\s*/, '').trim();
}

/**
 * The lines of an entry, markers removed and blanks dropped.
 * Used for display, so an entry written with or without bullets reads the same.
 */
export function entryLines(text) {
  return String(text || '')
    .split('\n')
    .map(stripMarker)
    .filter(Boolean);
}

/**
 * What actually gets stored. A box seeded with "• " and then left alone must
 * save as empty, not as a bullet with nothing after it — otherwise closing the
 * day without writing anything creates an entry that shows up in the diary.
 */
function normalise(text) {
  const lines = String(text || '').split('\n').filter((l) => stripMarker(l));
  return lines.join('\n').trim();
}

/**
 * Enter continues the list; Enter on an empty bullet leaves it.
 *
 * That second half matters as much as the first — without it there is no way
 * to stop making bullets except deleting the one you just got, and the box
 * fights you at the end of every list.
 *
 * Shift+Enter drops a plain line break, for when a point runs to two lines.
 */
function continueBullet(e, area, onChange) {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const { selectionStart: start, selectionEnd: end, value } = area;
  if (start !== end) return;            // a selection replaces normally

  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const line = value.slice(lineStart, start);

  e.preventDefault();
  if (/^\s*•\s*$/.test(line)) {
    // Empty bullet: take it away and break out of the list.
    const next = value.slice(0, lineStart) + '\n' + value.slice(start);
    area.value = next;
    area.selectionStart = area.selectionEnd = lineStart + 1;
  } else {
    const insert = `\n${BULLET}`;
    area.value = value.slice(0, start) + insert + value.slice(end);
    area.selectionStart = area.selectionEnd = start + insert.length;
  }
  onChange();
}

/**
 * A day's entry, editable.
 *
 * Saves while you type, debounced. It used to save only on blur, which on a
 * phone means it often never saved at all: you write the day up, swipe to
 * another app, and blur never fires before the page is frozen. That looked
 * like slow syncing and was actually no syncing. Blur, backgrounding and page
 * dismissal all commit immediately as well, so text cannot be stranded.
 *
 * Saves made while you are still typing do NOT redraw the app. They used to,
 * and the redraw rebuilt this textarea from scratch every 700ms: the caret was
 * put back but the box's own scroll position was not, so from the eighth line
 * on, the view snapped to the top while the cursor stayed at the bottom. You
 * were typing into a box showing something else. The box also grows to its
 * content now, so short entries never scroll internally at all.
 *
 * A redraw can still land here from elsewhere — a sync arriving mid-sentence —
 * which is what `focusId` is for: the caret, the half-typed value and both
 * scroll positions are restored afterwards. See captureFocus in app.js.
 */
export function journalEditor(dateKey, { compact = false } = {}) {
  const entry = journalFor(dateKey);
  const box = el('div.journal-editor', { class: compact ? 'is-compact' : '' });
  const status = el('span.journal-status');

  let saveTimer = null;
  let lastSaved = entry?.text || '';

  /**
   * Grow the box to its content.
   *
   * It used to be a fixed 170px with the overflow scrolling inside it, which
   * is the worst shape for this: a day's write-up runs past seven lines almost
   * immediately, and from then on you are typing into a letterbox. Growing
   * instead means the words stay put where you wrote them.
   *
   * Capped at just over half the window so a very long entry still leaves the
   * page navigable, and the cap is read live rather than stored so rotating a
   * phone re-measures against the new height.
   */
  const fit = () => {
    const max = Math.max(220, Math.round(window.innerHeight * 0.55));
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight + 2, max)}px`;
  };

  /**
   * @param live  true while the box is still being typed in — keeps the app
   *              from redrawing underneath the caret. See setJournal.
   * @param quiet suppress the "Saved" flash, for saves the user did not ask
   *              for (backgrounding the app).
   */
  const commit = ({ live = false, quiet = false } = {}) => {
    clearTimeout(saveTimer);
    const value = normalise(area.value);
    if (value === lastSaved) return;
    lastSaved = value;
    setJournal(dateKey, value, { live });
    if (!quiet) {
      status.textContent = 'Saved';
      setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 1600);
    }
  };

  // Long enough not to write on every keystroke, short enough that putting
  // the phone down mid-sentence still saves before you look away.
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    status.textContent = 'Saving…';
    saveTimer = setTimeout(() => commit({ live: true }), 700);
  };

  const area = el('textarea.journal-text', {
    placeholder: dateKey === todayKey()
      ? 'How did today go? What happened, what got in the way…'
      : 'What happened on this day…',
    value: entry?.text || '',
    rows: compact ? 8 : 14,
    dataset: { focusId: `journal-${dateKey}` },
    oninput: () => { fit(); scheduleSave(); },
    // Fired by the renderer after it restores a half-typed value into a
    // rebuilt box, which needs measuring again before anyone reads its height.
    onrefit: fit,
    onfocus: () => {
      // Start the first bullet for them, so writing a list is the default
      // rather than something you have to set up.
      if (!area.value) {
        area.value = BULLET;
        area.selectionStart = area.selectionEnd = BULLET.length;
      }
    },
    onkeydown: (e) => {
      // Single-letter view shortcuts live on the document; without this,
      // typing "w" here would jump to the week view mid-sentence.
      e.stopPropagation();
      if (e.key === 'Escape') { commit(); e.target.blur(); return; }
      continueBullet(e, area, () => { fit(); scheduleSave(); });
    },
    // Leaving the box is the moment a redraw is free, so this save is not
    // live: the rest of the app catches up with what was written, once.
    onblur: () => commit(),
  });

  // scrollHeight is 0 until the element is in the document, so the first fit
  // has to wait for mount. A timeout rather than rAF, for the same reason the
  // renderer uses one: rAF never fires in a backgrounded tab.
  setTimeout(fit, 0);

  // Hand this editor to the module-level leave handler. Registering listeners
  // here instead would add a pair on every render — and this view re-renders
  // on every sync tick — leaving hundreds pointed at detached textareas.
  liveEditor = { area, commit };

  // Dictation appends rather than replaces: you talk through a day in pieces,
  // and a second burst that wiped the first would be worse than useless.
  const mic = el('button.btn.btn-quiet.journal-mic', {
    type: 'button',
    title: speechSupported() ? 'Dictate' : 'This browser cannot listen — type instead',
    disabled: !speechSupported(),
    onclick: () => {
      if (voice.listening) {
        voice.stop();
        return;
      }
      // Dictated speech becomes its own bullet, so talking through a day
      // produces the same list as typing one.
      const trimmed = area.value.replace(/\s+$/, '');
      const before = trimmed && !/(^|\n)\s*•\s*$/.test(trimmed) ? `${trimmed}\n${BULLET}` : (trimmed || BULLET);
      mic.classList.add('is-live');
      status.textContent = 'Listening…';
      voice.start({
        continuous: true,
        onInterim: (final, interim) => {
          area.value = before + final + interim;
          fit();
          area.scrollTop = area.scrollHeight;
        },
        onFinal: (text) => {
          area.value = before + text;
          fit();
          commit();
          toast('Entry saved');
        },
        onError: (message) => toast(message, { error: true }),
        onEnd: () => {
          mic.classList.remove('is-live');
          status.textContent = '';
        },
      });
    },
  }, icon('mic', 'icon'), 'Dictate');

  box.append(
    area,
    el('div.journal-tools',
      mic,
      status,
      entry?.updatedAt
        ? el('span.journal-saved', `saved ${formatRelativeDay(entry.updatedAt.slice(0, 10))}`)
        : null,
    ),
  );
  return box;
}

/**
 * A written entry, as a list.
 *
 * A single line is left as a sentence — one bullet is not a list, it is a
 * sentence with a dot in front of it.
 */
function entryBody(text) {
  const lines = entryLines(text);
  if (lines.length <= 1) return el('p.journal-entry-text', lines[0] || '');
  return el('ul.journal-bullets', lines.map((line) => el('li', line)));
}

/* ------------------------------------------------------------------ */
/* What got done that day                                              */
/* ------------------------------------------------------------------ */

function doneList(dateKey) {
  const done = completedOn(dateKey);
  if (!done.length) return null;
  const cfg = settings();
  return el('div.journal-done',
    el('div.journal-done-head',
      icon('check', 'icon'),
      `${done.length} finished`),
    el('ul.journal-done-list', done.map((item) => el('li',
      item.time ? el('span.journal-done-time', formatTime(item.time, cfg.hour12)) : null,
      item.title || 'Untitled',
    ))),
  );
}

/* ------------------------------------------------------------------ */
/* The day, written up                                                 */
/* ------------------------------------------------------------------ */

/** Days currently being written up, so the button can show it. */
const busy = new Set();
/** Days whose "what gets sent" panel is open. */
const showingSource = new Set();

function rerender() {
  document.dispatchEvent(new CustomEvent('organizer:rerender'));
}

/**
 * The written-up paragraph for a day, with the control to make or remake it.
 *
 * Sits BELOW your own writing and in its own box, never inside it. The two are
 * different kinds of thing: one is what you thought, the other is what the app
 * can see you did, and folding the second into the first would mean the app
 * editing your diary. It is also stored separately, so writing a summary can
 * never touch a sentence you typed.
 */
function daySummary(dateKey) {
  const material = dayMaterial(dateKey);
  const saved = journalSummaryFor(dateKey);
  const working = busy.has(dateKey);

  // Nothing happened and nothing was written: there is nothing to write up,
  // and an empty box inviting you to summarise it would be silly.
  if (!saved && !hasDayMaterial(material)) return null;

  const box = el('div.day-summary', { class: saved ? 'has-text' : '' });

  box.appendChild(el('div.day-summary-head',
    el('span.day-summary-label', 'The day, written up'),
    saved ? el('span.day-summary-when', 'saved') : null,
  ));

  if (saved) {
    box.appendChild(el('p.day-summary-text', saved.text));
  } else if (!working) {
    // Show what it WOULD say before spending anything on wording it. With no
    // key this is also the finished article, so it is not a preview then.
    const preview = plainSummary(material, { hour12: settings().hour12 });
    if (preview) box.appendChild(el('p.day-summary-preview', preview));
  }

  if (working) {
    box.appendChild(el('p.day-summary-working', el('span.spinner'), 'Writing it up…'));
  }

  const actions = el('div.day-summary-actions');

  actions.appendChild(el('button.btn.btn-quiet', {
    disabled: working,
    onclick: async () => {
      busy.add(dateKey);
      rerender();
      try {
        const result = await writeUpDay(material, { hour12: settings().hour12 });
        if (result.text) {
          setJournalSummary(dateKey, result.text);
          if (result.error) toast(result.error);
        } else {
          toast('Nothing recorded for that day to write up.');
        }
      } finally {
        busy.delete(dateKey);
        rerender();
      }
    },
  }, saved ? 'Write it again' : 'Write it up'));

  if (saved) {
    actions.appendChild(el('button.btn.btn-quiet', {
      onclick: () => { setJournalSummary(dateKey, ''); rerender(); },
    }, 'Clear'));
  }

  // Only worth offering when something actually leaves the device.
  if (daylogConfigured()) {
    actions.appendChild(el('button.btn.btn-quiet.day-summary-peek', {
      onclick: () => {
        if (showingSource.has(dateKey)) showingSource.delete(dateKey);
        else showingSource.add(dateKey);
        rerender();
      },
    }, showingSource.has(dateKey) ? 'Hide what gets sent' : 'What gets sent'));
  }

  box.appendChild(actions);

  if (showingSource.has(dateKey)) {
    box.appendChild(el('pre.day-summary-source',
      materialToText(material, { hour12: settings().hour12 })));
  }

  if (!daylogConfigured() && !saved) {
    box.appendChild(el('p.field-hint',
      'Written from what the app recorded. Add an Anthropic key in Settings and ',
      'Claude will word it as a paragraph instead of a list of facts.'));
  }

  return box;
}

/* ------------------------------------------------------------------ */
/* The diary view                                                      */
/* ------------------------------------------------------------------ */

export function journalView({ onNavigate }) {
  const root = el('div.journal-view.view-anim');
  const today = todayKey();

  root.appendChild(el('header.journal-head',
    el('h1.journal-title', 'Diary'),
    el('p.journal-sub',
      'What happened, and what you finished. Write it as you go, or dictate it.'),
  ));

  // Today is always first and always open, written or not — the whole point is
  // to make writing tonight's entry the path of least resistance.
  root.appendChild(el('section.journal-entry.is-today',
    el('div.journal-entry-head',
      el('div',
        el('span.journal-entry-day', 'Today'),
        el('span.journal-entry-date', formatDayLong(today)),
      ),
    ),
    journalEditor(today),
    doneList(today),
    daySummary(today),
  ));

  // Every other day that has something to show: a written entry, or things
  // finished. Days with neither are not worth a heading.
  const written = new Map(journalEntries().map((e) => [e.date, e]));
  const days = new Set(written.keys());
  for (let i = 1; i <= 90; i++) {
    const key = addDays(today, -i);
    if (completedOn(key).length) days.add(key);
  }
  days.delete(today);

  const past = [...days].sort().reverse();
  if (!past.length) {
    root.appendChild(el('div.empty-state',
      el('div.empty-icon', '·'),
      el('p', 'No earlier days yet'),
      el('p.empty-hint', 'Entries you write, and days you finish something, collect here.'),
    ));
    return root;
  }

  for (const key of past) {
    const entry = written.get(key);
    root.appendChild(el('section.journal-entry',
      el('button.journal-entry-head', {
        title: 'Open this day',
        onclick: () => onNavigate({ view: 'day', anchor: key }),
      },
        el('div',
          el('span.journal-entry-day', formatRelativeDay(key)),
          el('span.journal-entry-date', formatDayLong(key)),
        ),
        icon('chevronRight', 'icon'),
      ),
      entry
        ? entryBody(entry.text)
        : el('p.journal-entry-empty', 'Nothing written for this day.'),
      doneList(key),
      daySummary(key),
    ));
  }

  return root;
}

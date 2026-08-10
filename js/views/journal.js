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
import { journalFor, setJournal, journalEntries, completedOn, settings } from '../state.js';
import { todayKey, formatDayLong, formatRelativeDay, formatTime, addDays } from '../dates.js';
import { voice, speechSupported } from '../voice.js';

/* ------------------------------------------------------------------ */
/* The editor, shared by the day view and the diary                    */
/* ------------------------------------------------------------------ */

/**
 * A day's entry, editable.
 *
 * Saves on blur rather than per keystroke: every save re-renders, and
 * re-rendering mid-sentence is how you lose a paragraph. `focusId` keeps the
 * caret across the re-renders that do happen.
 */
export function journalEditor(dateKey, { compact = false } = {}) {
  const entry = journalFor(dateKey);
  const box = el('div.journal-editor', { class: compact ? 'is-compact' : '' });

  const area = el('textarea.journal-text', {
    placeholder: dateKey === todayKey()
      ? 'How did today go? What happened, what got in the way, what is worth remembering…'
      : 'What happened on this day…',
    value: entry?.text || '',
    rows: compact ? 4 : 7,
    dataset: { focusId: `journal-${dateKey}` },
    onkeydown: (e) => {
      // Single-letter view shortcuts live on the document; without this,
      // typing "w" here would jump to the week view mid-sentence.
      e.stopPropagation();
      if (e.key === 'Escape') e.target.blur();
    },
    onblur: (e) => {
      const value = e.target.value;
      if (value.trim() !== (entry?.text || '')) {
        setJournal(dateKey, value);
        toast(value.trim() ? 'Entry saved' : 'Entry cleared');
      }
    },
  });

  const status = el('span.journal-status');

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
      const before = area.value;
      const join = before && !/\s$/.test(before) ? ' ' : '';
      mic.classList.add('is-live');
      status.textContent = 'Listening…';
      voice.start({
        continuous: true,
        onInterim: (final, interim) => {
          area.value = before + join + final + interim;
          area.scrollTop = area.scrollHeight;
        },
        onFinal: (text) => {
          area.value = before + join + text;
          setJournal(dateKey, area.value);
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
        ? el('p.journal-entry-text', entry.text)
        : el('p.journal-entry-empty', 'Nothing written for this day.'),
      doneList(key),
    ));
  }

  return root;
}

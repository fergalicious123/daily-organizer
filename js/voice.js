/* Voice capture and the natural-language parser.
 *
 * ---------------------------------------------------------------------------
 * SPEECH CAPTURE IS CURRENTLY SWITCHED OFF (2026-08-07, at Ben's request).
 *
 * `parseCommand` below is still very much in use — it is what lets the
 * quick-add boxes understand "call mum tomorrow at 3" — so this file stays.
 * Only the microphone UI is unwired.
 *
 * To restore it:
 *   1. index.html — put back the #micFab button and the #voicePanel div
 *   2. js/app.js  — import createVoicePanel/speechSupported, recreate the
 *      voicePanel const, re-add the header mic button, the FAB listener, and
 *      the 'v' / '/' / Escape keyboard cases
 * Nothing below needs changing; `createVoicePanel` and `speechSupported` are
 * still exported and working.
 * ---------------------------------------------------------------------------
 *
 * Speech-to-text uses the browser's built-in Web Speech API — free, no key,
 * no network setup. It is Chrome/Edge (and Android Chrome) only, so the typed
 * fallback is not a nicety: on unsupported browsers it IS the feature.
 *
 * The parser is deliberately rule-based rather than a model call: it runs
 * offline, instantly, and costs nothing. It handles the phrasings that
 * actually come up. Anything it cannot place stays in the title, and the
 * preview always shows what it understood BEFORE anything is saved — a
 * misheard command must never silently create a wrong event.
 */

import { el, icon, toast } from './ui.js';
import { todayKey, addDays, fromKey, toKey, DAY_NAMES } from './dates.js';
import { store, PRIORITY, addItem, settings } from './state.js';

/* ------------------------------------------------------------------ */
/* Speech recognition                                                  */
/* ------------------------------------------------------------------ */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function speechSupported() {
  return Boolean(SpeechRecognition);
}

class VoiceCapture {
  constructor() {
    this.recognition = null;
    this.listening = false;
  }

  start({ onInterim, onFinal, onError, onEnd }) {
    if (!SpeechRecognition) {
      onError?.('This browser cannot listen. Type it instead — the parsing is identical.');
      return false;
    }
    this.stop();

    const rec = new SpeechRecognition();
    rec.lang = navigator.language || 'en-GB';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let finalText = '';

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) onInterim?.(finalText, interim);
      if (finalText) onInterim?.(finalText, '');
    };

    rec.onerror = (event) => {
      const messages = {
        'no-speech': 'Did not catch that.',
        'not-allowed': 'Microphone access was blocked. Allow it in your browser settings.',
        'service-not-allowed': 'Microphone access was blocked.',
        'audio-capture': 'No microphone found.',
        network: 'Speech recognition needs a connection. Type it instead.',
      };
      onError?.(messages[event.error] || `Could not listen (${event.error}).`);
    };

    rec.onend = () => {
      this.listening = false;
      if (finalText.trim()) onFinal?.(finalText.trim());
      onEnd?.();
    };

    this.recognition = rec;
    this.listening = true;
    try {
      rec.start();
    } catch {
      this.listening = false;
      onError?.('Already listening.');
      return false;
    }
    return true;
  }

  stop() {
    if (this.recognition) {
      try { this.recognition.stop(); } catch { /* already stopped */ }
      this.recognition = null;
    }
    this.listening = false;
  }
}

export const voice = new VoiceCapture();

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45,
  sixty: 60, ninety: 90,
};

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

const DAY_LOOKUP = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/**
 * Turn a spoken/typed phrase into item fields.
 * Returns { title, date, time, durationMin, priority, listId, recur,
 *           remindMin, kind, dateExplicit, matched[] }
 */
export function parseCommand(input) {
  const original = String(input || '').trim();
  let text = ' ' + original.toLowerCase() + ' ';
  const matched = [];

  const out = {
    title: '',
    date: null,
    time: null,
    durationMin: null,
    priority: PRIORITY.NONE,
    listId: null,
    recur: null,
    remindMin: null,
    kind: 'task',
    dateExplicit: false,
  };

  /** Cut a matched span out of the working text so it never lands in the title. */
  const consume = (regex, handler) => {
    const m = text.match(regex);
    if (!m) return false;
    const keep = handler(m);
    if (keep === false) return false;
    text = text.replace(m[0], ' ');
    matched.push(m[0].trim());
    return true;
  };

  /* ---- leading verbs: "remind me to", "add", "schedule" ---- */
  consume(/\b(?:please\s+)?(?:can you\s+)?(?:remind me to|remind me|reminder to|remember to|don'?t forget to)\b/, () => {
    out.remindMin = settings().defaultRemindMin;
    return true;
  });
  // "book" is deliberately absent: it is far more often a real verb
  // ("book flights") than a scheduling filler, and swallowing it loses the
  // task's meaning. Event-ness is inferred from the nouns below instead.
  consume(/\b(?:add|create|make|new|schedule|put in)\b(?:\s+an?)?\s*(?:task|event|reminder|appointment)?/, (m) => {
    if (/event|appointment|meeting/.test(m[0])) out.kind = 'event';
    return true;
  });

  /* ---- explicit event nouns ---- */
  if (/\b(meeting|appointment|call with|dentist|doctor|interview|lunch with|dinner with|flight|train)\b/.test(text)) {
    out.kind = 'event';
  }

  /* ---- priority ---- */
  consume(/\b(urgent|asap|high priority|important|top priority)\b/, () => {
    out.priority = PRIORITY.HIGH;
    return true;
  });
  consume(/\b(medium priority|normal priority)\b/, () => { out.priority = PRIORITY.MEDIUM; return true; });
  consume(/\b(low priority|whenever|someday|no rush)\b/, () => { out.priority = PRIORITY.LOW; return true; });

  /* ---- recurrence (before date, so "every Monday" isn't eaten as a date) ---- */
  consume(/\bevery\s+(day|morning|night|weekday|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/,
    (m) => {
      const unit = m[1];
      if (unit === 'day' || unit === 'morning' || unit === 'night') {
        out.recur = { freq: 'daily', interval: 1 };
      } else if (unit === 'weekday') {
        out.recur = { freq: 'weekly', byDay: [1, 2, 3, 4, 5] };
      } else if (unit === 'week') {
        out.recur = { freq: 'weekly', interval: 1 };
      } else if (unit === 'month') {
        out.recur = { freq: 'monthly', interval: 1 };
      } else {
        const dow = DAY_LOOKUP[unit];
        out.recur = { freq: 'weekly', byDay: [dow] };
        if (!out.date) {
          out.date = nextWeekday(dow);
          out.dateExplicit = true;
        }
      }
      return true;
    });

  consume(/\bevery\s+(\d+|two|three|four)\s+(days?|weeks?|months?)\b/, (m) => {
    const n = Number(m[1]) || NUMBER_WORDS[m[1]] || 1;
    const freq = m[2].startsWith('day') ? 'daily' : m[2].startsWith('week') ? 'weekly' : 'monthly';
    out.recur = { freq, interval: n };
    return true;
  });

  /* ---- duration ---- */
  consume(/\bfor\s+(\d+|an?|half an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|forty[- ]?five|sixty|ninety)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/,
    (m) => {
      let n;
      if (/^\d+$/.test(m[1])) n = Number(m[1]);
      else if (/^an?$/.test(m[1]) || m[1] === 'one') n = 1;
      else if (m[1] === 'half an') n = 0.5;
      else n = NUMBER_WORDS[m[1].replace(/[- ]/g, '')] ?? NUMBER_WORDS[m[1]] ?? 1;
      const isHours = /^h/.test(m[2]);
      out.durationMin = Math.round(isHours ? n * 60 : n);
      return true;
    });

  /* ---- reminder lead time ---- */
  consume(/\b(\d+)\s*(minutes?|mins?|hours?|hrs?)\s+(?:before|ahead|early)\b/, (m) => {
    const n = Number(m[1]);
    out.remindMin = /^h/.test(m[2]) ? n * 60 : n;
    return true;
  });

  /* ---- relative dates ---- */
  consume(/\bday after tomorrow\b/, () => { out.date = addDays(todayKey(), 2); out.dateExplicit = true; return true; });
  consume(/\btomorrow\b/, () => { out.date = addDays(todayKey(), 1); out.dateExplicit = true; return true; });
  consume(/\btoday\b/, () => { out.date = todayKey(); out.dateExplicit = true; return true; });
  consume(/\btonight\b/, () => {
    out.date = todayKey();
    out.dateExplicit = true;
    if (!out.time) out.time = '19:00';
    return true;
  });

  consume(/\bin\s+(\d+|a|one|two|three|four|five|six|seven|ten|fourteen)\s+(days?|weeks?|months?)\b/, (m) => {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : (m[1] === 'a' ? 1 : NUMBER_WORDS[m[1]] ?? 1);
    const unit = m[2];
    if (unit.startsWith('day')) out.date = addDays(todayKey(), n);
    else if (unit.startsWith('week')) out.date = addDays(todayKey(), n * 7);
    else {
      const d = fromKey(todayKey());
      d.setMonth(d.getMonth() + n);
      out.date = toKey(d);
    }
    out.dateExplicit = true;
    return true;
  });

  /* ---- weekday names ---- */
  consume(/\b(?:on\s+|this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/,
    (m) => {
      const dow = DAY_LOOKUP[m[1]];
      if (dow == null) return false;
      const isNext = /next/.test(m[0]);
      out.date = nextWeekday(dow, isNext);
      out.dateExplicit = true;
      return true;
    });

  consume(/\bnext week\b/, () => { out.date = addDays(todayKey(), 7); out.dateExplicit = true; return true; });

  /* ---- explicit dates: "on 14 August", "August 14", "14/08" ---- */
  consume(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/, (m) => {
    out.date = resolveMonthDay(MONTHS[m[2]], Number(m[1]));
    out.dateExplicit = true;
    return true;
  });
  consume(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/, (m) => {
    out.date = resolveMonthDay(MONTHS[m[1]], Number(m[2]));
    out.dateExplicit = true;
    return true;
  });
  consume(/\b(?:on\s+)?(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/, (m) => {
    // Day-first: the app is en-GB.
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    if (month < 0 || month > 11 || day < 1 || day > 31) return false;
    let year = m[3] ? Number(m[3]) : fromKey(todayKey()).getFullYear();
    if (year < 100) year += 2000;
    out.date = toKey(new Date(year, month, day));
    out.dateExplicit = true;
    return true;
  });
  consume(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/, (m) => {
    out.date = resolveDayOfMonth(Number(m[1]));
    out.dateExplicit = true;
    return true;
  });

  /* ---- times ---- */
  consume(/\bat\s+(\d{1,2})[:.](\d{2})\s*(am|pm)?\b|\b(\d{1,2})[:.](\d{2})\s*(am|pm)\b/, (m) => {
    const h = Number(m[1] ?? m[4]);
    const min = Number(m[2] ?? m[5]);
    const suffix = m[3] ?? m[6];
    out.time = to24h(h, min, suffix);
    return true;
  });
  consume(/\b(?:at\s+)?(\d{1,2})\s*(am|pm)\b/, (m) => {
    out.time = to24h(Number(m[1]), 0, m[2]);
    return true;
  });
  consume(/\bat\s+(\d{1,2})\b/, (m) => {
    const h = Number(m[1]);
    if (h > 23) return false;
    // Bare "at 3" almost always means the afternoon in conversation.
    out.time = to24h(h, 0, h >= 1 && h <= 7 ? 'pm' : null);
    return true;
  });
  consume(/\bhalf past\s+(\d{1,2})\b/, (m) => {
    out.time = to24h(Number(m[1]), 30, Number(m[1]) <= 7 ? 'pm' : null);
    return true;
  });
  consume(/\b(quarter past)\s+(\d{1,2})\b/, (m) => {
    out.time = to24h(Number(m[2]), 15, Number(m[2]) <= 7 ? 'pm' : null);
    return true;
  });
  consume(/\bquarter to\s+(\d{1,2})\b/, (m) => {
    const h = Number(m[1]);
    out.time = to24h(h === 1 ? 12 : h - 1, 45, h <= 8 ? 'pm' : null);
    return true;
  });
  consume(/\b(?:in the\s+)?(morning|afternoon|evening|midday|noon|midnight)\b/, (m) => {
    if (out.time) return false;
    out.time = { morning: '09:00', afternoon: '14:00', evening: '19:00', midday: '12:00', noon: '12:00', midnight: '00:00' }[m[1]];
    return true;
  });

  /* ---- target list: "to my shopping list", "in work" ---- */
  consume(/\b(?:to|on|in)\s+(?:my\s+|the\s+)?([a-z][a-z ]{1,20}?)\s*list\b/, (m) => {
    const name = m[1].trim();
    const list = store.state.lists.find((l) => l.name.toLowerCase() === name);
    if (!list) return false;
    out.listId = list.id;
    return true;
  });

  /* ---- tidy up the leftover title ---- */
  let title = text
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:to|that|a|an|the|me|my|and|for|at|on|in)\s+/i, '')
    .replace(/\s+(?:to|that|and|for|at|on|in|by)\s*$/i, '')
    .trim();

  // Recover the original casing where we can, so "Call Mum" survives.
  out.title = restoreCasing(original, title);

  // A timed item with no date means today (or tomorrow if the time has passed).
  if (out.time && !out.date) {
    const now = new Date();
    const [h, min] = out.time.split(':').map(Number);
    const passed = h * 60 + min < now.getHours() * 60 + now.getMinutes();
    out.date = passed ? addDays(todayKey(), 1) : todayKey();
  }

  // A weekday-restricted series must start on a day it actually occurs:
  // "standup every weekday at 9:15" said on a Saturday should land on Monday,
  // not on tomorrow's Sunday.
  if (out.recur?.freq === 'weekly' && out.recur.byDay?.length) {
    const start = out.date || todayKey();
    let cursor = start;
    for (let i = 0; i < 7 && !out.recur.byDay.includes(fromKey(cursor).getDay()); i++) {
      cursor = addDays(cursor, 1);
    }
    out.date = cursor;
    out.dateExplicit = true;
  }
  // Reminder verbs with no lead time get the default.
  if (out.remindMin == null && /remind/.test(original.toLowerCase()) && out.time) {
    out.remindMin = settings().defaultRemindMin;
  }
  if (out.time && !out.durationMin && out.kind === 'event') {
    out.durationMin = settings().defaultDurationMin;
  }

  out.matched = matched;
  return out;
}

/* ---- parser helpers ---- */

function to24h(hour, minute, suffix) {
  let h = hour;
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  if (h > 23) h = 23;
  return `${String(h).padStart(2, '0')}:${String(Math.min(minute, 59)).padStart(2, '0')}`;
}

/** The next occurrence of a weekday. "next Monday" skips the imminent one. */
function nextWeekday(dow, forceNextWeek = false) {
  const today = fromKey(todayKey());
  let delta = (dow - today.getDay() + 7) % 7;
  if (delta === 0) delta = 7;              // "Monday" said on a Monday means the next one
  if (forceNextWeek && delta < 7) delta += 7;
  return addDays(todayKey(), delta);
}

/** A month/day with no year resolves forward, never into the past. */
function resolveMonthDay(month, day) {
  const today = fromKey(todayKey());
  let year = today.getFullYear();
  let candidate = new Date(year, month, day);
  if (candidate < today) candidate = new Date(year + 1, month, day);
  return toKey(candidate);
}

function resolveDayOfMonth(day) {
  const today = fromKey(todayKey());
  let candidate = new Date(today.getFullYear(), today.getMonth(), day);
  if (candidate < today) candidate = new Date(today.getFullYear(), today.getMonth() + 1, day);
  return toKey(candidate);
}

/**
 * The parser works in lower case; this walks the original string and returns
 * the surviving words with their original capitalisation.
 */
function restoreCasing(original, lowered) {
  if (!lowered) return '';
  const originalWords = original.split(/\s+/);
  const loweredWords = lowered.split(/\s+/);
  const result = [];
  let cursor = 0;
  for (const word of loweredWords) {
    const found = originalWords.findIndex(
      (o, i) => i >= cursor && o.toLowerCase().replace(/[^a-z0-9']/g, '') === word.replace(/[^a-z0-9']/g, ''),
    );
    if (found >= 0) {
      result.push(originalWords[found]);
      cursor = found + 1;
    } else {
      result.push(word);
    }
  }
  const out = result.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/* ------------------------------------------------------------------ */
/* Voice panel UI                                                      */
/* ------------------------------------------------------------------ */

/**
 * The capture panel. Nothing is saved until the user confirms the preview.
 */
export function createVoicePanel(host, { onSaved } = {}) {
  let pending = null;

  function close() {
    voice.stop();
    host.hidden = true;
    host.replaceChildren();
    pending = null;
  }

  function renderPreview(parsed, sourceText) {
    pending = parsed;
    const chips = [];
    if (parsed.date) chips.push(el('span.chip.is-today', parsed.date));
    if (parsed.time) chips.push(el('span.chip', parsed.time));
    if (parsed.durationMin) chips.push(el('span.chip', `${parsed.durationMin} min`));
    if (parsed.recur) chips.push(el('span.chip.is-recur', icon('repeat', 'icon'), 'repeats'));
    if (parsed.remindMin != null) chips.push(el('span.chip.is-remind', icon('bell', 'icon'), `${parsed.remindMin}m before`));
    if (parsed.priority) chips.push(el('span.chip', ['', 'low', 'medium', 'high'][parsed.priority]));
    chips.push(el('span.chip', parsed.kind));

    host.replaceChildren(
      el('div.voice-status', el('span', 'Is this right?')),
      el('div.voice-preview',
        el('div.voice-preview-title', parsed.title || '(no title heard)'),
        el('div.voice-preview-meta', chips),
        !parsed.date ? el('p.field-hint', 'No date — this will go to your unscheduled list.') : null,
      ),
      el('div.voice-actions',
        el('button.btn', { onclick: close }, 'Cancel'),
        el('button.btn', {
          onclick: () => { close(); openEditorFromParse(parsed); },
        }, 'Edit first'),
        el('button.btn.btn-primary', {
          onclick: () => {
            if (!pending?.title) { toast('Nothing to save.', { error: true }); return; }
            const fields = { ...pending };
            delete fields.matched;
            delete fields.dateExplicit;
            if (!fields.listId) delete fields.listId;
            const item = addItem(fields);
            close();
            toast(`Added “${item.title}”`, { action: 'Undo', onAction: () => store.undo() });
            onSaved?.(item);
          },
        }, 'Add it'),
      ),
      el('p.voice-examples', `Heard: “${sourceText}”`),
    );
    host.hidden = false;
  }

  function openEditorFromParse(parsed) {
    // Lazy import avoids a cycle between voice.js and the views.
    import('./views/tasks.js').then(({ openItemEditor }) => {
      const presets = { ...parsed };
      delete presets.matched;
      delete presets.dateExplicit;
      openItemEditor(null, presets);
    });
  }

  /** Start listening and show the live transcript. */
  function startListening() {
    const transcript = el('div.voice-transcript');
    host.replaceChildren(
      el('div.voice-status', el('span.dot'), el('span', 'Listening')),
      transcript,
      el('p.voice-examples',
        'Try: ', el('code', 'remind me to call mum tomorrow at 3'), ' · ',
        el('code', 'gym every monday 7am'), ' · ',
        el('code', 'dentist on the 14th for an hour'),
      ),
      el('div.voice-actions',
        el('button.btn', { onclick: close }, 'Cancel'),
        el('button.btn', { onclick: () => voice.stop() }, 'Done'),
      ),
    );
    host.hidden = false;

    const ok = voice.start({
      onInterim: (final, interim) => {
        transcript.replaceChildren(
          document.createTextNode(final),
          interim ? el('span.interim', ' ' + interim) : document.createTextNode(''),
        );
      },
      onFinal: (text) => renderPreview(parseCommand(text), text),
      onError: (message) => {
        toast(message, { error: true });
        showTypedFallback(message);
      },
    });
    if (!ok) showTypedFallback();
  }

  /** The typed path — also what unsupported browsers get. */
  function showTypedFallback(reason = '') {
    const input = el('input', {
      type: 'text',
      placeholder: 'remind me to call mum tomorrow at 3',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          const v = input.value.trim();
          if (v) renderPreview(parseCommand(v), v);
        }
        if (e.key === 'Escape') close();
      },
    });
    host.replaceChildren(
      el('div.voice-status', el('span', reason ? 'Type it instead' : 'Add by text')),
      el('div.voice-input',
        input,
        el('button.btn.btn-primary', {
          onclick: () => {
            const v = input.value.trim();
            if (v) renderPreview(parseCommand(v), v);
          },
        }, 'Parse'),
      ),
      el('p.voice-examples',
        'Try: ', el('code', 'remind me to call mum tomorrow at 3'), ' · ',
        el('code', 'gym every monday 7am'), ' · ',
        el('code', 'team meeting friday 2pm for 90 minutes'),
      ),
      el('div.voice-actions', el('button.btn', { onclick: close }, 'Cancel')),
    );
    host.hidden = false;
    requestAnimationFrame(() => input.focus());
  }

  return {
    open() {
      if (speechSupported()) startListening();
      else showTypedFallback('This browser cannot listen');
    },
    openTyped: showTypedFallback,
    close,
    get isOpen() { return !host.hidden; },
  };
}

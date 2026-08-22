/* The review — one block, read back.
 *
 * This is the second half of a loop whose first half is the mic on a task. You
 * talk into things as you do them across four days and four nights; at the end
 * of the block this puts all of it in one place, in the order it happened, and
 * asks what should come of it.
 *
 * The page works completely without Claude. Gathering, ordering and reading
 * back is the part that has to be right, and it is done by rules — so a review
 * is always available, offline, with no key, for nothing. Claude is the last
 * section on the page and it only ever suggests.
 */

import { el, icon, toast } from '../ui.js';
import { openItemEditor } from './tasks.js';
import {
  reflectionMaterial, shiftBlock, markReviewed, addItem, SHIFT, NOTE_SOURCE,
} from '../state.js';
import { todayKey, addDays, formatDayShort, formatDayLong } from '../dates.js';
import {
  proposeActions, reflectConfigured, materialToText, hasMaterial,
} from '../reflect.js';

const SHIFT_LABEL = {
  [SHIFT.NIGHT]: 'nights',
  [SHIFT.DAY]: 'days',
  [SHIFT.ONCALL]: 'on call',
  [SHIFT.TRAINING]: 'training',
  [SHIFT.OTHER]: 'shift',
};

/*
 * Presentation state, deliberately module-level.
 *
 * The whole app redraws on every change, so anything held inside the view
 * function is lost the moment a sync tick lands — including a set of proposals
 * that cost real money to produce. Keeping them out here means a background
 * sync during a review does not throw the answer away.
 */
let range = 'block';           // block | 7 | 14
let result = null;             // { reflection, proposals, sourceText }
let pending = false;
let failure = '';
let showSource = false;
// Indices, not quote text. Two proposals can legitimately cite the same line —
// one note often implies more than one job — and keying by the quote made
// dealing with either of them silently remove both.
const dismissed = new Set();

/** Reset everything the previous review left behind. */
function clearResult() {
  result = null;
  failure = '';
  dismissed.clear();
  showSource = false;
}

/**
 * The days a review covers.
 *
 * The default is the block you just finished, because that is the unit the
 * work actually comes in. The fixed windows are there for the times it does
 * not line up — a stretch of leave, or a block you never got round to.
 */
function rangeFor(choice) {
  const today = todayKey();
  if (choice === '7') return { from: addDays(today, -6), to: today, label: 'Last 7 days' };
  if (choice === '14') return { from: addDays(today, -13), to: today, label: 'Last 14 days' };

  const block = shiftBlock(today);
  if (!block) return { from: addDays(today, -6), to: today, label: 'Last 7 days' };
  return {
    from: block.start,
    to: block.end,
    // "Last block" is only true once it is over. Opening this three nights
    // into four and being told you are reading back the LAST block, when the
    // dates plainly include today, is the kind of small wrongness that makes
    // you stop trusting the bigger numbers on the page.
    label: block.ended
      ? `Last block — ${SHIFT_LABEL[block.kind] || 'shift'}`
      : `This block so far — ${SHIFT_LABEL[block.kind] || 'shift'}`,
    block,
  };
}

export function reviewView() {
  const span = rangeFor(range);
  const material = reflectionMaterial(span.from, span.to);
  const root = el('div.review');

  root.appendChild(header(span, material));

  if (!hasMaterial(material)) {
    root.appendChild(el('div.review-empty',
      icon('book', 'icon review-empty-icon'),
      el('p.review-empty-title', 'Nothing written in this stretch'),
      el('p.review-empty-body',
        'Notes you dictate onto tasks and anything you write in the diary show up here. ',
        'Open a task and press the mic to add one.'),
    ));
    return root;
  }

  root.appendChild(readback(material));
  root.appendChild(claudeSection(material));
  return root;
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function header(span, material) {
  const counts = [
    material.journal.length ? `${material.journal.length} diary` : null,
    material.notes.length ? `${material.notes.length} note${material.notes.length === 1 ? '' : 's'}` : null,
    material.done.length ? `${material.done.length} finished` : null,
    material.slipped.length ? `${material.slipped.length} slipped` : null,
  ].filter(Boolean);

  const pills = el('div.pill-row.review-ranges',
    ...[['block', 'This block'], ['7', '7 days'], ['14', '14 days']].map(([value, label]) =>
      el('button.pill', {
        class: range === value ? 'is-active' : '',
        onclick: () => {
          if (range === value) return;
          range = value;
          // A previous answer describes a different stretch of time. Keeping it
          // on screen under a new heading would be a quiet lie.
          clearResult();
          document.dispatchEvent(new CustomEvent('organizer:rerender'));
        },
      }, label)),
  );

  return el('div.review-head',
    el('div.review-head-top',
      el('div',
        el('h2.review-title', span.label),
        el('p.review-dates',
          span.from === span.to
            ? formatDayLong(span.from)
            : `${formatDayShort(span.from)} — ${formatDayShort(span.to)}`),
      ),
      pills,
    ),
    counts.length ? el('p.review-counts', counts.join(' · ')) : null,
  );
}

/* ------------------------------------------------------------------ */
/* Reading it back                                                     */
/* ------------------------------------------------------------------ */

function readback(material) {
  const wrap = el('div.review-body');

  if (material.journal.length) {
    wrap.appendChild(section('Diary', material.journal.map((entry) =>
      el('article.review-entry',
        el('h4.review-entry-day', formatDayShort(entry.date)),
        el('p.review-entry-text', entry.text),
      ))));
  }

  if (material.notes.length) {
    // Grouped by the thing they are about rather than left in one long stream:
    // four separate remarks about the same job across a block is a different
    // signal from four remarks about four jobs, and the grouping is what makes
    // that visible at a glance.
    const byItem = new Map();
    for (const note of material.notes) {
      if (!byItem.has(note.itemId)) byItem.set(note.itemId, []);
      byItem.get(note.itemId).push(note);
    }

    wrap.appendChild(section('Notes you made', [...byItem.entries()].map(([itemId, notes]) =>
      el('article.review-entry',
        // Opens the item itself rather than navigating to a list. The first
        // version of this passed a `focusItem` key to navigate(), which nothing
        // anywhere handled — so it jumped to Unscheduled, which need not even
        // contain the task, and left a dead key in the persisted route.
        el('button.review-entry-day.review-entry-link', {
          type: 'button',
          title: 'Open this task',
          onclick: () => openItemEditor(itemId),
        }, notes[0].itemTitle),
        ...notes.map((note) => el('p.review-note',
          el('span.review-note-when', formatDayShort(note.day)),
          note.source === NOTE_SOURCE.VOICE ? icon('mic', 'icon review-note-src') : null,
          note.source === NOTE_SOURCE.PASTE ? icon('clipboard', 'icon review-note-src') : null,
          el('span', note.text),
        )),
      ))));
  }

  if (material.done.length) {
    wrap.appendChild(section(`Finished (${material.done.length})`, [
      el('ul.review-list', ...material.done.map((item) =>
        el('li.review-list-item', el('span.review-tick', '✓'), item.title))),
    ]));
  }

  if (material.slipped.length) {
    wrap.appendChild(section(`Slipped (${material.slipped.length})`, [
      el('p.review-hint', 'Still open, and the date has gone past.'),
      el('ul.review-list', ...material.slipped.map((item) =>
        el('li.review-list-item.is-slipped',
          el('span.review-when', formatDayShort(item.day)), item.title))),
    ]));
  }

  return wrap;
}

function section(title, children) {
  return el('section.review-section',
    el('h3.review-section-title', title),
    ...children,
  );
}

/* ------------------------------------------------------------------ */
/* What Claude makes of it                                             */
/* ------------------------------------------------------------------ */

function claudeSection(material) {
  const wrap = el('section.review-section.review-ai');
  wrap.appendChild(el('h3.review-section-title', 'Turn it into actions'));

  if (!reflectConfigured()) {
    wrap.appendChild(el('p.review-hint',
      'Add an Anthropic API key in Settings and this will read the above back to you ',
      'and suggest what to do about it. Everything else on this page works without one.'));
    return wrap;
  }

  if (!result && !pending) {
    wrap.appendChild(el('p.review-hint',
      'Sends the diary entries and notes above to Claude, with your key, and asks ',
      'what actions they imply. Nothing is added to your lists until you say so.'));
    wrap.appendChild(el('p.review-hint.review-size', sizeNote(material)));
    wrap.appendChild(el('div.review-actions',
      el('button.btn.btn-primary', {
        onclick: () => run(material),
      }, 'Read it back'),
      el('button.btn.btn-quiet', {
        onclick: () => {
          showSource = !showSource;
          document.dispatchEvent(new CustomEvent('organizer:rerender'));
        },
      }, showSource ? 'Hide what gets sent' : 'See exactly what gets sent'),
    ));
    if (showSource) {
      wrap.appendChild(el('pre.review-source', materialToText(material)));
    }
  }

  if (pending) {
    wrap.appendChild(el('p.review-pending',
      el('span.spinner'), 'Reading the block back…'));
  }

  if (failure) {
    wrap.appendChild(el('p.review-error', failure));
    wrap.appendChild(el('div.review-actions',
      el('button.btn', { onclick: () => run(material) }, 'Try again')));
  }

  if (result) {
    if (result.reflection) {
      wrap.appendChild(el('blockquote.review-reflection', result.reflection));
    }

    const live = result.proposals
      .map((p, index) => ({ ...p, index }))
      .filter((p) => !dismissed.has(p.index));

    if (!live.length) {
      wrap.appendChild(el('p.review-hint',
        result.proposals.length
          ? 'That is all of them dealt with.'
          : 'Nothing in this block needs turning into a task.'));
    }

    for (const proposal of live) {
      wrap.appendChild(proposalCard(proposal));
    }

    wrap.appendChild(el('div.review-actions',
      el('button.btn.btn-quiet', {
        onclick: () => { clearResult(); document.dispatchEvent(new CustomEvent('organizer:rerender')); },
      }, 'Start again'),
      el('button.btn', {
        onclick: () => {
          markReviewed(todayKey());
          toast('Block marked as reviewed');
        },
      }, 'Mark this block reviewed'),
    ));
  }

  return wrap;
}

/**
 * Roughly how much this will cost, said out loud before you press the button.
 *
 * A rough figure beats no figure. Nobody can judge "is this worth doing" from a
 * character count, and a spend you cannot see coming is the kind you stop
 * trusting — so it is stated in pence, hedged honestly, rather than hidden
 * behind a word like "small".
 *
 * ~4 characters to a token is the usual English approximation, and the reply
 * plus the reasoning behind it are the larger half of the bill at Opus 5's
 * $5/$25 per million. Deliberately rounded up.
 */
function sizeNote(material) {
  const chars = materialToText(material).length;
  const inTokens = Math.ceil(chars / 4);
  // The output is what dominates: a reflection, a handful of proposals, and
  // the thinking that produced them.
  const outTokens = 1500;
  const usd = (inTokens / 1e6) * 5 + (outTokens / 1e6) * 25;
  const pence = Math.max(1, Math.ceil(usd * 80 * 100) / 100);
  return `About ${chars.toLocaleString()} characters — roughly ${pence}p.`;
}

/**
 * When the proposal is accepted, what date does it get?
 *
 * 'now' lands tomorrow rather than today: these are read at the end of a block,
 * usually when the day is already spoken for, and dating something to a day
 * that is nearly over is how it becomes overdue before you have seen it.
 */
function dateFor(urgency) {
  if (urgency === 'now') return addDays(todayKey(), 1);
  return null;
}

function proposalCard(proposal) {
  const card = el('article.proposal',
    { class: proposal.verified ? '' : 'is-unverified' });

  card.appendChild(el('h4.proposal-title', proposal.title));
  if (proposal.why) card.appendChild(el('p.proposal-why', proposal.why));

  card.appendChild(el('p.proposal-quote',
    proposal.verified
      ? el('span.proposal-badge', { title: 'These words were found in your notes' }, 'from your notes')
      : el('span.proposal-badge.is-warn', {
        title: 'Claude did not quote your notes exactly, so this may be its own words rather than yours',
      }, 'not found in your notes'),
    el('span.proposal-quote-text', `“${proposal.quote}”`),
  ));

  card.appendChild(el('div.proposal-actions',
    el('span.proposal-urgency', proposal.urgency),
    el('button.btn.btn-quiet', {
      onclick: () => {
        dismissed.add(proposal.index);
        document.dispatchEvent(new CustomEvent('organizer:rerender'));
      },
    }, 'No'),
    el('button.btn.btn-primary', {
      onclick: () => {
        const date = dateFor(proposal.urgency);
        addItem({
          kind: 'task',
          title: proposal.title,
          date,
          // No listId: makeItem drops it in the inbox, which is where
          // something you have only just agreed to belongs until you file it.
          // Where it came from, kept with it. In a month's time "why is this on
          // my list" has an answer that is not a guess.
          notes: `From the review of ${formatDayShort(todayKey())}.\n“${proposal.quote}”`,
        });
        dismissed.add(proposal.index);
        toast(date ? 'Added for tomorrow' : 'Added to Unscheduled');
        document.dispatchEvent(new CustomEvent('organizer:rerender'));
      },
    }, 'Add it'),
  ));

  return card;
}

async function run(material) {
  pending = true;
  failure = '';
  document.dispatchEvent(new CustomEvent('organizer:rerender'));
  try {
    result = await proposeActions(material);
  } catch (err) {
    failure = err?.message || 'Could not read the block back.';
  } finally {
    pending = false;
    document.dispatchEvent(new CustomEvent('organizer:rerender'));
  }
}

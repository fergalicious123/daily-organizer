/* The ritual, at both ends of the day.
 *
 * One card per phase: "First things" in the morning and "Before bed" at
 * night, built by the same function with `when`. Two cards rather than two
 * sections in one, because the spine down the left is a SEQUENCE and a single
 * card would draw one line through both -- implying you study, then train,
 * then put your phone down, as though bedtime were the third thing you do
 * after breakfast.
 *
 * The evening card does not exist unless there is an evening step, so nobody
 * gets an empty panel headed "Before bed".
 *
 * What follows is about the morning half, which came first and set the shape.
 *
 * Ben's rule is that the day starts with self-improvement before anything
 * else: study English, then the gym. So this is drawn as a SEQUENCE, not a
 * checklist. The order is the content — a tick list would say "do these two
 * things", and what he actually meant was "do this one, then that one".
 *
 * That is what the spine down the left side is for. Each step is a node on it,
 * and the segment between two nodes fills once the step above is done, so the
 * line grows downward as the morning goes. It is one drawing of two facts at
 * once: how far through you are, and what has to come next.
 *
 * The quotes are the other half. Machiavelli sits with the studying and
 * Goggins with the gym — Ben's pairing, and a good one: five hundred years
 * apart, and opposite answers to how a person makes themselves do something
 * hard. The card lets them sound different rather than flattening both into
 * the same grey caption. See `.routine-quote` in styles.css and the note at
 * the top of quotes.js.
 *
 * The card is deliberately monochrome apart from the spine. The one place
 * colour appears is the thing you are here to change.
 */

import { el, icon, haptic } from '../ui.js';
import {
  routineSteps, routineStepDone, routineProgress, toggleRoutineStep, linkedTask, PHASE,
} from '../state.js';
import { quoteFor } from '../quotes.js';
import { todayKey } from '../dates.js';
import { countdown } from '../countdown.js';
import * as usage from '../usage.js';

/**
 * Which quotes are showing their note.
 *
 * Module-level, like the day grid's collapsed hours, and for the same reason:
 * the card is rebuilt on every render — a sync tick, a ticked step — so a
 * panel that lived on the element would shut itself a few seconds after you
 * opened it. Keyed by step so opening the Machiavelli note does not also open
 * the Goggins one.
 */
const openNotes = new Set();

/**
 * How long until the thing a step is working towards.
 *
 * The counting itself lives in countdown.js now, shared with the countdowns
 * you can put on an item, so that a step and a task never phrase the same
 * number two different ways.
 */
export function countdownFor(step, dateKey) {
  if (!step?.target) return null;
  return countdown(step.target, step.targetLabel || 'Race', dateKey);
}

/**
 * The quote, with an optional word about what it means and where it is from.
 *
 * Shut by default. The quote is meant to be read in two seconds on the way out
 * of the door; the explanation is for the mornings you have a minute and think
 * "where is that from, actually". Putting it permanently on the card would
 * turn a nudge into a reading exercise.
 */
function quoteBlock(quote, step) {
  const open = openNotes.has(step.id);
  const noteId = `routine-note-${step.id}`;

  const toggle = el('button.routine-why', {
    type: 'button',
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': noteId,
    onclick: () => {
      if (open) openNotes.delete(step.id);
      else openNotes.add(step.id);
      // A disclosure is presentation, not data — routing it through the store
      // would write to disk and push to Drive for opening a footnote.
      document.dispatchEvent(new CustomEvent('organizer:rerender'));
    },
  }, open ? 'Hide' : 'What this means');

  return el('blockquote.routine-quote', { class: `tone-${quote.tone}` },
    el('p.routine-quote-text', quote.text),
    el('div.routine-quote-foot',
      el('cite.routine-quote-by', quote.author),
      toggle,
    ),
    open
      ? el('div.routine-note', { id: noteId },
          el('p.routine-note-text', quote.note),
          el('p.routine-note-source', quote.source),
        )
      : null,
  );
}

/**
 * What each end of the day is called, and what it says when it is finished.
 *
 * The done-note is per phase because they are not the same claim. "Downhill"
 * is a thing you say at 07:00 with the day in front of you; at 22:00 the
 * useful thing to say is that you are finished.
 */
const PHASES = {
  [PHASE.MORNING]: {
    title: 'First things',
    done: 'All done. The rest of the day is downhill.',
  },
  [PHASE.EVENING]: {
    title: 'Before bed',
    done: 'Phone down. Goodnight.',
  },
};

export function routineCard(dateKey = todayKey(), { onToggle, when = PHASE.MORNING } = {}) {
  const steps = routineSteps(when);
  // No card at all rather than an empty one, which is how the evening half
  // stays invisible for anyone who has not got one.
  if (!steps.length) return null;
  const phase = PHASES[when] || PHASES[PHASE.MORNING];

  const progress = routineProgress(dateKey, when);
  const complete = progress.total > 0 && progress.done === progress.total;

  const list = el('ol.routine-steps');

  steps.forEach((step, index) => {
    const done = routineStepDone(step, dateKey);
    const quote = quoteFor(step.kind, dateKey);
    const task = linkedTask(step, dateKey);
    const countdown = countdownFor(step, dateKey);

    const tick = el('button.routine-tick', {
      type: 'button',
      'aria-pressed': done ? 'true' : 'false',
      // The visible label alone would read as "Study English" with no hint
      // that pressing it does anything, which is exactly the case where a
      // screen reader needs the verb spelled out.
      'aria-label': `${done ? 'Undo' : 'Done'}: ${step.label}`,
      onclick: () => {
        haptic();
        toggleRoutineStep(step, dateKey);
        usage.record('ROUTINE_TICK');
        onToggle?.();
      },
    },
      el('span.routine-node', { 'aria-hidden': 'true' }, done ? icon('check', 'icon') : null),
      el('span.routine-label', step.label),
      countdown
        ? el('span.routine-countdown', { class: countdown.urgent ? 'is-urgent' : '' }, countdown.text)
        : null,
    );

    const row = el('li.routine-step', {
      class: [
        done ? 'is-done' : '',
        index === steps.length - 1 ? 'is-last' : '',
      ].filter(Boolean).join(' '),
    },
      tick,
      quote ? quoteBlock(quote, step) : null,
      // The argument, for a step that needs one. "Phone down" on its own reads
      // as nagging; the sentence after it is what makes it a reason.
      step.note ? el('p.routine-step-note', step.note) : null,
      // Only worth saying when the step is standing in for something real —
      // it explains why ticking here also ticks a task further down the page.
      task ? el('span.routine-linked', task.title) : null,
    );

    // Drives the stagger on the entrance: a ritual reveals in the order it is
    // performed. Set here rather than through el()'s `style` option, which
    // uses Object.assign — that silently drops custom properties, so the
    // stagger would quietly collapse to zero delay on every step.
    row.style.setProperty('--step', String(index));
    list.appendChild(row);
  });

  return el('section.routine-card', {
    class: [complete ? 'is-complete' : '', `is-${when}`].filter(Boolean).join(' '),
  },
    el('div.routine-head',
      el('h2.routine-title', phase.title),
      el('span.routine-count', `${progress.done} of ${progress.total}`),
    ),
    list,
    complete ? el('p.routine-done-note', phase.done) : null,
  );
}

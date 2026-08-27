/* The plan panel, on the Overdue page.
 *
 * A list of overdue rows tells you what has slipped and nothing about what to
 * do. This turns the pile into a handful of steps with a day against each, and
 * every step is DRAGGABLE onto the day strip directly above it — the strip is
 * already a drop target, so the gesture the page has taught you works on a
 * proposed step exactly as it does on a real task.
 *
 * Nothing becomes a task until a step is dropped or added. A plan that created
 * fourteen tasks the moment it was generated would be the pile again, with
 * more rows.
 */

import { el, icon, toast } from '../ui.js';
import { makeTouchDraggable } from '../dragdrop.js';
import {
  overdueTasks, itemsOnDay, shiftOnDay, settings, addItem, itemLog,
} from '../state.js';
import { todayKey, addDays, diffDays, formatDayShort, DAY_ABBR, fromKey } from '../dates.js';
import {
  makePlan, planInput, planConfigured, PLAN_PREFIX,
  registerPlanStep, takePlanStep, clearPlanSteps, isPlanStepConsumed,
} from '../plan.js';

/** How far ahead the plan is allowed to schedule. */
const HORIZON = 10;

let plan = null;
let working = false;
let failure = '';
let showSource = false;
/** Steps already dealt with, by index, so an accepted one stops offering. */
const used = new Set();

function rerender() {
  document.dispatchEvent(new CustomEvent('organizer:rerender'));
}

function reset() {
  plan = null;
  failure = '';
  showSource = false;
  used.clear();
  clearPlanSteps();
}

/** The pile and the days available, as the planner needs them. */
function gather() {
  const today = todayKey();

  const overdue = overdueTasks().map((item) => ({
    id: item.id,
    title: item.title || 'Untitled',
    daysLate: Math.max(1, diffDays(item.date, today)),
    rollCount: item.rollCount || 0,
    notes: itemLog(item).map((n) => n.text).concat(item.notes ? [item.notes] : []),
  }));

  const days = [];
  for (let i = 0; i <= HORIZON; i += 1) {
    const dateKey = addDays(today, i);
    const shift = shiftOnDay(dateKey);
    days.push({
      dateKey,
      label: i === 0 ? 'today' : i === 1 ? 'tomorrow' : DAY_ABBR[fromKey(dateKey).getDay()],
      shift: shift || '',
      count: itemsOnDay(dateKey).filter((x) => !x.done && !x.deleted).length,
    });
  }

  return { overdue, days };
}

function stepRow(step) {
  const key = String(step.index);
  registerPlanStep(key, step);

  const row = el('div.plan-step', {
    draggable: 'true',
    title: 'Drag onto a day above, or use the button',
  });

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', PLAN_PREFIX + key);
    e.dataTransfer.effectAllowed = 'copy';
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
  // Touch cannot fire dragstart, and this app is used on a phone.
  makeTouchDraggable(row, () => PLAN_PREFIX + key);

  const add = (dateKey) => {
    const s = takePlanStep(key);
    if (!s) return;
    addItem({
      kind: 'task',
      title: s.title,
      date: dateKey || null,
      notes: s.why ? `From a plan: ${s.why}` : '',
    });
    used.add(step.index);
    toast(dateKey ? `Added for ${formatDayShort(dateKey)}` : 'Added to Unscheduled');
    rerender();
  };

  row.append(
    el('div.plan-step-main',
      el('p.plan-step-title', step.title),
      step.why ? el('p.plan-step-why', step.why) : null,
    ),
    el('div.plan-step-side',
      step.day
        ? el('span.plan-step-day', formatDayShort(step.day))
        : el('span.plan-step-day.is-loose', 'no date'),
      el('button.btn.btn-quiet', { onclick: () => add(step.day || null) },
        step.day ? 'Put it there' : 'Add it'),
    ),
  );

  return row;
}

/**
 * The panel. Returns null when there is nothing to plan, so the page is
 * unchanged on a day with nothing overdue.
 */
export function planPanel() {
  const material = gather();
  if (!material.overdue.length) { reset(); return null; }

  const box = el('section.plan-panel');
  box.appendChild(el('div.plan-head',
    icon('review', 'icon plan-head-icon'),
    el('span.plan-head-label', 'A way through this'),
  ));

  if (!planConfigured()) {
    box.appendChild(el('p.plan-hint',
      'Add an Anthropic key in Settings and this will read the ', String(material.overdue.length),
      ' overdue things, work out a handful of steps that cover them, and put each one on a ',
      'day that suits your rota.'));
    return box;
  }

  if (!plan && !working) {
    box.appendChild(el('p.plan-hint',
      'Reads all ', String(material.overdue.length), ' of them, along with your rota for the ',
      'next ', String(HORIZON), ' days, and turns them into a few steps you can actually do. ',
      'Nothing is added until you drop a step on a day or press its button.'));
    box.appendChild(el('div.plan-actions',
      el('button.btn.btn-primary', { onclick: run }, 'Make me a plan'),
      el('button.btn.btn-quiet', {
        onclick: () => { showSource = !showSource; rerender(); },
      }, showSource ? 'Hide what gets sent' : 'What gets sent'),
    ));
    if (showSource) box.appendChild(el('pre.plan-source', planInput(material)));
    return box;
  }

  if (working) {
    box.appendChild(el('p.plan-working', el('span.spinner'), 'Working it out…'));
    return box;
  }

  if (failure) {
    box.appendChild(el('p.plan-error', failure));
    box.appendChild(el('div.plan-actions',
      el('button.btn', { onclick: run }, 'Try again')));
    return box;
  }

  if (plan.approach) box.appendChild(el('p.plan-approach', plan.approach));

  const live = plan.steps.filter((s) => !used.has(s.index) && !isPlanStepConsumed(s.index));
  if (!live.length) {
    box.appendChild(el('p.plan-hint', 'That is the plan dealt with.'));
  } else {
    box.appendChild(el('p.plan-drag-hint',
      'Drag any of these onto a day above, or use its button.'));
    for (const step of live) box.appendChild(stepRow(step));
  }

  box.appendChild(el('div.plan-actions',
    el('button.btn.btn-quiet', { onclick: () => { reset(); rerender(); } }, 'Start again')));
  return box;
}

async function run() {
  working = true;
  failure = '';
  rerender();
  try {
    plan = await makePlan(gather());
    used.clear();
    if (!plan.steps.length) failure = 'No plan came back. Try again.';
  } catch (err) {
    failure = err?.message || 'Could not make a plan.';
  } finally {
    working = false;
    rerender();
  }
}

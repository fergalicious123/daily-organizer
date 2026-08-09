/* Dual clock + time converter.
 *
 * Shows the time in two zones side by side, and lets you type a time into
 * either one to see the matching time in the other.
 *
 * All zone maths goes through Intl, never a stored offset. The gap between
 * London and Manila is 7 hours today and 8 from 25 October, because the UK
 * leaves BST while the Philippines has no DST at all — so anything that
 * hardcodes "+7" is wrong for a third of the year. Intl knows the rules; we
 * ask it every time.
 */

import { el, icon } from '../ui.js';
import { settings, updateSettings } from '../state.js';

const DEFAULT_HOME = { tz: 'Europe/London', label: 'UK' };
const DEFAULT_AWAY = { tz: 'Asia/Manila', label: 'PH' };

/* ------------------------------------------------------------------ */
/* Zone maths                                                          */
/* ------------------------------------------------------------------ */

/** The wall-clock fields an instant shows in a given zone. */
function partsInZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
  };
}

/** How far ahead of UTC a zone is, in minutes, at a given instant. */
function offsetMinutes(date, timeZone) {
  const p = partsInZone(date, timeZone);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = date.getTime() - date.getMilliseconds();
  return (asIfUTC - whole) / 60000;
}

/**
 * The instant at which `timeZone` reads the given wall-clock time.
 * Resolved twice because the offset used to make the first guess may itself
 * be the wrong side of a DST boundary.
 */
function instantForZonedTime(year, month, day, hour, minute, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let offset = offsetMinutes(new Date(naive), timeZone);
  let instant = naive - offset * 60000;
  offset = offsetMinutes(new Date(instant), timeZone);
  return new Date(naive - offset * 60000);
}

/** 'HH:MM' in the given zone. */
export function timeInZone(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** How many calendar days `away` is ahead of (or behind) `home`. */
function dayShift(date, homeTz, awayTz) {
  const h = partsInZone(date, homeTz);
  const a = partsInZone(date, awayTz);
  return Math.round(
    (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(h.year, h.month - 1, h.day)) / 86400000,
  );
}

/** "7h ahead" / "3h 30m behind" / "same time". */
export function describeGap(date, homeTz, awayTz) {
  const diff = offsetMinutes(date, awayTz) - offsetMinutes(date, homeTz);
  if (diff === 0) return 'same time';
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const span = m ? `${h}h ${m}m` : `${h}h`;
  return `${span} ${diff > 0 ? 'ahead' : 'behind'}`;
}

function zoneConfig() {
  const cfg = settings();
  return {
    home: { tz: cfg.homeTimeZone || DEFAULT_HOME.tz, label: cfg.homeLabel || DEFAULT_HOME.label },
    away: { tz: cfg.awayTimeZone || DEFAULT_AWAY.tz, label: cfg.awayLabel || DEFAULT_AWAY.label },
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * A fixed widget in the bottom-right corner: collapsed it is a single line
 * with both clocks, and it opens UPWARD into a two-way converter.
 *
 * Mounted once outside the render tree, not rebuilt with the sidebar. That is
 * not just tidiness — the sidebar redraws on every store change, and a rebuilt
 * widget would reset a conversion you were in the middle of reading.
 */
export function clockWidget() {
  const { home, away } = zoneConfig();

  // While converting, this holds the instant being represented. Null means
  // "follow the clock", and the ticker keeps it current.
  let pinned = null;
  let expanded = false;
  // Which field the user is currently typing into ('home' | 'away' | null).
  // Only that one is left alone during a repaint — guarding every FOCUSED
  // field instead meant converting from one side left the other stale and
  // showing a wrong time.
  let editing = null;

  const root = el('div.clock-widget', { role: 'group', 'aria-label': 'World clocks' });

  const homeTime = el('span.clock-time', { dataset: { clockTz: home.tz } });
  const awayTime = el('span.clock-time', { dataset: { clockTz: away.tz } });
  const awayDay = el('span.clock-day');
  const gapLabel = el('span.clock-gap');

  const homeInput = el('input', {
    type: 'time', 'aria-label': `Time in ${home.label}`,
    dataset: { focusId: 'clock-home' },
    onkeydown: (e) => e.stopPropagation(),
    oninput: (e) => convertFrom(home.tz, e.target.value, 'home'),
    onblur: () => { editing = null; },
  });
  const awayInput = el('input', {
    type: 'time', 'aria-label': `Time in ${away.label}`,
    dataset: { focusId: 'clock-away' },
    onkeydown: (e) => e.stopPropagation(),
    oninput: (e) => convertFrom(away.tz, e.target.value, 'away'),
    onblur: () => { editing = null; },
  });

  /** Typing into one side fixes an instant; everything else follows from it. */
  function convertFrom(tz, value, which) {
    if (!/^\d{2}:\d{2}$/.test(value)) return;
    editing = which;
    const [hh, mm] = value.split(':').map(Number);
    // Anchor to the day currently shown for that zone, so converting near
    // midnight rolls the date rather than jumping.
    const basis = pinned || new Date();
    const p = partsInZone(basis, tz);
    pinned = instantForZonedTime(p.year, p.month, p.day, hh, mm, tz);
    paint();
  }

  function reset() {
    pinned = null;
    editing = null;
    paint();
  }

  function paint() {
    const now = pinned || new Date();
    const shift = dayShift(now, home.tz, away.tz);

    homeTime.textContent = timeInZone(now, home.tz);
    awayTime.textContent = timeInZone(now, away.tz);
    awayDay.textContent = shift === 0 ? '' : (shift > 0 ? '+1 day' : '−1 day');
    gapLabel.textContent = `${away.label} ${describeGap(now, home.tz, away.tz)}`;

    if (editing !== 'home') homeInput.value = timeInZone(now, home.tz);
    if (editing !== 'away') awayInput.value = timeInZone(now, away.tz);

    root.classList.toggle('is-pinned', Boolean(pinned));
  }

  const header = el('button.clock-summary', {
    'aria-expanded': String(expanded),
    title: 'Convert a time between these zones',
    onclick: () => {
      expanded = !expanded;
      body.hidden = !expanded;
      // The chevron direction follows aria-expanded in CSS — no inline
      // transform here, or it would win and the arrow would stop matching.
      header.setAttribute('aria-expanded', String(expanded));
      if (expanded) queueMicrotask(() => homeInput.focus());
    },
  },
    el('span.clock-pair',
      el('span.clock-zone', home.label), homeTime,
      el('span.clock-sep', '·'),
      el('span.clock-zone', away.label), awayTime, awayDay,
    ),
  );
  const chevron = icon('chevronRight', 'icon clock-chevron');
  header.appendChild(chevron);

  const body = el('div.clock-body', { hidden: true },
    el('div.clock-row',
      el('label', home.label),
      homeInput,
    ),
    el('div.clock-row',
      el('label', away.label),
      awayInput,
    ),
    el('div.clock-foot',
      gapLabel,
      el('button.clock-now', {
        title: 'Reset both clocks to right now',
        onclick: reset,
      }, icon('clock', 'icon'), 'Now'),
    ),
  );

  // Body first so the panel opens UPWARD — the widget is pinned to the bottom
  // of the window, so expanding downward would push it off-screen.
  root.append(body, header);
  paint();
  return root;
}

/* ------------------------------------------------------------------ */
/* Mounting                                                            */
/* ------------------------------------------------------------------ */

let mounted = null;

/**
 * Put the widget in the corner, once. Deliberately outside the app's render
 * tree: nothing that redraws the sidebar should be able to reset a conversion
 * mid-read.
 */
export function mountClockWidget() {
  if (mounted?.isConnected) return mounted;
  mounted = clockWidget();
  document.body.appendChild(mounted);
  return mounted;
}

/* ------------------------------------------------------------------ */
/* Ticker                                                              */
/* ------------------------------------------------------------------ */

let ticker = null;

/**
 * Keep every mounted clock current without re-rendering the sidebar.
 * A full redraw each minute would fight focus restoration and undo the
 * converter mid-edit, so the ticker only rewrites the two text nodes — and
 * skips any card the user has pinned to a converted time.
 */
export function startClockTicker() {
  clearInterval(ticker);
  const tick = () => {
    const now = new Date();
    for (const node of document.querySelectorAll('.clock-time[data-clock-tz]')) {
      if (node.closest('.clock-widget')?.classList.contains('is-pinned')) continue;
      node.textContent = timeInZone(now, node.dataset.clockTz);
    }
  };
  tick();
  // Land close to the top of each minute rather than drifting.
  const toNextMinute = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => {
    tick();
    ticker = setInterval(tick, 60000);
  }, toNextMinute);
}

export { zoneConfig, DEFAULT_HOME, DEFAULT_AWAY };

/* Charts — hand-rolled SVG, no library.
 *
 * Nothing here loads from a CDN: the app has to work offline on a phone, and a
 * charting library would be the only thing standing between it and that.
 *
 * Form choices (deliberate, per the data's job):
 *  - Completion is ONE ratio against a limit, so the ring is a METER, not a
 *    two-category pie. The fill is the accent; the unfilled track is a lighter
 *    step of the same ramp. Both steps were chosen by measuring WCAG contrast.
 *  - The 7-day history is magnitude over time -> single-hue columns.
 *  - The per-list breakdown is nominal (list names), so every bar wears the
 *    same slot-1 hue. Colouring nominal bars by value would spend the identity
 *    channel re-encoding what bar length already shows.
 * No categorical palette is in play anywhere, so no CVD pair check applies.
 *
 * Every chart ships a visually-hidden table so the values are never gated
 * behind colour or hover.
 */

import { el, clear } from './ui.js';
import { DAY_ABBR, fromKey, todayKey } from './dates.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, v);
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Progress ring (meter)                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {{done:number,total:number,percent:number,ratio:number}} progress
 * @param {{size?:number, stroke?:number, label?:string}} opts
 */
export function progressRing(progress, { size = 132, stroke = 13, label = 'Today' } = {}) {
  const { done, total, percent, remaining } = progress;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const filled = circumference * (total === 0 ? 0 : progress.ratio);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    height: size,
    class: 'ring',
    role: 'img',
    'aria-label': total === 0
      ? `${label}: nothing scheduled`
      : `${label}: ${done} of ${total} tasks complete, ${percent} percent`,
  });

  // Track — a lighter step of the fill's own ramp, so state reads across the
  // whole ring rather than only where it happens to be filled.
  svg.appendChild(svgEl('circle', {
    cx, cy: cx, r,
    fill: 'none',
    stroke: 'var(--chart-track)',
    'stroke-width': stroke,
  }));

  if (total > 0 && filled > 0) {
    const arc = svgEl('circle', {
      cx, cy: cx, r,
      fill: 'none',
      // Complete is the one state that earns a status colour; below that the
      // ring stays accent rather than nagging the user in warning/danger hues.
      stroke: percent === 100 ? 'var(--success)' : 'var(--chart-fill)',
      'stroke-width': stroke,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${filled} ${circumference - filled}`,
      // Start at 12 o'clock and run clockwise.
      transform: `rotate(-90 ${cx} ${cx})`,
      class: 'ring-arc',
    });
    svg.appendChild(arc);
  }

  const wrap = el('div.ring-wrap', svg);

  // Hero number sits inside the ring. Proportional figures, not tabular:
  // tabular-nums makes a display-size number look loose.
  wrap.appendChild(el('div.ring-center',
    total === 0
      ? [el('div.ring-empty', '—'), el('div.ring-caption', 'nothing yet')]
      : [
        el('div.ring-value', `${percent}`, el('span.ring-pct', '%')),
        el('div.ring-caption', remaining === 0 ? 'all done' : `${remaining} left`),
      ],
  ));

  return wrap;
}

/* ------------------------------------------------------------------ */
/* 7-day completion columns                                            */
/* ------------------------------------------------------------------ */

/**
 * Single-hue columns. Labels are selective — only the tallest bar and today
 * get a value, because a number on every column is chaos and goes unread.
 * @param {{date:string,count:number}[]} data oldest first
 */
export function historyColumns(data, { height = 108 } = {}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const today = todayKey();

  const wrap = el('div.columns', { role: 'group', 'aria-label': 'Tasks completed per day, last 7 days' });
  const plot = el('div.columns-plot', { style: { height: `${height}px` } });

  // One recessive baseline. Hairline, solid, one step off the surface.
  plot.appendChild(el('div.columns-baseline'));

  for (const point of data) {
    const isToday = point.date === today;
    const isMax = point.count === max && point.count > 0;
    const pct = (point.count / max) * 100;

    const bar = el('div.column-bar', {
      style: { height: point.count === 0 ? '2px' : `${Math.max(pct, 4)}%` },
      class: point.count === 0 ? 'is-zero' : '',
    });

    const column = el('div.column',
      // Label only where it earns its place.
      (isMax || (isToday && point.count > 0))
        ? el('div.column-value', String(point.count))
        : el('div.column-value.is-blank', ' '),
      el('div.column-track', bar),
      el('div.column-label', { class: isToday ? 'is-today' : '' },
        DAY_ABBR[fromKey(point.date).getDay()].slice(0, 1)),
    );
    // Hover layer: every mark is inspectable without needing a label on it.
    column.title = `${point.count} completed on ${point.date}`;
    plot.appendChild(column);
  }

  wrap.appendChild(plot);
  wrap.appendChild(dataTable(
    ['Day', 'Completed'],
    data.map((d) => [d.date, String(d.count)]),
    'Tasks completed per day',
  ));
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Per-list breakdown                                                  */
/* ------------------------------------------------------------------ */

/**
 * Horizontal meter bars, one per list. Nominal categories, so every bar wears
 * the same hue and is direct-labelled by name.
 * @param {{name:string,done:number,total:number}[]} rows
 */
export function listBars(rows) {
  const wrap = el('div.bars', { role: 'group', 'aria-label': 'Progress by list' });

  for (const row of rows) {
    const pct = row.total === 0 ? 0 : Math.round((row.done / row.total) * 100);
    wrap.appendChild(el('div.bar-row',
      el('div.bar-head',
        el('span.bar-name', row.name),
        // Values in text tokens, never the mark colour.
        el('span.bar-value', `${row.done}/${row.total}`),
      ),
      el('div.bar-track',
        el('div.bar-fill', {
          style: { width: `${pct}%` },
          class: pct === 100 ? 'is-complete' : '',
          title: `${row.name}: ${pct}% complete`,
        }),
      ),
    ));
  }

  if (!rows.length) {
    wrap.appendChild(el('p.stat-sub', { style: { margin: 0 } }, 'No tasks yet.'));
  }

  wrap.appendChild(dataTable(
    ['List', 'Done', 'Total'],
    rows.map((r) => [r.name, String(r.done), String(r.total)]),
    'Progress by list',
  ));
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Sparkline                                                           */
/* ------------------------------------------------------------------ */

/** 2px line, round join/cap, single hue. Used inside stat tiles. */
export function sparkline(values, { width = 120, height = 30 } = {}) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((v, i) => {
    const x = i * step;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width, height,
    class: 'spark',
    'aria-hidden': 'true',
  });
  svg.appendChild(svgEl('polyline', {
    points: points.join(' '),
    fill: 'none',
    stroke: 'var(--chart-fill)',
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  }));

  // End marker with a surface ring, so it stays legible where it meets the line.
  const [lx, ly] = points[points.length - 1].split(',').map(Number);
  svg.appendChild(svgEl('circle', {
    cx: lx, cy: ly, r: 4,
    fill: 'var(--chart-fill)',
    stroke: 'var(--surface)',
    'stroke-width': 2,
  }));
  return svg;
}

/* ------------------------------------------------------------------ */
/* Table view                                                          */
/* ------------------------------------------------------------------ */

/** Screen-reader/table fallback so no value is reachable only by hover. */
function dataTable(headers, rows, caption) {
  return el('table.visually-hidden',
    el('caption', caption),
    el('thead', el('tr', headers.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', rows.map((cells) => el('tr', cells.map((c) => el('td', c))))),
  );
}

/** Re-render a chart into an existing host without leaking listeners. */
export function mount(host, node) {
  clear(host).appendChild(node);
  return host;
}

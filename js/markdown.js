/* Markdown, rendered.
 *
 * Ben pastes answers out of Claude into the diary and into the notes on a
 * task — tables of who is out of date on SCA, headings, bold names. The app
 * was showing that as what it literally is: a wall of pipes and asterisks.
 * The structure is most of the value in that kind of paste, and it was the
 * first thing thrown away.
 *
 * SAFETY, because this renders text that came from somewhere else.
 * Every node is built with createElement and textContent. There is no
 * innerHTML anywhere in this file and there must never be: the whole point of
 * a hand-rolled renderer here is that a `<script>` in pasted text is four
 * harmless characters of text content rather than something the browser is
 * invited to run. Link hrefs are checked against a scheme allow-list for the
 * same reason — `javascript:` in a pasted link is a real thing that happens.
 *
 * SCOPE. What Claude actually emits and what Ben actually pastes: headings,
 * bold and italic, inline and fenced code, pipe tables, bullet and numbered
 * lists, blockquotes, rules, links. Not footnotes, not reference links, not
 * HTML passthrough — the last of those deliberately, see above.
 */

const SAFE_SCHEME = /^(https?:|mailto:)/i;

/* Enough structure to be worth rendering rather than showing as typed. Used
   to decide whether a paste gets a provenance line, so it errs towards no. */
export function looksLikeMarkdown(text) {
  const s = String(text ?? '');
  return /^\s{0,3}#{1,6}\s/m.test(s)          // a heading
    || /^\s*\|.*\|/m.test(s)                   // a table row
    || /\*\*[^*\n]+\*\*/.test(s)               // bold
    || /^\s{0,3}([-*+]|\d+\.)\s+/m.test(s)     // a list
    || /^\s*```/m.test(s);                     // a fence
}

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

/*
 * Ordered, and the order matters. Code first so that `**` inside a code span
 * is left alone; bold before italic, or `**x**` is read as an italic `*x*`
 * wrapped in stray asterisks.
 */
const INLINE = [
  { re: /`([^`\n]+)`/, make: (m) => tag('code', m[1]) },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/, make: (m) => link(m[1], m[2]) },
  { re: /\*\*([^\n]+?)\*\*/, make: (m) => wrap('strong', m[1]) },
  { re: /__([^\n]+?)__/, make: (m) => wrap('strong', m[1]) },
  { re: /~~([^\n]+?)~~/, make: (m) => wrap('s', m[1]) },
  { re: /(?<![A-Za-z0-9*])\*([^*\n]+?)\*(?![A-Za-z0-9*])/, make: (m) => wrap('em', m[1]) },
  { re: /(?<![A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/, make: (m) => wrap('em', m[1]) },
];

function tag(name, text) {
  const node = document.createElement(name);
  node.textContent = text;
  return node;
}

function wrap(name, inner) {
  const node = document.createElement(name);
  node.append(...inlineNodes(inner));
  return node;
}

function link(text, href) {
  // Anything that is not plainly http, https or mailto becomes text. A
  // `javascript:` href pasted from who-knows-where is not a link this app is
  // going to build for anyone.
  if (!SAFE_SCHEME.test(href)) return document.createTextNode(`${text} (${href})`);
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/** One line of inline markdown as a list of nodes. */
function inlineNodes(text) {
  const src = String(text ?? '');
  if (!src) return [];

  let best = null;
  for (const rule of INLINE) {
    const m = rule.re.exec(src);
    // Earliest match wins, so `a **b** and \`c\`` resolves left to right
    // rather than in rule order.
    if (m && (!best || m.index < best.m.index)) best = { m, rule };
  }
  if (!best) return [document.createTextNode(src)];

  const { m, rule } = best;
  return [
    ...(m.index ? [document.createTextNode(src.slice(0, m.index))] : []),
    rule.make(m),
    ...inlineNodes(src.slice(m.index + m[0].length)),
  ];
}

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*```/;
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBER = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
/* A table needs its ruler: `| --- | --- |`. Without that check any sentence
   with a pipe in it would start a table. */
const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function isBlockStart(line) {
  return !line.trim()
    || HEADING.test(line) || FENCE.test(line) || RULE.test(line)
    || BULLET.test(line) || NUMBER.test(line) || QUOTE.test(line);
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Render markdown into a fragment.
 *
 * Returns a DocumentFragment so a caller can drop it straight into a node it
 * already owns, rather than this module deciding what element it lives in.
 */
export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    /* ---- fenced code ---- */
    if (FENCE.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;                                  // step over the closing fence
      const pre = document.createElement('pre');
      pre.className = 'md-pre';
      pre.appendChild(tag('code', body.join('\n')));
      frag.appendChild(pre);
      continue;
    }

    /* ---- heading ---- */
    const h = HEADING.exec(line);
    if (h) {
      // Levels are shifted down by one: a diary entry is already inside the
      // page's own h1/h2, so a pasted "# Title" becoming another h1 would be
      // both wrong structurally and enormous. Capped at h6.
      const level = Math.min(6, h[1].length + 2);
      const node = document.createElement(`h${level}`);
      node.className = 'md-h';
      node.append(...inlineNodes(h[2]));
      frag.appendChild(node);
      i += 1;
      continue;
    }

    /* ---- rule ---- */
    if (RULE.test(line)) {
      const hr = document.createElement('hr');
      hr.className = 'md-hr';
      frag.appendChild(hr);
      i += 1;
      continue;
    }

    /* ---- table ---- */
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      // Wrapped, because a table of service numbers and dates is wider than a
      // phone and the page itself must not start scrolling sideways.
      const wrapEl = document.createElement('div');
      wrapEl.className = 'md-table-wrap';
      const table = document.createElement('table');
      table.className = 'md-table';
      const thead = document.createElement('thead');
      const hr2 = document.createElement('tr');
      for (const cell of head) {
        const th = document.createElement('th');
        th.append(...inlineNodes(cell));
        hr2.appendChild(th);
      }
      thead.appendChild(hr2);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of rows) {
        const tr = document.createElement('tr');
        // Pad or trim to the header's width so a ragged row cannot shear the
        // columns out of line with their headings.
        for (let c = 0; c < head.length; c += 1) {
          const td = document.createElement('td');
          td.append(...inlineNodes(row[c] ?? ''));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrapEl.appendChild(table);
      frag.appendChild(wrapEl);
      continue;
    }

    /* ---- blockquote ---- */
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      const quote = document.createElement('blockquote');
      quote.className = 'md-quote';
      quote.appendChild(renderMarkdown(body.join('\n')));
      frag.appendChild(quote);
      continue;
    }

    /* ---- lists ---- */
    if (BULLET.test(line) || NUMBER.test(line)) {
      const numbered = !BULLET.test(line) && NUMBER.test(line);
      const list = document.createElement(numbered ? 'ol' : 'ul');
      list.className = 'md-list';
      while (i < lines.length) {
        const m = numbered ? NUMBER.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!m) break;
        const li = document.createElement('li');
        li.append(...inlineNodes(m[3]));
        // A wrapped continuation line belongs to the item above it, not to a
        // new paragraph after the list.
        i += 1;
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])
               && !BULLET.test(lines[i]) && !NUMBER.test(lines[i])) {
          li.append(document.createTextNode(' '), ...inlineNodes(lines[i].trim()));
          i += 1;
        }
        list.appendChild(li);
      }
      frag.appendChild(list);
      continue;
    }

    /* ---- paragraph ---- */
    const para = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])
           && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))) {
      para.push(lines[i].trim());
      i += 1;
    }
    const p = document.createElement('p');
    p.className = 'md-p';
    p.append(...inlineNodes(para.join(' ')));
    frag.appendChild(p);
  }

  return frag;
}

/** Convenience: a div with the rendered markdown inside it. */
export function markdownBlock(src, className = 'md') {
  const node = document.createElement('div');
  node.className = className;
  node.appendChild(renderMarkdown(src));
  return node;
}

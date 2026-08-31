/* Where a pasted block came from, and when.
 *
 * Ben pastes answers out of Claude into the diary and onto tasks. A week
 * later the entry is a table of service numbers with no indication of where
 * it came from or when it was true — and for something like "who is out of
 * date on SCA", when it was true is most of what decides whether to trust it.
 *
 * So a substantial paste gets a line above it saying so.
 *
 * WHAT IT CAN HONESTLY SAY. The time is ours and is always right. The source
 * is not: a browser hands over the text and, sometimes, an HTML flavour of the
 * same thing, and nothing in either reliably names the app it came from. Some
 * platforms put a source URL in the HTML flavour; where that is there, it is
 * used. Where it is not, the line says when and leaves the where to Ben —
 * it is ordinary text in his own entry, so he can finish the sentence or
 * delete the whole line.
 *
 * It never guesses. Writing "from Claude" because the text happens to contain
 * a markdown table would be inventing a fact into his diary, which is exactly
 * the kind of thing a diary must not do.
 */

import { looksLikeMarkdown } from './markdown.js';
import { toKey, formatDayShort } from './dates.js';

/* Below this, a paste is a phone number or a name and a caption would be
   noise. Above it, or with real structure in it, it is a document. */
const SUBSTANTIAL = 220;

/**
 * Pull a source URL out of the clipboard's HTML flavour, if one is there.
 *
 * Deliberately conservative: an absolute http(s) URL in a SourceURL header or
 * a <base href>, and nothing else. Links inside the copied content are NOT a
 * source — the first href in a pasted article is usually its first hyperlink,
 * which would attribute the paste to whatever the author happened to link to.
 */
export function sourceFromClipboard(data) {
  try {
    const html = data?.getData?.('text/html') || '';
    if (!html) return '';
    const m = /SourceURL:\s*(\S+)/i.exec(html)
      || /<base[^>]+href=["']([^"']+)["']/i.exec(html);
    if (!m) return '';
    const url = new URL(m[1]);
    if (!/^https?:$/.test(url.protocol)) return '';
    return url.host.replace(/^www\./, '');
  } catch {
    // A malformed URL, or a browser that will not hand over the HTML flavour.
    return '';
  }
}

/**
 * 'Mon 31 Aug 2026, 17:20' — written out, because it is read months later.
 *
 * Built from the app's own day and month names rather than
 * toLocaleDateString. That put a comma after the weekday on this machine and
 * would put something else again on another, so the one line whose whole job
 * is to be a reliable record would have been formatted differently on his
 * phone and his laptop.
 */
function stamp(now = new Date()) {
  const key = toKey(now);
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `${formatDayShort(key)} ${now.getFullYear()}, ${time}`;
}

/** The line itself. A blockquote so it renders as a quiet caption. */
export function provenanceLine(source, now = new Date()) {
  return source
    ? `> Pasted from ${source} · ${stamp(now)}`
    : `> Pasted ${stamp(now)}`;
}

/**
 * Handle a paste into a textarea, adding the provenance line.
 *
 * Takes over the insertion rather than letting the browser do it, because the
 * line has to go ABOVE the pasted block and the browser would put the caret
 * after it. Falls through to the default paste for anything short, so typing
 * flow is untouched by this in the common case.
 *
 * @param {ClipboardEvent} e
 * @param {HTMLTextAreaElement} area
 * @param {() => void} onChange  the caller's resize-and-save
 * @returns {boolean} whether a line was added
 */
export function stampPaste(e, area, onChange = () => {}) {
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!text) return false;
  if (text.length < SUBSTANTIAL && !looksLikeMarkdown(text)) return false;

  e.preventDefault();
  const source = sourceFromClipboard(e.clipboardData);
  const line = provenanceLine(source);

  const before = area.value.slice(0, area.selectionStart);
  const after = area.value.slice(area.selectionEnd);
  // A blank line each side, or the caption merges into whatever it lands
  // between and the markdown renderer reads it as one paragraph.
  const lead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const block = `${lead}${line}\n\n${text.trim()}\n`;

  area.value = before + block + after;
  const caret = (before + block).length;
  area.selectionStart = area.selectionEnd = caret;
  onChange();
  return true;
}

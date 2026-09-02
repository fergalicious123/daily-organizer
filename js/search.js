/* Finding something you already wrote down.
 *
 * There was no way to. Everything the app holds is filed by DAY — a task on
 * its date, an entry under its date, a caught line under the minute it was
 * caught — which is exactly right for "what am I doing today" and useless for
 * "where is that thing about the heater". After a few months that is hundreds
 * of items across a calendar you have to scroll to reach, and the only tool
 * for it was memory.
 *
 * Deliberately plain: substring matching over text this app already has, in
 * memory, with no index to keep in step and nothing to go stale. The whole
 * document is a couple of hundred kilobytes; a linear scan of it is under a
 * millisecond, and an index would be a second copy of the truth to get wrong.
 */

import { todayKey } from './dates.js';

/** Where a hit was found, worst to best. Decides the order results come back. */
const WEIGHT = {
  title: 100,
  note: 40,
  comment: 30,
  log: 30,
  entry: 50,
  capture: 50,
};

function norm(s) {
  return String(s ?? '').toLowerCase();
}

/**
 * Every term must appear somewhere in the haystack.
 *
 * AND rather than OR, because searching two words and getting everything
 * containing either is the behaviour that makes people stop using a search
 * box. Terms may match different fields of the same item — "heater glbo"
 * finds a task titled "heater" with "Glbo" in its notes.
 */
function matchesAll(terms, haystacks) {
  return terms.every((t) => haystacks.some((h) => h.includes(t)));
}

/** A short piece of the text around the first hit, for showing in the list. */
export function snippet(text, term, span = 70) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const at = norm(s).indexOf(term);
  if (at < 0) return s.slice(0, span) + (s.length > span ? '…' : '');
  const from = Math.max(0, at - Math.floor(span / 3));
  const to = Math.min(s.length, from + span);
  return `${from > 0 ? '…' : ''}${s.slice(from, to)}${to < s.length ? '…' : ''}`;
}

/**
 * Search the document.
 *
 * Returns plain data, not nodes, so the whole thing is testable without a DOM
 * and the view can decide how to draw a hit.
 *
 * @param {string} query
 * @param {object} doc  { items, journal, captures }
 */
export function search(query, doc = {}, limit = 40) {
  const terms = norm(query).split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return [];

  const first = terms[0];
  const out = [];
  const today = todayKey();

  /* ---- tasks and events ---- */
  for (const item of doc.items || []) {
    if (item.deleted) continue;
    const title = norm(item.title);
    const notes = norm(item.notes);
    const comment = norm(item.comment);
    const log = (item.log || []).filter((n) => !n.deleted).map((n) => norm(n.text));
    if (!matchesAll(terms, [title, notes, comment, ...log])) continue;

    // Named by the strongest field that matched, so a result says why it is
    // here rather than making you open it to find out.
    let where = 'note';
    let text = item.notes || item.comment || '';
    if (title.includes(first)) { where = 'title'; text = item.title; }
    else if (notes.includes(first)) { where = 'note'; text = item.notes; }
    else if (comment.includes(first)) { where = 'comment'; text = item.comment; }
    else {
      const hit = (item.log || []).find((n) => !n.deleted && norm(n.text).includes(first));
      if (hit) { where = 'log'; text = hit.text; }
    }

    out.push({
      kind: item.kind === 'event' ? 'event' : 'task',
      id: item.id,
      title: item.title || 'Untitled',
      date: item.date || null,
      done: Boolean(item.done),
      where,
      snippet: where === 'title' ? '' : snippet(text, first),
      score: WEIGHT[where] + (item.done ? -20 : 0) + (item.date === today ? 10 : 0),
    });
  }

  /* ---- diary ---- */
  for (const [day, entry] of Object.entries(doc.journal || {})) {
    const text = norm(entry?.text);
    if (!text || !matchesAll(terms, [text])) continue;
    out.push({
      kind: 'entry',
      id: day,
      title: 'Diary',
      date: day,
      where: 'entry',
      snippet: snippet(entry.text, first),
      score: WEIGHT.entry,
    });
  }

  /* ---- caught lines ---- */
  for (const c of doc.captures || []) {
    if (c.deleted) continue;
    const text = norm(c.text);
    if (!text || !matchesAll(terms, [text])) continue;
    out.push({
      kind: 'capture',
      id: c.id,
      title: c.text,
      date: (c.at || '').slice(0, 10) || null,
      where: 'capture',
      snippet: '',
      score: WEIGHT.capture,
    });
  }

  /* Best match first, then most recent, so two equal hits are ordered by the
     one you are more likely to have meant. */
  return out
    .sort((a, b) => b.score - a.score || String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, limit);
}

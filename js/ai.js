/* Optional: have Claude word the morning brief.
 *
 * This sits ON TOP of brief.js and never replaces it. The facts are assembled
 * by rules first; Claude is handed those facts and asked only to say them
 * better. It cannot add a shift, drop a task, or invent a time, because it is
 * never asked to work out what the day contains — only how to phrase what it
 * has been given. Every failure path returns the rule-written text unchanged,
 * so the brief is never missing and never wrong, only sometimes plainer.
 *
 * Off unless a key is set.
 *
 * ---------------------------------------------------------------------------
 * About the key. There is no server in this app, so the key is stored in this
 * browser and sent straight from the page. That is a real trade-off and worth
 * stating plainly:
 *
 *   - It is NOT in the public repo and NOT visible to anyone visiting the
 *     site. It lives only in the storage of the browser you typed it into,
 *     and it is kept out of both Drive sync and exported backups on purpose
 *     (see `device()` in state.js).
 *   - Anything that can run script in that browser can read it. On a phone
 *     with your own apps that is a small surface; on a shared machine it is
 *     not, and this should be left off there.
 *   - Use a key restricted to a low spend limit. If it ever leaks, that limit
 *     is the whole of the damage.
 *
 * For a personal organiser on your own phone this is a reasonable call. It
 * would not be for an app with other users, which would need a small server
 * to hold the key instead.
 */

import { device } from './state.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';
const API_VERSION = '2023-06-01';

/**
 * The instruction. Deliberately narrow.
 *
 * It says "reword", not "summarise", because summarising invites dropping
 * things — and the one property this brief must have is that everything on it
 * is on it. The facts arrive as a finished list; the job is delivery.
 */
const SYSTEM = [
  'You reword a daily brief for someone about to start their day.',
  'You are given the finished facts. Do not add, remove, reorder or reinterpret any of them.',
  'Every time, name, and person in the input must appear in your output.',
  'Never invent a shift, a task, a time or a name that is not in the input.',
  'Write it as one short piece of plain text a person could read in ten seconds:',
  'lead with what kind of day it is, then what is fixed by the clock, then what is loose.',
  'British English. No preamble, no sign-off, no markdown headings, no bullet characters',
  'other than a plain dash. Keep any *asterisk emphasis* that is already there.',
  'Reply with the brief itself and nothing else.',
].join(' ');

export function aiConfigured() {
  return Boolean(device().anthropicKey);
}

/**
 * Reword `brief.text`. Returns the original on any failure.
 *
 * Never throws: a brief that fails to render because the network was down
 * would be a worse outcome than one that reads a little flatter.
 */
export async function polishBrief(brief, { signal } = {}) {
  const key = device().anthropicKey;
  if (!key) return { text: brief.text, source: 'rules' };

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        // Required for a call made straight from a page rather than a server.
        // The name is a warning, and the note at the top of this file is the
        // explanation for why it is an acceptable one here.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        // Thinking is on by default on this model and shares this budget with
        // the reply, so the ceiling is well clear of what the brief needs —
        // a tight budget truncates the answer rather than the thinking.
        max_tokens: 4000,
        // A rewording task, not a reasoning one. Low keeps it quick and cheap;
        // thinking is deliberately left on, because turning it off on this
        // model can leak internal tags into the visible text.
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: brief.text }],
      }),
    });

    if (!response.ok) {
      return { text: brief.text, source: 'rules', error: await describe(response) };
    }

    const data = await response.json();

    // A declined request comes back as a perfectly good 200 with nothing in
    // it, so the stop reason has to be checked before the content is read.
    if (data.stop_reason === 'refusal') {
      return { text: brief.text, source: 'rules', error: 'The model declined to rewrite this one.' };
    }

    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text) return { text: brief.text, source: 'rules', error: 'Empty reply.' };
    return { text, source: 'claude' };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { text: brief.text, source: 'rules', error: friendly(err) };
  }
}

async function describe(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || '';
  } catch { /* not JSON */ }
  if (response.status === 401) return 'That API key was rejected.';
  if (response.status === 429) return 'Rate limited — try again shortly.';
  if (response.status >= 500) return 'Anthropic is having trouble; the plain brief is below.';
  return detail || `Request failed (${response.status}).`;
}

function friendly(err) {
  // A blocked cross-origin request and a dead network are indistinguishable
  // from here — both surface as a bare TypeError with no useful detail.
  if (err instanceof TypeError) return 'Could not reach Anthropic — offline, or the request was blocked.';
  return err?.message || 'Something went wrong.';
}

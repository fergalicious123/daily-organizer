/* The review: read a block back, and turn it into things to do.
 *
 * Ben works four days then four nights. At the end of a block there is a pile
 * of half-recorded material — notes dictated onto tasks between jobs, diary
 * entries written at odd hours, things finished, things that quietly did not
 * happen. This gathers that up, reads it back, and asks Claude for the actions
 * buried in it.
 *
 * Three rules shape what is here, and all three are about trust:
 *
 *  1. NOTHING IS CREATED AUTOMATICALLY. Every suggestion is a proposal until
 *     it is accepted by hand. A review that quietly adds eight tasks is a
 *     review you stop opening.
 *
 *  2. EVERY PROPOSAL MUST QUOTE ITS SOURCE, verbatim. The model is required to
 *     return the words the suggestion came from, and `verify()` below checks
 *     that those words are actually present in what was sent. A proposal whose
 *     quote cannot be found is marked unverified in the UI rather than shown
 *     as though it were grounded. This is the difference between a tool that
 *     reads your notes and one that makes things up about your life.
 *
 *  3. THE SHAPE IS GUARANTEED, not hoped for. The response is constrained by a
 *     JSON schema, so a wandering reply cannot become a malformed task.
 *
 * ---------------------------------------------------------------------------
 * What leaves the device. This sends your diary entries and your task notes to
 * Anthropic's API over the network. That is more personal than the morning
 * brief, which only ever sent times and titles, and it is worth knowing rather
 * than discovering. It goes with your own key, on your own account. The review
 * still assembles and reads back perfectly well with no key at all — only the
 * proposals need one. See the note at the top of ai.js about the key itself.
 */

import { device } from './state.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';
const API_VERSION = '2023-06-01';

/**
 * The shape of a reply.
 *
 * `quote` is the load-bearing field. Asking for it does two things: it forces
 * the suggestion to be traceable to something actually written, and it gives
 * this side something checkable, which is what makes rule 2 enforcement rather
 * than etiquette.
 *
 * Kept within what the API's schema support allows — no length or count
 * constraints, and `additionalProperties: false` on every object.
 */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reflection', 'proposals'],
  properties: {
    reflection: {
      type: 'string',
      description:
        'Two or three sentences, plain British English, addressed to the person '
        + 'whose notes these are. What actually happened across this block, and '
        + 'anything worth noticing. No praise, no coaching voice, no summary of '
        + 'the obvious. If there is nothing worth saying, say so briefly.',
    },
    proposals: {
      type: 'array',
      description:
        'Concrete actions that the notes imply but which are not already '
        + 'recorded as tasks. Empty is a perfectly good answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'quote', 'urgency'],
        properties: {
          title: {
            type: 'string',
            description:
              'The action, phrased the way a person writes a todo: a verb and '
              + 'an object, under about eight words. No trailing full stop.',
          },
          why: {
            type: 'string',
            description: 'One short sentence on why this is worth doing.',
          },
          quote: {
            type: 'string',
            description:
              'The exact words from the input this came from, copied character '
              + 'for character. Not a paraphrase. This is checked.',
          },
          urgency: {
            type: 'string',
            enum: ['now', 'soon', 'someday'],
            description:
              'now = needs a date in the next day or two. soon = this month. '
              + 'someday = worth keeping, no date.',
          },
        },
      },
    },
  },
};

const SYSTEM = [
  'You are reading back one block of someone\'s working notes so they can decide what to do next.',
  'They are a British soldier who works four day shifts then four night shifts, studying English',
  'part-time and training for a 10-mile race. Write to them directly, plainly, British English.',
  '',
  'Your job is to find actions their own notes imply and they have not already written down.',
  'Rules, in order of importance:',
  '1. Never invent anything. Every proposal must come from words actually in the input.',
  '2. Copy the source words into `quote` exactly as they appear. This is verified against the input;',
  '   a paraphrase will be rejected and the proposal discarded.',
  '3. Do not propose something already listed under "Already finished" or "Slipped" — those exist.',
  '4. Prefer few and real over many and vague. Returning an empty list is correct when the notes',
  '   contain no actions. Do not pad.',
  '5. No motivational language, no compliments on effort, no restating what they obviously know.',
].join('\n');

/** True when a key is set and proposals are possible. */
export function reflectConfigured() {
  return Boolean(device().anthropicKey);
}

/**
 * Turn gathered material into the text the model reads.
 *
 * Exported because the review view shows it: if this is going to be sent, the
 * person sending it should be able to read exactly what that is first, rather
 * than trust a description of it.
 */
export function materialToText(material) {
  const out = [];

  if (material.journal.length) {
    out.push('## Diary');
    for (const entry of material.journal) {
      out.push(`[${entry.date}]`, entry.text, '');
    }
  }

  if (material.notes.length) {
    out.push('## Notes made on tasks');
    for (const note of material.notes) {
      out.push(`[${note.day}] on "${note.itemTitle}": ${note.text}`);
    }
    out.push('');
  }

  if (material.done.length) {
    out.push('## Already finished — do not propose these again');
    for (const item of material.done) out.push(`- ${item.title} (${item.day})`);
    out.push('');
  }

  if (material.slipped.length) {
    out.push('## Slipped — already on the list, still not done');
    for (const item of material.slipped) out.push(`- ${item.title} (was due ${item.day})`);
    out.push('');
  }

  return out.join('\n').trim();
}

/** Is there anything at all to think about? */
export function hasMaterial(material) {
  return Boolean(material
    && (material.journal.length || material.notes.length
      || material.done.length || material.slipped.length));
}

/**
 * Normalise for comparison.
 *
 * Quote checking has to survive the difference between what someone dictated
 * and what the model copied out: a curly apostrophe against a straight one,
 * a line break that became a space, trailing punctuation. It must NOT survive
 * an actual change of words, which is the thing being tested.
 */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9'"\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mark each proposal with whether its quote is really in the source.
 *
 * Not a filter. An unverified proposal is still shown — it may be a fair
 * reading that got the wording wrong — but it is shown as unverified, so the
 * decision to accept it is made knowing that. Silently dropping them would
 * hide a model going astray; silently keeping them would hide it too.
 */
export function verify(proposals, sourceText) {
  const haystack = normalise(sourceText);
  return proposals.map((p) => {
    const needle = normalise(p.quote);
    return { ...p, verified: needle.length > 0 && haystack.includes(needle) };
  });
}

/**
 * Ask for proposals. Throws with a readable message; the caller shows it.
 *
 * Unlike polishBrief, this does NOT fall back to a rule-written answer, because
 * there is no rule-written answer to fall back to — the honest outcome of a
 * failure here is "the review is still here, the suggestions are not".
 */
export async function proposeActions(material, { signal } = {}) {
  const key = device().anthropicKey;
  if (!key) throw new Error('Add an Anthropic API key in Settings to get suggestions.');

  const sourceText = materialToText(material);
  if (!sourceText) throw new Error('Nothing written in this block to read back.');

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      // Thinking is on by default on this model and shares this budget with the
      // reply, so the ceiling is set well clear of what the answer needs. A
      // tight budget truncates the answer rather than the thinking.
      max_tokens: 16000,
      // Reading a fortnight of scattered notes and working out what is
      // actionable is a judgement task, not a formatting one — worth more than
      // the brief's 'low', not worth 'high' on a few thousand words.
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      system: SYSTEM,
      messages: [{ role: 'user', content: sourceText }],
    }),
  }).catch((err) => {
    if (err?.name === 'AbortError') throw err;
    throw new Error(friendly(err));
  });

  if (!response.ok) throw new Error(await describe(response));

  const data = await response.json();

  // A decline arrives as a perfectly good 200 with nothing usable in it, and
  // the schema is not honoured on that path — so the stop reason is checked
  // before the content is read, not after.
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude declined to read this one back.');
  }

  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) throw new Error('Empty reply.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Should be impossible with a schema attached, which is exactly why it is
    // worth saying so rather than showing a JSON parse error.
    throw new Error('Claude replied in an unexpected shape.');
  }

  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  return {
    reflection: String(parsed.reflection || '').trim(),
    proposals: verify(proposals, sourceText),
    sourceText,
  };
}

async function describe(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || '';
  } catch { /* not JSON */ }
  if (response.status === 401) return 'That API key was rejected.';
  if (response.status === 429) return 'Rate limited — try again shortly.';
  if (response.status >= 500) return 'Anthropic is having trouble. Try again in a minute.';
  return detail || `Request failed (${response.status}).`;
}

function friendly(err) {
  if (err instanceof TypeError) return 'Could not reach Anthropic — offline, or the request was blocked.';
  return err?.message || 'Something went wrong.';
}

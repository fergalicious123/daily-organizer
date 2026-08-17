/* The two voices.
 *
 * Ben picked these himself, and the pairing is the whole idea of the routine
 * card: Machiavelli before the studying, Goggins before the gym. They are five
 * centuries and one enormous temperamental gulf apart — cold calculation
 * against sheer will — and that contrast is what the card is built around.
 * Mind first, then body.
 *
 * The typography follows the voice rather than the other way round: the
 * Florentine gets a quiet italic serif, the ultramarathoner gets blunt capitals.
 * See `.routine-quote` in styles.css.
 *
 * On the text itself: Machiavelli died in 1527 and his work is long out of
 * copyright, so those are quoted freely. Goggins is a living author, so his are
 * kept to a handful of short, well-known lines, always shown with his name
 * attached — never presented as the app's own words.
 */

/**
 * For the studying. Chosen for the ones that are about *doing the work*
 * rather than about politics — Machiavelli on practice, timing and nerve.
 */
const MACHIAVELLI = [
  'Nature creates few men brave; industry and training make many.',
  'The wise man does at once what the fool does finally.',
  'Where the willingness is great, the difficulties cannot be great.',
  'Never was anything great achieved without danger.',
  'Whosoever desires constant success must change his conduct with the times.',
  'It is better to act and repent than not to act and regret.',
  'Fortune is the arbiter of one half our actions, but she leaves the direction of the other half to us.',
  'There is no other way to guard yourself against flattery than by making men understand that telling you the truth will not offend you.',
];

/** For the gym. Short on purpose — that is how he says them. */
const GOGGINS = [
  'Stay hard.',
  'Motivation is crap.',
  'Denial is the ultimate comfort zone.',
  'Suffering is the true test of life.',
  'The most important conversations you will ever have are the ones you have with yourself.',
  'You are in danger of living a life so comfortable and soft that you will die without ever realizing your true potential.',
];

/**
 * Which voice belongs to which kind of step.
 *
 * `tone` is what the card styles on. It is deliberately not a colour — the
 * routine card is monochrome apart from the spine, and the difference between
 * the two voices is carried by the type instead.
 */
export const VOICES = {
  study: { author: 'Machiavelli', lines: MACHIAVELLI, tone: 'considered' },
  gym: { author: 'Goggins', lines: GOGGINS, tone: 'blunt' },
};

/**
 * One quote per kind per day.
 *
 * Keyed off the date rather than picked at random, for two reasons: a quote
 * that reshuffles every time the view re-renders is wallpaper, not something
 * you read; and the same line staying put all day means you can come back to
 * it. Walking the list in order rather than hashing means every quote gets its
 * turn instead of some never appearing.
 */
export function quoteFor(kind, dateKey) {
  const voice = VOICES[kind];
  if (!voice) return null;
  const day = daysSinceEpoch(dateKey);
  const line = voice.lines[((day % voice.lines.length) + voice.lines.length) % voice.lines.length];
  return { text: line, author: voice.author, tone: voice.tone };
}

/** Whole days from 1970, from a local YYYY-MM-DD key. Timezone-free by design. */
function daysSinceEpoch(dateKey) {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return 0;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

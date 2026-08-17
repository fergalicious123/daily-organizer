/* The two voices.
 *
 * Ben picked these himself, and the pairing is the whole idea of the routine
 * card: Machiavelli before the studying, Goggins before the gym. They are five
 * centuries and one enormous temperamental gulf apart — cold calculation
 * against sheer will — and that contrast is what the card is built around.
 * Mind first, then body.
 *
 * The typography follows the voice rather than the other way round: the
 * Florentine gets a quiet italic serif, the ultramarathoner gets a heavier
 * sans. See `.routine-quote` in styles.css.
 *
 * On the text itself: Machiavelli died in 1527 and his work is long out of
 * copyright, so those are quoted freely. Goggins is a living author, so his are
 * kept to a handful of short, well-known lines, always shown with his name
 * attached — never presented as the app's own words.
 *
 * Each quote carries two extra fields, shown when you open the "What this
 * means" toggle on the card:
 *
 *   note   — what it is getting at, and what it has to do with the task it is
 *            attached to. This is a reading, not a fact.
 *   source — where the line comes from. Written straight: where the wording is
 *            traditional rather than traceable to a passage, it SAYS SO. A
 *            confident-sounding citation that turns out to be folklore is
 *            worse than no citation, and these are quotes Ben might repeat.
 */

/**
 * For the studying. Chosen for the ones about *doing the work* rather than
 * about politics — Machiavelli on practice, timing and nerve.
 */
const MACHIAVELLI = [
  {
    text: 'Nature creates few men brave; industry and training make many.',
    note: 'Courage is mostly repetition. What looks like a natural gift is usually just somebody who practised for longer than you watched.',
    source: 'From the Discourses on Livy — his book about how republics and armies are actually built, as opposed to The Prince, which is about holding on to power.',
  },
  {
    text: 'The wise man does at once what the fool does finally.',
    note: 'You will do the course eventually. Doing it now costs exactly the same and buys back the rest of the day.',
    source: 'Traditionally attributed to Machiavelli, but it does not appear in this form in his major works. Treat it as in his spirit rather than in his hand.',
  },
  {
    text: 'Where the willingness is great, the difficulties cannot be great.',
    note: 'Difficulty is partly a measure of how much you would rather not. The task does not change size; your resistance to it does.',
    source: 'Widely attributed to Machiavelli, though not traced to a specific passage.',
  },
  {
    text: 'Never was anything great achieved without danger.',
    note: 'Anything worth having sits behind the risk of failing at it in public. That is the price, not a sign you picked wrong.',
    source: 'Commonly attributed to Machiavelli; the wording is traditional rather than a direct quotation.',
  },
  {
    text: 'Whosoever desires constant success must change his conduct with the times.',
    note: 'What worked last month is not owed to you. If the way you are studying has stopped working, change the method instead of grinding harder at it.',
    source: 'The argument of The Prince, chapter 25 — on fortune, and why inflexible men come unstuck the moment circumstances turn.',
  },
  {
    text: 'It is better to act and repent than not to act and regret.',
    note: 'A wrong move can be corrected tomorrow. A morning you spent deciding cannot.',
    source: 'Traditionally attributed to Machiavelli; the phrasing is proverbial rather than traceable.',
  },
  {
    text: 'Fortune is the arbiter of one half our actions, but she leaves the direction of the other half to us.',
    note: 'Half of how today goes is luck. The half that is not is the half you are standing in front of.',
    source: 'The Prince, chapter 25. He wrote it in exile, having lost his career overnight to a change of regime — he had reason to think carefully about luck.',
  },
  {
    text: 'There is no other way to guard yourself against flattery than by making men understand that telling you the truth will not offend you.',
    note: 'This applies to marking your own work. If you only ever assess yourself kindly, you never find out what you do not know.',
    source: 'The Prince, chapter 23, on why rulers end up surrounded by people who will not tell them anything useful.',
  },
];

/** For the gym. Short on purpose — that is how he says them. */
const GOGGINS = [
  {
    text: 'Stay hard.',
    note: 'Not "be tough". Closer to: do not go soft now that it has started to be uncomfortable.',
    source: 'His sign-off — he closes most of what he says and posts with it.',
  },
  {
    text: 'Motivation is crap.',
    note: 'Motivation turns up when the work already appeals. His point is that you need something that still works on the mornings it does not.',
    source: "From Can't Hurt Me (2018), his account of going from an overweight exterminator to a Navy SEAL and ultramarathon runner.",
  },
  {
    text: 'Denial is the ultimate comfort zone.',
    note: 'The comfortable move is rarely skipping the session. It is the reason you give yourself afterwards for why skipping it was fine.',
    source: "From Can't Hurt Me — the section on what he calls taking a hard look in the mirror.",
  },
  {
    text: 'Suffering is the true test of life.',
    note: 'He means it literally: he treats discomfort as the measurement, not the obstacle. You find out what you are on the days it is unpleasant.',
    source: "A recurring line in Can't Hurt Me and in his talks.",
  },
  {
    text: 'The most important conversations you will ever have are the ones you have with yourself.',
    note: 'Nobody else is in the room at 6am. Whatever you say to yourself then is the thing that decides it.',
    source: "From Can't Hurt Me.",
  },
  {
    text: 'You are in danger of living a life so comfortable and soft that you will die without ever realizing your true potential.',
    note: 'The threat is not failure. It is a life pleasant enough that you never find the edge of what you could have done.',
    source: "From Can't Hurt Me — the line the book is best known for.",
  },
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
  const index = ((day % voice.lines.length) + voice.lines.length) % voice.lines.length;
  const line = voice.lines[index];
  return {
    text: line.text,
    note: line.note,
    source: line.source,
    author: voice.author,
    tone: voice.tone,
  };
}

/** Whole days from 1970, from a local YYYY-MM-DD key. Timezone-free by design. */
function daysSinceEpoch(dateKey) {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return 0;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

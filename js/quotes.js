/* The two voices.
 *
 * Ben picked the anchors — Machiavelli before the studying, Goggins before the
 * training — and the pairing is the idea the routine card is built around:
 * five centuries and one enormous temperamental gulf apart, cold calculation
 * against sheer will. Mind first, then body.
 *
 * The pools around them are chosen to sound like the anchor rather than to be
 * a general quotations dictionary. The study list is people on practice,
 * patience and thinking clearly; the training list is people who have actually
 * suffered through something physical. Anything that could sit equally well on
 * a motivational poster for a sales team is not in here.
 *
 * SIZES ARE DELIBERATE: 31 and 29, both prime. Each list walks in order, so no
 * quote repeats within its own cycle — a month for one, four weeks for the
 * other — and because the lengths share no factor, the PAIRING of the two
 * quotes shown on a given morning does not repeat for 899 days.
 *
 * Every line carries three things beyond the text:
 *
 *   who    — the name shown under it.
 *   note   — what it is getting at, and what it has to do with the task it is
 *            pinned to. This is a reading, not a fact.
 *   source — where it comes from, written straight. Where the wording is
 *            traditional, or the attribution is popular but wrong, IT SAYS SO.
 *            A confident-sounding citation that turns out to be folklore is
 *            worse than none, and these are lines Ben might repeat to someone.
 *            Several famous ones here are misattributed in the wild; those are
 *            kept, because they are good lines, and labelled.
 *
 * On copyright: everyone quoted at length died long enough ago that their work
 * is public domain. The handful of modern figures — Goggins, Murakami — are
 * held to short, widely known lines, always with the name attached.
 */

/* ------------------------------------------------------------------ */
/* Before the studying — practice, patience, thinking straight         */
/* ------------------------------------------------------------------ */

const STUDY = [
  {
    text: 'Nature creates few men brave; industry and training make many.',
    who: 'Machiavelli',
    note: 'Courage is mostly repetition. What looks like a natural gift is usually somebody who practised for longer than you watched.',
    source: 'From the Discourses on Livy — his book on how republics and armies are actually built, as opposed to The Prince, which is about holding on to power.',
  },
  {
    text: 'The wise man does at once what the fool does finally.',
    who: 'Machiavelli',
    note: 'You will do the course eventually. Doing it now costs exactly the same and buys back the rest of the day.',
    source: 'Traditionally attributed to Machiavelli, but it does not appear in this form in his works. In his spirit rather than his hand.',
  },
  {
    text: 'Where the willingness is great, the difficulties cannot be great.',
    who: 'Machiavelli',
    note: 'Difficulty is partly a measure of how much you would rather not. The task does not change size; your resistance to it does.',
    source: 'Widely attributed to Machiavelli, though not traced to a specific passage.',
  },
  {
    text: 'Never was anything great achieved without danger.',
    who: 'Machiavelli',
    note: 'Anything worth having sits behind the risk of failing at it in public. That is the price, not a sign you picked wrong.',
    source: 'Commonly attributed to Machiavelli; the wording is traditional rather than a direct quotation.',
  },
  {
    text: 'Whosoever desires constant success must change his conduct with the times.',
    who: 'Machiavelli',
    note: 'What worked last month is not owed to you. If the way you are studying has stopped working, change the method instead of grinding harder at it.',
    source: 'The argument of The Prince, chapter 25 — on fortune, and why inflexible men come unstuck the moment circumstances turn.',
  },
  {
    text: 'It is better to act and repent than not to act and regret.',
    who: 'Machiavelli',
    note: 'A wrong move can be corrected tomorrow. A morning spent deciding cannot.',
    source: 'Traditionally attributed to Machiavelli; the phrasing is proverbial rather than traceable.',
  },
  {
    text: 'Fortune is the arbiter of one half our actions, but she leaves the direction of the other half to us.',
    who: 'Machiavelli',
    note: 'Half of how today goes is luck. The half that is not is the half you are standing in front of.',
    source: 'The Prince, chapter 25. Written in exile, having lost his career overnight to a change of regime — he had reason to think carefully about luck.',
  },
  {
    text: 'There is no other way to guard yourself against flattery than by making men understand that telling you the truth will not offend you.',
    who: 'Machiavelli',
    note: 'This applies to marking your own work. If you only ever assess yourself kindly, you never find out what you do not know.',
    source: 'The Prince, chapter 23, on why rulers end up surrounded by people who will not tell them anything useful.',
  },
  {
    text: 'It is not that we have a short time to live, but that we waste much of it.',
    who: 'Seneca',
    note: 'The complaint is never really about not having time. It is about where the time went.',
    source: 'Opening argument of On the Shortness of Life, written around AD 49. Seneca was a Roman senator and, less comfortably, Nero’s tutor.',
  },
  {
    text: 'Waste no more time arguing about what a good man should be. Be one.',
    who: 'Marcus Aurelius',
    note: 'Reading about how to study is still not studying. At some point the argument has to stop and the work has to start.',
    source: 'Meditations, book 10. He wrote it as a private notebook while on campaign — it was never meant to be published.',
  },
  {
    text: 'If you wish to be a writer, write.',
    who: 'Epictetus',
    note: 'The identity follows the practice, not the other way round. You do not become a student and then study.',
    source: 'From the Discourses, recorded by his pupil Arrian. Epictetus was born a slave and taught after being freed.',
  },
  {
    text: 'We are what we repeatedly do. Excellence, then, is not an act, but a habit.',
    who: 'Will Durant',
    note: 'One good morning proves nothing. Forty of them is a different person.',
    source: 'Almost always credited to Aristotle, and it is not his — it is Will Durant in The Story of Philosophy (1926), summarising Aristotle in his own words. Kept here under the right name.',
  },
  {
    text: 'Reading maketh a full man; conference a ready man; and writing an exact man.',
    who: 'Francis Bacon',
    note: 'Three different skills. If you only ever read the material, you will know it and still not be able to use it.',
    source: 'From the essay Of Studies, 1597. Still the shortest good advice on how to learn anything.',
  },
  {
    text: 'What we hope ever to do with ease, we must first learn to do with diligence.',
    who: 'Samuel Johnson',
    note: 'The fluent version of anything is downstream of a slow, awkward version nobody saw.',
    source: 'Johnson, who compiled his Dictionary of the English Language largely single-handed over nine years, knew what he was talking about.',
  },
  {
    text: 'The mind is not a vessel to be filled but a fire to be kindled.',
    who: 'Plutarch',
    note: 'Getting through the material is not the same as getting anything from it. Ask what it is for.',
    source: 'From the essay On Listening to Lectures, first century AD.',
  },
  {
    text: 'Knowing is not enough; we must apply. Willing is not enough; we must do.',
    who: 'Goethe',
    note: 'Two separate gaps, and most people are stuck in the second one.',
    source: 'Widely attributed to Goethe and consistent with his writing, though the compact English form is a translator’s.',
  },
  {
    text: 'Learning never exhausts the mind.',
    who: 'Leonardo da Vinci',
    note: 'Tiredness at the end of a study session is nearly always the resistance rather than the learning.',
    source: 'From the notebooks. Leonardo taught himself Latin in his forties because he was tired of not being able to read the sources.',
  },
  {
    text: 'The greatest thing in the world is to know how to belong to oneself.',
    who: 'Montaigne',
    note: 'Doing the work first, before the day starts asking things of you, is what this looks like in practice.',
    source: 'From the Essays, book one, 1580 — the book that more or less invented the form.',
  },
  {
    text: 'I fear not the man who has practised ten thousand kicks once, but I fear the man who has practised one kick ten thousand times.',
    who: 'Bruce Lee',
    note: 'Twenty-six courses done badly is worse than four done properly. Depth beats breadth when it is your own head you are furnishing.',
    source: 'Widely attributed to Bruce Lee and consistent with his teaching, though not traced to a specific published passage.',
  },
  {
    text: 'Without struggle, there is no progress.',
    who: 'Frederick Douglass',
    note: 'If today’s session felt easy, it is worth asking whether it did anything.',
    source: 'From his 1857 West India Emancipation speech, on why power concedes nothing without a demand. Douglass taught himself to read while enslaved.',
  },
  {
    text: 'Nothing in life is to be feared, it is only to be understood. Now is the time to understand more, so that we may fear less.',
    who: 'Marie Curie',
    note: 'The dread before a hard subject is mostly unfamiliarity. It shrinks the moment you start.',
    source: 'Attributed to Curie in a 1930s biography by her daughter Ève; the exact phrasing has been polished in circulation.',
  },
  {
    text: 'A journey of a thousand miles begins beneath one’s feet.',
    who: 'Lao Tzu',
    note: 'Not "with a single step" — beneath your feet. It starts where you already are, which removes the excuse.',
    source: 'Tao Te Ching, chapter 64. The familiar "single step" version is a loose translation; this is closer to the Chinese.',
  },
  {
    text: 'Genius is one per cent inspiration and ninety-nine per cent perspiration.',
    who: 'Thomas Edison',
    note: 'The ratio is the point. Waiting to feel clever is waiting on the one per cent.',
    source: 'Edison said versions of this repeatedly from the 1890s; the exact wording varies between accounts.',
  },
  {
    text: 'In the midst of chaos, there is also opportunity.',
    who: 'Sun Tzu',
    note: 'A broken week is not a lost one. Disruption moves things that were previously stuck.',
    source: 'From The Art of War, though this compact English phrasing is a modern translator’s rendering.',
  },
  {
    text: 'We will either find a way, or make one.',
    who: 'Hannibal',
    note: 'Said about crossing the Alps with elephants. Your obstacle is a Tuesday evening and a laptop.',
    source: 'Attributed to Hannibal by later Roman writers rather than recorded at the time; the Latin form is aut inveniam viam aut faciam.',
  },
  {
    text: 'An investment in knowledge pays the best interest.',
    who: 'Benjamin Franklin',
    note: 'The one thing you own that cannot be taken, devalued, or left behind in a move.',
    source: 'Universally attributed to Franklin, but not found in his published writing — it appears to be a later paraphrase of his views on education.',
  },
  {
    text: 'It does not matter how slowly you go so long as you do not stop.',
    who: 'Confucius',
    note: 'Twenty minutes counts. Twenty minutes every day counts enormously.',
    source: 'Attributed to Confucius everywhere and found in none of the Analects. Origin unknown; kept because it is true, labelled because it is not his.',
  },
  {
    text: 'Well begun is half done.',
    who: 'Aristotle',
    note: 'The hard part of the session is the first four minutes. After that you are just doing it.',
    source: 'Aristotle quotes it in the Politics as an existing proverb — so even he was borrowing it.',
  },
  {
    text: 'He who has a why to live can bear almost any how.',
    who: 'Nietzsche',
    note: 'Twenty-six courses is a how. Worth being clear with yourself about the why before a morning you do not fancy it.',
    source: 'Twilight of the Idols, 1888. Later made famous by Viktor Frankl, who quoted it in Man’s Search for Meaning.',
  },
  {
    text: 'The best time to plant a tree was twenty years ago. The second best time is now.',
    who: 'Proverb',
    note: 'Starting late is not an argument against starting.',
    source: 'Usually labelled a Chinese proverb; no Chinese source has ever been found. Most likely twentieth-century English in origin.',
  },
  {
    text: 'Do not wait; the time will never be just right.',
    who: 'Napoleon Hill',
    note: 'There is no morning when you will feel entirely ready and nothing else is competing. That morning is not coming.',
    source: 'From his 1937 book Think and Grow Rich.',
  },
];

/* ------------------------------------------------------------------ */
/* Before the training — endurance, discomfort, keeping going          */
/* ------------------------------------------------------------------ */

const TRAINING = [
  {
    text: 'Stay hard.',
    who: 'Goggins',
    note: 'Not "be tough". Closer to: do not go soft now that it has started to be uncomfortable.',
    source: 'His sign-off — he closes most of what he says and posts with it.',
  },
  {
    text: 'Motivation is crap.',
    who: 'Goggins',
    note: 'Motivation turns up when the work already appeals. His point is that you need something that still works on the mornings it does not.',
    source: "From Can't Hurt Me (2018), his account of going from an overweight exterminator to a Navy SEAL and ultramarathon runner.",
  },
  {
    text: 'Denial is the ultimate comfort zone.',
    who: 'Goggins',
    note: 'The comfortable move is rarely skipping the session. It is the reason you give yourself afterwards for why skipping it was fine.',
    source: "From Can't Hurt Me — the section on what he calls taking a hard look in the mirror.",
  },
  {
    text: 'Suffering is the true test of life.',
    who: 'Goggins',
    note: 'He means it literally: discomfort is the measurement, not the obstacle. You find out what you are on the days it is unpleasant.',
    source: "A recurring line in Can't Hurt Me and in his talks.",
  },
  {
    text: 'The most important conversations you will ever have are the ones you have with yourself.',
    who: 'Goggins',
    note: 'Nobody else is in the room at 6am. Whatever you say to yourself then is the thing that decides it.',
    source: "From Can't Hurt Me.",
  },
  {
    text: 'You are in danger of living a life so comfortable and soft that you will die without ever realizing your true potential.',
    who: 'Goggins',
    note: 'The threat is not failure. It is a life pleasant enough that you never find the edge of what you could have done.',
    source: "From Can't Hurt Me — the line the book is best known for.",
  },
  {
    text: 'When you cannot keep going, go faster.',
    who: 'Emil Zátopek',
    note: 'Deliberately absurd, and he meant it. The body has more left at the point the mind starts negotiating.',
    source: 'Zátopek won the 5,000m, 10,000m and marathon at the 1952 Olympics in the same week. He had never run a marathon before.',
  },
  {
    text: 'An athlete cannot run with money in his pockets. He must run with hope in his heart and dreams in his head.',
    who: 'Emil Zátopek',
    note: 'Worth remembering on a training run that has no prize attached. The reason has to be yours.',
    source: 'Zátopek, whose training was so brutal that other runners assumed he was exaggerating it.',
  },
  {
    text: 'To give anything less than your best is to sacrifice the gift.',
    who: 'Steve Prefontaine',
    note: 'Turning up and coasting is worse than not turning up: it costs the same time and teaches you to coast.',
    source: 'Prefontaine held every American record from 2,000m to 10,000m when he died at 24.',
  },
  {
    text: 'The man who can drive himself further once the effort gets painful is the man who will win.',
    who: 'Roger Bannister',
    note: 'Everyone is roughly equal until it hurts. The race starts at the point most people quietly ease off.',
    source: 'Bannister ran the first sub-four-minute mile in 1954, training in his lunch breaks as a medical student.',
  },
  {
    text: 'I hated every minute of training, but I said: do not quit. Suffer now and live the rest of your life as a champion.',
    who: 'Muhammad Ali',
    note: 'Note that he hated it. Enjoying the training was never the requirement.',
    source: 'Ali said versions of this in several interviews; the polished form is the one that stuck.',
  },
  {
    text: 'Pain is inevitable. Suffering is optional.',
    who: 'Haruki Murakami',
    note: 'The legs hurting is a fact. The story you tell yourself about how unfair it is that they hurt is a choice.',
    source: 'From What I Talk About When I Talk About Running (2007), his memoir of marathon training. He notes it is a runner’s mantra, not his invention.',
  },
  {
    text: 'The impediment to action advances action. What stands in the way becomes the way.',
    who: 'Marcus Aurelius',
    note: 'The hill you did not want on the route is the part of the route doing the work.',
    source: 'Meditations, book 5, section 20 — one of the few lines in the book that reads as a slogan and genuinely is his.',
  },
  {
    text: 'Difficulties strengthen the mind, as labour does the body.',
    who: 'Seneca',
    note: 'He is making a direct comparison, not a metaphor. Both adapt to load, and neither adapts without it.',
    source: 'From the Moral Letters to Lucilius, written in the last years of his life.',
  },
  {
    text: 'No man is free who is not master of himself.',
    who: 'Epictetus',
    note: 'The alarm going off is the whole test, and it is over in four seconds.',
    source: 'From the Discourses. Epictetus was lame in one leg, most likely from an injury inflicted while he was enslaved.',
  },
  {
    text: 'Do not pray for an easy life; pray for the strength to endure a difficult one.',
    who: 'Bruce Lee',
    note: 'Wishing the ten-miler were shorter is wasted. Wishing you were harder is actionable.',
    source: 'Widely attributed to Bruce Lee; the sentiment predates him and appears in several older forms.',
  },
  {
    text: 'Fatigue makes cowards of us all.',
    who: 'Vince Lombardi',
    note: 'When you are tired everything looks like a good reason to stop. Recognising that is most of the defence against it.',
    source: 'Lombardi used it constantly; the line is older than him and appears in American football coaching well before his era.',
  },
  {
    text: 'We all have dreams. But to make dreams reality takes an awful lot of determination, dedication, self-discipline and effort.',
    who: 'Jesse Owens',
    note: 'Four separate things, and none of them is talent.',
    source: 'Owens won four golds at the 1936 Berlin Olympics in front of Hitler, and came home to a country that still made him use the freight lift.',
  },
  {
    text: 'It is not the mountain we conquer, but ourselves.',
    who: 'Edmund Hillary',
    note: 'The route does not care. The only thing that changes on the way up is you.',
    source: 'Hillary, a beekeeper from New Zealand, was first to the summit of Everest with Tenzing Norgay in 1953.',
  },
  {
    text: 'It is a rough road that leads to the heights of greatness.',
    who: 'Seneca',
    note: 'The roughness is not a detour from the route. It is the route.',
    source: 'From the Moral Letters to Lucilius.',
  },
  {
    text: 'Nothing in the world can take the place of persistence. Talent will not; nothing is more common than unsuccessful men with talent.',
    who: 'Calvin Coolidge',
    note: 'The gifted people you were intimidated by mostly stopped. That is the whole trick.',
    source: 'Attributed to Coolidge and printed for decades on motivational posters; there is no record of him actually writing or saying it.',
  },
  {
    text: 'The credit belongs to the man who is actually in the arena, whose face is marred by dust and sweat and blood.',
    who: 'Theodore Roosevelt',
    note: 'Nobody watching the ten-miler has an opinion worth as much as your own.',
    source: 'From the 1910 speech Citizenship in a Republic, given at the Sorbonne. Usually called the Man in the Arena passage.',
  },
  {
    text: 'Ready for anything.',
    who: 'Parachute Regiment',
    note: 'Utrinque Paratus. Ready for anything means having done the work before you knew what it was for.',
    source: 'The regimental motto, from the Latin utrinque paratus — literally "ready on both sides", from its airborne and ground roles.',
  },
  {
    text: 'Knowledge dispels fear.',
    who: 'Airborne Forces',
    note: 'The dread before a distance you have not run is mostly not knowing. Cover it once and the fear goes with it.',
    source: 'Motto of the British Army’s parachute training establishment at RAF Ringway, and later Brize Norton.',
  },
  {
    text: 'Sweat saves blood.',
    who: 'Erwin Rommel',
    note: 'What you spend in training you do not spend on the day. Not a metaphor in his line of work, or in yours.',
    source: 'Rommel, in Infanterie greift an (1937). The full version adds that blood saves lives.',
  },
  {
    text: 'The body achieves what the mind believes.',
    who: 'Proverb',
    note: 'Overstated, but directionally true: almost nobody stops because the legs have genuinely finished.',
    source: 'Gym-wall wisdom of no traceable origin, attributed to a dozen different people. Included as folklore, not scholarship.',
  },
  {
    text: 'It is not enough to be busy. The question is: what are we busy about?',
    who: 'Henry David Thoreau',
    note: 'Junk miles are still miles. Ten easy ones will not get you round a hard ten.',
    source: 'From an 1855 letter. Thoreau walked several hours a day and thought most people were rushing nowhere.',
  },
  {
    text: 'Perseverance is not a long race; it is many short races one after the other.',
    who: 'Walter Elliot',
    note: 'You are not training for September. You are training for this morning, thirty-nine more times.',
    source: 'Elliot was a Scottish MP and, before that, an army doctor in the First World War.',
  },
  {
    text: 'Fall seven times, stand up eight.',
    who: 'Japanese proverb',
    note: 'A missed session is one fall. The training block is not ruined; it is one short.',
    source: 'Nana korobi ya oki — a genuine Japanese proverb, unusually for something this widely quoted.',
  },
];

/**
 * Which pool belongs to which kind of step, and how that pool sounds by
 * default. `tone` is what the card styles on — the Florentine end gets a quiet
 * italic serif, the training end a heavier sans. A line may override it.
 */
export const VOICES = {
  study: { lines: STUDY, tone: 'considered' },
  gym: { lines: TRAINING, tone: 'blunt' },
};

/**
 * One quote per kind per day.
 *
 * Keyed off the date rather than picked at random, for two reasons: a quote
 * that reshuffles every time the view re-renders is wallpaper, not something
 * you read; and the same line staying put all day means you can come back to
 * it. Walking the list in order rather than hashing guarantees every quote
 * gets its turn instead of some never appearing.
 */
export function quoteFor(kind, dateKey) {
  const voice = VOICES[kind];
  if (!voice || !voice.lines.length) return null;
  const day = daysSinceEpoch(dateKey);
  const index = ((day % voice.lines.length) + voice.lines.length) % voice.lines.length;
  const line = voice.lines[index];
  return {
    text: line.text,
    note: line.note,
    source: line.source,
    author: line.who,
    tone: line.tone || voice.tone,
  };
}

/** Whole days from 1970, from a local YYYY-MM-DD key. Timezone-free by design. */
function daysSinceEpoch(dateKey) {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return 0;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/* Service worker — offline shell + notification clicks.
 *
 * Strategy:
 *   Navigation          -> network-first, falling back to cache when offline.
 *   Everything else     -> cache-first WITHIN a cache version.
 *   Cross-origin        -> never cached. Stale calendar data presented as
 *                          current would be worse than an honest failure.
 *
 * This used to be network-first on all code, to guarantee nobody ever ran a
 * stale build. It did guarantee that, and it cost a conditional request per
 * file on every single load — twenty-three modules plus the stylesheet, and
 * because ES imports arrive in a waterfall those were several sequential
 * rounds of latency before anything appeared. On a phone with one bar that is
 * the whole of the startup time, paid again at every open, forever.
 *
 * Cache-first is safe here because the freshness guarantee comes from
 * somewhere better: the worker script itself is fetched with
 * updateViaCache:'none' and re-checked every time the app is foregrounded, a
 * new version skips waiting and claims its clients, and the page listens for
 * controllerchange and reloads itself. So a deploy still lands on its own,
 * without every ordinary load paying for the check.
 *
 * The trade: for the few seconds between a new worker activating and the page
 * reloading, running code belongs to the old version while the cache holds the
 * new one. Only a lazily-imported module could notice, and the reload is
 * already in flight.
 *
 * Bump CACHE_VERSION on deploy to evict the old shell.
 */

// Bump on every deploy. Changing this evicts the previous cache wholesale, so
// nobody keeps running last week's code — and the app shows this string as its
// build stamp, read straight out of CacheStorage, so "has my phone got the new
// version?" is answerable by looking rather than guessing.
//
// v33: the Overdue page can turn the pile into a plan, spread across the days
// your rota actually leaves free, with each step draggable onto a day.
// v32: Catch, a note app at /capture/ that shares this app's storage; lines
// are sorted into now/later/note and reworded as actions before they become
// tasks.
// v31: the diary can write up a day as a paragraph, from what the app
// recorded rather than from anything invented.
// v30: the accent is a pale blue rather than olive, and the display serif is
// confined to text big enough to carry it.
// v29: Granola-style restyle - warm dark ground, a display serif for view
// titles, row colour as a bar rather than a wash, quieter chips.
// v28: bigger tick boxes with a target bigger still; the sync chip connects
// in one click; the sign-in hint is learned on its own.
// v27: a review of a block of NIGHTS collects the notes made after midnight,
// which is most of them.
// v26: the offline queue creates events idempotently too; closing a dialog
// or changing view stops dictation.
// v25: a review's suggestions cannot outlive the block they describe.
// v24: a task row shows how many notes are on it.
// v23: calendar events are created with an id we choose, so a create whose
// reply is lost can no longer become a second copy of the same task.
// v22: notes as you go, dictated or pasted onto a task; a review at the end
// of each shift block that reads the block back and proposes what to do.
// v21: the shell loads from cache instead of revalidating every file on every
// open; Google renews its own token ahead of expiry instead of only ever
// discovering it has expired.
// v20: the element being dragged keeps its pointer events.
// v19: a quote per routine step in the brief; all-day chips draggable by
// finger; the bin docks under the notes.
// v18: drag anything onto the bin to delete it, with undo.
// v17: a month of quotes per side; long events no longer block drops beneath
// them; day view swaps notes into the rail and the backlog into the panel.
// v16: the gym step becomes Para 10 training, counting down to 26 Sep.
// v15: each quote can explain itself — what it means, and where it is from.
// v14: quiet hours collapse; all-day strip folds; side panel holds only
// untimed items; the progress ring becomes an up-next strip.
// v13: day grid — titles clamp instead of clipping, short events read on one
// line, calmer event fills, the now-line carries the time.
// v12: First things — the morning ritual, with its two voices.
// v11: morning brief with WhatsApp send; diary box no longer redraws under
// the caret; the rail shows the backlog instead of repeating the day.
// v10: shift runs reveal across their days; reduced motion honoured globally.
// v9: month grid derives shift and crew from items already fetched.
// v8: the view scrolls while you drag near its edge.
// v7: shift runs as a block per day, carrying the crew; ranks stripped.
// v6: rota gate anchored to the start of a title; end dates repaired on
// every sync rather than only when the remote is newer.
// v5: multi-day events keep their end date through import and refresh.
// v4: shift runs drawn as one bar across their block, month cells pinned to
// their own columns, all-day end dates parsed in both forms.
//
// Bump this on EVERY deploy, not just when something looks cacheable. v3
// covered two deploys, so a device holding the first of them showed the right
// build number while running the wrong code — the stamp said v3 and so did the
// server, and there was no way to tell them apart by looking.
const CACHE_VERSION = 'organizer-v33';

// Every module the app loads. Keeping this complete matters more now than it
// used to: since the shell became cache-first, a file missing from here is not
// merely unavailable offline — it is fetched from the network on every single
// open, quietly giving back the startup time the change was made to save.
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  // Self-hosted because the worker never caches cross-origin: a font linked
  // from Google would disappear the moment the signal did.
  './fonts/figtree-latin-var.woff2',
  './fonts/instrumentserif-latin.woff2',
  './fonts/instrumentserif-latin-italic.woff2',
  './js/app.js',
  './js/state.js',
  './js/dates.js',
  './js/ui.js',
  './js/chart.js',
  './js/voice.js',
  './js/google.js',
  './js/sync.js',
  './js/notify.js',
  './js/brief.js',
  './js/quotes.js',
  './js/reflect.js',
  './js/triage.js',
  './js/plan.js',
  './js/daylog.js',
  './js/ai.js',
  './js/dragdrop.js',
  './js/shortcuts.js',
  './js/views/calendar.js',
  './js/views/tasks.js',
  './js/views/home.js',
  './js/views/done.js',
  './js/views/journal.js',
  './js/views/routine.js',
  './js/views/bin.js',
  './js/views/review.js',
  './js/views/planpanel.js',
  './js/views/clocks.js',
  './js/views/shortcutsPanel.js',
  './manifest.webmanifest',
  // Catch, the note app. Same origin on purpose — it shares this app's
  // storage, so handing a note over is a local write rather than a network
  // round trip. Precached so it opens instantly, which is its whole point.
  './capture/',
  './capture/index.html',
  './capture/capture.js',
  './capture/manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll fails the whole install if any single file 404s, which would
      // leave the app with no worker at all. Cache what we can instead.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

/* Where the app is being developed rather than used. */
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never serve Google or any cross-origin API from cache.
  if (url.origin !== self.location.origin) return;

  // The entry point stays network-first. It is one small request, so it costs
  // almost nothing, and it keeps a way back in if a worker ever gets itself
  // wedged: a hard reload fetches a real index.html from the server rather
  // than whatever this cache believes.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchAndCache(request).catch(() =>
        caches.match(request).then((cached) => cached || offlineFallback(request)),
      ),
    );
    return;
  }

  // On localhost, keep the old network-first behaviour.
  //
  // Cache-first is right for the deployed app and wrong for developing it:
  // every edit is invisible until the cache version changes or the cache is
  // cleared by hand. That cost me several confusing minutes in the session
  // that introduced it — a file edited on disk, served from cache, and an A/B
  // test that silently compared a build against itself. The speed it buys is
  // for a phone on a bad connection, which localhost is not.
  if (DEV_HOSTS.has(self.location.hostname)) {
    event.respondWith(
      fetchAndCache(request).catch(() =>
        caches.match(request).then((cached) => cached || offlineFallback(request)),
      ),
    );
    return;
  }

  // Everything else is immutable within a cache version, so the cache is the
  // answer — no request, no waiting. A miss (a file added since this version
  // was precached) falls through to the network and is kept.
  event.respondWith(
    caches.match(request).then((cached) => cached
      || fetchAndCache(request).catch(() => offlineFallback(request))),
  );
});

/**
 * Ask the server, not the browser's own cache.
 *
 * Network-first is not enough on its own: GitHub Pages serves `max-age=600`,
 * so a plain `fetch` inside the worker can be answered from the HTTP cache
 * with ten-minute-old code. The worker thinks it went to the network; it did
 * not. `no-cache` forces a revalidation, and a 304 keeps it cheap.
 *
 * Navigation requests cannot be reconstructed, so they fall through unchanged
 * — which is harmless, because index.html is a stub and every module it pulls
 * in goes through the revalidating path.
 */
function revalidating(request) {
  try {
    return new Request(request, { cache: 'no-cache' });
  } catch {
    return request;
  }
}

function fetchAndCache(request) {
  return fetch(revalidating(request)).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
    }
    return response;
  });
}

function offlineFallback(request) {
  if (request.mode === 'navigate') return caches.match('./index.html');
  return new Response('', { status: 504, statusText: 'Offline' });
}

/* Focus an existing window when a reminder is tapped, rather than opening
   a second copy of the app. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    }),
  );
});

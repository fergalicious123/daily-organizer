/* Service worker — offline shell + notification clicks.
 *
 * Strategy:
 *   Code (HTML/CSS/JS)  -> network-first, falling back to cache when offline.
 *   Static assets       -> cache-first (icons and the manifest never change
 *                          within a version).
 *   Cross-origin        -> never cached. Stale calendar data presented as
 *                          current would be worse than an honest failure.
 *
 * Network-first on code is deliberate. Stale-while-revalidate is the usual
 * choice, but it leaves every user exactly one version behind — a bug fix
 * only lands on their SECOND visit after a deploy, which is confusing to ship
 * against and worse to debug. The cost here is one round trip over a handful
 * of small files, and offline still works because the cache is the fallback.
 *
 * Bump CACHE_VERSION on deploy to evict the old shell.
 */

// Bump on every deploy. Changing this evicts the previous cache wholesale, so
// nobody keeps running last week's code — and the app shows this string as its
// build stamp, read straight out of CacheStorage, so "has my phone got the new
// version?" is answerable by looking rather than guessing.
//
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
const CACHE_VERSION = 'organizer-v18';

// Every module the app loads. A file missing from here still works online
// (code is network-first) but is unavailable offline, so the view that imports
// it fails to load with no obvious cause. Several were missing.
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
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
  './js/views/clocks.js',
  './js/views/shortcutsPanel.js',
  './manifest.webmanifest',
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

const STATIC_RE = /\.(png|svg|ico|woff2?)$|manifest\.webmanifest$/i;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never serve Google or any cross-origin API from cache.
  if (url.origin !== self.location.origin) return;

  // Icons and the manifest are immutable within a cache version.
  if (STATIC_RE.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(request)),
    );
    return;
  }

  // Code: network wins, cache rescues.
  event.respondWith(
    fetchAndCache(request).catch(() =>
      caches.match(request).then((cached) => cached || offlineFallback(request)),
    ),
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

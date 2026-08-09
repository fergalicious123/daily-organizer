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

// Bump on every deploy. v2: timezone-preserving push, list repair, focus
// survival, icon sizing. Changing this evicts the previous cache wholesale,
// so nobody keeps running last week's code.
const CACHE_VERSION = 'organizer-v2';
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
  './js/views/calendar.js',
  './js/views/tasks.js',
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

function fetchAndCache(request) {
  return fetch(request).then((response) => {
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

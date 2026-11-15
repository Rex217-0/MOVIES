/*
 * Service worker (Blocker F).
 *
 * Two jobs, both about making the app feel like a real installed app on a
 * phone:
 *
 *   1. A cached app shell, so launching from the home screen shows the UI
 *      immediately even on a slow mobile network.
 *   2. Never cache the API. Every /api call is live, authenticated and billable,
 *      and a cached job status would be a lie. API and render requests always go
 *      to the network.
 */
const CACHE = 'movie-creator-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live data: API, streams, renders. Never cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/renders/')) return;

  // Navigations: network first, fall back to the cached shell when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/')),
    );
    return;
  }

  // Static assets: cache first, then fill the cache in the background.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    }),
  );
});

/**
 * Service worker ZdrowaPolska — minimalny, pod instalowalność PWA i offline shell.
 * - same-origin GET only (API na yeapi.wpme.pl jest poza scope'em i tak omija SW)
 * - nawigacje: network-first z fallbackiem do cache'owanego '/' (offline)
 * - /assets/* (Vite, hashowane = immutable) i ikony/manifest: cache-first
 * Zmień CACHE przy zmianach logiki — activate czyści stare wersje.
 */
const CACHE = 'zp-v1';
const PRECACHE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ??
        fetch(e.request).then((res) => {
          if (res.ok && (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname))) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        }),
    ),
  );
});

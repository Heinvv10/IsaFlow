/**
 * IsaFlow Service Worker v3
 * Provides the offline page and cache-first static assets. Nothing that
 * depends on who is signed in is ever written to Cache Storage: tenant
 * identity lives in a cookie, and a cache keyed on the URL alone would hand
 * one user's or company's data to the next person at the browser (audit
 * 11 Nov 2026). So no API response and no app page is cached.
 */

// IMPORTANT: CACHE_NAME must change on every deploy so stale pages and
// JS chunks from previous builds get evicted. The deploy script injects
// the current BUILD_ID automatically via sed (see scripts/deploy/bluegreen.sh).
// The v3 prefix also differs from every cache an older worker created, and
// activate deletes them all.
const CACHE_NAME = 'isaflow-v3-__BUILD_ID__';

// Public, user-independent resources only.
const STATIC_ASSETS = [
  '/offline',
  '/manifest.json',
];

// Install: cache the offline page and manifest
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: delete every other cache, including any that hold tenant data
// written by an older worker.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/**
 * The public share page (/share/<token>) is never cached, by any strategy.
 *
 * Three reasons, each sufficient. The pathname IS the credential, so a cache
 * entry keyed on it writes a live token to the recipient's disk. The HTML
 * carries the financial pack and the token again inside __NEXT_DATA__. And the
 * page is served no-store precisely so that withdrawing the link withdraws the
 * document — a cached copy served offline after revocation defeats the one
 * control the sender has.
 *
 * Matched on the PATH, not the URL string: /sharepoint and /shared-with-me are
 * ordinary app pages, and a query string must not be able to smuggle "/share/"
 * into a URL that is not one.
 *
 * THE definition of this boundary lives in src/lib/paths/isSharePath.ts. This
 * is a deliberate second copy: a service worker is plain JS served to the
 * browser and cannot import from src. Change one, change both —
 * tests/unit/lib/serviceWorkerShareCache.test.ts runs this copy against the
 * same cases.
 */
function isSharePath(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return pathname === '/share' || pathname.startsWith('/share/');
}

/**
 * Check if a PATHNAME is a static asset (CSS, JS, images, fonts). Decided on
 * the path, never the full URL, so a query string such as `?f=a.js` cannot
 * turn an app page into a cache-first asset.
 */
function isStaticAsset(pathname) {
  return /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)$/.test(pathname);
}

function offlineFallback() {
  return caches.match('/offline').then((cached) =>
    cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
  );
}

// Fetch: strategy per request type
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // The shared pack: straight to the network, never into a cache. Before every
  // strategy, so no later branch can claim it.
  if (isSharePath(url)) return;

  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return;
  }

  // API calls carry tenant data: always the network, never a cache.
  if (pathname.startsWith('/api/')) return;

  // Cache-first for static assets (CSS, JS, images, fonts)
  if (isStaticAsset(pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          }).catch(() => cached || new Response('', { status: 503 }));
        })
      )
    );
    return;
  }

  // Page navigations: network only; the offline page when the network fails.
  // The response is NOT cached: an app page is authenticated and carries
  // tenant data in __NEXT_DATA__.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(offlineFallback));
  }
});

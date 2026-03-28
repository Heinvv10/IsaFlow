/**
 * IsaFlow Service Worker v2
 * Provides offline support, aggressive caching, and stale-while-revalidate for key APIs.
 */

const CACHE_NAME = 'isaflow-v2';

const STATIC_ASSETS = [
  '/accounting',
  '/accounting/customer-invoices',
  '/accounting/supplier-invoices',
  '/accounting/bank-reconciliation',
  '/accounting/journal-entries',
  '/accounting/reports',
  '/login',
  '/offline',
];

// Read-only API endpoints eligible for stale-while-revalidate
const SWR_API_PATTERNS = [
  '/api/accounting/dashboard-stats',
  '/api/accounting/chart-of-accounts',
];

// Install — cache shell and offline page
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/**
 * Check if request URL matches a stale-while-revalidate API pattern.
 */
function isSWRApi(url) {
  return SWR_API_PATTERNS.some((pattern) => url.includes(pattern));
}

/**
 * Check if request is for a static asset (CSS, JS, images, fonts).
 */
function isStaticAsset(url) {
  return /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)(\?.*)?$/.test(url);
}

// Fetch — strategy per request type
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Strategy 1: Stale-while-revalidate for key read-only API endpoints
  if (isSWRApi(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request).then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          }).catch(() => {
            // Network failed — return cached if available
            if (cached) return cached;
            return new Response(JSON.stringify({ error: 'Offline' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          });

          // Return cached immediately, update in background
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Skip other API calls — let them go to network directly
  if (url.includes('/api/')) return;

  // Strategy 2: Cache-first for static assets (CSS, JS, images, fonts)
  if (isStaticAsset(url)) {
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

  // Strategy 3: Network-first for HTML pages, offline fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          // Serve offline page as last resort for navigation requests
          if (request.mode === 'navigate') {
            return caches.match('/offline');
          }
          return new Response('', { status: 503 });
        })
      )
  );
});

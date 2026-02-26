const CACHE_NAME = 'cascata-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Install: Cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});


// Activate: Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (key !== CACHE_NAME) return caches.delete(key);
      })
    )).then(() => self.clients.claim())
  );
});

// Fetch: Stale-While-Revalidate strategy for assets, Network-First for API
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // Only cache GET requests

  const url = new URL(event.request.url);

  // API calls: Network First (never cache API data heavily)
  const apiPaths = ['/api/', '/rest/', '/rpc/', '/auth/', '/storage/', '/edge/', '/tables/', '/vector/', '/realtime', '/graphql'];
  if (apiPaths.some(p => url.pathname.startsWith(p))) {
    return;
  }

  // Allow cross-origin requests ONLY from specific safe CDNs
  const safeOrigins = ['esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com'];
  if (url.origin !== location.origin && !safeOrigins.includes(url.hostname)) {
    return; // Pass through to network (e.g., api.ipify.org) to prevent CORS/Opaque cache blocks
  }

  // External CDNs (esm.sh, fonts): Cache First
  if (safeOrigins.includes(url.hostname)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // App Shell: Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return res;
      });
      return cached || networkFetch;
    })
  );
});
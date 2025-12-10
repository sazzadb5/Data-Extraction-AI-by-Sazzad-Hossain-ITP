const CACHE_NAME = 'dataxtract-v1';
const URLS_TO_CACHE = [
  './',
  './index.html',
  './index.tsx',
  './App.tsx',
  './types.ts',
  './services/gemini.ts',
  './utils/export.ts',
  './utils/storage.ts',
  './components/InputSection.tsx',
  './components/ResultsView.tsx',
  './manifest.json'
];

// Install: Cache core files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // We attempt to cache core files, but don't fail if one is missing (dev environments vary)
      return cache.addAll(URLS_TO_CACHE).catch(err => console.log('Cache addAll warning:', err));
    })
  );
});

// Fetch: Intercept requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Ignore API calls (always need network)
  if (url.hostname.includes('googleapis')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // 2. Return cached content if available
      if (cachedResponse) {
        return cachedResponse;
      }

      // 3. Network Request
      return fetch(event.request).then((response) => {
        // Check if valid response
        if (!response || response.status !== 200 || response.type !== 'basic' && response.type !== 'cors') {
          return response;
        }

        // 4. Cache CDNs (React, Tailwind, Lucide, Fonts) dynamically
        if (
             url.hostname.includes('cdn') || 
             url.hostname.includes('aistudiocdn') ||
             url.hostname.includes('fonts') ||
             url.pathname.endsWith('.js') ||
             url.pathname.endsWith('.css')
           ) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }

        return response;
      });
    })
  );
});

// Activate: Cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
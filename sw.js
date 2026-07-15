// ============================================================
// ===== SERVICE WORKER - DHouse PWA v3 =====
// ============================================================

const CACHE_NAME = 'dhouse-v3';
const STATIC_CACHE = 'dhouse-static-v3';
const IMAGE_CACHE = 'dhouse-images-v3';
const API_CACHE = 'dhouse-api-v3';

// Files to cache on install (App Shell)
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Files to cache but update in background
const STATIC_ASSETS = [
  '/style.css',
  '/app.js',
];

// ============================================================
// ===== INSTALL =====
// ============================================================

self.addEventListener('install', (event) => {
  console.log('📦 Service Worker installing...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE)
    .then((cache) => {
      console.log('📦 Caching app shell...');
      return cache.addAll(APP_SHELL);
    })
    .then(() => {
      console.log('✅ App shell cached');
      return self.skipWaiting();
    })
  );
});

// ============================================================
// ===== ACTIVATE =====
// ============================================================

self.addEventListener('activate', (event) => {
  console.log('🚀 Service Worker activating...');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          // Keep only current caches
          if (![STATIC_CACHE, IMAGE_CACHE, API_CACHE].includes(name)) {
            console.log('🗑️ Deleting old cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => {
      console.log('✅ Service Worker activated');
      return self.clients.claim();
    })
  );
});

// ============================================================
// ===== FETCH =====
// ============================================================

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  
  // ---- Skip cross-origin requests ----
  if (url.origin !== location.origin) {
    // Handle external images (R2) with stale-while-revalidate
    if (request.destination === 'image' && url.hostname === 'pub-b159a4e8b8f5455391144b76fb07bbe5.r2.dev') {
      event.respondWith(handleImageRequest(request));
      return;
    }
    
    // Handle API calls to your worker
    if (url.hostname === 'dhouse-api.aplusbuddyhelp.workers.dev') {
      event.respondWith(handleApiRequest(request));
      return;
    }
    
    // For Firebase, Sentry, etc. - network only
    event.respondWith(fetch(request));
    return;
  }
  
  // ---- Same-origin requests ----
  const urlPath = url.pathname;
  
  // Static assets - cache first with background update
  if (STATIC_ASSETS.includes(urlPath) || urlPath.endsWith('.js') || urlPath.endsWith('.css')) {
    event.respondWith(handleStaticRequest(request));
    return;
  }
  
  // Images - stale-while-revalidate
  if (request.destination === 'image' || urlPath.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i)) {
    event.respondWith(handleImageRequest(request));
    return;
  }
  
  // HTML pages - network first, cache fallback
  if (request.destination === 'document' || urlPath === '/' || urlPath.endsWith('.html')) {
    event.respondWith(handleDocumentRequest(request));
    return;
  }
  
  // Everything else - cache first, network fallback
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Refresh in background
        fetch(request).then((response) => {
          if (response.ok) {
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, response);
            });
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => {
            cache.put(request, clone);
          });
        }
        return response;
      });
    })
  );
});

// ============================================================
// ===== HANDLER FUNCTIONS =====
// ============================================================

// ---- Static Assets (Cache First with Background Update) ----
async function handleStaticRequest(request) {
  const cached = await caches.match(request);
  
  if (cached) {
    // Return cached, update in background
    fetch(request).then((response) => {
      if (response.ok) {
        caches.open(STATIC_CACHE).then((cache) => {
          cache.put(request, response);
        });
      }
    }).catch(() => {});
    return cached;
  }
  
  // Not in cache - fetch and cache
  const response = await fetch(request);
  if (response.ok) {
    const clone = response.clone();
    caches.open(STATIC_CACHE).then((cache) => {
      cache.put(request, clone);
    });
  }
  return response;
}

// ---- Images (Stale-While-Revalidate) ----
async function handleImageRequest(request) {
  const cached = await caches.match(request);
  
  // Update cache in background
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      caches.open(IMAGE_CACHE).then((cache) => {
        cache.put(request, response);
      });
    }
    return response;
  }).catch(() => null);
  
  // Return cached if available, otherwise wait for fetch
  if (cached) {
    // Don't wait for fetch
    fetchPromise.catch(() => {});
    return cached;
  }
  
  // Not in cache - wait for fetch
  const response = await fetchPromise;
  return response || new Response('', { status: 404 });
}

// ---- API Calls (Network First with Cache Fallback) ----
async function handleApiRequest(request) {
  try {
    const response = await fetch(request);
    
    // Cache successful GET requests
    if (response.ok && request.method === 'GET') {
      const clone = response.clone();
      caches.open(API_CACHE).then((cache) => {
        cache.put(request, clone);
      });
    }
    return response;
  } catch (error) {
    // Network failed - try cache
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    // Return offline error
    return new Response(JSON.stringify({
      error: 'Network unavailable. Please check your connection.',
      offline: true,
      timestamp: Date.now(),
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ---- Documents (Network First with Cache Fallback) ----
async function handleDocumentRequest(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const clone = response.clone();
      caches.open(STATIC_CACHE).then((cache) => {
        cache.put(request, clone);
      });
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    // Fallback to offline page
    return new Response(`
      <!DOCTYPE html>
      <html>
        <head><title>DHouse - Offline</title></head>
        <body style="background:#0f0e17;color:#fffffe;text-align:center;padding:2rem;font-family:sans-serif;">
          <h1>📡 DHouse</h1>
          <p>You're offline. Please check your internet connection.</p>
          <p style="color:#6b7280;font-size:0.8rem;">The app will reconnect automatically when you're back online.</p>
        </body>
      </html>
    `, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

// ============================================================
// ===== BACKGROUND SYNC (Optional) ============================================================

// For future: Add background sync for offline posts
// self.addEventListener('sync', (event) => {
//   if (event.tag === 'sync-posts') {
//     event.waitUntil(syncPendingPosts());
//   }
// });
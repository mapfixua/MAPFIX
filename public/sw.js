/* Mapfix offline shell — network first, never hijack sitemap/API. */
const CACHE = 'mapfix-shell-v8';
const ASSETS = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/css/mapfix-map.css',
  '/js/mapfix-app.js',
];

function shouldBypass(url) {
  const p = url.pathname;
  if (url.origin !== self.location.origin) return true;
  if (p.startsWith('/api/')) return true;
  if (p === '/sitemap.xml' || p === '/robots.txt' || p === '/llms.txt') return true;
  // Let the browser follow these 301s. Intercepting them hides the redirect.
  if (
    p === '/kotsyubynske' ||
    p.startsWith('/kotsyubynske/') ||
    p === '/kotsiubynske' ||
    p.startsWith('/kotsiubynske/') ||
    p === '/kotsiubinske' ||
    p.startsWith('/kotsiubinske/') ||
    p === '/index.html' ||
    p === '/kiev' ||
    p.startsWith('/kiev/')
  ) {
    return true;
  }
  if (p.startsWith('/google') && p.endsWith('.html')) return true;
  if (
    p === '/login.html' ||
    p === '/register.html' ||
    p === '/forgot-password.html' ||
    p === '/reset-password.html' ||
    p === '/admin' ||
    p === '/admin.html' ||
    p.startsWith('/admin')
  ) {
    return true;
  }
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (shouldBypass(url)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // fetch() follows redirects. Hand the final URL back as a 301 so the
        // address bar changes instead of painting that page on the old URL.
        if (req.mode === 'navigate' && res.redirected && res.url) {
          return Response.redirect(res.url, 301);
        }
        if (res.ok && ASSETS.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate' && url.pathname === '/') {
          return caches.match('/');
        }
        return Response.error();
      })
  );
});

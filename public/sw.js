/* Mapfix offline shell — network first, never hijack sitemap/API. */
const CACHE = 'mapfix-shell-v6';
const ASSETS = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

function shouldBypass(url) {
  const p = url.pathname;
  if (url.origin !== self.location.origin) return true;
  if (p.startsWith('/api/')) return true;
  if (p === '/sitemap.xml' || p === '/robots.txt' || p === '/llms.txt') return true;
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

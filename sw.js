// Plan Flyover service worker: installable + works offline. Nothing is sent anywhere.
// Bump CACHE when you publish a new version so devices pick it up.
const CACHE = 'plan-flyover-v1.0';
const SHELL = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs', './vendor/three.module.min.js', './vendor/OrbitControls.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && /^plan-flyover-v/.test(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {   // page: network first so updates show up, cached copy offline
    e.respondWith(fetch(req, { cache: 'no-store' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  // app files, pdf.js fonts/cmaps: cache first, fill cache on first use
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});

// Offline cache for the installed app: network-first (always revalidated), cache fallback.
const CACHE = 'stenosim-v3';
const ASSETS = ['./', './index.html', './css/style.css', './js/rng.js', './js/vessel.js', './js/tree.js',
  './js/render.js', './js/scoring.js', './js/real.js', './js/tree3d.js', './js/vendor/three.min.js', './js/app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});

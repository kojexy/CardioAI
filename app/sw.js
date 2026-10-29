// Offline cache for the website version. Network first, cache as fallback.
const CACHE = 'cardioai-v2';
const FILES = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'data/labels-ru.json', 'icons/icon.svg', 'icons/icon-192.png',
  'js/main.js', 'js/ecg301.js', 'js/measure.js', 'js/signal.js', 'js/rules.js', 'js/compare.js', 'js/store.js', 'js/charts.js', 'js/files.js'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});

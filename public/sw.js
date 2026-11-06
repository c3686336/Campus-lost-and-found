const CACHE_PREFIX = 'campus-shell-';
const CACHE = `${CACHE_PREFIX}v3`;
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Keep all authenticated data out of Cache Storage, even while offline.
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || !SHELL.includes(url.pathname)) return;
  const network = fetch(event.request, {cache: 'no-cache'});
  const updateCache = network.then(async response => {
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE);
      await cache.put(event.request, copy);
    }
  });
  // Cache writes must finish before the browser is allowed to stop this worker.
  event.waitUntil(updateCache.catch(() => {}));
  event.respondWith(network.catch(async () => (await caches.match(event.request)) || new Response(
    '오프라인 화면을 준비하지 못했습니다. 인터넷에 연결한 후 다시 열어 주세요.',
    {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}}
  )));
});

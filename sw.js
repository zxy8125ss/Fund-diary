// 网络优先，离线时用缓存
const CACHE = 'fund-diary-v16';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const fresh = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/') ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request);   // 页面本身每次向服务器确认是否有新版
  e.respondWith(fresh.then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(url.origin + url.pathname, copy)); }
    return r;
  }).catch(() => caches.match(url.origin + url.pathname, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});

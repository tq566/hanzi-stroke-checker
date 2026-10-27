// sw.js — Service Worker：应用外壳预缓存 + 笔顺分块按需缓存
// 效果：添加到主屏幕后可离线使用；已写过的字离线依然可练习。

const VERSION = 'hzstroke-v6';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './data/meta.json',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/geometry.js',
  './js/matcher.js',
  './js/capture.js',
  './js/camera.js',
  './js/animator.js',
  './js/feedback.js',
  './js/perf.js',
  './js/vendor/qr.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 策略：同源 GET 一律缓存优先，未命中取网络并写回缓存（分块数据由此按需离线化）
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit ||
      fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit)
    )
  );
});

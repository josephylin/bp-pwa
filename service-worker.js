/* 血壓紀錄 PWA v2 — Service Worker
 * 改版號以強制更新；新增 stats.html 與 Chart.js
 */
const CACHE = 'bp-pwa-v2.6';   // 🌗 主題自動按時段切換
const ASSETS = [
  './',
  './index.html',
  './stats.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Apps Script API 一律走網路（且不快取，讓統計頁能取最新資料）
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) {
    return;
  }
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && (url.origin === self.location.origin
            || url.hostname === 'cdn.jsdelivr.net'
            || url.hostname.endsWith('fontshare.com')
            || url.hostname.endsWith('cdn.fontshare.com'))) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

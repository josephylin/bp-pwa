/* 血壓紀錄 PWA — Service Worker v2.8
 * 策略升級：
 *   - HTML：Network First（先網路、失敗才回快取）→ 解決 PWA 永遠看到舊頁面的問題
 *   - 靜態資源 (JS/CSS/字型/圖示)：Stale-While-Revalidate（先快取秒回，背景拉新版）
 *   - Apps Script API：直接 bypass，不過 SW
 *   - 新版安裝完成會主動 postMessage 通知頁面，由頁面決定要不要彈出「發現新版」提示
 */
const CACHE = 'bp-pwa-v2.20';  // 🔄 醫師列印報告：病患資訊、期間、達標定義、簽名區
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

/* ---------- Install：預先快取 ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
  // 不立即 skipWaiting()，讓頁面端決定何時切換（避免使用者中途資料未存就被重整）
});

/* ---------- Activate：清舊快取 + 接管所有頁面 + 通知所有頁面 ---------- */
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    // 通知所有已開啟的頁面：新版已就緒
    const all = await self.clients.matchAll({ type: 'window' });
    all.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: CACHE }));
  })());
});

/* ---------- 接收頁面命令：SKIP_WAITING → 立刻切換到新版 ---------- */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ---------- Fetch 策略 ---------- */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Apps Script API 一律 bypass（必須每次拉新）
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) {
    return;
  }
  if (e.request.method !== 'GET') return;

  // HTML 與 manifest：Network First → 確保使用者打開時看到最新內容
  const isDoc = e.request.mode === 'navigate'
              || e.request.destination === 'document'
              || url.pathname.endsWith('.html')
              || url.pathname.endsWith('/')
              || url.pathname.endsWith('manifest.json');

  if (isDoc) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // 靜態資源：Stale-While-Revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkPromise = fetch(e.request).then(res => {
        if (res.ok && (url.origin === self.location.origin
            || url.hostname === 'cdn.jsdelivr.net'
            || url.hostname.endsWith('fontshare.com')
            || url.hostname.endsWith('cdn.fontshare.com'))) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkPromise;
    })
  );
});

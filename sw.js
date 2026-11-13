// Service Worker：全アセットを事前にキャッシュし、以後はキャッシュから返す（cache-first）。
// ファイル（音声・phrases.json・コード）を差し替えて配信し直すときは VERSION を上げること。

const VERSION = 'v1';
const CACHE = `kuma-gaya-${VERSION}`;

const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './phrases.json',
  './css/app.css',
  './js/app.js',
  './js/detector.js',
  './js/panel.js',
  './js/player.js',
  './js/settings.js',
  './js/trigger.js',
  './icons/icon-180.png',
  './icons/icon-512.png',
  './vendor/mediapipe/vision_bundle.mjs',
  './vendor/mediapipe/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  './models/efficientdet_lite0.tflite',
];

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(CORE.map((url) => new Request(url, { cache: 'reload' })));

  // 音声ファイルは phrases.json から拾う。未配置のものがあってもインストールは失敗させない
  try {
    const res = await fetch('./phrases.json', { cache: 'reload' });
    const phrases = await res.json();
    await Promise.all(phrases.map(async (p) => {
      const url = `./audio/${p.file}`;
      try {
        const r = await fetch(url, { cache: 'reload' });
        if (r.ok) await cache.put(url, r);
      } catch { /* 未配置 */ }
    }));
  } catch { /* phrases.json は CORE 側で取得済み */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('kuma-gaya-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // 後から配置した音声などもここで溜めておく
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const index = await cache.match('./index.html');
        if (index) return index;
      }
      throw err;
    }
  })());
});

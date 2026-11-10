// オフラインでも開けるようにアプリ本体をキャッシュ（通信できる時は常に最新を取得）
const CACHE = 'todays-path-v13';
const META = 'todays-path-meta';   // バッジの数など、アプリ本体以外の小さな記録
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/store.js', 'js/util.js', 'js/sync.js', 'js/push.js', 'js/claude.js', 'js/backup.js', 'js/holidays.js', 'js/config.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== META).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // ブラウザの HTTP キャッシュで古いファイルが使われないよう、毎回サーバーに更新を確認する
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(fetch(req).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './#path';
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => list[0]
    ? list[0].navigate(url).then(c => c && c.focus())
    : self.clients.openWindow(url)));
});

// サーバーから届いたプッシュ通知。届いた数をバッジに足していく（アプリを開くと 0 に戻る）
self.addEventListener('push', e => {
  let n = {};
  try { n = e.data ? e.data.json() : {}; } catch { n = { title: "Today's Path", body: e.data?.text() || '' }; }
  e.waitUntil((async () => {
    const meta = await caches.open(META);
    const count = (+(await (await meta.match('badge'))?.text()) || 0) + 1;
    await meta.put('badge', new Response(String(count)));
    if (self.navigator.setAppBadge) await self.navigator.setAppBadge(count).catch(() => {});
    await self.registration.showNotification(n.title || "Today's Path", {
      body: n.body || '', tag: n.tag || undefined, data: { url: n.url || './#path' },
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    });
  })());
});

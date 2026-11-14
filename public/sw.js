/* MeshLink Chat Service Worker: App-Shell cachen, API nie cachen, Benachrichtigungs-Klicks. */
const CACHE = 'meshlink-chat-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network-first: immer aktuelle Version, offline aus dem Cache
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (SHELL.includes(url.pathname) || url.searchParams.has('v'))) {
          const copy = res.clone();
          caches.open(CACHE).then(async (c) => {
            // Ältere Versionen derselben Datei (?v=…) entfernen, sonst wächst der Cache mit jedem Update
            if (url.search) for (const k of await c.keys()) { const u = new URL(k.url); if (u.pathname === url.pathname && u.search !== url.search) c.delete(k); }
            c.put(e.request, copy);
          });
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  );
});

// Echte Push-Nachricht vom MeshLink-Chat-Server (kommt auch bei geschlossener App)
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'MeshLink Chat', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    timestamp: d.ts || Date.now(),
    data: { conv: d.conv || null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const conv = e.notification.data?.conv;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      if (conv) client.postMessage({ type: 'open-conv', conv });
    } else {
      await self.clients.openWindow(conv ? `/?conv=${encodeURIComponent(conv)}` : '/');
    }
  })());
});

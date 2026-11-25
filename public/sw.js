// Service worker: keeps the app working offline and shows reminders.

const CACHE = 'diary-v1';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/shared/format.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so updates arrive straight away), falling back to the saved copy when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/link/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(e.request.mode === 'navigate' ? '/' : e.request, { ignoreSearch: e.request.mode === 'navigate' });
      return cached || Response.error();
    }
  })());
});

// A reminder has arrived: ask the server what to show.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let shown = 0;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      const res = await fetch(`/api/push/pending?endpoint=${encodeURIComponent(sub ? sub.endpoint : '')}`, { credentials: 'include' });
      const { notifications = [] } = await res.json();
      for (const n of notifications) {
        await self.registration.showNotification(n.title, {
          body: n.body, tag: n.tag || undefined, data: { url: n.url || '/' },
          icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
          requireInteraction: true, renotify: !!n.tag,
        });
        shown += 1;
      }
    } catch { /* fall through */ }
    if (!shown) {
      const open = await self.registration.getNotifications();
      if (!open.length) {
        await self.registration.showNotification('Diary', { body: 'Tap to see your diary.', icon: '/icons/icon-192.png', data: { url: '/' } });
      }
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('navigate' in c) { await c.navigate(target); return c.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});

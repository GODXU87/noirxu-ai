// NOIRXU AI service worker: shows push notifications and opens the app when tapped.
// It deliberately does not cache pages, so data is never stale.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'NOIRXU AI', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'NOIRXU AI', {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '/apple-icon.png',
    badge: '/apple-icon.png',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) { await client.navigate(url); return client.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

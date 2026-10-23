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
    data: { url: data.url || '/', key: data.key }
  }).then(() => receipt(data.key, 'displayed')));
});

// Tells the server the notification was really shown / tapped. Best effort: a failed
// receipt only means the app keeps saying "push service accepted" instead of "displayed".
function receipt(key, event) {
  if (!key) return Promise.resolve();
  return fetch('/api/notify/receipt', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, event }) }).catch(() => undefined);
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    await receipt(event.notification.data?.key, 'opened');
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) { await client.navigate(url); return client.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

// The browser can replace a subscription (expiry, key rotation). Re-register the new one so
// reminders keep arriving; the diagnostics panel shows a mismatch if this ever fails.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const key = event.oldSubscription?.options?.applicationServerKey;
    const subscription = event.newSubscription || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
    if (!subscription) return;
    await fetch('/api/push/subscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription }) });
  })());
});

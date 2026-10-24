// Network-first app shell cache, so the page still opens on a flaky connection.
const CACHE = 'icecream-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'art.js', 'app.js', 'icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never cache the API
  e.respondWith(
    // no-cache: always check with the server (cheap 304 if unchanged), so a fresh
    // deploy shows up on the next open instead of after GitHub's 10-minute cache.
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Web Push: the Worker sends { title, body, tag, url } (see worker/src/push.js).
// iOS requires every push to show a notification, so always show one.
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = (e.data && e.data.json()) || {};
  } catch {
    data = { body: e.data ? e.data.text() : '' };
  }
  const options = {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: data.url || './' },
  };
  // renotify without a tag throws in Chrome, so only set it alongside one.
  if (data.tag) {
    options.tag = data.tag;
    options.renotify = true;
  }
  e.waitUntil(self.registration.showNotification(data.title || '🍦 Ice creams', options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => w.url.startsWith(self.registration.scope)) || wins[0];
      if (win && 'focus' in win) {
        // Already open: tell the page where to go (e.g. #post-5), then bring it forward.
        win.postMessage({ type: 'open', url });
        return win.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

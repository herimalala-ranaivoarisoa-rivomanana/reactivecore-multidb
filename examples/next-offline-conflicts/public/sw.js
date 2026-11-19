const cacheName = 'reactivecore-offline-conflicts-v1';

function shellResource(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname === '/' || url.pathname.startsWith('/_next/static/'))
  );
}

self.addEventListener('install', (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'warm-shell' || !event.ports[0]) return;
  event.waitUntil(
    (async () => {
      try {
        const assets = event.data.assets.map(
          (asset) => new URL(asset, self.location.origin),
        );
        const cache = await caches.open(cacheName);
        await cache.addAll([
          ...new Set(assets.filter(shellResource).map((url) => url.href)),
        ]);
        event.ports[0].postMessage(true);
      } catch {
        event.ports[0].postMessage(false);
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !shellResource(new URL(request.url))) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(request);
        return cached ?? Response.error();
      }
    })(),
  );
});

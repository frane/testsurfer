self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).pathname === '/parity/built') e.respondWith(new Response('from the worker', { headers: { 'content-type': 'text/plain' } }));
});

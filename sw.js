// Retomazera: cache para abrir rápido/offline e notificação diária (enviada pelo server.py do PC).
const CACHE = 'retomazera-v41';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'sync.js',
  'icon-192.png', 'badge-96.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('retomazera-') && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Rede primeiro (pega atualizações), cache como reserva offline. A API do server.py nunca vai para o cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const atualizado = e.request.mode === 'navigate'
    ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    atualizado
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match(e.request, { ignoreSearch: true })))
  );
});

// Push: { title, body, tag, data: 'AAAA-MM-DD' }
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Retomazera', {
      body: d.body || 'Lista de clientes para chamar hoje.',
      tag: d.tag || 'retomazera',
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200],
      icon: 'icon-192.png',
      badge: 'badge-96.png',
      data: { dia: d.data || '' },
    });
    const abertos = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    abertos.forEach((c) => c.postMessage({ tipo: 'push' }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const escopo = self.registration.scope;
  const dia = e.notification.data?.dia;
  const destino = dia === 'espera' ? `${escopo}#/espera` : !dia || dia === 'noite' ? `${escopo}#/` : dia.startsWith('semana/') ? `${escopo}#/${dia}` : `${escopo}#/dia/${dia}`;
  e.waitUntil((async () => {
    const abertos = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = abertos.find((c) => c.url.startsWith(escopo));
    if (app) {
      app.postMessage({ tipo: 'abrir', url: destino });
      return app.focus();
    }
    return self.clients.openWindow(destino);
  })());
});

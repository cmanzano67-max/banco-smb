// Service worker: la app abre sin conexión y se actualiza sola al publicar una versión nueva.
const VERSION = 'smb-20261007104342';
const SHELL = ['./', './index.html', './cloud.js', './firebase-config.js', './manifest.webmanifest', './icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  // Firebase (datos y cuentas) va siempre directo a la red
  if (/googleapis\.com|firebaseio\.com|identitytoolkit|securetoken/.test(u.host)) return;
  const libs = /gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.g/.test(u.host);
  if (u.origin === location.origin) {
    // la app: primero la red (para tener siempre la última versión), si no hay, lo guardado
    e.respondWith(fetch(r, { cache: 'no-cache' }).then(res => { const c = res.clone(); caches.open(VERSION).then(k => k.put(r, c)); return res; }).catch(() => caches.match(r).then(m => m || caches.match('./index.html'))));
  } else if (libs) {
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => { const c = res.clone(); caches.open(VERSION).then(k => k.put(r, c)); return res; })));
  }
});

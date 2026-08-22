const CACHE_NAME = 'bhr-lab-v2-robust-20260822-ux2';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './config.js',
    './script.js',
    './manifest.json',
    './qrcode.min.js',
    './pwa-icon.png'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => response || fetch(e.request))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        ).then(() => self.clients.claim())
    );
});

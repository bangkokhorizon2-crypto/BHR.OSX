// BHR.OSX Service Worker
// Version this file whenever a new app build is published.
const APP_VERSION = '1.0.10';
const CACHE_NAME = `bhr-osx-${APP_VERSION}`;

const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './config.js',
    './script.js',
    './manifest.json',
    './qrcode.min.js',
    './pwa-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((key) => key.startsWith('bhr-osx-') && key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

function isAppAsset(request) {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    return /\.(html?|css|js|json)(\?.*)?$/i.test(url.pathname) || url.pathname.endsWith('/');
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    // Always prefer the network for app code so GitHub updates are picked up.
    // If the network is unavailable, fall back to the current cache.
    if (isAppAsset(request)) {
        event.respondWith(
            fetch(request, { cache: 'no-store' })
                .then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
        );
        return;
    }

    // Static local assets can remain cache-first for fast startup/offline use.
    event.respondWith(
        caches.match(request).then((cached) => cached || fetch(request).then((response) => {
            if (response && response.ok && new URL(request.url).origin === self.location.origin) {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
        }))
    );
});

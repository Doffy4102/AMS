// Minimal service worker (PWA shell, network-first)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network passthrough */ });

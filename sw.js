// Lets phones install the site as an app. It does not save pages or data offline:
// every request goes straight to the network, so participants always get the current version.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* network only */ });

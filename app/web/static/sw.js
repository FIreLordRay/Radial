// Radial's service worker exists only to satisfy Chrome/Edge's installability
// criteria (a manifest alone isn't always enough to offer "Install app").
// It deliberately does NOT cache anything: every request just passes through
// to the network untouched. This is a live, local single-user app talking to
// its own backlog/Plaky state -- caching responses would just mean stale
// data with no correctness benefit, since there's nothing here worth an
// offline fallback for.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});

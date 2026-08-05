// Telesto Node service worker — minimal, hand-written (no next-pwa) so the
// caching behavior is fully legible and doesn't depend on a third-party
// build plugin's compatibility with the current Next.js version.
//
// Strategy:
//   - Navigations (HTML documents): network-first, falling back to the
//     last cached version of that exact route when offline. This is what
//     lets the app open at all with zero connectivity, as long as the
//     route was visited at least once while online.
//   - Same-origin static assets (/_next/static/*, /icons/*): cache-first.
//     Next.js content-hashes these filenames, so a cached copy is never
//     stale — a new build means a new URL, not a stale hit on an old one.
//   - Cross-origin requests (the FastAPI backend, Cloudinary, MapLibre
//     CDN, Jitsi) and any non-GET request: NOT intercepted at all.
//     Offline handling of actual mission data (snapshots, clips,
//     telemetry) is the IndexedDB queue's job (lib/offlineStore.js), not
//     this service worker's — conflating the two would make failures
//     much harder to reason about.

const CACHE_NAME = "telesto-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin || request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirstAsset(request));
  }
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Genuinely nothing to serve: this exact route was never opened
    // while online, so there's no cached copy to fall back to.
    return new Response(
      "<!DOCTYPE html><html><body style=\"background:#171d20;color:#5a6a72;font-family:monospace;padding:2rem;\">" +
        "<h1 style=\"color:#d3dbe0;\">Telesto Node is offline</h1>" +
        "<p>This page hasn't been opened before while online, so nothing is cached for it yet. " +
        "Connect once, then it'll be available offline.</p></body></html>",
      { headers: { "Content-Type": "text/html" } }
    );
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  cache.put(request, response.clone());
  return response;
}
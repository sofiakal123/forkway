// Offline support. The app, its NYC transit data and recently viewed map
// tiles are cached, so planning and trip tracking keep working underground.
// Bump VERSION whenever app files or data change, so phones pick them up.

const VERSION = "forkway-v1";
const TILE_CACHE = "forkway-tiles";
const MAX_TILES = 400;

const APP_FILES = [
  "./",
  "index.html",
  "css/app.css",
  "js/app.js",
  "js/network.js",
  "js/router.js",
  "js/search.js",
  "js/map.js",
  "js/live.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "data/transit.json",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "tile.openstreetmap.org") {
    event.respondWith(tile(request));
  } else if (url.hostname === "nominatim.openstreetmap.org") {
    return; // place search needs the network; no caching
  } else if (url.origin === self.location.origin || url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith(cachedThenRefresh(request));
  }
});

// Answer from the cache right away, and refresh the cache in the background
async function cachedThenRefresh(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: true });
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached ?? (await fresh) ?? new Response("Offline", { status: 503 });
}

// Map tiles: cached as you view them, oldest dropped past MAX_TILES
async function tile(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") {
      await cache.put(request, response.clone());
      const keys = await cache.keys();
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(old);
    }
    return response;
  } catch {
    return new Response("", { status: 504 });
  }
}

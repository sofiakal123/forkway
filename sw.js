// Offline support. The app, its NYC transit data and the map are cached, so
// planning and trip tracking keep working underground. Live MTA data is
// never cached: it's either fresh or not used.
// Bump VERSION whenever app files or data change, so phones pick them up.

const VERSION = "forkway-v2";
const MAP_CACHE = "forkway-map"; // map tiles, fonts and the map's index
const MAX_CLOSE_TILES = 800; // street-level tiles kept from browsing (saved NYC map tiles are never dropped)
const SAVED_MAP_ZOOM = 13; // the "Save NYC map" download covers zooms up to this

const APP_FILES = [
  "./",
  "index.html",
  "css/app.css",
  "fonts/bricolage-grotesque.woff2",
  "js/app.js",
  "js/network.js",
  "js/router.js",
  "js/search.js",
  "js/map.js",
  "js/live.js",
  "js/realtime.js",
  "js/offline-map.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "data/transit.json",
  "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css",
  "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== MAP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "tiles.openfreemap.org") {
    event.respondWith(url.pathname === "/planet" ? networkFirst(request) : mapFile(request, url));
  } else if (url.origin === self.location.origin || url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith(cachedThenRefresh(request));
  }
  // Everything else (live MTA data, place search) goes straight to the network
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

// The map's index names this week's tile set; use the saved one when offline
async function networkFirst(request) {
  const cache = await caches.open(MAP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? new Response("{}", { status: 504 });
  }
}

// Map tiles and fonts change rarely, so a saved copy is good enough. Tile
// addresses include the week's tile set ("/planet/20261025_080012_pt/13/…"),
// so they're stored under a week-independent name to stay usable.
async function mapFile(request, url) {
  const cache = await caches.open(MAP_CACHE);
  const key = mapKey(url);
  const cached = await cache.match(key);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(key, response.clone());
      trimCloseTiles(cache);
    }
    return response;
  } catch {
    return new Response("", { status: 504 });
  }
}

function mapKey(url) {
  return url.href.replace(/\/planet\/[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, "/planet/saved/$1");
}

// Street-level tiles from browsing are dropped oldest first past a limit
let trimming = false;
async function trimCloseTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const close = (await cache.keys()).filter((r) => {
      const z = r.url.match(/\/planet\/saved\/(\d+)\//)?.[1];
      return z && Number(z) > SAVED_MAP_ZOOM;
    });
    for (const old of close.slice(0, Math.max(0, close.length - MAX_CLOSE_TILES))) await cache.delete(old);
  } finally {
    trimming = false;
  }
}

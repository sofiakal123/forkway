// Offline support. The app, its NYC transit data and the map are cached, so
// planning and trip tracking keep working underground. Live MTA data is
// never cached: it's either fresh or not used.
// Bump VERSION whenever app files or data change, so phones pick them up.

const VERSION = "forkway-v4";
const NETWORK_TIMEOUT_MS = 4000; // past this, answer from the saved copy
const MAP_TIMEOUT_MS = 8000; // a map piece that takes longer is treated as missing
const MAP_CACHE = "forkway-map"; // map tiles, fonts and the map's index
const MAX_CLOSE_TILES = 800; // street-level tiles kept from browsing (saved NYC map tiles are never dropped)
const SAVED_MAP_ZOOM = 13; // the "Save NYC map" download covers zooms up to this

const APP_FILES = [
  "./",
  "index.html",
  "css/app.css",
  "fonts/bricolage-grotesque.woff2",
  "fonts/geist-mono.woff2",
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

// "reload" skips the browser's HTTP cache, so a new version never saves a
// mix of old and new files
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: "reload" }))))
  );
  self.skipWaiting();
});

// Pages from these versions can't reload themselves after an update, and may
// be running a mix of old and new files, so reload them from here
const LEGACY_VERSIONS = ["forkway-v1", "forkway-v2"];

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter((k) => k !== VERSION && k !== MAP_CACHE);
      await Promise.all(old.map((k) => caches.delete(k)));
      await self.clients.claim();
      if (old.some((k) => LEGACY_VERSIONS.includes(k))) {
        for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url).catch(() => {});
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "tiles.openfreemap.org") {
    event.respondWith(url.pathname === "/planet" ? networkFirst(request) : mapFile(request, url));
  } else if (url.origin === self.location.origin || url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith(appFile(request));
  }
  // Everything else (live MTA data, place search) goes straight to the network
});

// App files: the latest from the network when there's signal, so every file
// is from the same version; the saved copy when there isn't
async function appFile(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await withTimeout(fetch(request, { cache: "no-cache" }), NETWORK_TIMEOUT_MS);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) ?? new Response("Offline", { status: 503 });
  }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

// The map's index names this week's tile set; use the saved one when offline
async function networkFirst(request) {
  const cache = await caches.open(MAP_CACHE);
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
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
    const response = await withTimeout(fetch(request), MAP_TIMEOUT_MS);
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

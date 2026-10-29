// "Save NYC map": downloads the base map for all five boroughs (zooms 10-13,
// about 300 tiles) so the map works with no signal. Tiles hold map data, not
// pictures, so the saved map stays sharp when you zoom in further.
// Uses the same cache and names as the service worker (sw.js).

const TILEJSON = "https://tiles.openfreemap.org/planet";
const FONTS = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"];
const FONT_RANGES = ["0-255", "8192-8447"]; // letters, then dashes and quotes
const MAP_CACHE = "forkway-map";
const SAVED_KEY = "forkway-map-saved";
const NYC = { south: 40.49, north: 40.92, west: -74.27, east: -73.68 };
const ZOOMS = [10, 11, 12, 13];
const PARALLEL = 6;

export function savedMapDate() {
  try {
    const saved = localStorage.getItem(SAVED_KEY);
    return saved ? new Date(saved) : null;
  } catch {
    return null;
  }
}

// onProgress(done, total, bytes). Resolves with the bytes saved.
export async function saveNycMap(onProgress = () => {}) {
  const cache = await caches.open(MAP_CACHE);
  const index = await fetch(TILEJSON, { cache: "no-store" });
  if (!index.ok) throw new Error(`Map index: HTTP ${index.status}`);
  await cache.put(TILEJSON, index.clone());
  const tiles = (await index.json()).tiles;
  const template = tiles[0];
  try {
    localStorage.setItem("forkway-map-tiles", JSON.stringify(tiles)); // so the map can start with no signal (see map.js)
  } catch {
    // The map fetches the address itself next time it's online
  }

  const jobs = [];
  for (const z of ZOOMS) {
    for (let x = tileX(NYC.west, z); x <= tileX(NYC.east, z); x++) {
      for (let y = tileY(NYC.north, z); y <= tileY(NYC.south, z); y++) {
        const url = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
        jobs.push({ url, key: url.replace(/\/planet\/[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, "/planet/saved/$1") });
      }
    }
  }
  for (const font of FONTS) {
    for (const range of FONT_RANGES) {
      const url = `https://tiles.openfreemap.org/fonts/${encodeURIComponent(font)}/${range}.pbf`;
      jobs.push({ url, key: url });
    }
  }

  let done = 0;
  let bytes = 0;
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        if (!(await cache.match(job.key))) {
          const res = await fetch(job.url, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.arrayBuffer();
          bytes += body.byteLength;
          await cache.put(job.key, new Response(body, { headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/x-protobuf" } }));
        }
      } catch {
        failed++;
      }
      onProgress(++done, jobs.length, bytes);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (failed > jobs.length * 0.05) throw new Error(`${failed} of ${jobs.length} map pieces didn't download`);

  try {
    localStorage.setItem(SAVED_KEY, new Date().toISOString());
  } catch {
    // The map is saved either way; only the "saved on" date is lost
  }
  return bytes;
}

function tileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

// Builds data/transit.json, the compact transit network the app routes on,
// from the MTA's official GTFS schedule feeds (subway and all bus feeds).
//
//   node tools/build-data.mjs            uses feeds already downloaded
//   node tools/build-data.mjs --refresh  downloads fresh feeds first
//
// Full timetables are far too big for a phone (the Bronx buses alone are
// 76 MB), so each route is reduced to its stop patterns: the stops in order,
// typical travel times between them, and how many trips leave each hour on a
// weekday, Saturday and Sunday. That's enough to plan trips and estimate
// waits entirely on the phone, with no signal needed.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "tools", ".cache");
const OUT = path.join(ROOT, "data", "transit.json");
const FEEDS = ["gtfs_subway", "gtfs_bx", "gtfs_m", "gtfs_b", "gtfs_q", "gtfs_si", "gtfs_busco"];
const FEED_URL = (feed) => `https://rrgtfsfeeds.s3.amazonaws.com/${feed}.zip`;
const DAY_TYPES = { wd: 3, sa: 6, su: 0 }; // representative day of week: Wednesday, Saturday, Sunday

// --- Download and unzip --------------------------------------------------

async function loadFeed(feed, refresh) {
  const file = path.join(CACHE, `${feed}.zip`);
  if (refresh || !fs.existsSync(file)) {
    process.stdout.write(`Downloading ${feed}... `);
    const res = await fetch(FEED_URL(feed));
    if (!res.ok) throw new Error(`Download failed for ${feed}: HTTP ${res.status}`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log("done");
  }
  return readZip(fs.readFileSync(file));
}

// Minimal zip reader: finds each file through the central directory and
// inflates it on demand
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");

  const files = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    files.set(name, () => {
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(start, start + compressedSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// --- CSV -----------------------------------------------------------------

// Calls onRow(get) for each row, where get(column) returns that field
function readCsv(zip, name, onRow) {
  const open = zip.get(name);
  if (!open) return;
  let text = open().toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let pos = 0;
  const nextLine = () => {
    if (pos >= text.length) return null;
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).replace(/\r$/, "");
    pos = end + 1;
    return line;
  };

  const header = splitCsvLine(nextLine()).map((h) => h.trim());
  const index = Object.fromEntries(header.map((h, i) => [h, i]));
  let line;
  while ((line = nextLine()) !== null) {
    if (!line) continue;
    const fields = splitCsvLine(line);
    onRow((column) => (index[column] === undefined ? "" : (fields[index[column]] ?? "").trim()));
  }
}

function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

function toSeconds(time) {
  const [h, m, s] = time.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

// --- Calendar --------------------------------------------------------------

const ymd = (date) => date.toISOString().slice(0, 10).replace(/-/g, "");

// For each day type, the services running on one representative upcoming
// date (holiday changes from calendar_dates included)
function activeServices(zip) {
  const calendar = [];
  readCsv(zip, "calendar.txt", (get) => {
    calendar.push({
      id: get("service_id"),
      days: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((d) => get(d) === "1"),
      start: get("start_date"),
      end: get("end_date"),
    });
  });
  const exceptions = new Map(); // date -> [{ id, type }]
  readCsv(zip, "calendar_dates.txt", (get) => {
    const date = get("date");
    if (!exceptions.has(date)) exceptions.set(date, []);
    exceptions.get(date).push({ id: get("service_id"), type: get("exception_type") });
  });

  const starts = calendar.map((c) => c.start).concat([...exceptions.keys()]).sort();
  const ends = calendar.map((c) => c.end).concat([...exceptions.keys()]).sort();
  const feedStart = starts[0];
  const feedEnd = ends[ends.length - 1];

  const servicesOn = (date, weekday) => {
    const services = new Set();
    for (const c of calendar) {
      if (c.days[weekday] && c.start <= date && date <= c.end) services.add(c.id);
    }
    for (const e of exceptions.get(date) ?? []) {
      if (e.type === "1") services.add(e.id);
      else services.delete(e.id);
    }
    return services;
  };

  const result = {};
  for (const [type, weekday] of Object.entries(DAY_TYPES)) {
    // Candidates: the next few matching days within the feed, or, if the
    // feed ends before any, the last few it covers
    const candidates = matchingDates(weekday, ymd(new Date()) > feedStart ? ymd(new Date()) : feedStart, feedEnd, 1);
    if (candidates.length === 0) candidates.push(...matchingDates(weekday, feedEnd, feedStart, -1));

    // The candidate with the most service running is a typical day; holidays
    // and special schedules run less
    let best = { date: null, services: new Set() };
    for (const date of candidates) {
      const services = servicesOn(date, weekday);
      if (services.size > best.services.size) best = { date, services };
    }
    result[type] = best;
  }
  return result;
}

// Up to 6 dates on the given weekday, walking from `from` toward `to`
function matchingDates(weekday, from, to, step) {
  const date = new Date(Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8), 12));
  const out = [];
  for (let i = 0; i < 120 && out.length < 6; i++) {
    const d = ymd(date);
    if (step > 0 ? d > to : d < to) break;
    if (date.getUTCDay() === weekday) out.push(d);
    date.setUTCDate(date.getUTCDate() + step);
  }
  return out;
}

// --- Names -----------------------------------------------------------------

const KEEP_UPPER = new Set(["CUNY", "LIRR", "JFK", "MTA", "SBS", "NYC", "PS", "IS", "HS", "JHS", "LGA", "YMCA", "VA", "II", "III"]);

// "AMSTERDAM AV/W 181 ST" -> "Amsterdam Av/W 181 St"
function titleCase(name) {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(/[a-z0-9']+/g, (word) => {
      const upper = word.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      if (/^\d+(st|nd|rd|th)$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .replace(/\bVia\b/g, "via");
}

// --- Build ---------------------------------------------------------------------

async function build() {
  const refresh = process.argv.includes("--refresh");

  const stopIndex = new Map(); // stop key -> index
  const stops = { id: [], name: [], lat: [], lon: [], mode: [] };
  const routeIndex = new Map();
  const routes = [];
  const patterns = new Map();
  const serviceDates = {};

  function addStop(key, name, lat, lon, mode) {
    if (stopIndex.has(key)) return stopIndex.get(key);
    const i = stops.id.length;
    stopIndex.set(key, i);
    stops.id.push(key);
    stops.name.push(titleCase(name));
    stops.lat.push(Math.round(lat * 1e5));
    stops.lon.push(Math.round(lon * 1e5));
    stops.mode.push(mode);
    return i;
  }

  for (const feed of FEEDS) {
    const zip = await loadFeed(feed, refresh);
    const isSubway = feed === "gtfs_subway";
    const mode = isSubway ? "s" : "b";
    const services = activeServices(zip);
    for (const [type, { date }] of Object.entries(services)) {
      serviceDates[type] ??= {};
      serviceDates[type][feed] = date;
    }

    // Stops: subway platforms are merged into their station; bus stops keep
    // their MTA stop code, shared across bus feeds
    const platformToStation = new Map();
    readCsv(zip, "stops.txt", (get) => {
      const id = get("stop_id");
      const lat = Number(get("stop_lat"));
      const lon = Number(get("stop_lon"));
      if (isSubway) {
        if (get("location_type") === "1") addStop(`S:${id}`, get("stop_name"), lat, lon, mode);
        else if (get("parent_station")) platformToStation.set(id, `S:${get("parent_station")}`);
      } else if (get("location_type") !== "1") {
        addStop(`B:${id}`, get("stop_name"), lat, lon, mode);
      }
    });
    const stopKey = (id) => (isSubway ? platformToStation.get(id) ?? `S:${id}` : `B:${id}`);

    readCsv(zip, "routes.txt", (get) => {
      const key = `${feed}:${get("route_id")}`;
      if (routeIndex.has(key)) return;
      routeIndex.set(key, routes.length);
      routes.push({
        id: get("route_id"),
        name: get("route_short_name") || get("route_id"),
        long: get("route_long_name"),
        color: get("route_color") || (isSubway ? "808183" : "0039A6"),
        text: get("route_text_color") || "FFFFFF",
        mode: isSubway ? "subway" : "bus",
      });
    });

    // Trips running on at least one representative day
    const trips = new Map();
    readCsv(zip, "trips.txt", (get) => {
      let days = 0;
      for (const [bit, type] of Object.keys(DAY_TYPES).entries()) {
        if (services[type].services.has(get("service_id"))) days |= 1 << bit;
      }
      if (!days) return;
      trips.set(get("trip_id"), {
        route: routeIndex.get(`${feed}:${get("route_id")}`),
        direction: get("direction_id") || "0",
        headsign: get("trip_headsign"),
        days,
        stops: [],
        times: [],
      });
    });

    readCsv(zip, "stop_times.txt", (get) => {
      const trip = trips.get(get("trip_id"));
      if (!trip) return;
      const key = stopKey(get("stop_id"));
      if (!stopIndex.has(key)) return;
      trip.stops.push([Number(get("stop_sequence")), stopIndex.get(key), toSeconds(get("arrival_time") || get("departure_time"))]);
    });

    // Group trips into patterns: same route, direction and stops in order
    for (const trip of trips.values()) {
      if (trip.stops.length < 2) continue;
      trip.stops.sort((a, b) => a[0] - b[0]);
      const stopList = trip.stops.map((s) => s[1]);
      const key = `${trip.route}|${trip.direction}|${stopList.join(",")}`;
      let pattern = patterns.get(key);
      if (!pattern) {
        pattern = { route: trip.route, direction: trip.direction, stops: stopList, headsigns: new Map(), trips: [] };
        patterns.set(key, pattern);
      }
      pattern.headsigns.set(trip.headsign, (pattern.headsigns.get(trip.headsign) ?? 0) + 1);
      const start = trip.stops[0][2];
      pattern.trips.push({ start, days: trip.days, offsets: trip.stops.map((s) => s[2] - start) });
    }
    console.log(`${feed}: ${trips.size} trips, ${patterns.size} patterns so far, ${stops.id.length} stops so far`);
  }

  // Reduce each pattern to typical travel times and trips per hour
  const outPatterns = [];
  for (const pattern of patterns.values()) {
    // Typical travel times come from daytime weekday trips when there are any
    const daytime = pattern.trips.filter((t) => t.days & 1 && t.start >= 7 * 3600 && t.start < 19 * 3600);
    const sample = daytime.length >= 3 ? daytime : pattern.trips;
    const offsets = pattern.stops.map((_, i) => median(sample.map((t) => t.offsets[i])));
    const gaps = offsets.map((o, i) => (i === 0 ? 0 : Math.max(0, Math.round(o - offsets[i - 1]))));

    // Trips per hour (for typical waits) and each trip's departure from the
    // first stop, in minutes after midnight, stored as gaps: [first, +gap, ...]
    const perHour = {};
    const departures = {};
    for (const [bit, type] of Object.keys(DAY_TYPES).entries()) {
      const counts = new Array(24).fill(0);
      const starts = [];
      for (const t of pattern.trips) {
        if (!(t.days & (1 << bit))) continue;
        counts[Math.floor(t.start / 3600) % 24]++;
        starts.push(Math.round(t.start / 60));
      }
      if (!counts.some(Boolean)) continue;
      perHour[type] = counts;
      starts.sort((a, b) => a - b);
      departures[type] = starts.map((m, k) => (k === 0 ? m : m - starts[k - 1]));
    }

    const headsign = [...pattern.headsigns.entries()].sort((a, b) => b[1] - a[1])[0][0];
    outPatterns.push({
      r: pattern.route,
      d: Number(pattern.direction),
      h: titleCase(headsign),
      s: pattern.stops,
      t: gaps.slice(1),
      n: perHour,
      x: departures,
    });
  }

  // Drop routes that never run on the representative days
  const usedRoutes = [...new Set(outPatterns.map((p) => p.r))].sort((a, b) => a - b);
  const routeRemap = new Map(usedRoutes.map((r, i) => [r, i]));
  const keptRoutes = usedRoutes.map((r) => routes[r]);
  for (const p of outPatterns) p.r = routeRemap.get(p.r);

  // Drop stops no pattern uses
  const used = new Set(outPatterns.flatMap((p) => p.s));
  const remap = new Map();
  const keptStops = { id: [], name: [], lat: [], lon: [], mode: [] };
  stops.id.forEach((id, i) => {
    if (!used.has(i)) return;
    remap.set(i, keptStops.id.length);
    for (const field of Object.keys(keptStops)) keptStops[field].push(stops[field][i]);
  });
  for (const p of outPatterns) p.s = p.s.map((i) => remap.get(i));

  const data = {
    version: 1,
    generated: new Date().toISOString(),
    serviceDates,
    routes: keptRoutes,
    stops: keptStops,
    patterns: outPatterns,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(OUT, json);
  const gz = zlib.gzipSync(json).length;
  console.log(
    `\nWrote ${path.relative(ROOT, OUT)}: ${keptRoutes.length} routes, ${keptStops.id.length} stops, ` +
      `${outPatterns.length} patterns, ${(json.length / 1e6).toFixed(1)} MB (${(gz / 1e6).toFixed(1)} MB gzipped)`
  );
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

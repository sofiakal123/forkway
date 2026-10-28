// Live MTA data, read straight from the MTA's open feeds (no key needed):
//   - subway arrival predictions for every train (GTFS-realtime, protobuf)
//   - service alerts for subway and bus lines (JSON)
// All of it is optional. When the phone is offline, or the rider switches
// live data off, the app plans and tracks from the saved schedules alone.

const FEED_BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/";
const SUBWAY_FEEDS = {
  "nyct%2Fgtfs": ["1", "2", "3", "4", "5", "6", "6X", "7", "7X", "GS"],
  "nyct%2Fgtfs-ace": ["A", "C", "E", "H", "FS"],
  "nyct%2Fgtfs-bdfm": ["B", "D", "F", "FX", "M"],
  "nyct%2Fgtfs-g": ["G"],
  "nyct%2Fgtfs-jz": ["J", "Z"],
  "nyct%2Fgtfs-nqrw": ["N", "Q", "R", "W"],
  "nyct%2Fgtfs-l": ["L"],
  "nyct%2Fgtfs-si": ["SI"],
};
const ALERT_FEEDS = ["camsys%2Fsubway-alerts.json", "camsys%2Fbus-alerts.json"];
const FEED_REFRESH_MS = 30_000; // the MTA updates trains about this often
const FEED_STALE_MS = 3 * 60_000; // older predictions aren't trusted
const ALERT_REFRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MODE_KEY = "forkway-live";

const FEED_OF_ROUTE = new Map(
  Object.entries(SUBWAY_FEEDS).flatMap(([feed, routes]) => routes.map((r) => [r, feed]))
);

export class LiveData {
  constructor(net) {
    this.net = net;
    this.stopIndex = new Map(net.data.stops.id.map((id, s) => [id, s]));
    this.feeds = new Map(); // feed -> { fetchedAt, trips: Map(id -> trip) }
    this.inFlight = new Map();
    this.alerts = [];
    this.alertsAt = 0;
    this.lastSuccess = 0;
    this.lastFailure = 0;
    this.enabled = loadSetting() !== "off";
  }

  // "live": fresh data in hand. "connecting": trying. "offline": no network
  // (or the MTA isn't answering). "off": the rider chose saved data only.
  get state() {
    if (!this.enabled) return "off";
    if (!isOnline()) return "offline";
    if (Date.now() - this.lastSuccess < FEED_STALE_MS) return "live";
    return this.lastFailure > this.lastSuccess ? "offline" : "connecting";
  }

  get usable() {
    return this.enabled && isOnline();
  }

  get updatedAt() {
    return this.lastSuccess ? new Date(this.lastSuccess) : null;
  }

  setEnabled(on) {
    this.enabled = on;
    saveSetting(on ? "on" : "off");
  }

  // Fetch whatever is due for these routes (route ids like "4" or "BX11").
  // Resolves once done; never throws.
  async refresh(routeIds, { force = false } = {}) {
    if (!this.usable) return false;
    const now = Date.now();
    const jobs = [];
    const feeds = new Set(routeIds.map((r) => FEED_OF_ROUTE.get(r)).filter(Boolean));
    for (const feed of feeds) {
      const have = this.feeds.get(feed);
      if (force || !have || now - have.fetchedAt > FEED_REFRESH_MS) jobs.push(this.once(feed, () => this.loadTrains(feed)));
    }
    if (force || now - this.alertsAt > ALERT_REFRESH_MS) jobs.push(this.once("alerts", () => this.loadAlerts()));
    const results = await Promise.all(jobs);
    return results.some(Boolean);
  }

  once(key, job) {
    if (!this.inFlight.has(key)) {
      this.inFlight.set(key, job().finally(() => this.inFlight.delete(key)));
    }
    return this.inFlight.get(key);
  }

  async loadTrains(feed) {
    try {
      const res = await fetch(FEED_BASE + feed, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const trips = decodeTripFeed(new Uint8Array(await res.arrayBuffer()), this.stopIndex);
      this.feeds.set(feed, { fetchedAt: Date.now(), trips });
      this.lastSuccess = Date.now();
      return true;
    } catch (err) {
      console.warn("Live trains unavailable:", err.message);
      this.lastFailure = Date.now();
      return false;
    }
  }

  async loadAlerts() {
    try {
      const lists = await Promise.all(
        ALERT_FEEDS.map(async (feed) => {
          const res = await fetch(FEED_BASE + feed, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return readAlerts(await res.json());
        })
      );
      this.alerts = lists.flat();
      this.alertsAt = Date.now();
      this.lastSuccess = Date.now();
      return true;
    } catch (err) {
      console.warn("Live alerts unavailable:", err.message);
      this.lastFailure = Date.now();
      return false;
    }
  }

  freshTrips(routeId) {
    const feed = this.feeds.get(FEED_OF_ROUTE.get(routeId));
    if (!this.usable || !feed || Date.now() - feed.fetchedAt > FEED_STALE_MS) return null;
    return feed.trips;
  }

  // Real trains of pattern p that stop at its position i and later at j,
  // soonest first: [{ id, depart, arrive }] (Dates)
  trains(p, i, j) {
    const pattern = this.net.patterns[p];
    const route = this.net.routes[pattern.route];
    const trips = route.mode === "subway" ? this.freshTrips(route.id) : null;
    if (!trips) return null;
    const from = pattern.stops[i];
    const to = pattern.stops[j];
    const found = [];
    for (const trip of trips.values()) {
      if (trip.route !== route.id) continue;
      const k = trip.stops.findIndex((x) => x.stop === from);
      if (k < 0) continue;
      const m = trip.stops.findIndex((x, n) => n > k && x.stop === to);
      if (m < 0) continue;
      found.push({ id: trip.id, depart: new Date(trip.stops[k].time), arrive: new Date(trip.stops[m].time) });
    }
    return found.sort((a, b) => a.depart - b.depart);
  }

  // One train's remaining stops: [{ stop, time }], or null if it's gone
  train(routeId, id) {
    return this.freshTrips(routeId)?.get(id)?.stops ?? null;
  }

  // Alerts in effect now for any of these routes, most serious first
  alertsFor(routeIds, now = new Date()) {
    const wanted = new Set(routeIds);
    const t = now.getTime() / 1000;
    const seen = new Set();
    return this.alerts
      .filter((a) => a.routes.some((r) => wanted.has(r)) && a.periods.some(([s, e]) => s <= t && t <= e))
      .filter((a) => !seen.has(a.title) && seen.add(a.title))
      .sort((a, b) => a.rank - b.rank);
  }
}

// --- Using live trains in a trip ------------------------------------------------

// A copy of a trip with live times: each subway ride takes the next real train
// after you reach the platform, and everything after it moves to match. Rides
// without live data (buses, or no signal) keep their schedule estimates.
// onBoard: the first ride is a train you're already on, with this id
export function withLiveTimes(trip, live, onBoard = null) {
  if (!live?.usable) return trip;
  let shift = 0;
  let changed = false;
  const legs = trip.legs.map((original, index) => {
    const leg = { ...original };
    if (shift) moveLeg(leg, shift);
    if (leg.kind !== "ride") return leg;

    let board = null;
    let arrive = null;
    let trainId = null;
    if (index === 0 && onBoard) {
      const stops = live.train(leg.route.id, onBoard);
      const at = stops?.find((x) => x.stop === leg.toStop.stop);
      if (at) {
        board = leg.board;
        arrive = new Date(at.time);
        trainId = onBoard;
      }
    } else {
      const next = live.trains(leg.pattern, leg.from, leg.to)?.find((t) => t.depart >= leg.start - 30_000);
      if (next) ({ depart: board, arrive, id: trainId } = next);
    }
    if (!arrive) return leg;

    const end = new Date(arrive.getTime() + (leg.end - leg.arrive));
    shift += end - leg.end;
    leg.headway ??= Math.round((original.wait * 2) / 60);
    leg.wait = Math.max(0, (board - leg.start) / 1000);
    leg.board = board;
    leg.arrive = arrive;
    leg.end = end;
    leg.train = trainId;
    leg.live = true;
    changed = true;
    return leg;
  });
  if (!changed) return trip;

  const arrive = legs[legs.length - 1].end;
  return { ...trip, legs, arrive, minutes: Math.round((arrive - trip.depart) / 60000), live: true };
}

function moveLeg(leg, ms) {
  for (const key of ["start", "end", "board", "arrive"]) {
    if (leg[key]) leg[key] = new Date(leg[key].getTime() + ms);
  }
}

// Live times for every option in a planner result, re-ranked to match
export function liveResults(trips, live) {
  if (!live?.usable) return trips;
  const updated = trips.map((option) => {
    const choices = option.choices.map((c) => {
      const timed = withLiveTimes(c, live);
      return timed === c ? c : { ...timed, exit: c.exit };
    });
    const fastest = Math.min(...choices.map((c) => c.arrive.getTime()));
    for (const c of choices) c.fastest = c.arrive.getTime() === fastest;
    const best = choices.find((c) => c.fastest);
    return { ...option, choices, best, arrive: best.arrive };
  });
  return updated.sort((a, b) => a.arrive - b.arrive);
}

// Route ids a set of trips rides, for fetching just the feeds they need
export function routesOf(trips) {
  const ids = new Set();
  for (const option of trips) {
    for (const choice of option.choices) {
      for (const leg of choice.legs) if (leg.kind === "ride") ids.add(leg.route.id);
    }
  }
  return [...ids];
}

// --- Alerts -----------------------------------------------------------------------

const ALERT_RANK = [/suspend/i, /no .*service|cancel/i, /delay/i, /reduced|skip|express|local|reroute|detour/i];

function readAlerts(json) {
  const alerts = [];
  for (const entity of json.entity ?? []) {
    const a = entity.alert;
    if (!a) continue;
    const title = english(a.header_text);
    if (!title) continue;
    const type = a["transit_realtime.mercury_alert"]?.alert_type ?? "";
    const rank = ALERT_RANK.findIndex((re) => re.test(type));
    alerts.push({
      title,
      text: english(a.description_text),
      type,
      rank: rank < 0 ? ALERT_RANK.length : rank,
      routes: [...new Set((a.informed_entity ?? []).map((e) => e.route_id).filter(Boolean))],
      periods: (a.active_period ?? []).map((p) => [p.start ?? 0, p.end ?? Infinity]),
    });
  }
  return alerts;
}

function english(text) {
  const t = text?.translation ?? [];
  return (t.find((x) => x.language === "en") ?? t.find((x) => !x.language?.includes("html")))?.text?.trim() ?? "";
}

// --- GTFS-realtime (protobuf) -------------------------------------------------------
// Just the fields the app uses:
//   FeedMessage.entity(2) > FeedEntity.trip_update(3)
//     > TripUpdate.trip(1) > TripDescriptor.trip_id(1), route_id(5)
//     > TripUpdate.stop_time_update(2) > stop_id(4), arrival(2), departure(3)
//       > StopTimeEvent.time(2)

export function decodeTripFeed(bytes, stopIndex) {
  const trips = new Map();
  const r = new Reader(bytes);
  while (r.more()) {
    const [field, type] = r.tag();
    if (field !== 2) {
      r.skip(type);
      continue;
    }
    const entity = r.sub();
    while (entity.more()) {
      const [f, t] = entity.tag();
      if (f !== 3) {
        entity.skip(t);
        continue;
      }
      const trip = readTripUpdate(entity.sub(), stopIndex);
      if (trip.id && trip.stops.length) trips.set(trip.id, trip);
    }
  }
  return trips;
}

function readTripUpdate(r, stopIndex) {
  const trip = { id: "", route: "", stops: [] };
  while (r.more()) {
    const [f, t] = r.tag();
    if (f === 1) {
      const d = r.sub();
      while (d.more()) {
        const [g, u] = d.tag();
        if (g === 1) trip.id = d.string();
        else if (g === 5) trip.route = d.string();
        else d.skip(u);
      }
    } else if (f === 2) {
      const update = r.sub();
      let stopId = "";
      let arrival = 0;
      let departure = 0;
      while (update.more()) {
        const [g, u] = update.tag();
        if (g === 4) stopId = update.string();
        else if (g === 2) arrival = readEventTime(update.sub());
        else if (g === 3) departure = readEventTime(update.sub());
        else update.skip(u);
      }
      // "A03N" is the northbound platform of station A03
      const stop = stopIndex.get(`S:${stopId.replace(/[NS]$/, "")}`);
      const time = (departure || arrival) * 1000;
      if (stop !== undefined && time) trip.stops.push({ stop, time });
    } else {
      r.skip(t);
    }
  }
  return trip;
}

function readEventTime(r) {
  let time = 0;
  while (r.more()) {
    const [f, t] = r.tag();
    if (f === 2) time = r.varint();
    else r.skip(t);
  }
  return time;
}

class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
  }

  more() {
    return this.pos < this.end;
  }

  varint() {
    let result = 0;
    let scale = 1;
    let byte;
    do {
      byte = this.bytes[this.pos++];
      result += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return result;
  }

  tag() {
    const key = this.varint();
    return [Math.floor(key / 8), key & 7];
  }

  sub() {
    const length = this.varint();
    const r = new Reader(this.bytes, this.pos, this.pos + length);
    this.pos += length;
    return r;
  }

  string() {
    const r = this.sub();
    return TEXT.decode(this.bytes.subarray(r.pos, r.end));
  }

  skip(type) {
    if (type === 0) this.varint();
    else if (type === 1) this.pos += 8;
    else if (type === 2) {
      const length = this.varint(); // read first: it moves pos
      this.pos += length;
    }
    else if (type === 5) this.pos += 4;
    else throw new Error(`Unsupported protobuf wire type ${type}`);
  }
}

const TEXT = new TextDecoder();

// --- Small helpers -------------------------------------------------------------------

function isOnline() {
  return globalThis.navigator?.onLine !== false;
}

function loadSetting() {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
}

function saveSetting(value) {
  try {
    localStorage.setItem(MODE_KEY, value);
  } catch {
    // Storage unavailable; the choice lasts until the app closes
  }
}

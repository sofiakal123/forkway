// The transit network loaded from data/transit.json: stops, routes and
// patterns (one route's stops in order, with typical travel times and how
// many trips leave each hour), plus lookups the planner needs.

export const WALK_SPEED = 1.3; // meters per second
export const WALK_DETOUR = 1.25; // streets are longer than a straight line
const GRID_DEGREES = 0.003; // about 330 m per grid cell
const EARTH_RADIUS = 6371000;

export class Network {
  constructor(data) {
    this.data = data;
    this.routes = data.routes;
    this.stopCount = data.stops.id.length;
    this.stopName = data.stops.name;
    this.stopMode = data.stops.mode;
    this.lat = Float64Array.from(data.stops.lat, (v) => v / 1e5);
    this.lon = Float64Array.from(data.stops.lon, (v) => v / 1e5);

    // Patterns with cumulative ride times from their first stop
    this.patterns = data.patterns.map((p, index) => {
      const cum = new Float64Array(p.s.length);
      for (let i = 1; i < p.s.length; i++) cum[i] = cum[i - 1] + p.t[i - 1];
      return {
        index,
        route: p.r,
        direction: p.d,
        headsign: p.h,
        stops: Int32Array.from(p.s),
        cum,
        perHour: p.n,
        mode: this.routes[p.r].mode,
      };
    });

    // Which patterns serve each stop, and at what position
    const lists = Array.from({ length: this.stopCount }, () => []);
    for (const p of this.patterns) p.stops.forEach((s, i) => lists[s].push([p.index, i]));
    this.stopPatterns = lists;

    // Spatial grid for "stops near here"
    this.grid = new Map();
    for (let s = 0; s < this.stopCount; s++) {
      const key = this.cellKey(Math.floor(this.lat[s] / GRID_DEGREES), Math.floor(this.lon[s] / GRID_DEGREES));
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(s);
    }

    // Each stop's routes, for labels like "4 · 5 · 6"
    this.stopRoutes = lists.map((list) => [...new Set(list.map(([p]) => this.patterns[p].route))]);
  }

  cellKey(row, col) {
    return row * 100000 + col;
  }

  // Stops within radius meters, nearest first: [{ stop, meters }]
  nearbyStops(lat, lon, radius) {
    const reach = Math.ceil(radius / 111000 / GRID_DEGREES) + 1;
    const row = Math.floor(lat / GRID_DEGREES);
    const col = Math.floor(lon / GRID_DEGREES);
    const found = [];
    for (let r = row - reach; r <= row + reach; r++) {
      for (let c = col - reach; c <= col + reach; c++) {
        for (const s of this.grid.get(this.cellKey(r, c)) ?? []) {
          const meters = distance(lat, lon, this.lat[s], this.lon[s]);
          if (meters <= radius) found.push({ stop: s, meters });
        }
      }
    }
    return found.sort((a, b) => a.meters - b.meters);
  }

  stopDistance(a, b) {
    return distance(this.lat[a], this.lon[a], this.lat[b], this.lon[b]);
  }

  // Expected wait in seconds for pattern p at stop position i, for someone
  // arriving at the stop at `time` (a Date). Infinity if it isn't running.
  waitSeconds(p, i, time) {
    const pattern = this.patterns[p];
    const counts = pattern.perHour[dayType(time)];
    if (!counts) return Infinity;
    // Vehicles reaching this stop now left the first stop a little earlier
    const secondsOfDay = time.getHours() * 3600 + time.getMinutes() * 60 + time.getSeconds() - pattern.cum[i];
    const hour = (((Math.floor(secondsOfDay / 3600) % 24) + 24) % 24);
    const now = counts[hour];
    if (now > 0) return Math.max(60, 3600 / now / 2);

    // None this hour: wait for the next hour's first trips (up to 2 hours ahead)
    const intoHour = (((secondsOfDay % 3600) + 3600) % 3600);
    for (let ahead = 1; ahead <= 2; ahead++) {
      const next = counts[(hour + ahead) % 24];
      if (next > 0) return 3600 * ahead - intoHour + 3600 / next / 2;
    }
    return Infinity;
  }

  // Seconds of riding pattern p from position i to position j
  rideSeconds(p, i, j) {
    const cum = this.patterns[p].cum;
    return cum[j] - cum[i];
  }

  routeOf(p) {
    return this.routes[this.patterns[p].route];
  }
}

// "wd" on weekdays, "sa" on Saturdays, "su" on Sundays
export function dayType(date) {
  const day = date.getDay();
  return day === 6 ? "sa" : day === 0 ? "su" : "wd";
}

export function distance(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

export function walkSeconds(meters) {
  return (meters * WALK_DETOUR) / WALK_SPEED;
}

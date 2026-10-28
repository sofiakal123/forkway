// Trip planning, built around exit choices: for any train or bus you're on,
// every stop where you could get off is an option, each with its own best
// way to finish the trip.
//
// The trick is to search backward from the destination once. That gives, for
// every stop in the city, the quickest way to finish the trip from there and
// how long it takes. Listing the choices for a vehicle is then just reading
// that answer at each of its upcoming stops.
import { distance, walkSeconds } from "./network.js";

const MAX_ORIGIN_WALK = 900; // meters to walk to the first stop
const MAX_DEST_WALK = 900; // meters to walk from the last stop
const TRANSFER_WALK = 300; // meters to walk between stops when changing
const MAX_WALK_ONLY = 2500; // offer walking the whole way up to this far
const BOARD_PENALTY = { bus: 180, subway: 180 }; // seconds; people avoid extra changes (subway includes getting down to the platform)
const ALIGHT_TIME = { bus: 0, subway: 60 }; // seconds to get out of a station
const MAX_COST = 4 * 3600;
const EXIT_SLACK = 12 * 60; // show exits up to this much slower than the best one
const MAX_EXITS = 6;
const MAX_TRIPS = 6;
const TRIP_SLACK = 30 * 60; // show trips up to this much slower than the best

const DEST = -1;
const NONE = -2;

// --- Backward search ---------------------------------------------------------

// Nodes are stops (0..S-1) and "on board pattern p at its stop i" (S and up).
// cost[node] is the seconds left to the destination; next[node] is the step
// taken from there: DEST (walk to the destination), a stop (walk there or
// get off there), or an on-board node (board, or stay on to the next stop).
export function searchToDestination(net, dest, time) {
  const S = net.stopCount;
  const layout = onboardLayout(net);
  const N = S + layout.total;
  const cost = new Float64Array(N).fill(Infinity);
  const next = new Int32Array(N).fill(NONE);
  const heap = new MinHeap();

  for (const { stop, meters } of net.nearbyStops(dest.lat, dest.lon, MAX_DEST_WALK)) {
    const c = walkSeconds(meters);
    if (c < cost[stop]) {
      cost[stop] = c;
      next[stop] = DEST;
      heap.push(c, stop);
    }
  }

  const relax = (node, c, step) => {
    if (c < cost[node] && c <= MAX_COST) {
      cost[node] = c;
      next[node] = step;
      heap.push(c, node);
    }
  };

  while (heap.size > 0) {
    const [c, u] = heap.pop();
    if (c > cost[u]) continue;

    if (u < S) {
      // Walk here from a nearby stop, but only to catch a vehicle: no
      // walk-then-walk chains
      if (next[u] >= S) {
        for (const { stop: v, meters } of net.nearbyStops(net.lat[u], net.lon[u], TRANSFER_WALK)) {
          if (v !== u) relax(v, c + walkSeconds(meters), u);
        }
      }
      // Get off here from any vehicle that stops here
      for (const [p, i] of net.stopPatterns[u]) {
        if (i > 0) relax(S + layout.start[p] + i, c + ALIGHT_TIME[net.patterns[p].mode], u);
      }
    } else {
      const p = layout.pattern[u - S];
      const i = u - S - layout.start[p];
      const pattern = net.patterns[p];
      // Being on board one stop earlier
      if (i > 0) relax(u - 1, c + pattern.cum[i] - pattern.cum[i - 1], u);
      // Boarding here
      if (i < pattern.stops.length - 1) {
        const wait = net.waitSeconds(p, i, time);
        if (Number.isFinite(wait)) relax(pattern.stops[i], c + wait + BOARD_PENALTY[pattern.mode], u);
      }
    }
  }

  return { net, dest, cost, next, layout, S };
}

function onboardLayout(net) {
  if (net.onboard) return net.onboard;
  const start = new Int32Array(net.patterns.length);
  let total = 0;
  net.patterns.forEach((p, k) => {
    start[k] = total;
    total += p.stops.length;
  });
  const pattern = new Int32Array(total);
  net.patterns.forEach((p, k) => pattern.fill(k, start[k], start[k] + p.stops.length));
  net.onboard = { start, total, pattern };
  return net.onboard;
}

// --- Building trips ----------------------------------------------------------

// The rest of the trip from stop s, reached at time t, following the search
function continueFrom(search, s, t) {
  const { net, dest, next, layout, S } = search;
  const legs = [];
  let u = s;
  for (let guard = 0; guard < 40; guard++) {
    const step = next[u];
    if (step === DEST) {
      legs.push(walkLeg(stopPoint(net, u), dest, t));
      return legs;
    }
    if (step === NONE) return null;
    if (step < S) {
      const leg = walkLeg(stopPoint(net, u), stopPoint(net, step), t);
      legs.push(leg);
      t = leg.end;
      u = step;
      continue;
    }
    // Board, then stay on until the search says to get off
    const p = layout.pattern[step - S];
    const i = step - S - layout.start[p];
    let o = step;
    while (next[o] >= S) o = next[o];
    const j = o - S - layout.start[p];
    const leg = rideLeg(net, p, i, j, t);
    if (!leg) return null;
    legs.push(leg);
    t = leg.end;
    u = next[o];
  }
  return null;
}

function walkLeg(from, to, start) {
  const meters = distance(from.lat, from.lon, to.lat, to.lon);
  const seconds = walkSeconds(meters);
  return { kind: "walk", from, to, meters, seconds, start, end: addSeconds(start, seconds) };
}

// Ride pattern p from stop position i to j, arriving at the stop at `start`
// (or already on board there at `start`, so with no wait)
function rideLeg(net, p, i, j, start, onBoard = false) {
  const pattern = net.patterns[p];
  const wait = onBoard ? 0 : net.waitSeconds(p, i, start);
  if (!Number.isFinite(wait)) return null;
  const board = addSeconds(start, wait);
  const arrive = addSeconds(board, pattern.cum[j] - pattern.cum[i]);
  return {
    kind: "ride",
    pattern: p,
    route: net.routes[pattern.route],
    headsign: pattern.headsign,
    from: i,
    to: j,
    fromStop: stopPoint(net, pattern.stops[i]),
    toStop: stopPoint(net, pattern.stops[j]),
    wait,
    start,
    board,
    arrive,
    end: addSeconds(arrive, ALIGHT_TIME[pattern.mode]),
  };
}

export function stopPoint(net, s) {
  return { stop: s, name: net.stopName[s], lat: net.lat[s], lon: net.lon[s] };
}

function makeTrip(legs, depart) {
  const arrive = legs.length ? legs[legs.length - 1].end : depart;
  return { legs, depart, arrive, minutes: Math.round((arrive - depart) / 60000) };
}

// Routes taken after getting off at stop s, e.g. "BX11" or "walk"
function continuationKey(search, s) {
  const { net, next, layout, S } = search;
  const names = [];
  let u = s;
  for (let guard = 0; guard < 40; guard++) {
    const step = next[u];
    if (step === DEST || step === NONE) break;
    if (step < S) {
      u = step;
      continue;
    }
    const p = layout.pattern[step - S];
    names.push(net.patterns[p].route);
    let o = step;
    while (next[o] >= S) o = next[o];
    u = next[o];
  }
  return names.length ? names.join(">") : "walk";
}

// The route of the next vehicle boarded after reaching stop s, or -1
function nextRoute(search, s) {
  const { net, next, layout, S } = search;
  let u = s;
  for (let guard = 0; guard < 10; guard++) {
    const step = next[u];
    if (step === DEST || step === NONE) return -1;
    if (step >= S) return net.patterns[layout.pattern[step - S]].route;
    u = step;
  }
  return -1;
}

// Every worthwhile place to get off pattern p after stop position i, given
// that you'll be at position i at `boardTime`. Each choice is a full trip
// from that point, distinct in how it continues.
function exitChoices(search, p, i, boardTime, legsBefore, depart, firstRideWait, onBoard = false) {
  const { net, cost, next, layout, S } = search;
  const pattern = net.patterns[p];
  const candidates = [];

  for (let j = i + 1; j < pattern.stops.length; j++) {
    const s = pattern.stops[j];
    if (!Number.isFinite(cost[s])) continue;
    // Getting off only to ride this same route again (even after crossing the
    // street) is never a real choice
    if (nextRoute(search, s) === pattern.route) continue;
    const total = firstRideWait + pattern.cum[j] - pattern.cum[i] + ALIGHT_TIME[pattern.mode] + cost[s];
    candidates.push({ j, s, total });
  }
  if (candidates.length === 0) return [];

  const best = Math.min(...candidates.map((c) => c.total));
  const seen = new Set();
  const choices = [];
  for (const c of candidates.sort((a, b) => a.total - b.total)) {
    if (c.total > best + EXIT_SLACK || choices.length >= MAX_EXITS) break;
    const key = continuationKey(search, c.s);
    if (seen.has(key)) continue;
    seen.add(key);

    const ride = rideLeg(net, p, i, c.j, boardTime, onBoard);
    if (!ride) continue;
    const rest = continueFrom(search, c.s, ride.end);
    if (!rest) continue;
    const trip = makeTrip([...legsBefore, ride, ...rest], depart);
    trip.exit = { stop: c.s, position: c.j, name: net.stopName[c.s], then: describeRest(rest) };
    choices.push(trip);
  }

  // In the order you reach them, like the stops going by
  choices.sort((a, b) => a.exit.position - b.exit.position);
  const fastest = Math.min(...choices.map((t) => t.arrive.getTime()));
  for (const t of choices) t.fastest = t.arrive.getTime() === fastest;
  return choices;
}

// Short label for how a trip continues after an exit: "Bx11" or "Walk 4 min"
function describeRest(legs) {
  const rides = legs.filter((l) => l.kind === "ride").map((l) => l.route.name);
  if (rides.length) return rides.join(" → ");
  const walk = legs.reduce((sum, l) => sum + l.seconds, 0);
  return `Walk ${Math.max(1, Math.round(walk / 60))} min`;
}

// Trip options from origin to dest leaving at `time`. Each option is one way
// of starting out (a first train or bus) with all its exit choices.
export function planTrips(net, origin, dest, time) {
  const search = searchToDestination(net, dest, time);
  const groups = new Map(); // first route and direction -> best way to catch it

  for (const { stop: o, meters } of net.nearbyStops(origin.lat, origin.lon, MAX_ORIGIN_WALK)) {
    const walk = walkSeconds(meters);
    const atStop = addSeconds(time, walk);
    for (const [p, i] of net.stopPatterns[o]) {
      const pattern = net.patterns[p];
      if (i >= pattern.stops.length - 1) continue;
      const wait = net.waitSeconds(p, i, atStop);
      if (!Number.isFinite(wait)) continue;

      // Quick estimate: best exit on this pattern
      let bestRest = Infinity;
      for (let j = i + 1; j < pattern.stops.length; j++) {
        const rest = pattern.cum[j] - pattern.cum[i] + search.cost[pattern.stops[j]];
        if (rest < bestRest) bestRest = rest;
      }
      const estimate = walk + wait + bestRest;
      if (!Number.isFinite(estimate)) continue;

      const key = `${pattern.route}|${pattern.direction}`;
      const current = groups.get(key);
      if (!current || estimate < current.estimate) groups.set(key, { estimate, o, meters, p, i, wait });
    }
  }

  const trips = [];
  for (const g of groups.values()) {
    const walk = walkLeg({ name: "Start", lat: origin.lat, lon: origin.lon }, stopPoint(net, g.o), time);
    const legsBefore = walk.meters > 15 ? [walk] : [];
    const atStop = legsBefore.length ? walk.end : time;
    const choices = exitChoices(search, g.p, g.i, atStop, legsBefore, time, net.waitSeconds(g.p, g.i, atStop));
    if (choices.length === 0) continue;
    const best = choices.reduce((a, b) => (b.arrive < a.arrive ? b : a));
    trips.push({ first: { pattern: g.p, route: net.routeOf(g.p) }, choices, best, arrive: best.arrive });
  }

  const walkMeters = distance(origin.lat, origin.lon, dest.lat, dest.lon);
  if (walkMeters <= MAX_WALK_ONLY) {
    const leg = walkLeg({ name: "Start", lat: origin.lat, lon: origin.lon }, dest, time);
    const trip = makeTrip([leg], time);
    trips.push({ first: null, choices: [trip], best: trip, arrive: trip.arrive, walkOnly: true });
  }

  trips.sort((a, b) => a.arrive - b.arrive);
  if (trips.length === 0) return { trips: [], search };
  const cutoff = trips[0].arrive.getTime() + TRIP_SLACK * 1000;
  return { trips: trips.filter((t) => t.arrive.getTime() <= cutoff).slice(0, MAX_TRIPS), search };
}

// While riding pattern p, now at stop position i: every place you could get
// off from here on, each with the rest of the trip
export function exitChoicesWhileRiding(search, p, i, now) {
  return exitChoices(search, p, i, now, [], now, 0, true);
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

// --- Binary min-heap -----------------------------------------------------------

class MinHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop() {
    const { keys, values } = this;
    const top = [keys[0], values[0]];
    const lastKey = keys.pop();
    const lastValue = values.pop();
    if (keys.length > 0) {
      let i = 0;
      const n = keys.length;
      while (true) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}

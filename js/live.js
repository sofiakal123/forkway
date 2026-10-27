// Follows a trip as it happens: where you are, which exits are still ahead
// (with fresh arrival times), and when to get off. Position comes from GPS
// when there is a fix (elevated lines, buses), from the schedule when there
// isn't (underground), and from the rider tapping "I'm here" at any time.
import { distance } from "./network.js";
import { exitChoicesWhileRiding, searchToDestination } from "./router.js";

const AT_STOP_METERS = 70; // close enough to count as at a stop
const ON_ROUTE_METERS = 150; // close enough to a stop to place you on the line
const LOOK_AHEAD_STOPS = 15; // how far ahead a GPS fix may move you
const SEARCH_REFRESH_MS = 5 * 60_000; // re-plan the rest of the trip this often
const MIN_ACCURACY_METERS = 120; // ignore fixes vaguer than this

export class TripTracker {
  constructor(net, trip, dest) {
    this.net = net;
    this.dest = dest;
    this.legs = trip.legs.slice();
    this.legIndex = 0;
    this.anchor = null; // while riding: { position, time } we're sure of
    this.boarded = false;
    this.alerted = new Set();
    this.search = null;
    this.searchedAt = 0;
    this.lastFix = null;
  }

  get leg() {
    return this.legs[this.legIndex] ?? null;
  }

  // --- Things the rider tells us -------------------------------------------

  arrivedAtStop() {
    this.nextLeg();
  }

  boardedNow(now = new Date()) {
    const leg = this.leg;
    if (leg?.kind !== "ride") return;
    this.boarded = true;
    this.anchor = { position: leg.from, time: now };
  }

  // "I'm at this stop" while riding
  atPosition(position, now = new Date()) {
    if (this.leg?.kind !== "ride") return;
    this.boarded = true;
    this.anchor = { position, time: now };
  }

  gotOff() {
    this.nextLeg();
  }

  // Switch to another exit choice (a trip from the current position)
  chooseExit(choice) {
    const leg = this.leg;
    const [ride, ...rest] = choice.legs;
    if (leg?.kind !== "ride" || ride?.kind !== "ride") return;
    this.legs = [
      ...this.legs.slice(0, this.legIndex),
      { ...leg, to: ride.to, toStop: ride.toStop, arrive: ride.arrive, end: ride.end },
      ...rest,
    ];
    this.alerted.clear();
  }

  nextLeg() {
    this.legIndex++;
    this.boarded = false;
    this.anchor = null;
    this.alerted.clear();
  }

  // --- GPS -------------------------------------------------------------------

  locate(fix, now = new Date()) {
    if (fix.accuracy > MIN_ACCURACY_METERS) return;
    this.lastFix = fix;
    const leg = this.leg;
    if (!leg) return;

    if (leg.kind === "walk") {
      if (distance(fix.lat, fix.lon, leg.to.lat, leg.to.lon) <= AT_STOP_METERS + fix.accuracy / 2) this.nextLeg();
      return;
    }

    // Riding (or waiting): find the nearest stop on the line ahead of us
    const pattern = this.net.patterns[leg.pattern];
    const from = this.boarded ? this.estimatePosition(now) : leg.from;
    let best = null;
    for (let j = Math.max(leg.from, from - 1); j <= Math.min(pattern.stops.length - 1, from + LOOK_AHEAD_STOPS); j++) {
      const s = pattern.stops[j];
      const meters = distance(fix.lat, fix.lon, this.net.lat[s], this.net.lon[s]);
      if (meters <= ON_ROUTE_METERS && (!best || meters < best.meters)) best = { position: j, meters };
    }
    if (!best) return;
    // Seen past the boarding stop: we must be on board
    if (best.position > leg.from) this.boarded = true;
    if (this.boarded) this.anchor = { position: best.position, time: now };
  }

  // --- Where we are now --------------------------------------------------------

  // Stop position along the current ride: the last sure position, moved on by
  // the schedule's travel times since then
  estimatePosition(now) {
    const leg = this.leg;
    const pattern = this.net.patterns[leg.pattern];
    const anchor = this.anchor ?? { position: leg.from, time: leg.board };
    const elapsed = (now - anchor.time) / 1000;
    let position = anchor.position;
    while (
      position + 1 < pattern.stops.length &&
      pattern.cum[position + 1] - pattern.cum[anchor.position] <= elapsed
    ) {
      position++;
    }
    return position;
  }

  // Everything the screen needs right now
  status(now = new Date()) {
    const leg = this.leg;
    if (!leg) return { phase: "done" };

    if (leg.kind === "walk") {
      const toGo = this.lastFix
        ? distance(this.lastFix.lat, this.lastFix.lon, leg.to.lat, leg.to.lon)
        : null;
      return {
        phase: "walk",
        leg,
        final: this.legIndex === this.legs.length - 1,
        metersLeft: toGo,
        alert: null,
      };
    }

    // Before boarding, assume we got on once the vehicle should have come
    if (!this.boarded && now > leg.board && now - leg.board > 2 * 60_000) {
      this.boarded = true;
      this.anchor = { position: leg.from, time: leg.board };
      this.boardedByEstimate = true;
    }

    const pattern = this.net.patterns[leg.pattern];
    const position = this.boarded ? Math.min(this.estimatePosition(now), leg.to) : leg.from;
    const confirmed = Boolean(this.anchor) && !this.boardedByEstimate;

    // Fresh exit choices from where we are
    this.refreshSearch(now);
    const choices = exitChoicesWhileRiding(this.search, leg.pattern, position, now);

    let alert = null;
    const stopsLeft = leg.to - position;
    if (this.boarded && stopsLeft === 1 && !this.alerted.has("next")) {
      this.alerted.add("next");
      alert = "next";
    } else if (this.boarded && stopsLeft <= 0 && !this.alerted.has("now")) {
      this.alerted.add("now");
      alert = "now";
    }

    return {
      phase: this.boarded ? (stopsLeft <= 0 ? "getoff" : "ride") : "wait",
      leg,
      pattern,
      position,
      confirmed,
      nextStop: position + 1 < pattern.stops.length ? this.net.stopName[pattern.stops[position + 1]] : null,
      stopsLeft,
      choices,
      chosenExit: leg.to,
      waitMinutes: Math.max(0, Math.round((leg.board - now) / 60000)),
      headwayMinutes: Math.round((leg.wait * 2) / 60),
      alert,
    };
  }

  refreshSearch(now) {
    if (!this.search || now - this.searchedAt > SEARCH_REFRESH_MS) {
      this.search = searchToDestination(this.net, this.dest, now);
      this.searchedAt = now.getTime();
    }
  }
}

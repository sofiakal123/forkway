// Re-timing during a trip: on the 4 toward the Bx11, the train runs ahead of
// schedule (the rider taps "I'm here" at 167 St early), so the rest of the
// trip should move to an earlier Bx11, and running late should move it later.
//   node tools/test-retime.mjs
import fs from "node:fs";
import { Network } from "../js/network.js";
import { planTrips } from "../js/router.js";
import { TripTracker } from "../js/live.js";

const net = new Network(JSON.parse(fs.readFileSync(new URL("../data/transit.json", import.meta.url))));
const fmt = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const station = (name, route) =>
  net.data.stops.id.findIndex((id, s) => id.startsWith("S:") && net.stopName[s] === name && net.stopRoutes[s].some((r) => net.routes[r].id === route));

const s125 = station("125 St", "4");
const dest = { name: "W 181 St & Amsterdam Av", lat: 40.8506, lon: -73.9311 };
const start = new Date(2026, 10, 4, 8, 30);
const { trips } = planTrips(net, { lat: net.lat[s125], lon: net.lon[s125] }, dest, start);
const option = trips.find((t) => t.first?.route.id === "4");
const plan = option.choices.find((c) => c.exit.then === "Bx11");

function bx11(tracker) {
  const bus = tracker.legs.find((l) => l.kind === "ride" && l.route.id === "BX11");
  return `Bx11 at ${fmt(bus.board)}, arrive ${fmt(tracker.legs[tracker.legs.length - 1].end)}`;
}

for (const [label, minutesToExitStop] of [["on time", null], ["train 4 min fast", -4], ["train 8 min fast", -8], ["train 6 min slow", 6]]) {
  const tracker = new TripTracker(net, plan, dest, null, start);
  const ride = tracker.leg;
  tracker.status(start);
  tracker.boardedNow(ride.board);
  let st = tracker.status(ride.board);
  const planned = bx11(tracker);
  let change = null;
  if (minutesToExitStop !== null) {
    // The rider confirms they're at the stop before the exit, earlier or later than the schedule says
    const pattern = net.patterns[ride.pattern];
    const before = ride.to - 1;
    const scheduled = new Date(ride.board.getTime() + (pattern.cum[before] - pattern.cum[ride.from]) * 1000);
    const at = new Date(scheduled.getTime() + minutesToExitStop * 60_000);
    tracker.atPosition(before, at);
    st = tracker.status(at);
    change = st.change;
  }
  console.log(
    `${label.padEnd(18)} planned: ${planned}   now: ${bx11(tracker)}` +
      (change ? `   → ${change.earlier ? "earlier" : "later"} ${change.route.name} at ${fmt(change.board)}` : "")
  );
}

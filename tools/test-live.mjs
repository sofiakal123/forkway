// Simulates riding the 4 train with the live tracker
import fs from "node:fs";
import { Network } from "../js/network.js";
import { planTrips } from "../js/router.js";
import { TripTracker } from "../js/live.js";

const net = new Network(JSON.parse(fs.readFileSync(new URL("../data/transit.json", import.meta.url))));
const stopBy = (name, route) => { for (let s = 0; s < net.stopCount; s++) if (net.stopName[s] === name && (!route || net.stopRoutes[s].some((r) => net.routes[r].name === route))) return s; };
const point = (s) => ({ lat: net.lat[s], lon: net.lon[s], name: net.stopName[s] });
const fmt = (d) => d.toTimeString().slice(0, 5);

const origin = point(stopBy("125 St", "4"));
const dest = point(stopBy("Amsterdam Av/W 181 St"));
const start = new Date(2026, 9, 28, 8, 30);
const { trips } = planTrips(net, origin, dest, start);
const trip = trips[0].best;
console.log("Planned:", trip.legs.map((l) => (l.kind === "walk" ? "walk" : `${l.route.name} → ${l.toStop.name}`)).join(" | "), "arrive", fmt(trip.arrive));

const tracker = new TripTracker(net, trip, dest);
const show = (label, now) => {
  const st = tracker.status(now);
  const exits = st.choices?.map((c) => `${c.exit.name}→${c.exit.then} ${fmt(c.arrive)}${c.exit.position === st.chosenExit ? "◀" : ""}`).join(", ");
  console.log(`${fmt(now)} ${label.padEnd(26)} phase=${st.phase.padEnd(6)} at=${st.position !== undefined ? net.stopName[st.pattern.stops[st.position]] : "-"} next=${st.nextStop ?? "-"} stopsLeft=${st.stopsLeft ?? "-"}${st.alert ? " ALERT:" + st.alert : ""}\n        exits: ${exits ?? "-"}`);
  return st;
};

let now = new Date(start);
const tick = (min) => (now = new Date(now.getTime() + min * 60000));
show("waiting on platform", now);
tick(4); tracker.boardedNow(now); show("boarded", now);
tick(8); show("8 min later (underground)", now);
// Elevated in the Bronx: a GPS fix at 161 St
const s161 = stopBy("161 St-Yankee Stadium", "4");
tick(1); tracker.locate({ lat: net.lat[s161], lon: net.lon[s161], accuracy: 20 }, now); let st = show("GPS fix at 161 St", now);
// Rider decides to switch to the 167 St / Bx35 option
const alt = st.choices.find((c) => c.exit.name === "167 St");
tracker.chooseExit(alt); st = show("switched to 167 St exit", now);
tick(1.5); show("1.5 min later", now);
tick(1.5); show("1.5 min later", now);
tracker.gotOff(now); tick(1); st = show("got off, walking to Bx35", now);

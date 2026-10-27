// Plans sample trips against the real data and prints the exit choices
import fs from "node:fs";
import { Network } from "../js/network.js";
import { planTrips } from "../js/router.js";

const net = new Network(JSON.parse(fs.readFileSync(new URL("../data/transit.json", import.meta.url))));
const fmt = (d) => d.toTimeString().slice(0, 5);
// A stop by name, optionally one served by a given route (several stations share names)
const find = (re, route) => {
  for (let s = 0; s < net.stopCount; s++) {
    if (!re.test(net.stopName[s])) continue;
    if (route && !net.stopRoutes[s].some((r) => net.routes[r].name === route)) continue;
    return { lat: net.lat[s], lon: net.lon[s], name: net.stopName[s], stop: s };
  }
};

const cases = [
  { label: "4 train (125 St) to W 181 St & Amsterdam Av", from: find(/^125 St$/, "4"), to: find(/^Amsterdam Av\/W 181 St$/) },
];
const when = new Date(2026, 9, 28, 8, 30); // Wednesday 8:30 am

for (const c of cases) {
  const t0 = performance.now();
  const { trips } = planTrips(net, c.from, c.to, when);
  console.log(`\n=== ${c.label}  (planned in ${(performance.now() - t0).toFixed(0)} ms)`);
  for (const trip of trips) {
    const first = trip.walkOnly ? "Walk" : `${trip.first.route.name} toward ${net.patterns[trip.first.pattern].headsign}`;
    console.log(`\n${first}: arrive ${fmt(trip.arrive)}`);
    for (const ch of trip.choices) {
      const legs = ch.legs.map((l) => l.kind === "walk" ? `walk ${Math.round(l.seconds / 60)}m` : `${l.route.name} ${l.fromStop.name}→${l.toStop.name} (wait ${Math.round(l.wait / 60)}m)`).join(" | ");
      console.log(`   ${ch.fastest ? "★" : " "} ${ch.exit ? "exit " + ch.exit.name.padEnd(22) + " then " + ch.exit.then.padEnd(14) : "".padEnd(46)} arrive ${fmt(ch.arrive)} (${ch.minutes} min)   ${legs}`);
    }
  }
}

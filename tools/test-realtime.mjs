// Live MTA data, end to end: decodes the real subway feed, finds the next
// uptown 4 trains at 125 St, and plans the 4 to W 181 St example with live
// times. Needs an internet connection.
//   node tools/test-realtime.mjs
import fs from "node:fs";
import { Network } from "../js/network.js";
import { planTrips } from "../js/router.js";
import { LiveData, liveResults, routesOf } from "../js/realtime.js";

const net = new Network(JSON.parse(fs.readFileSync(new URL("../data/transit.json", import.meta.url))));
const live = new LiveData(net);
const clock = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

const ok = await live.refresh(["4", "BX11"], { force: true });
console.log(`Live data: ${ok ? "loaded" : "FAILED"} (state: ${live.state})`);
if (!ok) process.exit(1);

const feed = live.feeds.get("nyct%2Fgtfs");
console.log(`Trains in the 1-7 feed: ${feed.trips.size}`);

const station = (name, route) =>
  net.data.stops.id.findIndex((id, s) => id.startsWith("S:") && net.stopName[s] === name && net.stopRoutes[s].some((r) => net.routes[r].id === route));
const s125 = station("125 St", "4");
const s170 = station("170 St", "4");
const uptown = net.patterns.findIndex((p) => net.routes[p.route].id === "4" && p.stops.includes(s125) && p.stops.indexOf(s170) > p.stops.indexOf(s125));
const pattern = net.patterns[uptown];
const trains = live.trains(uptown, pattern.stops.indexOf(s125), pattern.stops.indexOf(s170));
console.log(`Next uptown 4s at 125 St that stop at 170 St:`);
for (const t of trains.slice(0, 4)) console.log(`  leaves ${clock(t.depart)}, at 170 St ${clock(t.arrive)}  (${t.id})`);

const alerts = live.alertsFor(["4", "BX11", "BX13", "BX35"]);
console.log(`Alerts now for 4/Bx11/Bx13/Bx35: ${alerts.length}`);
for (const a of alerts.slice(0, 3)) console.log(`  [${a.type}] ${a.title}`);

const origin = { lat: net.lat[s125], lon: net.lon[s125] };
const dest = { name: "W 181 St & Amsterdam Av", lat: 40.8506, lon: -73.9311 };
const now = new Date();
const { trips } = planTrips(net, origin, dest, now);
await live.refresh(routesOf(trips));
const timed = liveResults(trips, live);
const four = timed.find((t) => t.first?.route.id === "4");
if (!four) {
  console.log("No 4 train option right now (late night or service change?)");
  process.exit(0);
}
const sched = trips.find((t) => t.first?.route.id === "4");
console.log(`\n4 train now, schedule vs live:`);
four.choices.forEach((c, k) => {
  const ride = c.legs.find((l) => l.kind === "ride");
  console.log(
    `  ${c.fastest ? "★" : " "} exit ${c.exit.name.padEnd(22)} then ${c.exit.then.padEnd(6)} ` +
      `schedule ${clock(sched.choices[k].arrive)}  live ${clock(c.arrive)}  ` +
      `(board ${clock(ride.board)}${ride.live ? ", live train" : ""})`
  );
});

// Route audit: plans a set of everyday NYC trips and prints every option, so
// missing or odd routes are easy to spot.
//   node tools/test-audit.mjs [weekday hour]
import fs from "node:fs";
import { Network } from "../js/network.js";
import { planTrips } from "../js/router.js";

const net = new Network(JSON.parse(fs.readFileSync(new URL("../data/transit.json", import.meta.url))));
const hour = Number(process.argv[2] ?? 8.5);
const time = new Date(2026, 10, 4, Math.floor(hour), Math.round((hour % 1) * 60)); // a Wednesday

const TRIPS = [
  ["Hunter College (68 St) → Times Sq", [40.7682, -73.9645], [40.7559, -73.9871]],
  ["Hunter College → Union Sq", [40.7682, -73.9645], [40.7359, -73.9906]],
  ["125 St & Lexington → W 181 St & Amsterdam", [40.8041, -73.9375], [40.8506, -73.9311]],
  ["Union Sq → Bedford Av (Williamsburg)", [40.7359, -73.9906], [40.7172, -73.9566]],
  ["Grand Central → Brooklyn Museum", [40.7527, -73.9772], [40.6712, -73.9636]],
  ["Jackson Heights → LaGuardia", [40.7466, -73.8912], [40.7769, -73.8740]],
  ["Penn Station → Barclays Center", [40.7506, -73.9935], [40.6826, -73.9754]],
  ["Columbia (116 & Bway) → Wall St", [40.8075, -73.9641], [40.7069, -74.0113]],
  ["Astoria (Ditmars) → Midtown (5 Av/53)", [40.7751, -73.9120], [40.7602, -73.9754]],
  ["Fordham Rd (Grand Concourse) → Hunter College", [40.8614, -73.8906], [40.7682, -73.9645]],
];

const fmt = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const legText = (l) =>
  l.kind === "walk" ? `walk ${Math.round(l.seconds / 60)}m` : `${l.route.name} ${l.fromStop.name}→${l.toStop.name} (wait ${Math.round(l.wait / 60)}m)`;

for (const [name, [olat, olon], [dlat, dlon]] of TRIPS) {
  const t0 = performance.now();
  const { trips } = planTrips(net, { lat: olat, lon: olon }, { name, lat: dlat, lon: dlon }, time);
  console.log(`\n=== ${name}  (${fmt(time)}, ${Math.round(performance.now() - t0)} ms, ${trips.length} options)`);
  for (const t of trips) {
    console.log(`  ${String(t.best.minutes).padStart(3)} min  arrive ${fmt(t.arrive)}  ${t.best.legs.map(legText).join(" | ")}`);
    if (t.choices.length > 1) console.log(`           forks: ${t.choices.map((c) => `${c.exit.name}→${c.exit.then} ${fmt(c.arrive)}`).join(", ")}`);
  }
}

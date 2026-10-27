import fs from "node:fs";
import { Network } from "../js/network.js";
import { planTrips } from "../js/router.js";
import { StopSearch } from "../js/search.js";

const net = new Network(JSON.parse(fs.readFileSync(new URL("../data/transit.json", import.meta.url))));
const search = new StopSearch(net);
const place = (q) => search.find(q, 1)[0];
const fmt = (d) => d.toTimeString().slice(0, 5);
const cases = [
  ["Times Sq", "Flushing-Main St", new Date(2026, 9, 28, 17, 45)],
  ["Coney Island-Stillwell Av", "Fordham Rd", new Date(2026, 9, 31, 12, 0)],
  ["Grand Central", "Jamaica Center", new Date(2026, 10, 1, 9, 0)],
  ["W181st and Amsterdam", "Grand Central", new Date(2026, 9, 28, 2, 30)], // late night
];
for (const [a, b, when] of cases) {
  const from = place(a), to = place(b);
  const t0 = performance.now();
  const { trips } = planTrips(net, from, to, when);
  const ms = performance.now() - t0;
  console.log(`\n${from.name} → ${to.name}, ${when.toDateString().slice(0, 3)} ${fmt(when)}  (${ms.toFixed(0)} ms, ${trips.length} options)`);
  for (const t of trips.slice(0, 3)) {
    const legs = t.best.legs.map((l) => (l.kind === "walk" ? "walk" : l.route.name)).join(" › ");
    const forks = t.choices.length > 1 ? `   switch options: ${t.choices.map((c) => `${c.exit.name}→${c.exit.then}`).join(", ")}` : "";
    console.log(`  ${legs.padEnd(30)} ${t.best.minutes} min, arrive ${fmt(t.arrive)}${forks}`);
  }
}

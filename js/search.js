// Finding places. Stops and stations are searched offline by name, so
// "W181st and Amsterdam" finds the "Amsterdam Av/W 181 St" stops even with no
// signal. Addresses and landmarks come from OpenStreetMap's Nominatim search
// when online.

const ALIASES = {
  street: "st", str: "st", avenue: "av", ave: "av", boulevard: "blvd", road: "rd", place: "pl",
  parkway: "pkwy", west: "w", east: "e", north: "n", south: "s", saint: "st", square: "sq",
};
// Words that don't narrow a search: "W 181 St & Amsterdam" is about 181 and Amsterdam
const OPTIONAL = new Set(["st", "av", "and", "at", "the", "of", "blvd", "rd", "pl"]);
const NYC_VIEWBOX = "-74.27,40.93,-73.68,40.48";

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    // "34th" -> "34", then "W181" -> "W 181"
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/([a-z])(?=\d)/g, "$1 ")
    .replace(/(\d)(?=[a-z])/g, "$1 ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^(\d+)(st|nd|rd|th)$/, "$1")) // 181st -> 181
    .map((word) => ALIASES[word] ?? word);
}

export class StopSearch {
  constructor(net) {
    this.net = net;
    // One entry per place: a station, or an intersection's bus stops (the
    // stops on each side of the street share a name, sometimes reversed)
    const places = new Map();
    for (let s = 0; s < net.stopCount; s++) {
      const tokens = tokenize(net.stopName[s]);
      const key = `${net.stopMode[s]}:${[...tokens].sort().join(" ")}`;
      let place = places.get(key);
      if (!place) {
        place = { name: net.stopName[s], tokens, stops: [], routes: new Set(), mode: net.stopMode[s] };
        places.set(key, place);
      }
      // Stations with the same name in different places (there are several
      // "125 St") stay separate
      if (place.stops.length && net.stopDistance(place.stops[0], s) > 600) {
        const separate = { name: net.stopName[s], tokens, stops: [s], routes: new Set(), mode: net.stopMode[s] };
        for (const r of net.stopRoutes[s]) separate.routes.add(net.routes[r].name);
        places.set(`${key}#${s}`, separate);
        continue;
      }
      place.stops.push(s);
      for (const r of net.stopRoutes[s]) place.routes.add(net.routes[r].name);
    }
    this.places = [...places.values()].map((p) => ({
      ...p,
      routes: [...p.routes].sort(routeOrder),
      lat: average(p.stops.map((s) => net.lat[s])),
      lon: average(p.stops.map((s) => net.lon[s])),
    }));
  }

  // Up to `limit` places matching the text, best first
  find(text, limit = 8) {
    const query = tokenize(text);
    const required = query.filter((t) => !OPTIONAL.has(t));
    if (required.length === 0) return [];
    const results = [];
    for (const place of this.places) {
      let score = 0;
      let ok = true;
      for (const word of required) {
        const exact = place.tokens.includes(word);
        // Numbers must match exactly (181 shouldn't find 1810); words may be prefixes
        const prefix = !exact && !/^\d+$/.test(word) && place.tokens.some((t) => t.startsWith(word));
        if (!exact && !prefix) {
          ok = false;
          break;
        }
        score += exact ? 2 : 1;
      }
      if (!ok) continue;
      if (place.mode === "s") score += 1.5; // stations are usually what people mean
      score -= place.tokens.length * 0.05; // prefer tighter matches
      results.push({ score, place });
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ place }) => ({
        name: place.name,
        detail: place.mode === "s" ? `Station · ${place.routes.join(" ")}` : `Bus stop · ${place.routes.join(" ")}`,
        lat: place.lat,
        lon: place.lon,
        kind: place.mode === "s" ? "station" : "stop",
      }));
  }
}

// Addresses and landmarks from OpenStreetMap (needs signal)
export async function geocode(text, signal) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1" +
    `&viewbox=${NYC_VIEWBOX}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const results = await res.json();
  return results.map((r) => {
    const [first, ...rest] = r.display_name.split(", ");
    return {
      name: first,
      detail: rest.slice(0, 3).join(", "),
      lat: Number(r.lat),
      lon: Number(r.lon),
      kind: "place",
    };
  });
}

function average(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Subway lines first (1 2 3... A C E...), then buses
function routeOrder(a, b) {
  const isNumber = (s) => /^\d/.test(s);
  if (a.length <= 2 && b.length > 2) return -1;
  if (b.length <= 2 && a.length > 2) return 1;
  if (isNumber(a) !== isNumber(b)) return isNumber(a) ? -1 : 1;
  return a.localeCompare(b, undefined, { numeric: true });
}

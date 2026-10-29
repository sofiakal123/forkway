// The trip map: a quiet base map (OpenFreeMap data, styled here to show only
// land, water, parks, streets and a few names) with the trip drawn on top
// from the app's own transit data, so the route always shows, even with no
// base map.
//
// The base map uses the same detail online and offline (zoom 13 data,
// enlarged when you zoom in), so losing signal never rebuilds the map, and
// the saved NYC map covers everything.

const TILEJSON = "https://tiles.openfreemap.org/planet";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const TILES_KEY = "forkway-map-tiles"; // last known tile address, to start without the network
const NYC = [-73.95, 40.73];
const REGULAR = ["Noto Sans Regular"];
const BOLD = ["Noto Sans Bold"];
const ITALIC = ["Noto Sans Italic"];
const DETAIL_ZOOM = 13;
const TILEJSON_TIMEOUT_MS = 5000;
const MISSING_AFTER_ERRORS = 3; // base map pieces failing before we say so

const PALETTES = {
  light: {
    land: "#f4f4f1",
    park: "#e2ecdc",
    water: "#cfe2f4",
    road: "#ffffff",
    casing: "#e6e5e0",
    motorway: "#ffffff",
    label: "#8a8c8f",
    faint: "#a7aaae",
    waterLabel: "#7c9cbb",
    casingTrip: "#ffffff",
    walk: "#7d8187",
    ink: "#111213",
    accent: "#2f74e6",
  },
  dark: {
    land: "#141516",
    park: "#18201a",
    water: "#16222e",
    road: "#26282a",
    casing: "#1c1e20",
    motorway: "#2e3033",
    label: "#7d8084",
    faint: "#5d6064",
    waterLabel: "#4f6a84",
    casingTrip: "#141516",
    walk: "#9a9ea3",
    ink: "#efefec",
    accent: "#6ea6ff",
  },
};

export class TripMap {
  constructor(element) {
    this.element = element;
    this.scheme = matchMedia("(prefers-color-scheme: dark)");
    this.tiles = loadTiles(); // base map tile addresses, once known
    this.data = { trip: collection([]), you: collection([]) };
    this.baseErrors = 0;

    this.map = new maplibregl.Map({
      container: element,
      style: this.style(),
      center: NYC,
      zoom: 11,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 0,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      })
    );

    // "No map here" note for when the base map can't load (offline, not saved)
    this.notice = document.createElement("div");
    this.notice.className = "map-notice";
    this.notice.textContent = "Map not saved for offline use · your route still shows";
    this.notice.hidden = Boolean(this.tiles); // no base map at all until it's been online once
    element.append(this.notice);

    // A new style starts empty: put the trip back on it
    this.map.on("style.load", () => this.pushData());
    this.map.on("error", (event) => {
      if (event.sourceId !== "base") return;
      if (++this.baseErrors >= MISSING_AFTER_ERRORS) this.notice.hidden = false;
    });
    this.map.on("sourcedata", (event) => {
      if (event.sourceId === "base" && event.tile && event.isSourceLoaded) {
        this.baseErrors = 0;
        this.notice.hidden = true;
      }
    });
    // Phones can drop the map's drawing surface when the app is in the
    // background, and the container can change size: keep it drawn
    new ResizeObserver(() => this.map.resize()).observe(element);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.redraw();
    });
    this.map.on("webglcontextrestored", () => this.redraw());
    this.scheme.addEventListener("change", () => this.restyle());
    this.refreshTileAddress();
  }

  // The tile address changes when OpenFreeMap publishes new map data. Use the
  // last known one right away, and quietly pick up a new one when online.
  async refreshTileAddress() {
    try {
      const res = await fetch(TILEJSON, { signal: AbortSignal.timeout(TILEJSON_TIMEOUT_MS) });
      const tiles = (await res.json()).tiles;
      if (!tiles?.length || tiles[0] === this.tiles?.[0]) return;
      const first = !this.tiles;
      this.tiles = tiles;
      this.notice.hidden = true;
      saveTiles(tiles);
      const source = this.map.getSource("base");
      if (source?.setTiles) source.setTiles(tiles);
      else if (first) this.restyle();
    } catch {
      // Offline: the saved address (if any) keeps working with saved tiles
    }
  }

  restyle() {
    this.map.setStyle(this.style(), { diff: false });
  }

  redraw() {
    this.map.resize();
    this.map.triggerRepaint();
  }

  style() {
    const c = PALETTES[this.scheme.matches ? "dark" : "light"];
    const sources = {
      trip: { type: "geojson", data: this.data.trip },
      you: { type: "geojson", data: this.data.you },
    };
    if (this.tiles) sources.base = { type: "vector", tiles: this.tiles, maxzoom: DETAIL_ZOOM };
    return {
      version: 8,
      glyphs: GLYPHS,
      sources,
      layers: [...(this.tiles ? baseLayers(c) : [{ id: "land", type: "background", paint: { "background-color": c.land } }]), ...tripLayers(c)],
    };
  }

  pushData() {
    this.map.getSource("trip")?.setData(this.data.trip);
    this.map.getSource("you")?.setData(this.data.you);
  }

  // trip: the selected choice; exits: the other choices' exit stops
  show(net, trip, { exits = [], fit = true } = {}) {
    const features = [];
    const points = [];

    for (const leg of trip.legs) {
      if (leg.kind === "walk") {
        const line = [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]];
        features.push(lineFeature(line, { kind: "walk" }));
        points.push(...line);
        continue;
      }
      const pattern = net.patterns[leg.pattern];
      const line = [];
      for (let i = leg.from; i <= leg.to; i++) {
        const s = pattern.stops[i];
        line.push([net.lon[s], net.lat[s]]);
      }
      const color = `#${leg.route.color}`;
      features.push(lineFeature(line, { kind: "ride", color }));
      line.forEach((point, k) => {
        const end = k === 0 || k === line.length - 1;
        features.push(pointFeature(point, { kind: "stop", color, end }));
      });
      points.push(...line);
    }

    // Other places you could get off, as rings with what you'd take from there
    for (const exit of exits) features.push(pointFeature([exit.lon, exit.lat], { kind: "exit", label: exit.label }));

    const first = trip.legs[0];
    const last = trip.legs[trip.legs.length - 1];
    if (first) features.push(pinFeature(first.kind === "walk" ? first.from : first.fromStop, "start"));
    if (last) features.push(pinFeature(last.kind === "walk" ? last.to : last.toStop, "end"));

    this.data.trip = collection(features);
    this.pushData();

    if (fit && points.length) {
      const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
      this.map.fitBounds(bounds, { padding: 44, maxZoom: 16, duration: 0 });
    }
  }

  showYou(fix) {
    this.data.you = collection(
      fix
        ? [
            { type: "Feature", properties: { kind: "accuracy" }, geometry: circlePolygon(fix.lon, fix.lat, fix.accuracy) },
            pointFeature([fix.lon, fix.lat], { kind: "you" }),
          ]
        : []
    );
    this.pushData();
  }

  follow(fix) {
    if (fix) this.map.easeTo({ center: [fix.lon, fix.lat] });
  }

  resize() {
    this.map.resize();
  }
}

// --- Styles --------------------------------------------------------------------------

const zoomed = (stops) => ["interpolate", ["exponential", 1.6], ["zoom"], ...stops];
const name = ["coalesce", ["get", "name:en"], ["get", "name"]];
const roadClass = (classes) => ["match", ["get", "class"], classes, true, false];
const notTunnel = ["!=", ["get", "brunnel"], "tunnel"];

function baseLayers(c) {
  const source = { source: "base" };
  return [
    { id: "land", type: "background", paint: { "background-color": c.land } },
    { id: "park", type: "fill", ...source, "source-layer": "park", paint: { "fill-color": c.park } },
    {
      id: "green",
      type: "fill",
      ...source,
      "source-layer": "landcover",
      filter: ["match", ["get", "class"], ["grass", "wood"], true, false],
      paint: { "fill-color": c.park, "fill-opacity": 0.8 },
    },
    { id: "water", type: "fill", ...source, "source-layer": "water", filter: notTunnel, paint: { "fill-color": c.water } },
    {
      id: "road-minor",
      type: "line",
      ...source,
      "source-layer": "transportation",
      minzoom: 12.5,
      filter: ["all", roadClass(["minor", "service"]), notTunnel],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.road, "line-width": zoomed([13, 0.6, 16, 4, 19, 14]) },
    },
    {
      id: "road-major-casing",
      type: "line",
      ...source,
      "source-layer": "transportation",
      filter: ["all", roadClass(["primary", "secondary", "tertiary", "trunk"]), notTunnel],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.casing, "line-width": zoomed([11, 0.8, 16, 9, 19, 24]) },
    },
    {
      id: "road-major",
      type: "line",
      ...source,
      "source-layer": "transportation",
      filter: ["all", roadClass(["primary", "secondary", "tertiary", "trunk"]), notTunnel],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.road, "line-width": zoomed([11, 0.5, 16, 7, 19, 20]) },
    },
    {
      id: "road-motorway",
      type: "line",
      ...source,
      "source-layer": "transportation",
      filter: ["all", roadClass(["motorway"]), notTunnel],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.motorway, "line-width": zoomed([9, 0.8, 16, 8, 19, 20]) },
    },
    {
      id: "water-name",
      type: "symbol",
      ...source,
      "source-layer": "water_name",
      layout: { "text-field": name, "text-font": ITALIC, "text-size": 11, "symbol-placement": "point" },
      paint: { "text-color": c.waterLabel },
    },
    {
      id: "street-name",
      type: "symbol",
      ...source,
      "source-layer": "transportation_name",
      minzoom: 14,
      filter: roadClass(["primary", "secondary", "tertiary", "trunk", "minor"]),
      layout: { "text-field": name, "text-font": REGULAR, "text-size": 10.5, "symbol-placement": "line" },
      paint: { "text-color": c.label, "text-halo-color": c.land, "text-halo-width": 1.5 },
    },
    {
      id: "area-name",
      type: "symbol",
      ...source,
      "source-layer": "place",
      minzoom: 11,
      maxzoom: 16,
      filter: ["match", ["get", "class"], ["suburb", "neighbourhood", "quarter"], true, false],
      layout: {
        "text-field": name,
        "text-font": BOLD,
        "text-size": 9.5,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.14,
        "text-max-width": 7,
      },
      paint: { "text-color": c.faint, "text-halo-color": c.land, "text-halo-width": 1.5 },
    },
    {
      id: "city-name",
      type: "symbol",
      ...source,
      "source-layer": "place",
      maxzoom: 11,
      filter: ["match", ["get", "class"], ["city", "town", "borough"], true, false],
      layout: { "text-field": name, "text-font": BOLD, "text-size": 12 },
      paint: { "text-color": c.label, "text-halo-color": c.land, "text-halo-width": 1.5 },
    },
  ];
}

function tripLayers(c) {
  const kind = (k) => ["==", ["get", "kind"], k];
  return [
    {
      id: "you-accuracy",
      type: "fill",
      source: "you",
      filter: kind("accuracy"),
      paint: { "fill-color": c.accent, "fill-opacity": 0.1 },
    },
    {
      id: "walk",
      type: "line",
      source: "trip",
      filter: kind("walk"),
      layout: { "line-cap": "round" },
      paint: { "line-color": c.walk, "line-width": 3, "line-dasharray": [0.1, 2] },
    },
    {
      id: "ride-casing",
      type: "line",
      source: "trip",
      filter: kind("ride"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": c.casingTrip, "line-width": 9 },
    },
    {
      id: "ride",
      type: "line",
      source: "trip",
      filter: kind("ride"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 5 },
    },
    {
      id: "stops",
      type: "circle",
      source: "trip",
      filter: kind("stop"),
      paint: {
        "circle-radius": ["case", ["get", "end"], 5, 2.5],
        "circle-color": c.casingTrip,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": ["case", ["get", "end"], 2.5, 1.5],
      },
    },
    {
      id: "exits",
      type: "circle",
      source: "trip",
      filter: kind("exit"),
      paint: {
        "circle-radius": 8,
        "circle-opacity": 0,
        "circle-stroke-color": c.accent,
        "circle-stroke-width": 2,
      },
    },
    {
      id: "exit-names",
      type: "symbol",
      source: "trip",
      filter: kind("exit"),
      layout: {
        "text-field": ["get", "label"],
        "text-font": BOLD,
        "text-size": 11,
        "text-anchor": "left",
        "text-offset": [1.1, 0],
        "text-optional": true,
      },
      paint: { "text-color": c.accent, "text-halo-color": c.land, "text-halo-width": 2 },
    },
    {
      id: "pins",
      type: "circle",
      source: "trip",
      filter: kind("pin"),
      paint: {
        "circle-radius": 6.5,
        "circle-color": ["case", ["==", ["get", "role"], "end"], c.accent, c.ink],
        "circle-stroke-color": c.casingTrip,
        "circle-stroke-width": 3,
      },
    },
    {
      id: "you",
      type: "circle",
      source: "you",
      filter: kind("you"),
      paint: { "circle-radius": 7, "circle-color": c.accent, "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
    },
  ];
}

// --- GeoJSON ---------------------------------------------------------------------------

function collection(features) {
  return { type: "FeatureCollection", features };
}

function lineFeature(coordinates, properties) {
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates } };
}

function pointFeature(coordinates, properties) {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates } };
}

function pinFeature(point, role) {
  return pointFeature([point.lon, point.lat], { kind: "pin", role });
}

// A circle of `meters` around a point, as a polygon
function circlePolygon(lon, lat, meters, sides = 40) {
  const ring = [];
  const dLat = meters / 111_320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  for (let k = 0; k <= sides; k++) {
    const a = (k / sides) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

function loadTiles() {
  try {
    return JSON.parse(localStorage.getItem(TILES_KEY)) ?? null;
  } catch {
    return null;
  }
}

function saveTiles(tiles) {
  try {
    localStorage.setItem(TILES_KEY, JSON.stringify(tiles));
  } catch {
    // Not saved: next start fetches the address again
  }
}

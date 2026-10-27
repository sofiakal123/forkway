// The trip map: OpenStreetMap tiles via Leaflet, with each ride drawn in its
// line's color, walks dashed, and the other exit choices marked along the way.

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export class TripMap {
  constructor(element) {
    this.map = L.map(element, { zoomControl: false }).setView([40.75, -73.97], 12);
    L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.tripLayer = L.layerGroup().addTo(this.map);
    this.youLayer = L.layerGroup().addTo(this.map);
  }

  // trip: the selected choice; exits: the other choices' exit stops
  show(net, trip, { exits = [], fit = true } = {}) {
    this.tripLayer.clearLayers();
    const points = [];

    for (const leg of trip.legs) {
      if (leg.kind === "walk") {
        const line = [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
        L.polyline(line, { color: "#64748b", weight: 4, dashArray: "2 8", lineCap: "round" }).addTo(this.tripLayer);
        points.push(...line);
        continue;
      }
      const pattern = net.patterns[leg.pattern];
      const line = [];
      for (let i = leg.from; i <= leg.to; i++) {
        const s = pattern.stops[i];
        line.push([net.lat[s], net.lon[s]]);
      }
      const color = `#${leg.route.color}`;
      L.polyline(line, { color: "#ffffff", weight: 9, opacity: 0.9 }).addTo(this.tripLayer);
      L.polyline(line, { color, weight: 6 }).addTo(this.tripLayer);
      line.forEach((latlng, k) => {
        const end = k === 0 || k === line.length - 1;
        L.circleMarker(latlng, {
          radius: end ? 6 : 3,
          color,
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
        }).addTo(this.tripLayer);
      });
      points.push(...line);
    }

    // Other places you could get off, as hollow rings you can identify
    for (const exit of exits) {
      L.circleMarker([exit.lat, exit.lon], { radius: 9, color: "#7c3aed", weight: 3, fill: false })
        .bindTooltip(exit.label, { direction: "top" })
        .addTo(this.tripLayer);
    }

    const first = trip.legs[0];
    const last = trip.legs[trip.legs.length - 1];
    if (first) this.pin(first.kind === "walk" ? first.from : first.fromStop, "#16a34a");
    if (last) this.pin(last.kind === "walk" ? last.to : last.toStop, "#dc2626");

    if (fit && points.length) this.map.fitBounds(points, { padding: [36, 36], maxZoom: 16 });
  }

  pin(point, color) {
    L.circleMarker([point.lat, point.lon], {
      radius: 8,
      color: "#ffffff",
      weight: 3,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(this.tripLayer);
  }

  showYou(fix) {
    this.youLayer.clearLayers();
    if (!fix) return;
    L.circle([fix.lat, fix.lon], { radius: fix.accuracy, color: "#2563eb", weight: 1, fillOpacity: 0.12 }).addTo(this.youLayer);
    L.circleMarker([fix.lat, fix.lon], { radius: 7, color: "#ffffff", weight: 3, fillColor: "#2563eb", fillOpacity: 1 }).addTo(this.youLayer);
  }

  follow(fix) {
    if (fix) this.map.panTo([fix.lat, fix.lon]);
  }

  resize() {
    this.map.invalidateSize();
  }
}

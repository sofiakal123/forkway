# Forkway

NYC transit directions built around a question other apps don't answer well: **where should I switch?**

When a train or bus gives you several good places to get off and change, Forkway shows all of them, during the trip, so you can decide as you get closer. Riding the 4 uptown to W 181 St & Amsterdam Av, it offers:

| Get off at | Then take | Arrive |
| --- | --- | --- |
| 161 St–Yankee Stadium | Bx13 | 9:04 |
| 167 St | Bx35 | 9:03 |
| **170 St** (fastest) | **Bx11** | **9:01** |
| 176 St | Bx36 | 9:08 |

Tap any option to see the whole trip on the map. Switch options while you ride and the rest of the trip updates.

## Install it on your Android phone

Forkway is a Progressive Web App: it installs from Chrome like a regular app, opens full screen and works offline.

1. Put this folder on GitHub and turn on **GitHub Pages**: repository **Settings → Pages → Deploy from a branch → `main` / root**.
2. On your phone, open `https://<your-username>.github.io/<repo-name>/` in Chrome.
3. Tap **⋮ → Install app** (or **Add to Home screen**).
4. Open it once with signal so it can save NYC's transit data for offline use.

To try it on your computer first:

```bash
npx serve .
```

Then open http://localhost:3000. Location works on `localhost`; on a phone the app must be served over `https` (GitHub Pages is).

## Using it

1. **From:** your current location (allow location access), or search for a starting point.
2. **To:** start typing. Stops and stations are found offline (`W181st and Amsterdam`, `34th st herald`, `grand central`); addresses and places come from OpenStreetMap when you have signal.
3. Pick a trip. Cards marked **"3 places to switch"** have exit choices.
4. On the trip screen, choose where to get off. The map shows the chosen route, with the other exits as purple rings.
5. Tap **Start trip**. Forkway follows along:
   - **Above ground** (elevated lines, buses) it uses GPS.
   - **Underground** it moves you along by the schedule. Tap **I'm here…** to correct it.
   - It keeps showing every exit still ahead with updated arrival times. Change your mind any time.
   - Your phone vibrates one stop before your exit, and again when it's time to get off.

## How it works

| Part | What it does | File |
| --- | --- | --- |
| Transit data | `tools/build-data.mjs` downloads the MTA's official schedule feeds (subway plus all five boroughs' buses) and condenses ~60 MB of timetables into a 1.5 MB file (0.4 MB compressed): each route's stop patterns, typical travel times between stops, and how many trips leave each hour on a weekday, Saturday and Sunday | `tools/build-data.mjs` → `data/transit.json` |
| Planning | One search runs **backward from the destination** (Dijkstra's algorithm over stops and "on board this vehicle at this stop" positions). That gives, for every stop in the city, the fastest way to finish the trip from there. Listing a vehicle's exit choices is then just reading that answer at each of its upcoming stops. Choices that continue the same way are merged | `js/router.js` |
| Waits | Expected wait is half the time between vehicles at that hour, adjusted for how long the vehicle takes to reach your stop | `js/network.js` |
| Live trip | GPS snaps you to the line when there's a fix; otherwise the schedule moves you along. Exit choices are recomputed every few seconds from where you are | `js/live.js` |
| Search | Offline name search over stops and stations ("W181st" → "W 181 St"), plus OpenStreetMap Nominatim for addresses | `js/search.js` |
| Map | Leaflet with OpenStreetMap tiles; rides drawn in each line's official color | `js/map.js` |
| Offline | A service worker caches the app, the transit data and map tiles you've viewed | `sw.js` |

Planning a trip takes about 40-80 ms on a laptop.

## Updating the schedules

The MTA updates its schedules a few times a year. To refresh:

```bash
node tools/build-data.mjs --refresh
```

Then change `VERSION` in `sw.js` (for example to `forkway-v2`) so installed copies pick up the new data, and push to GitHub.

## Tests

```bash
node tools/test-router.mjs   # the 4 train to W 181 St example
node tools/test-live.mjs     # simulates riding the 4, switching exits along the way
node tools/test-more.mjs     # other trips across boroughs, including late night
```

## Limits

- **Times are from the schedule, not live vehicle positions.** Waits are estimates from how often each line runs. Live MTA arrival times would need a small server (the MTA's live feeds don't allow direct browser access) and, for buses, a free MTA Bus Time key.
- Holiday schedules, planned service changes and outages aren't reflected.
- Subway, local, Select Bus and express buses are included. The Staten Island Ferry, PATH, LIRR and Metro-North aren't.
- Walking distances are estimated from straight-line distance, not actual streets.
- Exit choices are for the train or bus you're on. Once you get off, the next vehicle's choices appear when you board it.

## Tech

Vanilla JavaScript (ES modules), Leaflet 1.9.4, OpenStreetMap, MTA GTFS data. No build step and no dependencies to install. The data and icon scripts use only Node's standard library.

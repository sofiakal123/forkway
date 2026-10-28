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

## Live when you have signal, saved when you don't

| | Online | Offline (or "Saved data" mode) |
| --- | --- | --- |
| Subway times | Real train predictions from the MTA, updated every 30 seconds | Estimated from the saved timetable |
| Where your train is | Follows your actual train | Estimated from the schedule; tap **I'm here** to correct |
| Service alerts | Delays, skipped stops, detours for your lines | Not shown |
| Bus times | Timetable estimates | Timetable estimates |
| Map | Full detail | The saved NYC map (tap **Save** under Data first) |
| Searching addresses | Stops, stations and addresses | Stops and stations |

The pill in the top corner shows which one you're on: **Live**, **Offline**, or **Saved data**. Tap it to switch to saved data on purpose, for example to save mobile data. It switches back to live data automatically when signal returns, unless you turned live data off.

Every trip also has **Compare in Google Maps / Citymapper** links that open the same trip in those apps. Their data can't be pulled into Forkway: Citymapper has no public API, and Google's transit directions need a paid key and can't be shown outside Google's own map.

## Install it on your Android phone

Forkway is a Progressive Web App: it installs from Chrome like a regular app, opens full screen and works offline.

1. Put this folder on GitHub and turn on **GitHub Pages**: repository **Settings → Pages → Deploy from a branch → `main` / root**.
2. On your phone, open `https://<your-username>.github.io/<repo-name>/` in Chrome.
3. Tap **⋮ → Install app** (or **Add to Home screen**).
4. Open it once with signal. Then, under **Data**, tap **Save** next to **Offline NYC map** (about 10 MB) so the map works underground too.

To try it on your computer first:

```bash
npx serve .
```

Then open http://localhost:3000. Location works on `localhost`; on a phone the app must be served over `https` (GitHub Pages is).

## Using it

1. **From:** your current location (allow location access), or search for a starting point.
2. **To:** start typing. Stops and stations are found offline (`W181st and Amsterdam`, `34th st herald`, `grand central`); addresses and places come from OpenStreetMap when you have signal.
3. Pick a trip. Cards marked **"3 places to switch"** have exit choices.
4. On the trip screen, choose where to get off. The map shows the chosen route, with the other exits as blue rings labeled with the line you'd take from there.
5. Tap **Start trip**. While you wait, you'll see the next trains (live). Once you're on board, Forkway follows along:
   - **With signal** it follows your actual train using the MTA's live data.
   - **Above ground** (elevated lines, buses) it also uses GPS.
   - **With neither** it moves you along by the schedule. Tap **I'm here…** to correct it.
   - It keeps showing every exit still ahead with updated arrival times. Change your mind any time.
   - Your phone vibrates one stop before your exit, and again when it's time to get off.

## How it works

| Part | What it does | File |
| --- | --- | --- |
| Transit data | `tools/build-data.mjs` downloads the MTA's official schedule feeds (subway plus all five boroughs' buses) and condenses ~60 MB of timetables into a 1.5 MB file (0.4 MB compressed): each route's stop patterns, typical travel times between stops, and how many trips leave each hour on a weekday, Saturday and Sunday | `tools/build-data.mjs` → `data/transit.json` |
| Planning | One search runs **backward from the destination** (Dijkstra's algorithm over stops and "on board this vehicle at this stop" positions). That gives, for every stop in the city, the fastest way to finish the trip from there. Listing a vehicle's exit choices is then just reading that answer at each of its upcoming stops. Choices that continue the same way are merged | `js/router.js` |
| Waits | Offline, expected wait is half the time between vehicles at that hour, adjusted for how long the vehicle takes to reach your stop | `js/network.js` |
| Live data | Reads the MTA's subway feeds (GTFS-realtime, decoded by a small protobuf reader) and alert feeds straight from the phone; no key or server needed. Each subway ride in a plan is matched to the next real train, and the rest of the trip shifts to match | `js/realtime.js` |
| Live trip | Live train position when online, GPS when there's a fix, the schedule otherwise. Exit choices are recomputed every few seconds from where you are | `js/live.js` |
| Search | Offline name search over stops and stations ("W181st" → "W 181 St"), plus OpenStreetMap Nominatim for addresses | `js/search.js` |
| Map | MapLibre with OpenFreeMap's map data, restyled to show only land, water, parks, streets and a few names. The trip is drawn from Forkway's own data, so it shows even with no map saved | `js/map.js` |
| Offline | A service worker caches the app and transit data, and the map you've viewed. **Save NYC map** downloads all five boroughs (about 300 map tiles) | `sw.js`, `js/offline-map.js` |

Planning a trip takes about 40-80 ms on a laptop.

## Updating the schedules

The MTA updates its schedules a few times a year. To refresh:

```bash
node tools/build-data.mjs --refresh
```

Then change `VERSION` in `sw.js` (for example to `forkway-v4`) so installed copies pick up the new data, and push to GitHub.

## Tests

```bash
node tools/test-router.mjs     # the 4 train to W 181 St example
node tools/test-live.mjs       # simulates riding the 4, switching exits along the way
node tools/test-more.mjs       # other trips across boroughs, including late night
node tools/test-realtime.mjs   # live MTA data: next real trains, alerts, the example with live times (needs internet)
```

## Limits

- **Live times are for the subway only.** The MTA's live bus feed doesn't allow access from a browser, so buses use timetable estimates. Live bus times would need a small server and a free MTA Bus Time key.
- The live train feed covers trains already scheduled to run soon, so live times apply to trips leaving within about 20 minutes. Later trips use the timetable.
- Offline, holiday schedules, planned service changes and outages aren't reflected. Online, service alerts are shown but the planner doesn't route around them.
- Subway, local, Select Bus and express buses are included. The Staten Island Ferry, PATH, LIRR and Metro-North aren't.
- Walking distances are estimated from straight-line distance, not actual streets.
- The saved map has street-level detail up to zoom 13 and is enlarged beyond that, so tiny streets' names may be missing offline.

## Tech

Vanilla JavaScript (ES modules), MapLibre GL 4.7.1, OpenFreeMap and OpenStreetMap, MTA GTFS and GTFS-realtime data, Bricolage Grotesque (bundled, SIL Open Font License). No build step and no dependencies to install. The data and icon scripts use only Node's standard library.
